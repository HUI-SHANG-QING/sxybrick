// 局域网同步中枢 —— 在家里的电脑上运行，手机/平板连同一 WiFi 即可一键同步
// 用法：在 new_card 目录下运行  npm run hub  （或 node sync-hub/hub.js）
// 作用：
//   1) 提供 GET/PUT /backup 接口，与前端共用 src/sync-manifest.js 的合并规则，
//      把多台设备的数据合并到一起（卡片=内容/SRS 双时间戳，其余=updatedAt 或 id 幂等，删除走墓碑）；
//   2) 同时把打包好的前端（dist/）直接提供出来，手机浏览器打开 http://<电脑IP>:4780 即用。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  BACKUP_VERSION, SYNC_TABLES, PRIVACY_SYNC_TABLES,
  mergeRows, mergeTombstones, applyTombstones,
} from '../src/sync-manifest.js';
import {
  AUTH_VERSION, signPayload, safeEqual, createChallengeStore,
  createRateLimiter, normalizeIp, corsHeaders, isOriginAllowed,
} from './auth-core.js';

// 中枢同时处理标准表和隐私表（仅当客户端 opt-in 发送时才包含隐私数据）
const ALL_TABLES = [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
// 数据文件与令牌文件路径可用环境变量覆盖（集成测试需要隔离，避免污染仓库目录）
const DATA_FILE = process.env.HUB_DATA_FILE
  ? resolve(process.env.HUB_DATA_FILE) : join(__dirname, 'hub-data.json');
const TOKEN_FILE = process.env.HUB_TOKEN_FILE
  ? resolve(process.env.HUB_TOKEN_FILE) : join(__dirname, 'hub-token.txt');
const PORT = Number(process.env.PORT || process.argv[2] || 4780);
// 监听地址：Hub 的用途就是让同网段设备访问，默认 0.0.0.0。
// 若只想让某张网卡可达（如在不可信网络下），用 HUB_HOST=192.168.1.5 指定。
const HOST = String(process.env.HUB_HOST || '0.0.0.0');
// 跨域白名单：默认仅同源 + localhost。需要额外来源时用 HUB_ALLOW_ORIGIN 逗号分隔配置。
const ALLOW_ORIGIN = String(process.env.HUB_ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ---------- 鉴权基础设施（P0 重做） ----------
const challenges = createChallengeStore();
// 挑战签发限流：防止被无限刷
const challengeLimiter = createRateLimiter({ windowMs: 60_000, max: 60, baseLockMs: 1_000, maxLockMs: 5 * 60_000 });
// 鉴权失败限流：口令猜测是高危行为，失败即指数退避锁定（1s→2s→4s…上限 15min）
const authLimiter = createRateLimiter({ windowMs: 60_000, max: 20, baseLockMs: 1_000, maxLockMs: 15 * 60_000 });

// 同步密码：首次启动自动生成并保存，之后每次启动复用；打印给用户填到手机端
function loadToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  const t = randomBytes(16).toString('hex');
  writeFileSync(TOKEN_FILE, t);
  return t;
}
const TOKEN = loadToken();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function emptyData() {
  const out = { tombstones: [], streakMeta: null };
  for (const t of ALL_TABLES) out[t.table] = [];
  return out;
}

function loadData() {
  if (!existsSync(DATA_FILE)) return emptyData();
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    return { ...emptyData(), ...raw }; // 旧版本数据文件缺新表时自动补齐空数组
  } catch {
    return emptyData();
  }
}

// 原子写入：先写临时文件再改名，避免写入中途崩溃损坏数据文件
function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, DATA_FILE);
}

// M3：按 scope 加载/保存独立数据文件（real → 原文件；test → hub-data-test.json）
function scopedFile(scope) {
  return scope === 'test' ? DATA_FILE.replace(/\.json$/, '-test.json') : DATA_FILE;
}
function loadScopedData(scope) {
  const f = scopedFile(scope);
  if (!existsSync(f)) return emptyData();
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return { ...emptyData(), ...raw };
  } catch {
    return emptyData();
  }
}
function saveScopedData(scope, data) {
  const f = scopedFile(scope);
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, f);
}

