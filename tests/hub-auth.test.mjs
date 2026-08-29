// 局域网 Hub 鉴权测试（P0 回归）
// 覆盖两个层次：
//   1) auth-core.js 纯函数：恒定时间比较 / 挑战池 / 限流退避 / CORS 白名单 / 签名绑定
//   2) 端到端：真实启动 hub.js 子进程，验证旧预言机已移除、HMAC 与兼容路径均可用
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  AUTH_VERSION, signPayload, safeEqual, createChallengeStore, createRateLimiter,
  normalizeIp, corsHeaders, isOriginAllowed, buildSignPayload,
} from '../sync-hub/auth-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUB_JS = join(__dirname, '..', 'sync-hub', 'hub.js');
const SECRET = 'test-secret-0123456789abcdef';

// ---------- 恒定时间比较 ----------

test('safeEqual: 相同/不同内容判定正确', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('safeEqual: 长度不等不抛异常且返回 false', () => {
  assert.equal(safeEqual('short', 'much-longer-string'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('safeEqual: 常量时间的签名比较可用于口令校验', () => {
  const sig = signPayload(SECRET, { challenge: 'c1', method: 'GET', path: '/backup', body: '' });
  assert.equal(safeEqual(sig, sig), true);
  const wrong = signPayload(SECRET + 'x', { challenge: 'c1', method: 'GET', path: '/backup', body: '' });
  assert.equal(safeEqual(sig, wrong), false);
});

// ---------- 签名绑定（防重放/挪用） ----------

test('签名绑定方法、路径与请求体：任一变化签名即变', () => {
  const base = { challenge: 'c1', method: 'GET', path: '/backup', body: '' };
  const s0 = signPayload(SECRET, base);
  assert.notEqual(s0, signPayload(SECRET, { ...base, method: 'PUT' }), '方法必须参与签名');
  assert.notEqual(s0, signPayload(SECRET, { ...base, path: '/other' }), '路径必须参与签名');
  assert.notEqual(s0, signPayload(SECRET, { ...base, body: '{"a":1}' }), '请求体必须参与签名');
  assert.notEqual(s0, signPayload(SECRET, { ...base, challenge: 'c2' }), '挑战必须参与签名');
});

test('签名确定性：相同输入两次结果一致', () => {
  const p = { challenge: 'c1', method: 'PUT', path: '/backup', body: '{"x":1}' };
  assert.equal(signPayload(SECRET, p), signPayload(SECRET, p));
});

test('buildSignPayload 规范串含版本前缀 v2', () => {
  assert.ok(buildSignPayload({ challenge: 'c', method: 'GET', path: '/p', body: 'h' }).startsWith('v2\n'));
  assert.equal(AUTH_VERSION, 2);
});

// ---------- 挑战池 ----------

test('挑战池: 签发后可消费，且一次性', () => {
  const store = createChallengeStore();
  const c = store.issue();
  assert.ok(c.challenge && c.expiresAt > Date.now());
  assert.equal(store.has(c.challenge), true);
  assert.equal(store.consume(c.challenge), true, '首次消费应成功');
  assert.equal(store.consume(c.challenge), false, '挑战必须一次性，防重放');
});

test('挑战池: 过期挑战不可用', () => {
  let t = Date.now();
  const store = createChallengeStore({ now: () => t });
  const c = store.issue();
  t += 61_000; // 越过 60s 有效期
  assert.equal(store.has(c.challenge), false, '过期挑战应失效');
  assert.equal(store.consume(c.challenge), false);
});

test('挑战池: 未知挑战被拒绝', () => {
  const store = createChallengeStore();
  assert.equal(store.consume('not-issued'), false);
  assert.equal(store.consume(''), false);
});

// ---------- 限流与失败锁定 ----------

test('限流器: 窗口内超限即锁定，且返回重试时间', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 3, baseLockMs: 1000, maxLockMs: 1000, now: () => t });
  assert.equal(rl.hit('1.2.3.4').allowed, true);
  assert.equal(rl.hit('1.2.3.4').allowed, true);
  assert.equal(rl.hit('1.2.3.4').allowed, true);
  const r = rl.hit('1.2.3.4');
  assert.equal(r.allowed, false, '超过 max 应锁定');
  assert.ok(r.retryAfterMs > 0, '应返回重试等待毫秒');
});

test('限流器: 鉴权失败立即退避，且指数增长', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 60_000, max: 100, baseLockMs: 1000, maxLockMs: 1e9, now: () => t });
  assert.equal(rl.fail('ip'), 1000, '第 1 次失败锁 1s');
  assert.equal(rl.fail('ip'), 2000, '第 2 次失败锁 2s');
  assert.equal(rl.fail('ip'), 4000, '第 3 次失败锁 4s');
  assert.equal(rl.fail('ip'), 8000, '指数退避');
});

