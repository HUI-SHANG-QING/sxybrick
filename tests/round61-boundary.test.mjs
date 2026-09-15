// round61 回归：核心统计对「畸形数据」的健壮性（边界条件 + 数据对象建模）
//
// 三个实证缺陷（用 fake-indexeddb 复现过）：
//  ① rating 不在域 {0,1,2}：`agg.sum += r.rating` →
//     · 缺字段/字符串 → NaN（**一条坏行污染全局 avgMastery**，下游 `NaN || 0` 又静默退化成"掌握度 0"）
//     · 越界值 → 掌握度 250% / -50%
//     · 还只进 correct/stable 的分母不进分子 → 静默压低正确率
//  ② reviewedAt 非有限数字 → `new Date(NaN)` 产 `"NaN-NaN-NaN"` 热力图脏桶、
//     `hourly[NaN]++` 把小时分布写成 NaN 属性。
//  ③ 悬空复习行（cardId 指向已删卡）→ 覆盖率分子 > 分母 → coverage = 200% 这种越界值。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/repo-core.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 15, 4, 0, 0); // 固定基准时刻，避免跑测试时的时钟漂移
const mkCard = (i, extra = {}) => ({
  id: 'c' + i, front: 'F' + i, back: 'B', subject: 's' + (i % 2),
  createdAt: NOW - 30 * DAY, updatedAt: NOW, dueAt: NOW + DAY, ...extra,
});
const mkReview = (i, extra = {}) => ({
  id: 'r' + i, cardId: 'c' + (i % 2), reviewedAt: NOW - DAY, rating: 2, type: 'srs', ...extra,
});
function assertSane(st, label) {
  for (const [k, v] of [['avgMastery', st.avgMastery], ['ability.correct', st.ability.correct],
    ['ability.stable', st.ability.stable], ['ability.coverage', st.ability.coverage]]) {
    assert.ok(Number.isFinite(v), `${label}：${k} 必须有限，实际 ${v}`);
    assert.ok(v >= 0 && v <= 100, `${label}：${k} 必须落在 0~100，实际 ${v}`);
  }
  for (const m of st.mastery) {
    assert.ok(Number.isFinite(m.mastery), `${label}：科目 ${m.subject} 掌握度必须有限，实际 ${m.mastery}`);
    assert.ok(m.mastery >= 0 && m.mastery <= 100, `${label}：科目 ${m.subject} 掌握度越界 = ${m.mastery}`);
  }
  assert.ok((st.hourly || []).every(Number.isFinite), `${label}：hourly 不得含非有限值`);
  assert.ok((st.trend || []).every(t => Number.isFinite(t.count)), `${label}：trend 不得含非有限值`);
  assert.ok(Object.keys(st.heatmap || {}).every(k => !k.includes('NaN')), `${label}：heatmap 不得含 NaN 键`);
}

test('round61 P2①：rating 越界（5 / -1）不得产出 >100% 或负的掌握度', () => {
  const cards = [mkCard(0), mkCard(1), mkCard(2)];
  const reviews = [mkReview(0, { rating: 2 }), mkReview(1, { rating: 5 }), mkReview(2, { rating: -1 })];
  const st = computeStats(cards, reviews, NOW);
  assertSane(st, '越界 rating');
  assert.equal(st.avgMastery, 100, '只有合法的 rating=2 计入 → 掌握度 100');
});

test('round61 P2①：rating 缺失/字符串不得把 avgMastery 污染成 NaN', () => {
  for (const bad of [{ rating: null }, { rating: undefined }, { rating: '2' }, { rating: 'x' }]) {
    const cards = [mkCard(0), mkCard(1)];
    const reviews = [mkReview(0, { rating: 2 }), mkReview(1, { ...bad, id: 'rb' })];
    const st = computeStats(cards, reviews, NOW);
    assertSane(st, `rating=${JSON.stringify(bad.rating)}`);
    assert.equal(st.avgMastery, 100, '坏行被剔除，合法行仍算 100（而不是 NaN / 0）');
  }
});

test('round61 P2①：坏 rating 不得稀释 correct/stable 的分母', () => {
  const cards = [mkCard(0), mkCard(1), mkCard(2)];
  // 2 条合法(全对) + 1 条 rating=5（只进分母会让 correct 掉到 66）
  const reviews = [mkReview(0, { rating: 2 }), mkReview(1, { rating: 2 }), mkReview(2, { rating: 5 })];
  const st = computeStats(cards, reviews, NOW);
  assert.equal(st.ability.correct, 100, '域外行不计入 → 正确率 100（此前被稀释成 67）');
  assert.equal(st.ability.stable, 100, '稳定度同理');
  assert.equal(st.dirtyReviews, 1, '且必须显式汇报脏行数，不静默丢弃');
});

test('round61 P2②：reviewedAt 非有限不得污染热力图 / 小时分布 / 趋势', () => {
  const cards = [mkCard(0), mkCard(1)];
  const reviews = [
    mkReview(0, { rating: 2 }),
    mkReview(1, { reviewedAt: NaN, rating: 2, id: 'rNaN' }),
    mkReview(1, { reviewedAt: undefined, rating: 2, id: 'rUndef' }),
  ];
  const st = computeStats(cards, reviews, NOW);
  assertSane(st, '畸形时间戳');
  assert.equal(st.totalReviews, 1, '畸形 reviewedAt 行被剔除，只留 1 条合法复习');
  assert.equal(st.dirtyReviews, 2, '两条畸形行都要被计数（不静默）');
});

test('round61 P2③：悬空复习（指向已删卡）不得让覆盖率 >100%', () => {
  const cards = [mkCard(0)];
  const reviews = [
    mkReview(0, { rating: 2 }),
    { id: 'ghost', cardId: 'deleted-card', reviewedAt: NOW - DAY, rating: 0, type: 'srs' },
  ];
  const st = computeStats(cards, reviews, NOW);
  assert.equal(st.ability.coverage, 100, '分子只认"仍存在的卡" → 覆盖率 100（此前 200%）');
  assertSane(st, '悬空复习');
});

test('round61：正常数据结果不得被本次过滤改变（防误伤）', () => {
  const cards = [mkCard(0), mkCard(1)];
  const reviews = [
    mkReview(0, { rating: 2 }), mkReview(1, { rating: 0 }),
    mkReview(0, { rating: 1 }), { id: 'q1', cardId: 'c0', reviewedAt: NOW - DAY, rating: 0, type: 'quick' },
  ];
  const st = computeStats(cards, reviews, NOW);
  assert.equal(st.totalReviews, 3, 'quick 行仍被排除，其余 3 条计入');
  assert.equal(st.dirtyReviews, 0, '⚠️ quick 行是合法业务数据，绝不能算作"脏数据"');
  assert.equal(st.ability.correct, 33, '3 条中 1 条 rating=2 → 33%');
  assert.equal(st.ability.stable, 67, '3 条中 1 条 rating=0 → 稳定度 67%');
  assert.equal(st.ability.coverage, 100, '两张卡都复习过 → 100%');
  assert.deepEqual(st.ratingDist, { 0: 1, 1: 1, 2: 1 });
  assertSane(st, '正常数据');
});
