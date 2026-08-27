// tests/calibration.test.mjs —— 校准回测纯函数层单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillCardCalibration,
  calibrationBuckets,
  calibrationStats,
  computeCalibration,
} from '../src/algorithms/calibration.js';
import { retrievability, initStability } from '../src/fsrs.js';

const DAY = 86400000;
const T0 = 1700000000000;

test('backfill：首条复习无先验状态 predR=null，后续有条目且 simulated 标记', () => {
  const rows = backfillCardCalibration([
    { reviewedAt: T0, rating: 2 },
    { reviewedAt: T0 + DAY, rating: 2 },
    { reviewedAt: T0 + DAY + 10 * DAY, rating: 0 },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].predR, null);
  for (const r of rows.slice(1)) {
    assert.ok(typeof r.predR === 'number' && r.predR > 0 && r.predR < 1);
    assert.equal(r.simulated, true);
  }
  // 间隔更长 → 预测 R 更低（单调性）
  assert.ok(rows[2].predR < rows[1].predR);
});

test('backfill：落盘 predR 优先于模拟值，乱序输入按时间排序', () => {
  const rows = backfillCardCalibration([
    { reviewedAt: T0 + 2 * DAY, rating: 2, predR: 0.42 },
    { reviewedAt: T0, rating: 2 },
    { reviewedAt: T0 + DAY, rating: 1 },
  ]);
  assert.equal(rows[0].reviewedAt, T0);
  assert.equal(rows[2].predR, 0.42);
  assert.equal(rows[2].simulated, false);
});

test('backfill：第二次预测可手工复算（R = (1+t/9S)^-1）', () => {
  const rows = backfillCardCalibration([
    { reviewedAt: T0, rating: 2 },
    { reviewedAt: T0 + 5 * DAY, rating: 2 },
  ]);
  const expected = retrievability(initStability(3), 5);
  assert.ok(Math.abs(rows[1].predR - expected) < 1e-9);
});

test('buckets：分桶聚合 / 实际与严格正确率 / delta', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ predR: 0.55, rating: 2 }); // 全对
  const buckets = calibrationBuckets(rows);
  assert.equal(buckets.length, 1);
  const b = buckets[0];
  assert.equal(b.lo, 0.5); assert.equal(b.hi, 0.6);
  assert.equal(b.n, 10);
  assert.equal(b.actualRate, 1); assert.equal(b.strictRate, 1);
  assert.ok(Math.abs(b.delta - 0.45) < 1e-9);

  // 混合：5 对 5 错
  const rows2 = [];
  for (let i = 0; i < 5; i++) rows2.push({ predR: 0.75, rating: 1 });
  for (let i = 0; i < 5; i++) rows2.push({ predR: 0.75, rating: 0 });
  const b2 = calibrationBuckets(rows2)[0];
  assert.equal(b2.actualRate, 0.5);
  assert.equal(b2.strictRate, 0); // rating 1 不算严格记住
});

test('buckets：边界与非法 predR 过滤、非法宽度回退 0.1', () => {
  const buckets = calibrationBuckets([
    { predR: 1.0, rating: 2 },   // 桶 idx 夹取到最后一桶
    { predR: 0.0, rating: 0 },   // 第一桶
    { predR: 'abc', rating: 2 }, // 非法 → 跳过
    { rating: 2 },               // 无 predR → 跳过
  ]);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].lo, 0);
  assert.equal(buckets[1].hi, 1);
  // 宽度非法 → 回退 0.1（仍是 10 桶制）
  assert.equal(calibrationBuckets([{ predR: 0.55, rating: 2 }], 2)[0].lo, 0.5);
});

test('stats：完美校准 → bias=0 / ece=0，Brier 按公式', () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push({ predR: 0.8, rating: 2 });
  for (let i = 0; i < 20; i++) rows.push({ predR: 0.8, rating: 0 });
  const s = calibrationStats(rows);
  assert.equal(s.n, 100);
  assert.ok(Math.abs(s.bias) < 1e-9);
  assert.ok(s.ece < 1e-9);
  // Brier = 0.8*(0.2²) + 0.2*(0.8²) = 0.032 + 0.128 = 0.16
  assert.ok(Math.abs(s.brier - 0.16) < 1e-6);
  assert.equal(s.verdict, '校准良好');
});

test('stats：高估记忆 → 乐观结论 + 建议上调（缩短间隔）', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ predR: 0.95, rating: 0 });
  const s = calibrationStats(rows);
  assert.ok(s.bias > 0.05);
  assert.ok(s.verdict.includes('乐观'));
  assert.ok(s.note.includes('上调'));
});

test('stats：低估记忆 → 悲观结论 + 建议下调（延长间隔）', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ predR: 0.3, rating: 2 });
  const s = calibrationStats(rows);
  assert.ok(s.bias < -0.05);
  assert.ok(s.verdict.includes('悲观'));
  assert.ok(s.note.includes('下调'));
});

test('stats：空样本 → 样本不足且不抛错', () => {
  const s = calibrationStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.verdict, '样本不足');
  assert.equal(s.brier, null);
});

test('computeCalibration：多卡分组 + 无先验首条被排除在桶外', () => {
  const reviews = [
    { cardId: 'a', reviewedAt: T0, rating: 2 },
    { cardId: 'a', reviewedAt: T0 + 2 * DAY, rating: 2 },
    { cardId: 'a', reviewedAt: T0 + 4 * DAY, rating: 0 },
    { cardId: 'b', reviewedAt: T0 + DAY, rating: 1 },           // 首条无预测
    { cardId: 'b', reviewedAt: T0 + 3 * DAY, rating: 2 },
  ];
  const s = computeCalibration(reviews);
  // a 贡献 2 条可回测 + b 贡献 1 条 = 3（两条首卡复习被排除）
  assert.equal(s.n, 3);
  assert.ok(s.buckets.length >= 1);
  assert.ok(s.brier !== null && s.brier >= 0);
});
