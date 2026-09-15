// tests/sync-domain.test.mjs —— round64：导入侧行级域校验
//   ① 单元：sanitizeIncomingRow 的清洗/规范化/不丢行/不动合法值
//   ② 接线：importBackup 真的调到了（脏字段入库前被洗净，行数不变，stats 有汇报）
// 背景：round61 只在读取侧（computeStats）加了护栏，脏行仍会入库并随同步扩散到所有设备。
//   本轮把校验挪到入口，hub 合并复用同一函数，两端一致。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, setDbInstance, getDb } from '../src/db.js';
import { importBackup, getEffectiveSyncTables } from '../src/sync.js';
import {
  sanitizeIncomingRow, sanitizeIncomingTable, normalizeTs,
  TIMESTAMP_FIELDS, FIELD_DOMAINS,
} from '../src/sync-manifest.js';

after(async () => { try { await db.close(); } catch {} });

async function resetAll() {
  setDbInstance('real');
  const d = getDb();
  for (const t of getEffectiveSyncTables()) {
    try { await d[t.table].clear(); } catch { /* 表不存在则跳过 */ }
  }
  await d.tombstones.clear();
  await d.snapshots.clear();
  await d.meta.clear();
  await d.images.clear();
}

const mkCard = (id) => ({
  id, front: `Q-${id}`, back: `A-${id}`, subject: '计组', type: 'basic', tags: [],
  ease: 2.5, level: 0, intervalDays: 0, dueAt: 1000, reviewedAt: 0,
  createdAt: 1, updatedAt: 1,
});

// ───────────────────────── 单元：sanitizeIncomingRow ─────────────────────────

test('域校验：rating 越界 / 非数字 → 置 null', () => {
  const row = { id: 'r1', rating: 7 };
  assert.equal(sanitizeIncomingRow('reviews', row), 1);
  assert.equal(row.rating, null);
  const row2 = { id: 'r2', rating: '2' };
  sanitizeIncomingRow('reviews', row2);
  assert.equal(row2.rating, null, '字符串 "2" 不是合法评分（不能靠 Number() 猜）');
});

test('域校验：合法评分必须原样保留，尤其 rating=0（falsy 陷阱）', () => {
  for (const v of [0, 1, 2]) {
    const row = { id: 'r', rating: v };
    assert.equal(sanitizeIncomingRow('reviews', row), 0, `rating=${v} 不应被修正`);
    assert.equal(row.rating, v);
  }
});

test('域校验：字段缺失不被"补齐"（不凭空新增字段）', () => {
  const row = { id: 'r1' };
  assert.equal(sanitizeIncomingRow('reviews', row), 0);
  assert.ok(!('rating' in row));
  assert.ok(!('updatedAt' in row));
});

test('域校验：type 非字符串 → null；字符串原样', () => {
  const a = { id: 'r', type: 1 };
  sanitizeIncomingRow('reviews', a);
  assert.equal(a.type, null);
  const b = { id: 'r', type: 'quick' };
  assert.equal(sanitizeIncomingRow('reviews', b), 0);
  assert.equal(b.type, 'quick');
});

test('域校验：时间戳字符串数字 → 规范化为 number（可逆）', () => {
  const row = { id: 'r', updatedAt: '1757894400000', reviewedAt: ' 2000 ' };
  assert.equal(sanitizeIncomingRow('reviews', row), 2);
  assert.equal(row.updatedAt, 1757894400000);
  assert.equal(typeof row.updatedAt, 'number');
  assert.equal(row.reviewedAt, 2000, '两端空白应被容忍');
});

test('域校验：不可解析的时间戳 → null（避免字符串比较恒 false 的"僵尸行"）', () => {
  for (const bad of ['2026-09-15', 'abc', {}, true, []]) {
    const row = { id: 'r', dueAt: bad };
    assert.equal(sanitizeIncomingRow('reviews', row), 1, `${JSON.stringify(bad)} 应被修正`);
    assert.equal(row.dueAt, null);
  }
});

test('域校验：空值（null / undefined）原样放行，不计数', () => {
  const row = { id: 'r', updatedAt: null, dueAt: undefined };
  assert.equal(sanitizeIncomingRow('reviews', row), 0);
  assert.equal(row.updatedAt, null);
});

test('normalizeTs：NaN / Infinity 归 null，合法数字原样', () => {
  assert.equal(normalizeTs(NaN), null);
  assert.equal(normalizeTs(Infinity), null);
  assert.equal(normalizeTs(-1), -1);
  assert.equal(normalizeTs(0), 0);
});

test('域校验：非对象行 / 数组行安全跳过（不抛错）', () => {
  assert.equal(sanitizeIncomingRow('reviews', null), 0);
  assert.equal(sanitizeIncomingRow('reviews', undefined), 0);
  assert.equal(sanitizeIncomingRow('reviews', 'x'), 0);
  assert.equal(sanitizeIncomingRow('reviews', []), 0);
});

test('域校验：sanitizeIncomingTable 累计修正数，非数组输入返回 0', () => {
  const rows = [{ id: 'a', rating: 9 }, { id: 'b', rating: 1 }, { id: 'c', updatedAt: 'abc' }];
  assert.equal(sanitizeIncomingTable('reviews', rows), 2);
  assert.equal(sanitizeIncomingTable('reviews', undefined), 0);
  assert.equal(sanitizeIncomingTable('reviews', {}), 0);
});

test('域校验：登记表自身的结构不变量', () => {
  assert.ok(TIMESTAMP_FIELDS.includes('updatedAt'), '通用水位必须在列');
  assert.ok(TIMESTAMP_FIELDS.includes('reviewedAt'), '复习时间必须在列');
  assert.ok(Object.isFrozen(TIMESTAMP_FIELDS));
  assert.equal(typeof FIELD_DOMAINS.reviews.rating, 'function');
});

