// tests/demo-mode.test.mjs —— M3 演示模式（双数据库隔离）测试
// 覆盖：
//   1) 双实例：real/test 两个 Dexie 实例物理隔离，setDbInstance 切换后 live-binding 跟随
//   2) 数据隔离：test 库写入不影响 real 库（反向亦然）
//   3) testDataSeeder：空库播种（20 卡/3 卡组/关联/备忘/笔记）+ 非空不重播
//   4) 同步 scope：buildBackup 带 scope 标记；hub 端 /backup/{scope} 独立数据文件 + 409 域校验
//      （hub 以子进程启动，PORT/HUB_DATA_FILE/HUB_TOKEN_FILE 环境变量隔离）
//   5) appMode store：enterTestMode/exitTestMode 的 localStorage 标记与实例切换（mock reload）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const {
  setDbInstance, currentDbMode, MODE_KEY, uid, getDb,
} = await import('../src/db.js');
// 注意：解构拿到的 db 是值快照，不跟随 setDbInstance 切换；
// 每个用例开头 `const db = getDb()` 取「当时」的实例。

const tmp = mkdtempSync(join(tmpdir(), 'sxy-hub-test-'));
const HUB_PORT = 48231;
let hubProc = null;
let hubToken = '';

// ---------- 1) 双实例隔离 ----------

test('db：setDbInstance 切换 real/test，currentDbMode 跟随', () => {
  const modeBefore = currentDbMode();
  setDbInstance('test');
  assert.equal(currentDbMode(), 'test');
  assert.equal(getDb().name, 'sxybrick-test');
  setDbInstance('real');
  assert.equal(currentDbMode(), 'real');
  assert.equal(getDb().name, 'sxybrick');
  assert.equal(currentDbMode(), modeBefore, '切回原模式');
});

test('数据隔离：test 库写入的卡不出现在 real 库', async () => {
  // 关键：每次 setDbInstance 后必须用 getDb() 重取实例（解构的 db 是值快照）
  setDbInstance('test');
  const dbTest = getDb();
  await dbTest.cards.put({ id: 'iso-test-card', front: '只存在于测试库', back: 'x', subject: '计网', tags: [], ease: 2.5, level: 0, intervalDays: 0, dueAt: Date.now(), reviewedAt: 0, createdAt: Date.now(), updatedAt: Date.now() });
  assert.ok(await dbTest.cards.get('iso-test-card'), 'test 库应能读到');

  setDbInstance('real');
  const dbReal = getDb();
  assert.equal(await dbReal.cards.get('iso-test-card'), undefined, 'real 库不应读到 test 库的卡（物理隔离）');

  // 反向：real 写入，test 看不到
  const rid = uid();
  await dbReal.cards.put({ id: rid, front: '只存在于真实库', back: 'x', subject: '计网', tags: [], ease: 2.5, level: 0, intervalDays: 0, dueAt: Date.now(), reviewedAt: 0, createdAt: Date.now(), updatedAt: Date.now() });
  setDbInstance('test');
  const dbTest2 = getDb();
  assert.equal(await dbTest2.cards.get(rid), undefined, 'test 库不应读到 real 库的卡');

  // 清理
  await dbReal.cards.delete(rid);
  await dbTest2.cards.delete('iso-test-card');
  setDbInstance('real');
});

// ---------- 2) 测试数据播种 ----------

