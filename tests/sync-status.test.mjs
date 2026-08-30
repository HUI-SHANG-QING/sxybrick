// tests/sync-status.test.mjs —— M5 同步状态跟踪测试
// 覆盖：
//   1) getModuleStatus 四态判定：未配置(none)/待同步(pending)/成功(ok)/失败(error)
//   2) 新变更判定：表最大活跃时间戳 > lastSyncAt → pending
//   3) recordModuleResult / recordAllModulesOk / recordAllModulesError 持久化（localStorage）
//   4) scope 隔离：real/test 状态分键互不串（M3 联动）
//   5) 全覆盖：有效同步表（24 张）全部出现在状态面板，含 M1/M2 新增表
//   6) summarizeStatus 计数正确
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const { getModuleStatus, recordModuleResult, recordAllModulesOk, recordAllModulesError,
        loadStatus, resetStatus, summarizeStatus, MODULE_LABELS } =
  await import('../src/sync-status.js');
const { db, setDbInstance, getDb, uid } = await import('../src/db.js');
const { getEffectiveSyncTables } = await import('../src/sync.js');

const T = Date.now();
function card(id, updatedAt = T) {
  return { id, front: 'q-' + id, back: 'a', subject: '计网', tags: [], ease: 2.5, level: 1,
    intervalDays: 1, dueAt: T, reviewedAt: 0, createdAt: T - 1000, updatedAt };
}

before(async () => {
  setDbInstance('real');
  const d = getDb();
  // 灌入少量测试数据（确保 cards 表非空）
  const cid = 'ss-c1';
  await d.cards.delete(cid);
  await d.cards.put(card(cid));
});

after(async () => {
  resetStatus();
  try { setDbInstance('real'); getDb().close(); } catch {}
});

test('全覆盖：状态面板包含全部有效同步表（24 张，含 M1/M2 新增表）', async () => {
  resetStatus();
  const list = await getModuleStatus({ channels: { hub: true } });
  const tables = getEffectiveSyncTables().map(t => t.table);
  assert.equal(list.length, tables.length, `面板模块数 ${list.length} 应等于有效同步表数 ${tables.length}`);
  for (const t of tables) {
    assert.ok(list.some(m => m.module === t), `缺少模块 ${t}`);
  }
  // M1/M2 新增表必须带中文标签
  for (const t of ['cardGroups', 'cardGroupLinks', 'analysisSessions', 'analysisMessages']) {
    assert.ok(MODULE_LABELS[t], `${t} 缺中文标签`);
  }
});

test('未配置：无任何通道时全部模块为 none', async () => {
  resetStatus();
  const list = await getModuleStatus({ channels: { hub: false, gist: false, backup: false } });
  assert.ok(list.every(m => m.status === 'none'), '无通道 → 全部「未配置」');
  const s = summarizeStatus(list);
  assert.equal(s.none, list.length);
  assert.equal(s.ok, 0);
});

test('待同步：已配置通道 + 从未同步 + 有数据 → pending；空表 → ok', async () => {
  resetStatus();
  const list = await getModuleStatus({ channels: { hub: true } });
  const cards = list.find(m => m.module === 'cards');
  assert.equal(cards.status, 'pending', 'cards 有数据且从未同步 → 待同步');
  assert.ok(cards.count >= 1, `cards 计数应 >=1，实际 ${cards.count}`);
  // 空表（reviews 此刻应为空或测试残留：若空则 ok）
  const reviews = list.find(m => m.module === 'reviews');
  if (reviews.count === 0) assert.equal(reviews.status, 'ok', '空表且从未同步 → 无事可做=ok');
});

test('成功：recordAllModulesOk 后全模块为 ok（含条数记录）', async () => {
  resetStatus();
  recordAllModulesOk({ cards: 1 });
  const list = await getModuleStatus({ channels: { hub: true } });
  const cards = list.find(m => m.module === 'cards');
  assert.equal(cards.status, 'ok');
  assert.ok(cards.lastSyncAt > 0);
  assert.equal(cards.lastRows, 1);
  const s = summarizeStatus(list);
  assert.equal(s.ok, list.length, `全部成功，实际 ok=${s.ok}/${list.length}`);
});