test('限流器: 成功后清零，正常用户不被长期惩罚', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 60_000, max: 100, baseLockMs: 1000, now: () => t });
  rl.fail('ip'); rl.fail('ip');
  assert.ok(rl.lockedFor('ip') > 0);
  rl.reset('ip');
  assert.equal(rl.lockedFor('ip'), 0, '成功后应解除锁定');
});

test('限流器: 不同 IP 互不影响', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, baseLockMs: 1000, now: () => t });
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, false);
  assert.equal(rl.hit('b').allowed, true, '另一 IP 不应被牵连');
});

test('normalizeIp: IPv6 映射的 IPv4 归一化', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp(''), 'unknown');
});

// ---------- CORS 白名单 ----------

test('CORS: 无 Origin（同源/非浏览器）放行', () => {
  assert.equal(isOriginAllowed(undefined, {}), true);
  assert.equal(isOriginAllowed('', {}), true);
});

test('CORS: localhost 与同源放行，恶意站点拒绝', () => {
  assert.equal(isOriginAllowed('http://localhost:5173', { host: '192.168.1.5:4780' }), true, '本地 dev 需放行');
  assert.equal(isOriginAllowed('http://127.0.0.1:8080', { host: '192.168.1.5:4780' }), true);
  assert.equal(isOriginAllowed('http://192.168.1.5:4780', { host: '192.168.1.5:4780' }), true, '同源');
  // 关键：恶意站点不得被放行（否则可跨域穷举口令并读取响应）
  assert.equal(isOriginAllowed('https://evil.test', { host: '192.168.1.5:4780' }), false);
  assert.equal(isOriginAllowed('http://attacker.example:9000', { host: '192.168.1.5:4780' }), false);
});

test('CORS: 环境变量白名单生效', () => {
  assert.equal(isOriginAllowed('https://a.example', { allowList: ['https://a.example'] }), true);
  assert.equal(isOriginAllowed('https://b.example', { allowList: ['https://a.example'] }), false);
});

test('CORS: 被拒来源不返回 Access-Control-Allow-Origin', () => {
  const h = corsHeaders('https://evil.test', { host: '192.168.1.5:4780' });
  assert.equal(h['Access-Control-Allow-Origin'], undefined, '恶意来源不应拿到 CORS 头');
  const ok = corsHeaders('http://localhost:5173', { host: '192.168.1.5:4780' });
  assert.equal(ok['Access-Control-Allow-Origin'], 'http://localhost:5173');
});

test('CORS: 非法 Origin 字符串被拒绝', () => {
  assert.equal(isOriginAllowed('not-a-url', {}), false);
});