test('testDataSeeder：空测试库自动播种完整示例数据', async () => {
  setDbInstance('test');
  const db = getDb();
  const { testDbEmpty, seedTestDatabase } = await import('../src/utils/testDataSeeder.js');
  // 先清空测试库模拟首次进入
  await db.transaction('rw', db.cards, db.reviews, db.cardGroups, db.cardGroupLinks, db.memos, db.notes, async () => {
    for (const t of [db.cards, db.reviews, db.cardGroups, db.cardGroupLinks, db.memos, db.notes]) await t.clear();
  });
  assert.ok(await testDbEmpty(), '清空后应为空');

  await seedTestDatabase();
  assert.ok(!(await testDbEmpty()), '播种后非空');

  const cardCount = await db.cards.count();
  assert.equal(cardCount, 20, '20 张演示卡');
  const groupCount = await db.cardGroups.count();
  assert.equal(groupCount, 3, '3 个演示卡组');
  const archGroups = (await db.cardGroups.toArray()).filter(g => g.status === 'archived');
  assert.equal(archGroups.length, 1, '含 1 个备用（archived）卡组');

  const linkCount = await db.cardGroupLinks.count();
  assert.ok(linkCount >= 10, `关联数应 >=10，实际 ${linkCount}`);
  // 存在「仅属于备用组」的卡（演示备用停车）
  const groups = await db.cardGroups.toArray();
  const archIds = new Set(archGroups.map(g => g.id));
  const actIds = new Set(groups.filter(g => g.status === 'active').map(g => g.id));
  const links = await db.cardGroupLinks.toArray();
  const byCard = new Map();
  for (const l of links) {
    if (!byCard.has(l.cardId)) byCard.set(l.cardId, new Set());
    byCard.get(l.cardId).add(l.groupId);
  }
  const parked = [...byCard.entries()].filter(([cid, gs]) =>
    [...gs].every(gid => archIds.has(gid)) && byCard.get(cid).size > 0);
  assert.ok(parked.length >= 2, `应有多张「仅备用组」卡，实际 ${parked.length}`);

  const memoCount = await db.memos.count();
  assert.ok(memoCount >= 2, '演示备忘');
  const noteCount = await db.notes.count();
  assert.ok(noteCount >= 1, '演示笔记');

  // 复习记录：已背过的卡有 reviews
  const revCount = await db.reviews.count();
  assert.ok(revCount > 10, `演示复习记录应较多，实际 ${revCount}`);
});

test('testDataSeeder：非空测试库不重复播种（幂等）', async () => {
  setDbInstance('test');
  const db = getDb();
  const { testDbEmpty, seedTestDatabase } = await import('../src/utils/testDataSeeder.js');
  assert.ok(!(await testDbEmpty()));
  const before = await db.cards.count();
  await seedTestDatabase(); // 重复调用应幂等（bulkPut 覆盖，不新增）
  const after = await db.cards.count();
  assert.equal(after, before, `重复播种不应改变卡片数（${before} → ${after}）`);
});

// ---------- 3) 同步 scope 标记（前端侧） ----------

test('buildBackup：数据包带 scope 标记，跟随当前实例', async () => {
  const { buildBackup } = await import('../src/sync.js');
  setDbInstance('real');
  const realBak = await buildBackup();
  assert.equal(realBak.scope, 'real');

  setDbInstance('test');
  const testBak = await buildBackup();
  assert.equal(testBak.scope, 'test');
  // test 包应包含演示卡片
  assert.ok(testBak.cards.length >= 20, `演示数据应入包，实际 ${testBak.cards.length}`);
  assert.equal(testBak.app, 'sxybrick');
  setDbInstance('real');
});

// ---------- 4) hub 端 scope 隔离（子进程真实 HTTP） ----------

