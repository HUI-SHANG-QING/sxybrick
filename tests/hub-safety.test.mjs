// tests/hub-safety.test.mjs —— 2026-08-29 审计 hub 侧数据安全修复回归
// 覆盖：
//   M3  数据文件损坏 → 改名留证（.corrupt-*），不静默覆盖损坏现场
//   M4  PUT /backup 校验 version：包版本与中枢不符 → 400（不再静默丢新表返回 200）
//   M7  GET /backup 默认不下发隐私表；?includePrivacy=1 才带
// 方式：真实 spawn hub.js 子进程（同 tests/hub-auth.test.mjs 的 withHub 思路）
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUB_JS = join(__dirname, '..', 'sync-hub', 'hub.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHub(fn, { corruptData = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sxy-hub-safety-'));
  const tokenFile = join(dir, 'token.txt');
  const dataFile = join(dir, 'data.json');
  const token = randomBytes(16).toString('hex');
  writeFileSync(tokenFile, token);
  if (corruptData !== null) writeFileSync(dataFile, corruptData); // M3：预置损坏现场
  const port = 48000 + Math.floor(Math.random() * 1000);

  const child = spawn(process.execPath, [HUB_JS, String(port)], {
    env: { ...process.env, PORT: String(port), HUB_HOST: '127.0.0.1', HUB_TOKEN_FILE: tokenFile, HUB_DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch { /* 未就绪 */ }
      await sleep(100);
    }
    return await fn({ base: `http://127.0.0.1:${port}`, token, dir, dataFile });
  } finally {
    child.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  }
}

const H = { 'Content-Type': 'application/json' };

function makePacket(extra = {}) {
  return {
    version: 7, app: 'sxybrick', scope: 'real', exportedAt: Date.now(),
    tombstones: [], streakMeta: null,
    cards: [], reviews: [], images: [], notes: [],
    privacyRecords: [],
    ...extra,
  };
}

// ---------- M4 PUT version 校验 ----------

test('M4: PUT 版本不符返回 400（不再静默吞新表）', async () => {
  await withHub(async ({ base, token }) => {
    const bad = makePacket({ version: 999 });
    const r1 = await fetch(`${base}/backup/real`, { method: 'PUT', headers: { ...H, 'x-sync-token': token }, body: JSON.stringify(bad) });
    assert.equal(r1.status, 400, '版本不符应 400');
    const j1 = await r1.json();
    assert.match(j1.error || '', /版本不匹配/);

    const noVer = makePacket();
    delete noVer.version;
    const r2 = await fetch(`${base}/backup/real`, { method: 'PUT', headers: { ...H, 'x-sync-token': token }, body: JSON.stringify(noVer) });
    assert.equal(r2.status, 400, '缺 version 也应 400（防老包静默丢表）');

    // 正确版本正常通过
    const ok = makePacket({ cards: [{ id: 'c1', front: 'f', back: 'b', updatedAt: Date.now(), createdAt: Date.now() }] });
    const r3 = await fetch(`${base}/backup/real`, { method: 'PUT', headers: { ...H, 'x-sync-token': token }, body: JSON.stringify(ok) });
    assert.equal(r3.status, 200);
  });
});

// ---------- M7 GET 隐私不下发 ----------

test('M7: GET /backup 默认不含隐私表，?includePrivacy=1 才下发', async () => {
  await withHub(async ({ base, token }) => {
    // 先 PUT 一条隐私记录（opt-in 客户端主动推送）
    const pkt = makePacket({
      privacyRecords: [{ id: 'p1', date: '2026-09-02', location: '家', people: ['张'], mood: 3, updatedAt: Date.now(), createdAt: Date.now() }],
    });
    const up = await fetch(`${base}/backup/real`, { method: 'PUT', headers: { ...H, 'x-sync-token': token }, body: JSON.stringify(pkt) });
    assert.equal(up.status, 200);

    // 不带 includePrivacy：隐私表应为空数组
    const plain = await (await fetch(`${base}/backup/real`, { headers: { 'x-sync-token': token } })).json();
    assert.ok(Array.isArray(plain.privacyRecords), '响应含 privacyRecords 键');
    assert.equal(plain.privacyRecords.length, 0, '默认不下发隐私记录');

    // 带 includePrivacy=1：下发
    const withP = await (await fetch(`${base}/backup/real?includePrivacy=1`, { headers: { 'x-sync-token': token } })).json();
    assert.ok(withP.privacyRecords.some((r) => r.id === 'p1'), 'includePrivacy=1 时应下发已存隐私记录');
  });
});

// ---------- M3 损坏文件改名留证 ----------

test('M3: 数据文件损坏 → 改名 .corrupt-* 留证，用空数据继续', async () => {
  await withHub(async ({ base, token, dataFile }) => {
    // 触发一次读（GET 会 loadScopedData → 解析失败 → recoverCorrupt 改名）
    const r = await fetch(`${base}/backup/real`, { headers: { 'x-sync-token': token } });
    assert.equal(r.status, 200);
    const files = readdirSync(join(dataFile, '..'));
    const corrupts = files.filter((f) => f.includes('.corrupt-'));
    assert.equal(corrupts.length, 1, '损坏现场应被改名留证，不静默覆盖');
    // 原始数据文件恢复为合法 JSON（空数据补齐），后续 PUT 正常
    const ok = makePacket({ cards: [{ id: 'c2', front: 'f2', back: 'b2', updatedAt: Date.now(), createdAt: Date.now() }] });
    const up = await fetch(`${base}/backup/real`, { method: 'PUT', headers: { ...H, 'x-sync-token': token }, body: JSON.stringify(ok) });
    assert.equal(up.status, 200, '损坏处理后服务应能继续正常写入');
  }, { corruptData: '{ this is not valid json !!!' });
});