// ---------- 端到端：真实启动 hub ----------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withHub(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sxy-hub-'));
  const tokenFile = join(dir, 'token.txt');
  const dataFile = join(dir, 'data.json');
  const token = randomBytes(16).toString('hex');
  writeFileSync(tokenFile, token);
  const port = 47000 + Math.floor(Math.random() * 1000);

  const child = spawn(process.execPath, [HUB_JS, String(port)], {
    env: {
      ...process.env,
      PORT: String(port), HUB_HOST: '127.0.0.1',
      HUB_TOKEN_FILE: tokenFile, HUB_DATA_FILE: dataFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // 等待监听就绪
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch { /* 尚未就绪 */ }
      await sleep(100);
    }
    return await fn({ base: `http://127.0.0.1:${port}`, token, dir, dataFile });
  } finally {
    child.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
}

test('E2E: /health 不再泄露口令校验结果（原预言机已移除）', async () => {
  await withHub(async ({ base, token }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    // 核心断言：无论传对传错，都不应出现 tokenOk 之类的判定字段
    assert.equal(j.tokenOk, undefined, 'tokenOk 必须移除——它是公开的口令穷举预言机');
    assert.equal(j.authVersion, 2);
    assert.ok(Array.isArray(j.authModes));
    // 带上正确与错误的口令分别请求，响应除 time 外必须完全一致（不含任何可区分信息）
    const stripTime = (o) => { const { time, ...rest } = o; return rest; };
    const a = stripTime(await (await fetch(`${base}/health`, { headers: { 'x-sync-token': token } })).json());
    const b = stripTime(await (await fetch(`${base}/health`, { headers: { 'x-sync-token': 'wrong' } })).json());
    const c = stripTime(await (await fetch(`${base}/health`)).json());
    assert.equal(JSON.stringify(a), JSON.stringify(b), '正确/错误口令的 /health 响应必须不可区分');
    assert.equal(JSON.stringify(a), JSON.stringify(c), '带不带口令的 /health 响应必须不可区分');
  });
});

test('E2E: /backup 无鉴权返回 401，且不泄露数据', async () => {
  await withHub(async ({ base }) => {
    const res = await fetch(`${base}/backup`);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.ok(j.error, '应返回错误说明');
    assert.equal(j.cards, undefined, '401 时不得返回任何数据');
  });
});

test('E2E: 旧式 x-sync-token 明文仍可用（向后兼容）', async () => {
  await withHub(async ({ base, token }) => {
    const ok = await fetch(`${base}/backup`, { headers: { 'x-sync-token': token } });
    assert.equal(ok.status, 200, '正确口令应通过');
    const j = await ok.json();
    assert.equal(j.app, 'sxybrick');
  });
});

test('E2E: 错误口令返回 401（明文路径）', async () => {
  await withHub(async ({ base }) => {
    const bad = await fetch(`${base}/backup`, { headers: { 'x-sync-token': 'definitely-wrong' } });
    assert.equal(bad.status, 401);
  });
});

// 用 node:crypto 模拟客户端的 HMAC 计算（浏览器端走 WebCrypto，逻辑等价）
async function hmacGet(base, token, path, body = '') {
  const chRes = await fetch(`${base}/auth/challenge`);
  assert.equal(chRes.status, 200, '挑战签发应成功');
  const ch = await chRes.json();
  assert.ok(ch.challenge, '应返回挑战串');
  const { createHash } = await import('node:crypto');
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const payload = ['v2', ch.challenge, 'GET', path, bodyHash].join('\n');
  const sig = createHmac('sha256', token).update(payload).digest('hex');
  return fetch(`${base}${path}`, { headers: { 'x-sync-challenge': ch.challenge, 'x-sync-sig': sig } });
}

test('E2E: HMAC 挑战-响应鉴权通过（口令不上网）', async () => {
  await withHub(async ({ base, token }) => {
    const res = await hmacGet(base, token, '/backup');
    assert.equal(res.status, 200, '正确签名的请求应通过');
    const j = await res.json();
    assert.equal(j.app, 'sxybrick');
  });
});

test('E2E: 错误口令算出的签名被拒绝', async () => {
  await withHub(async ({ base, token }) => {
    const res = await hmacGet(base, token + 'tampered', '/backup');
    assert.equal(res.status, 401, '错误密钥的签名必须被拒');
  });
});

test('E2E: 挑战一次性，重放被拒', async () => {
  await withHub(async ({ base, token }) => {
    const ch = await (await fetch(`${base}/auth/challenge`)).json();
    const { createHash } = await import('node:crypto');
    const bodyHash = createHash('sha256').update('', 'utf8').digest('hex');
    const payload = ['v2', ch.challenge, 'GET', '/backup', bodyHash].join('\n');
    const sig = createHmac('sha256', token).update(payload).digest('hex');
    const h = { 'x-sync-challenge': ch.challenge, 'x-sync-sig': sig };
    const first = await fetch(`${base}/backup`, { headers: h });
    assert.equal(first.status, 200, '首次使用应通过');
    const replay = await fetch(`${base}/backup`, { headers: h });
    assert.equal(replay.status, 401, '同一挑战重放必须被拒');
  });
});

test('E2E: 签名绑定到路径/方法，跨端点挪用被拒', async () => {
  await withHub(async ({ base, token }) => {
    const ch = await (await fetch(`${base}/auth/challenge`)).json();
    const { createHash } = await import('node:crypto');
    const bodyHash = createHash('sha256').update('', 'utf8').digest('hex');
    // 用 /other 路径签名，却发给 /backup
    const payload = ['v2', ch.challenge, 'GET', '/other', bodyHash].join('\n');
    const sig = createHmac('sha256', token).update(payload).digest('hex');
    const res = await fetch(`${base}/backup`, {
      headers: { 'x-sync-challenge': ch.challenge, 'x-sync-sig': sig },
    });
    assert.equal(res.status, 401, '跨路径挪用签名必须被拒');
  });
});

test('E2E: 篡改请求体导致签名失效（PUT 场景）', async () => {
  await withHub(async ({ base, token }) => {
    const ch = await (await fetch(`${base}/auth/challenge`)).json();
    const { createHash } = await import('node:crypto');
    const signedBody = JSON.stringify({ app: 'sxybrick', cards: [] });
    const bodyHash = createHash('sha256').update(signedBody, 'utf8').digest('hex');
    const payload = ['v2', ch.challenge, 'PUT', '/backup', bodyHash].join('\n');
    const sig = createHmac('sha256', token).update(payload).digest('hex');
    // 中间人篡改请求体
    const tampered = JSON.stringify({ app: 'sxybrick', cards: [{ id: 'evil' }] });
    const res = await fetch(`${base}/backup`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-challenge': ch.challenge, 'x-sync-sig': sig,
      },
      body: tampered,
    });
    assert.equal(res.status, 401, '请求体被篡改后签名应失效');
  });
});

