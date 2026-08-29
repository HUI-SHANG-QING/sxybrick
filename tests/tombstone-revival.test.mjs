// 墓碑复活判定测试（P0 回归：漏 reviewedAt 导致跨设备复习进度被误删）
//
// 历史缺陷：applyTombstones 用 `r.updatedAt ?? r.createdAt ?? 0` 判定行是否「比墓碑新」，
// 而卡片合并侧（mergeCardPair）的 SRS 字段是按 reviewedAt 取的，两侧口径不一致。
// 竞态：
//   A 机删卡（deletedAt=100，卡片 updatedAt 仍为 50）
//   B 机此前复习过（reviewedAt=200，updatedAt 仍为 50）
//   → 复活判定 50 <= 100 → 判为「已删除」→ B 机的卡片连同复习进度一起被抹掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTombstones, livenessTs, mergeCardPair, mergeRows } from '../src/sync-manifest.js';

const card = (id, extra = {}) => ({
  id, front: 'Q' + id, back: 'A' + id, updatedAt: 50, createdAt: 10, ...extra,
});

// ---------- livenessTs ----------

test('livenessTs: 取所有活跃时间字段的最大值', () => {
  assert.equal(livenessTs({ updatedAt: 10, reviewedAt: 200 }), 200, 'reviewedAt 必须纳入');
  assert.equal(livenessTs({ updatedAt: 300, reviewedAt: 200 }), 300);
  assert.equal(livenessTs({ updatedAt: 10, wrongReasonAt: 150 }), 150, 'wrongReasonAt 必须纳入');
  assert.equal(livenessTs({ updatedAt: 10, selfExplainAt: 90 }), 90, 'selfExplainAt 必须纳入');
  assert.equal(livenessTs({ createdAt: 77 }), 77);
  assert.equal(livenessTs({}), 0);
  assert.equal(livenessTs(null), 0);
});

test('livenessTs: 非法值（NaN/字符串/负数）被忽略', () => {
  assert.equal(livenessTs({ updatedAt: NaN, reviewedAt: 50 }), 50);
  assert.equal(livenessTs({ updatedAt: '123', reviewedAt: 50 }), 50, '字符串时间戳不参与比较');
  assert.equal(livenessTs({ updatedAt: -5 }), 0);
  assert.equal(livenessTs({ updatedAt: Infinity, reviewedAt: 1 }), 1, 'Infinity 被忽略');
});

// ---------- 核心回归 ----------

test('P0 回归: A 删卡 / B 复习 → 卡片必须复活，复习进度不得丢失', () => {
  // B 机的卡：updatedAt 仍是 50（复习不 bump updatedAt），但 reviewedAt 已推进到 200
  const rows = [card('c1', { updatedAt: 50, reviewedAt: 200, ease: 2.5, dueAt: 999 })];
  const tombs = [{ id: 'c1', kind: 'card', deletedAt: 100 }];
  const res = applyTombstones(rows, tombs, 'card');

  assert.equal(res.rows.length, 1, '卡片必须保留（B 机的复习比删除更新）');
  assert.equal(res.rows[0].id, 'c1');
  assert.equal(res.rows[0].reviewedAt, 200, '复习进度必须保留');
  assert.deepEqual(res.stale, ['c1'], '墓碑应被标记为 stale（待清除）');
  assert.deepEqual(res.removed, [], '不应删除任何行');
});

test('P0 回归: 确属「删除后无活动」的卡片仍然被删除', () => {
  const rows = [card('c1', { updatedAt: 50, reviewedAt: 40 })];
  const tombs = [{ id: 'c1', kind: 'card', deletedAt: 100 }];
  const res = applyTombstones(rows, tombs, 'card');
  assert.equal(res.rows.length, 0, '删除后无任何活动应正常删除');
  assert.deepEqual(res.removed, ['c1']);
  assert.deepEqual(res.stale, []);
});

test('P0 回归: 错因（wrongReasonAt）晚于删除 → 复活', () => {
  const rows = [card('c2', { updatedAt: 50, wrongReasonAt: 150, wrongReason: '混淆概念' })];
  const tombs = [{ id: 'c2', kind: 'card', deletedAt: 100 }];
  const res = applyTombstones(rows, tombs, 'card');
  assert.equal(res.rows.length, 1, '错因更新晚于删除，应复活');
  assert.equal(res.rows[0].wrongReason, '混淆概念');
});