// 提取正文中的 sxy-img:// 图片 id（hub 运行于 Node，不能 import 浏览器模块，此处内联同款正则）
function imageIdsOf(card) {
  const ids = [];
  const re = /sxy-img:\/\/([0-9a-fA-F-]+)/g;
  const text = `${card.front || ''}\n${card.back || ''}`;
  let m;
  while ((m = re.exec(text))) ids.push(m[1]);
  return ids;
}

// 全量合并：与前端 importBackup 共用 sync-manifest 的纯函数，保证两端合并语义一致
function merge(base, incoming) {
  const out = {};
  out.tombstones = mergeTombstones(base.tombstones, incoming.tombstones);
  for (const t of ALL_TABLES) {
    out[t.table] = mergeRows(base[t.table], incoming[t.table], t.merge);
  }

  // 卡片：应用墓碑（删除跨设备传播）+ 级联清理复习记录与孤儿图片 + 复活卡清除墓碑
  const cardRes = applyTombstones(out.cards, out.tombstones, 'card');
  out.cards = cardRes.rows;
  out.tombstones = out.tombstones.filter(t => !cardRes.stale.includes(t.id));
  if (cardRes.removed.length) {
    const alive = new Set(out.cards.map(c => c.id));
    out.reviews = (out.reviews || []).filter(r => alive.has(r.cardId));
    const used = new Set();
    for (const c of out.cards) for (const id of imageIdsOf(c)) used.add(id);
    out.images = (out.images || []).filter(i => used.has(i.id));
  }

  // 其余各表：应用墓碑（备忘/计划/图谱边/文档/对话/记忆的删除跨设备传播）
  for (const t of ALL_TABLES) {
    if (t.kind === 'card') continue;
    const res = applyTombstones(out[t.table] || [], out.tombstones, t.kind);
    out[t.table] = res.rows;
  }

  // 打卡元数据（每日目标 goal）：updatedAt 谁新听谁
  let streakMeta = base.streakMeta || null;
  if (incoming.streakMeta && (!streakMeta || (incoming.streakMeta.updatedAt || 0) >= (streakMeta.updatedAt || 0))) {
    streakMeta = incoming.streakMeta;
  }
  out.streakMeta = streakMeta;
  return out;
}

/**
 * 读取请求体。同时返回原始字符串——HMAC 签名是对原始字节做的，
 * 若先 JSON.parse 再 stringify，键序变化会导致摘要不一致。
 */