test('E2E: 连续错误口令触发限流锁定（防暴力破解）', async () => {
  await withHub(async ({ base }) => {
    let sawLock = false;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/backup`, { headers: { 'x-sync-token': 'guess-' + i } });
      if (res.status === 401) {
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter && Number(retryAfter) > 0) { sawLock = true; break; }
      }
    }
    assert.equal(sawLock, true, '连续猜错应触发 Retry-After 退避锁定');
  });
});

test('E2E: 恶意 Origin 拿不到 CORS 头（阻断跨域穷举）', async () => {
  await withHub(async ({ base }) => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.test' } });
    assert.equal(
      res.headers.get('access-control-allow-origin'), null,
      '恶意来源不应获得 CORS 授权，否则任意网页可跨域穷举口令');
    const ok = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173',
      '本地 dev 来源应放行');
  });
});

test('E2E: 静态资源目录穿越被拦截', async () => {
  await withHub(async ({ base }) => {
    // 尝试读取仓库外的 package.json
    const res = await fetch(`${base}/../package.json`, { redirect: 'manual' });
    // 无论回退到 index.html 还是 404，都不能返回 package.json 内容
    if (res.ok) {
      const text = await res.text();
      assert.ok(!text.includes('"devDependencies"'), `不得泄露上级目录文件：${text.slice(0, 80)}`);
    }
    const res2 = await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`, { redirect: 'manual' });
    if (res2.ok) {
      const text2 = await res2.text();
      assert.ok(!text2.includes('"devDependencies"'), '编码绕过同样不得泄露');
    }
  });
});