test('域校验：dailyTasks 的脏 scheduledHour / estimatedMinutes → null', () => {
  // NaN / 字符串 / 越界 —— 展示侧 `sh < 6 || sh > 23` 对 NaN 恒 false，只能靠这里拦
  for (const bad of [NaN, '9:00', 25, -1, Infinity, {}]) {
    const row = { id: 't', scheduledHour: bad };
    assert.equal(sanitizeIncomingRow('dailyTasks', row), 1, `scheduledHour=${String(bad)} 应被修正`);
    assert.equal(row.scheduledHour, null);
  }
  const dur = { id: 't', estimatedMinutes: 'abc' };
  assert.equal(sanitizeIncomingRow('dailyTasks', dur), 1);
  assert.equal(dur.estimatedMinutes, null);
});

test('域校验：dailyTasks 的合法值原样保留（含 0 点 / 0 分钟边界）', () => {
  const row = { id: 't', scheduledHour: 0, estimatedMinutes: 60 };
  assert.equal(sanitizeIncomingRow('dailyTasks', row), 0);
  assert.equal(row.scheduledHour, 0, '0 点是合法值（falsy 陷阱）');
  assert.equal(row.estimatedMinutes, 60);
  const edge = { id: 't', scheduledHour: 23, estimatedMinutes: 0 };
  assert.equal(sanitizeIncomingRow('dailyTasks', edge), 0);
  assert.equal(edge.scheduledHour, 23);
  assert.equal(edge.estimatedMinutes, 0);
});

// ───────────────────────── 接线：importBackup 真的调用到了 ─────────────────────────

test('importBackup：脏 rating 被洗净、行数不变、stats 有汇报', async () => {
  await resetAll();
  const backup = {
    app: 'sxybrick', version: 10,
    cards: [mkCard('c1')],
    reviews: [
      { id: 'r1', cardId: 'c1', rating: 1, type: 'basic', reviewedAt: 1000 },
      { id: 'r2', cardId: 'c1', rating: 7, type: 'basic', reviewedAt: 2000 },   // 越界
      { id: 'r3', cardId: 'c1', rating: '2', type: 'basic', reviewedAt: 3000 }, // 字符串
      { id: 'r4', cardId: 'c1', rating: 0, type: 'basic', reviewedAt: 4000 },   // 合法 0
    ],
    tombstones: [],
  };
  const stats = await importBackup(backup, { skipSnapshot: true });

  const rows = await db.reviews.toArray();
  assert.equal(rows.length, 4, '行数必须不变（绝不丢行）');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.r1.rating, 1);
  assert.equal(byId.r2.rating, null, '越界 7 → null');
  assert.equal(byId.r3.rating, null, '字符串 "2" → null');
  assert.equal(byId.r4.rating, 0, '合法 0 必须保留');

  assert.ok(stats.sanitized, 'stats.sanitized 应存在');
  assert.equal(stats.sanitized.tables.reviews, 2, '应汇报 reviews 修正 2 个字段');
});

test('importBackup：乱码时间戳被规范化/清空，合法数字不受影响', async () => {
  await resetAll();
  const backup = {
    app: 'sxybrick', version: 10,
    cards: [mkCard('c1')],
    reviews: [
      { id: 'r1', cardId: 'c1', rating: 1, type: 'basic', reviewedAt: '1757894400000' },
      { id: 'r2', cardId: 'c1', rating: 1, type: 'basic', reviewedAt: '2026-09-15' },
      { id: 'r3', cardId: 'c1', rating: 1, type: 'basic', reviewedAt: 5000 },
    ],
    tombstones: [],
  };
  await importBackup(backup, { skipSnapshot: true });

  const rows = await db.reviews.toArray();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.r1.reviewedAt, 1757894400000, '数字字符串 → number');
  assert.equal(typeof byId.r1.reviewedAt, 'number');
  assert.equal(byId.r2.reviewedAt, null, '日期字符串 → null（避免僵尸行）');
  assert.equal(byId.r3.reviewedAt, 5000, '合法数字原样');
});

test('importBackup：全干净包不产生 sanitized 键（不虚报）', async () => {
  await resetAll();
  const backup = {
    app: 'sxybrick', version: 10,
    cards: [mkCard('c1')],
    reviews: [{ id: 'r1', cardId: 'c1', rating: 1, type: 'basic', reviewedAt: 1000 }],
    tombstones: [],
  };
  const stats = await importBackup(backup, { skipSnapshot: true });
  assert.equal(stats.sanitized, undefined, '干净包不应出现 sanitized 字段');
});

// ───────────────────────── 中枢接线（防脏行经 hub 回流） ─────────────────────────

test('中枢 hub 的合并路径同样接入域校验', () => {
  // 只在前端洗净是不够的：hub-data.json 若驻留脏行，每轮 GET 都会把它回灌给所有设备，
  // 前端那层修复等于白做。这里锁定「两端同口径」不被后续误删。
  const src = readFileSync(new URL('../sync-hub/hub.js', import.meta.url), 'utf8');
  const head = src.split('\n').slice(0, 40).join('\n');
  assert.ok(/\bsanitizeIncomingRow\b/.test(head), 'hub.js 应 import sanitizeIncomingRow');
  const calls = (src.match(/sanitizeIncomingRow\(t\.table, r\)/g) || []).length;
  assert.ok(calls >= 2, `hub.js 应对入站行与中枢现存行都净化（实际 ${calls} 处，少一处即脏行回流）`);
});