before(async () => {
  // HTTP header 要求 ASCII：token 不能含中文
  const token = 'test-token-m3-scope-isolation';
  const tokenFile = join(tmp, 'token.txt');
  const dataFile = join(tmp, 'hub-data.json');
  writeFileSync(tokenFile, token);
  hubToken = token;

  hubProc = spawn(process.execPath, [join(ROOT, 'sync-hub', 'hub.js')], {
    env: {
      ...process.env,
      PORT: String(HUB_PORT),
      HUB_HOST: '127.0.0.1',
      HUB_DATA_FILE: dataFile,
      HUB_TOKEN_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 排空子进程输出：pipe 不读会填满内核/uv 缓冲区把 hub 卡死，
  // 同时这些可读流本身也是 libuv handle，需要在收尾时显式销毁。
  hubProc.stdout?.on('data', () => {});
  hubProc.stderr?.on('data', () => {});

  // 等待端口就绪
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${HUB_PORT}/health`, { signal: AbortSignal.timeout(2000) });
      // 关键：必须消费/取消响应体。否则 keep-alive 连接不会被释放，
      // 探测阶段每轮都会泄漏一个 socket handle —— 这是 Windows 下
      // 主进程收尾时 UV_HANDLE_CLOSING 断言的真实来源之一。
      await r.arrayBuffer().catch(() => {});
      if (r.status === 200) break;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 15000) throw new Error('hub 子进程启动超时');
    await new Promise(r => setTimeout(r, 200));
  }
});

// 关键：kill 只是「发信号」，不代表子进程已退出。
// 必须等 'exit' 事件再返回，否则 --test-force-exit 会在子进程 handle 还开着时
// 让主进程收尾，Windows 下触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
async function stopHub() {
  if (!hubProc) return;
  const proc = hubProc;
  hubProc = null;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      // SIGTERM 未果（Windows 无控制台的子进程可能不响应）→ 强杀兜底
      try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }, 3000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    try { proc.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
  // 显式销毁 stdio 流，确保 libuv handle 在主进程退出前关闭
  try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* 已销毁 */ }
}

after(async () => {
  await stopHub();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function hubPayload(scope, cards = []) {
  // 最小合法数据包（app=sxybrick + scope + 空表），复用 manifest 表清单避免手抄
  const { SYNC_TABLES, BACKUP_VERSION } = require_manifest();
  const payload = { version: BACKUP_VERSION, app: 'sxybrick', scope, exportedAt: Date.now(), tombstones: [], streakMeta: null };
  for (const t of SYNC_TABLES) payload[t.table] = [];
  payload.cards = cards;
  return payload;
}
// 同步清单是 ESM，动态 import 缓存复用
let _manifest = null;
function require_manifest() {
  if (!_manifest) throw new Error('manifest 未加载');
  return _manifest;
}
before(async () => { _manifest = await import('../src/sync-manifest.js'); });

test('hub：/backup/real 与 /backup/test 数据物理隔离（独立文件互不合并）', async () => {
  const base = `http://127.0.0.1:${HUB_PORT}`;
  const hdr = { 'Content-Type': 'application/json', 'x-sync-token': hubToken };
  const cardReal = { id: 'hub-real-1', front: 'real 域卡', back: 'a', subject: '计网', tags: [], ease: 2.5, level: 1, intervalDays: 1, dueAt: Date.now(), reviewedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
  const cardTest = { id: 'hub-test-1', front: 'test 域卡', back: 'a', subject: '计网', tags: [], ease: 2.5, level: 1, intervalDays: 1, dueAt: Date.now(), reviewedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };

  // PUT 到 real 域
  let r = await fetch(`${base}/backup/real`, { method: 'PUT', headers: hdr, body: JSON.stringify(hubPayload('real', [cardReal])) });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.scope, 'real');
  assert.ok(j.cards.some(c => c.id === 'hub-real-1'));

  // PUT 到 test 域
  r = await fetch(`${base}/backup/test`, { method: 'PUT', headers: hdr, body: JSON.stringify(hubPayload('test', [cardTest])) });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.scope, 'test');
  assert.ok(j.cards.some(c => c.id === 'hub-test-1'));

  // GET 验证隔离：real 域看不到 test 卡，反之亦然
  r = await fetch(`${base}/backup/real`, { headers: hdr });
  j = await r.json();
  assert.ok(j.cards.some(c => c.id === 'hub-real-1'));
  assert.ok(!j.cards.some(c => c.id === 'hub-test-1'), 'real 域不应出现 test 域的卡');

  r = await fetch(`${base}/backup/test`, { headers: hdr });
  j = await r.json();
  assert.ok(j.cards.some(c => c.id === 'hub-test-1'));
  assert.ok(!j.cards.some(c => c.id === 'hub-real-1'), 'test 域不应出现 real 域的卡');

  // 数据文件物理分离
  const { HUB_DATA_FILE } = process.env;
  const realFile = join(tmp, 'hub-data.json');
  const testFile = join(tmp, 'hub-data-test.json');
  assert.ok(existsSync(realFile), 'real 数据文件应存在');
  assert.ok(existsSync(testFile), 'test 独立数据文件应存在（-test.json）');
});

test('hub：scope 不匹配返回 409（测试包不能混入真实域）', async () => {
  const base = `http://127.0.0.1:${HUB_PORT}`;
  const hdr = { 'Content-Type': 'application/json', 'x-sync-token': hubToken };
  const r = await fetch(`${base}/backup/real`, { method: 'PUT', headers: hdr, body: JSON.stringify(hubPayload('test')) });
  assert.equal(r.status, 409, '包内 scope=test 打到 /backup/real 应被拒绝');
  const j = await r.json();
  assert.ok(/数据域不匹配/.test(j.error));
});

test('hub：默认 /backup 等价 /backup/real（向后兼容）', async () => {
  const base = `http://127.0.0.1:${HUB_PORT}`;
  const hdr = { 'x-sync-token': hubToken };
  const r = await fetch(`${base}/backup`, { headers: hdr });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.scope, 'real');
});

// ---------- 5) appMode store（mock reload） ----------

test('appMode：enter/exit 切换实例并写 localStorage 标记（location.reload mock）', async () => {
  const reloadCalls = [];
  const origReload = globalThis.location?.reload;
  const origLocation = globalThis.location;
  globalThis.location = { ...origLocation, reload: () => { reloadCalls.push(1); } };
  try {
    const { useAppModeStore } = await import('../src/stores/appMode.js');
    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    const store = useAppModeStore();

    await store.enterTestMode();
    assert.equal(currentDbMode(), 'test', 'enterTestMode 后实例应为 test');
    assert.equal(localStorage.getItem(MODE_KEY), 'test');
    assert.equal(reloadCalls.length, 1, '应触发整页 reload');

    // 模拟 reload 后重新 init（新 store 实例从 localStorage 恢复）
    setActivePinia(createPinia());
    const store2 = useAppModeStore();
    await store2.init();
    assert.equal(currentDbMode(), 'test', 'init 应恢复 test 模式');

    store2.exitTestMode();
    assert.equal(currentDbMode(), 'real', 'exitTestMode 后实例应为 real');
    assert.equal(localStorage.getItem(MODE_KEY), null, '退出应清除标记');
    assert.equal(reloadCalls.length, 2);
  } finally {
    globalThis.location = origLocation;
    localStorage.removeItem(MODE_KEY);
    setDbInstance('real');
  }
});

test('appMode：enterTestMode 空测试库自动播种（演示数据立即可用）', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.transaction('rw', db.cards, db.reviews, db.cardGroups, db.cardGroupLinks, async () => {
    for (const t of [db.cards, db.reviews, db.cardGroups, db.cardGroupLinks]) await t.clear();
  });
  const reloadCalls = [];
  const origLocation = globalThis.location;
  globalThis.location = { ...origLocation, reload: () => reloadCalls.push(1) };
  try {
    const { useAppModeStore } = await import('../src/stores/appMode.js');
    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    const store = useAppModeStore();
    await store.enterTestMode();
    assert.ok(reloadCalls.length >= 1);
  } finally {
    globalThis.location = origLocation;
    setDbInstance('real');
    localStorage.removeItem(MODE_KEY);
  }
  setDbInstance('test');
  const n = await db.cards.count();
  assert.equal(n, 20, '进入演示模式后测试库应自动填充 20 张示例卡');
  setDbInstance('real');
});