test('P0 回归: 复习记录（review）的自我解释晚于删除 → 复活', () => {
  const rows = [{ id: 'r1', cardId: 'c1', rating: 1, reviewedAt: 30, selfExplainAt: 180, selfExplanation: '我错在…' }];
  const tombs = [{ id: 'r1', kind: 'review', deletedAt: 100 }];
  const res = applyTombstones(rows, tombs, 'review');
  assert.equal(res.rows.length, 1, '自我解释晚于删除，应复活');
  assert.equal(res.rows[0].selfExplanation, '我错在…');
});

test('P0 回归: 边界——活跃时间恰好等于 deletedAt 视为已删除（<= 语义不变）', () => {
  const rows = [card('c1', { updatedAt: 100 })];
  const tombs = [{ id: 'c1', kind: 'card', deletedAt: 100 }];
  const res = applyTombstones(rows, tombs, 'card');
  assert.equal(res.rows.length, 0, '等于 deletedAt 视为已删除');
});

test('P0 回归: 快 1 毫秒也算复活（严格 >）', () => {
  const rows = [card('c1', { updatedAt: 100, reviewedAt: 101 })];
  const tombs = [{ id: 'c1', kind: 'card', deletedAt: 100 }];
  assert.equal(applyTombstones(rows, tombs, 'card').rows.length, 1);
});

test('复活判定口径与合并侧一致：合并后的 SRS 来自 B，则 B 的时间戳也用于复活判定', () => {
  // A：删除方（内容旧但删得晚）；B：复习方（reviewedAt 新）
  const a = card('c1', { updatedAt: 50, reviewedAt: 30, ease: 2.0, fsrs: { s: 1 } });
  const b = card('c1', { updatedAt: 50, reviewedAt: 200, ease: 2.6, fsrs: { s: 9 } });
  const merged = mergeCardPair(a, b);
  // 合并侧按 reviewedAt 取 B 的 SRS
  assert.equal(merged.ease, 2.6, 'SRS 应取 reviewedAt 较新的 B');
  // 复活判定必须能看见同一个 reviewedAt，否则刚合并来的 SRS 会被墓碑抹掉
  assert.ok(livenessTs(merged) > 100, '合并结果的最新活跃时间应 > deletedAt');
  const res = applyTombstones([merged], [{ id: 'c1', kind: 'card', deletedAt: 100 }], 'card');
  assert.equal(res.rows.length, 1, '合并后的卡片不应被墓碑删除');
  assert.equal(res.rows[0].ease, 2.6, 'B 的复习进度必须存活');
});

test('端到端：两台设备完整流程（A 删 + B 复习 → 同步后 B 的复习进度存活）', () => {
  // A 机：本地卡片（已删，留墓碑）
  const aCards = [];
  const aTombs = [{ id: 'c1', kind: 'card', deletedAt: 100 }];
  // B 机：复习过，准备上传
  const bCards = [card('c1', { updatedAt: 50, reviewedAt: 200, ease: 2.7, intervalDays: 12, dueAt: 999 })];
  const bTombs = [];

  // 1) 合并两侧数据（中枢行为）
  const mergedCards = mergeRows(aCards, bCards, 'card');
  const mergedTombs = [...aTombs, ...bTombs];
  // 2) 应用墓碑
  const res = applyTombstones(mergedCards, mergedTombs, 'card');

  assert.equal(res.rows.length, 1, 'B 的卡片必须存活');
  assert.equal(res.rows[0].ease, 2.7, 'B 的复习进度必须存活');
  assert.equal(res.rows[0].intervalDays, 12);
});

test('kind 隔离不受影响', () => {
  const rows = [card('c1', { reviewedAt: 200 })];
  // 墓碑是 graphEdge 类型，不应作用于卡片
  const res = applyTombstones(rows, [{ id: 'c1', kind: 'graphEdge', deletedAt: 100 }], 'card');
  assert.equal(res.rows.length, 1, '不同 kind 的墓碑不应误删');
});