function readBody(req, limitBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ raw: '', json: null });
      try { resolve({ raw, json: JSON.parse(raw) }); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(req, res, code, obj, extraHeaders = {}) {
  const origin = req?.headers?.origin;
  const cors = corsHeaders(origin, { host: req?.headers?.host, allowList: ALLOW_ORIGIN });
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...cors,
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

/**
 * 校验请求鉴权。
 * 优先走 v2 HMAC 挑战-响应（密钥不上网）；老客户端可退回 x-sync-token 明文。
 * @returns {{ok:boolean, mode:'hmac'|'token'|'none', retryAfterMs?:number}}
 */
function authenticate(req, rawBody) {
  const ip = normalizeIp(req.socket?.remoteAddress);
  const locked = authLimiter.lockedFor(ip);
  if (locked > 0) return { ok: false, mode: 'none', retryAfterMs: locked };

  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  const challenge = req.headers['x-sync-challenge'];
  const sig = req.headers['x-sync-sig'];

  if (challenge && sig) {
    // v2：一次性挑战 + HMAC 签名（绑定方法/路径/请求体摘要）
    if (!challenges.consume(challenge)) {
      authLimiter.fail(ip);
      return { ok: false, mode: 'hmac' };
    }
    const expect = signPayload(TOKEN, {
      challenge: String(challenge), method: req.method, path, body: rawBody,
    });
    if (!safeEqual(String(sig), expect)) {
      authLimiter.fail(ip);
      return { ok: false, mode: 'hmac' };
    }
    authLimiter.reset(ip);
    return { ok: true, mode: 'hmac' };
  }

  // 兼容旧客户端：明文 token（恒定时间比较 + 同一套失败退避）
  const given = req.headers['x-sync-token'];
  if (given != null && safeEqual(String(given), TOKEN)) {
    authLimiter.reset(ip);
    return { ok: true, mode: 'token' };
  }
  authLimiter.fail(ip);
  return { ok: false, mode: 'token' };
}

function unauthorized(req, res, info) {
  const headers = info?.retryAfterMs ? { 'Retry-After': String(Math.ceil(info.retryAfterMs / 1000)) } : {};
  return json(req, res, 401, {
    error: info?.retryAfterMs
      ? `鉴权失败次数过多，请 ${Math.ceil(info.retryAfterMs / 1000)} 秒后重试`
      : '同步密码错误，请在 App「同步」页填写正确密码',
    authVersion: AUTH_VERSION,
  }, headers);
}

function usbHints(name) {
  const s = String(name || '').toLowerCase();
  if (/rndis|usb|android|remote ndis|tether/.test(s)) return '  ← USB/手机USB共享，手机连数据线时优先用这个';
  if (/hyper-v|virtual|vmware|virtualbox|wsl|loopback/.test(s)) return '  ← 虚拟网卡，手机一般访问不到';
  if (/wi-fi|wifi|wireless|wlan|802\.11/.test(s)) return '  ← WiFi 网卡，手机需连同一WiFi';
  if (/ethernet|eth|lan|以太网|local area/.test(s)) return '  ← 有线网卡';
  return '';
}

function serveStatic(req, res, pathname) {
  // 防目录穿越，归档到 dist 目录内。
  const rel = pathname.replace(/^\/sxybrick\b/, '');
  let p = normalize(join(DIST, (!rel || rel === '/') ? 'index.html' : rel));
  // 前缀比较必须带分隔符，否则 ../dist-evil 这类同级目录会被判为合法
  if (p !== DIST && !p.startsWith(DIST + sep)) p = join(DIST, 'index.html');
  if (!existsSync(p) || extname(p) === '') p = join(DIST, 'index.html'); // SPA 回退
  const body = readFileSync(p);
  const origin = req?.headers?.origin;
  const cors = isOriginAllowed(origin, { host: req?.headers?.host, allowList: ALLOW_ORIGIN })
    ? { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' }
    : {};
  res.writeHead(200, {
    'Content-Type': MIME[extname(p)] || 'application/octet-stream',
    ...cors,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS 预检：仅对白名单来源放行（默认同源 + localhost）。
  // 旧实现一律回 *，等于允许任意网站跨域调用 Hub 并读取响应。
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, { host: req.headers.host, allowList: ALLOW_ORIGIN })) {
      res.writeHead(204, { Vary: 'Origin' });
      return res.end();
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS,HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, x-sync-token, x-sync-challenge, x-sync-sig',
      'Access-Control-Max-Age': '3600',
      Vary: 'Origin',
    });
    return res.end();
  }

  // 签发一次性挑战（限流）。客户端据此用同步密码做 HMAC 签名，密钥本身不上网。
  if (pathname === '/auth/challenge') {
    const ip = normalizeIp(req.socket?.remoteAddress);
    const gate = challengeLimiter.hit(ip);
    if (!gate.allowed) {
      return json(req, res, 429, { error: '请求过于频繁，请稍后再试', retryAfterMs: gate.retryAfterMs },
        { 'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)) });
    }
    return json(req, res, 200, { ...challenges.issue(), app: 'sxybrick-hub' });
  }

  // 健康检查端点：仅回可达性与版本，绝不包含任何口令校验结果。
  // 旧实现免鉴权返回 tokenOk，配合 CORS * 构成公开的口令穷举预言机。
  if (pathname === '/health' || pathname === '/healthz') {
    return json(req, res, 200, {
      ok: true, app: 'sxybrick-hub', version: BACKUP_VERSION,
      authVersion: AUTH_VERSION,
      authModes: ['hmac', 'token'],
      time: Date.now(),
      tips: [
        '如手机端浏览器显示无法访问：',
        '1) 数据线连接电脑时，请在手机端开启「USB 共享网络 / USB 网络共享」，并使用上面标注 USB/RNDIS 的 IP；',
        '2) Windows 端请确认已放行本 Hub 程序的「专用网络」防火墙权限（首次启动弹窗要点「允许访问」）；',
        '3) 若前端部署在 GitHub Pages (HTTPS)，浏览器会阻止 HTTPS 页面调用 HTTP 内网地址（混合内容阻断），请改用本地 npm run hub 提供的 HTTP 页面或手机浏览器直接打开 Hub IP。',
      ],
    });
  }

  // M3 演示模式：/backup/{scope} 按数据域隔离（real 默认 | test 独立数据文件），
  // 演示数据与真实数据在中枢侧也物理分开，互不合并
  const scopeMatch = pathname.match(/^\/backup\/(real|test)$/) || (pathname === '/backup' ? [null, 'real'] : null);
  if (scopeMatch) {
    const scope = scopeMatch[1];
    // PUT 需要先读原始体（签名绑定了请求体摘要）；GET 无体
    let raw = '';
    if (req.method === 'PUT') {
      try {
        const r = await readBody(req);
        raw = r.raw;
      } catch (e) {
        return json(req, res, 400, { error: '请求体解析失败：' + e.message });
      }
    }
    const auth = authenticate(req, raw);
    if (!auth.ok) return unauthorized(req, res, auth);

    if (req.method === 'GET') {
      return json(req, res, 200, { version: BACKUP_VERSION, app: 'sxybrick', scope, exportedAt: Date.now(), ...loadScopedData(scope) });
    }
    if (req.method === 'PUT') {
      try {
        const incoming = JSON.parse(raw || 'null');
        if (!incoming || incoming.app !== 'sxybrick') return json(req, res, 400, { error: '无效数据包' });
        // scope 校验：数据包声明的 scope 必须与请求路径一致，防止测试包混入真实域（反之亦然）
        if (incoming.scope && incoming.scope !== scope) {
          return json(req, res, 409, { error: `数据域不匹配：包内 scope=${incoming.scope}，端点 scope=${scope}` });
        }
        const merged = merge(loadScopedData(scope), incoming);
        saveScopedData(scope, merged);
        return json(req, res, 200, { version: BACKUP_VERSION, app: 'sxybrick', scope, exportedAt: Date.now(), ...merged });
      } catch (e) { return json(req, res, 400, { error: e.message }); }
    }
    return json(req, res, 405, { error: 'method not allowed' });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('\n✅ SxyBrick 局域网同步中枢已启动');
  console.log(`   端口：${PORT}　监听地址：${HOST}`);
  if (HOST === '0.0.0.0') {
    console.log('   ⚠ 监听全部网卡：同网段设备均可访问。在不可信网络（公共 WiFi）下');
    console.log('     建议用 HUB_HOST=<内网IP> 只绑一张网卡，或确认防火墙已勾选「专用网络」。');
  }
  console.log(`   鉴权：HMAC-SHA256 挑战-响应（v${AUTH_VERSION}，同步密码不上网）＋ 失败指数退避锁定`);
  console.log(`   跨域：仅允许同源与 localhost${ALLOW_ORIGIN.length ? `，另加白名单 ${ALLOW_ORIGIN.join(', ')}` : ''}`);
  console.log('   下面列了本机全部 IPv4 网卡，请选与你手机/平板同一网段的地址。\n');
  const ifaces = networkInterfaces();
  let any = false;
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) {
        any = true;
        console.log(`   [${name}]  http://${it.address}:${PORT}${usbHints(name)}`);
      }
    }
  }
  if (!any) console.log('   ⚠ 未找到可用 IPv4 网卡，请检查网络连接后重试。');
  console.log(`\n   同步密码：${TOKEN}`);
  console.log('   在 App「同步」页里，把「电脑端地址」和上面这个「同步密码」都填上，即可安全同步。');
  console.log('   同步页内置了「测试连接」按钮：先跑一遍探活，再点立即同步。');
  console.log('\n   💡 USB/数据线连接小贴士：');
  console.log('   · 安卓：设置 → 连接与共享 → 打开「USB 共享网络」（手机从电脑获取网络，并出现 USB/RNDIS 网卡 IP）。');
  console.log('   · iPhone：电脑安装 iTunes → 数据线连接 → 设置「个人热点」→ 选择「仅 USB」。');
  console.log('   · 仍无法访问？请在 Windows 安全中心放防火墙：允许应用通过防火墙 → 勾选 node/npm 的专用/公用网络。');
  if (!existsSync(DIST)) console.log('\n⚠ 尚未找到 dist/，请先运行 npm run build 再访问网页。');
});