test('新变更判定：lastSyncAt 之后表有新写入 → 重新变 pending', async () => {
  resetStatus();
  recordAllModulesOk({});
  let list = await getModuleStatus({ channels: { hub: true } });
  assert.equal(list.find(m => m.module === 'cards').status, 'ok');

  // 新写入（updatedAt 晚于刚才的 lastSyncAt；用 L1 偏移而非墙钟，避免毫秒撞车 flaky）
  const L1 = list.find(m => m.module === 'cards').lastSyncAt;
  await getDb().cards.put(card('ss-new', L1 + 1000));
  list = await getModuleStatus({ channels: { hub: true } });
  assert.equal(list.find(m => m.module === 'cards').status, 'pending', '新变更未同步 → 待同步');

  // 再次同步成功（本次同步发生在新写入之后，at > 写入时间戳）→ ok
  recordModuleResult('cards', { ok: true, rows: 2, at: L1 + 2000 });
  list = await getModuleStatus({ channels: { hub: true } });
  assert.equal(list.find(m => m.module === 'cards').status, 'ok');

  await getDb().cards.delete('ss-new');
});

test('失败：recordAllModulesError 后全部为 error 且带错误原因；recordModuleResult 可单模块重试成功', async () => {
  resetStatus();
  await getDb().cards.delete('ss-new'); // 防御上一测试残留（未来时间戳会造成假「新变更」pending）
  recordAllModulesError('中枢 502 Bad Gateway');
  let list = await getModuleStatus({ channels: { hub: true } });
  assert.ok(list.every(m => m.status === 'error'), '全量失败 → 全部「失败」');
  assert.ok(list.find(m => m.module === 'cards').error.includes('502'), '错误原因应保留');

  // 单模块重试成功（模拟面板「重试」按钮）
  recordModuleResult('cards', { ok: true, rows: 3 });
  list = await getModuleStatus({ channels: { hub: true } });
  const cards = list.find(m => m.module === 'cards');
  assert.equal(cards.status, 'ok', '重试成功 → ok（无新变更时）');
  assert.equal(cards.lastRows, 3);
  // 其它模块仍是 error
  assert.ok(list.some(m => m.status === 'error'), '其它模块应保持失败态');

  const s = summarizeStatus(list);
  assert.equal(s.error, list.length - 1);
});

test('scope 隔离：real/test 状态分键，互不串（M3 联动）', async () => {
  resetStatus();
  setDbInstance('real');
  recordModuleResult('cards', { ok: true, rows: 10 });
  setDbInstance('test');
  const stReal = JSON.parse(localStorage.getItem('sxy_sync_status_real'));
  const stTest = JSON.parse(localStorage.getItem('sxy_sync_status_test') || 'null');
  assert.equal(stReal.modules.cards.lastRows, 10, 'real 状态已记录');
  assert.ok(!stTest || !stTest.modules?.cards, 'test 键不应含 real 的状态');

  // test 域独立记录
  recordModuleResult('cards', { ok: false, error: 'demo err' });
  const stTest2 = JSON.parse(localStorage.getItem('sxy_sync_status_test'));
  assert.equal(stTest2.modules.cards.lastResult, 'error');
  assert.equal(stTest2.modules.cards.lastError, 'demo err');

  // 清理
  resetStatus(); // 清 test 键
  setDbInstance('real');
  resetStatus(); // 清 real 键
  setDbInstance('test');
  resetStatus();
  setDbInstance('real');
});

test('loadStatus：localStorage 损坏安全返回空结构', () => {
  setDbInstance('real');
  localStorage.setItem('sxy_sync_status_real', '{broken json');
  const st = loadStatus();
  assert.deepEqual(st, { version: 1, modules: {} }, '损坏数据 → 空结构不炸');
  localStorage.removeItem('sxy_sync_status_real');
});
