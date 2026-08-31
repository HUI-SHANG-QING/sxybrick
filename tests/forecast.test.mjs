// tests/forecast.test.mjs —— Due Forecast 纯函数单测（Node 可测，不依赖浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastDue, noFuzzWeights, startOfDay, isoDate } from '../src/algorithms/forecast.js';
import { DEFAULT_WEIGHTS } from '../src/fsrs.js';

const DAY = 86400000;
const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime(); // 2026-01-05 中午（本地时区）
const START = startOfDay(NOW); // 2026-01-05 00:00 本地

function mkCard(over = {}) {
  return {
    id: over.id ?? 'c1', front: 'f', back: 'b', subject: 's',
    dueAt: over.dueAt, createdAt: over.createdAt ?? 0,
    fsrs: over.fsrs ?? null, ease: 2.5, level: 2, intervalDays: 5,
    ...over,
  };
}

// 大稳定度卡：复习后间隔被 clamp 到 365 天，只会到期一次
const longCard = (id, dueAt) => mkCard({ id, dueAt, fsrs: { s: 100, d: 5, reps: 3, last: START - 10 * DAY } });

test('空表：全零且不抛错', () => {
  const r = forecastDue([], 7, { now: NOW });
  assert.equal(r.totalDue, 0);
  assert.equal(r.backlog, 0);
  assert.equal(r.byDay.length, 7);
  assert.ok(r.byDay.every(b => b.count === 0));
  assert.equal(r.peak.count, 0);
  assert.equal(r.avgPerDay, 0);
});

test('单卡未来第 5 天到期：只在第 5 天计数一次', () => {
  const r = forecastDue([longCard('a', START + 5 * DAY)], 30, { now: NOW });
  assert.equal(r.byDay[5].count, 1);
  assert.equal(r.totalDue, 1);
  assert.equal(r.backlog, 0);
});

test('逾期卡：计入 backlog，并推到今天（第 0 天）复习', () => {
  const r = forecastDue([longCard('a', START - 2 * DAY)], 30, { now: NOW });
  assert.equal(r.backlog, 1);
  assert.equal(r.byDay[0].count, 1);
  assert.equal(r.totalDue, 1);
});

test('遗忘回炉：rating=0 只计「当天是否要复习」，不按重学次数重复计数', () => {
  // ⚠️ 历史缺陷（2026-08-30 修复）：again 的间隔是 0.01 天（14.4 分钟），
  //   reviewAt 恒等于 start、idx 恒等于 0，1 张卡在 day0 被反复计数到 maxIters 次
  //   → 单卡预测出 totalDue=200 / peak=100，容量规划完全失真。
  //   语义上「今天这张卡要复习吗」才是到期量，同一天重学 10 次仍只是 1 张卡。
  const card = mkCard({ dueAt: START, fsrs: null }); // 新卡、今天到期
  const r10 = forecastDue([card], 30, { now: NOW, rating: 0, maxIters: 10 });
  const r200 = forecastDue([card], 30, { now: NOW, rating: 0, maxIters: 200 });
  assert.equal(r10.byDay[0].count, 1, '同一天同一张卡只计一次');
  assert.equal(r200.byDay[0].count, 1, '迭代次数翻倍，当日计数也不应增长（证明是在去重而非累加）');
  assert.equal(r10.peak.count, 1, '峰值不应被重学次数刷高');
  assert.ok(r200.totalDue >= r10.totalDue, '迭代预算更多应能看得更远，不能更少');
});

test('多卡同天到期：每张卡各计一次（不互相抵消）', () => {
  const cards = ['a', 'b', 'c'].map(id => mkCard({ id, dueAt: START, fsrs: null }));
  const r = forecastDue(cards, 30, { now: NOW, rating: 0, maxIters: 10 });
  assert.equal(r.byDay[0].count, 3, '3 张卡各计一次');
  // 注意：totalDue 不再恒等于 3 —— 评分为 0 的卡第二天仍会到期，
  // 旧断言把它们写成「永远不再到期」，那是迭代预算在前两天被耗尽造成的假象。
  assert.ok(r.totalDue >= 3, `总额应至少覆盖首日 3 张，实际 ${r.totalDue}`);
});

test('确定性：无抖动权重下两次调用结果一致', () => {
  const cards = [longCard('a', START + 3 * DAY), mkCard({ id: 'b', dueAt: START + 4 * DAY, fsrs: { s: 50, d: 4, reps: 2, last: START - 5 * DAY } })];
  const a = forecastDue(cards, 30, { now: NOW });
  const b = forecastDue(cards, 30, { now: NOW });
  assert.deepEqual(a, b);
});

test('峰值与日均：多卡分布验证 peak/avgPerDay', () => {
  const cards = [
    longCard('a', START + 1 * DAY),
    longCard('b', START + 1 * DAY),
    longCard('c', START + 2 * DAY),
  ];
  const r = forecastDue(cards, 30, { now: NOW });
  assert.equal(r.byDay[1].count, 2);
  assert.equal(r.byDay[2].count, 1);
  assert.equal(r.totalDue, 3);
  assert.equal(r.peak.count, 2);
  assert.equal(r.peak.date, r.byDay[1].date);
  assert.equal(r.avgPerDay, 0.1); // 3 / 30 = 0.1
});

test('noFuzzWeights：w[17]=0 且不影响其他权重', () => {
  const w = noFuzzWeights();
  assert.equal(w[17], 0);
  assert.equal(w[0], DEFAULT_WEIGHTS[0]);
  assert.equal(w.length, DEFAULT_WEIGHTS.length);
});

test('startOfDay/isoDate 工具：零点对齐与日期格式', () => {
  const s = startOfDay(NOW);
  const d = new Date(s);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.match(isoDate(NOW), /^\d{4}-\d{2}-\d{2}$/);
});

test('rating=0（遗忘回炉洪峰）：预测必须覆盖整个窗口，不能只算头几天', () => {
  // ⚠️ 2026-08-31 修正：again/hard 的间隔是亚日级（约 14 分钟），
  //   旧实现任由同一天内的重学无限迭代，maxIters=200 只够走约 48 小时 ——
  //   于是 rating=0（文档里正是用来模拟「遗忘回炉洪峰」的场景）跑 30 天预测
  //   只有前 3 天有数、后 27 天恒为 0，洪峰场景完全失效。
  const NOW = new Date(2026, 7, 26, 10, 0, 0).getTime();
  const cards = Array.from({ length: 60 }, (_, i) => ({
    id: 'c' + i, createdAt: NOW - 30 * 86400000, dueAt: NOW - (i % 20) * 86400000,
    level: 1, ease: 2.5, intervalDays: 2,
    fsrs: { s: 5, d: 5, reps: 5, lapses: 1, lastReviewedAt: NOW - 86400000, state: 'review' },
  }));
  const r = forecastDue(cards, 30, { now: NOW, rating: 0 });
  const covered = r.byDay.filter(d => d.count > 0).length;
  assert.ok(covered >= 20, `rating=0 应覆盖大部分窗口，实际只有 ${covered}/30 天有数据`);
  // 洪峰场景：几乎每张卡每天都到期
  assert.ok(r.byDay[0].count >= 50, `首日应接近全量，实际 ${r.byDay[0].count}`);
  assert.ok(r.totalDue > covered * 40, `总量应显著高于"每卡只复习 1~2 次"，实际 ${r.totalDue}`);
  // 同一天重复重学不应把计数刷成天文数字（同一卡同一天只计一次）
  for (const d of r.byDay) assert.ok(d.count <= cards.length, `单日数量不应超过卡数：${d.count}`);
});

test('rating=2（正常推进）不受当天重学上限影响：间隔按天增长', () => {
  const NOW = new Date(2026, 7, 26, 10, 0, 0).getTime();
  const cards = Array.from({ length: 30 }, (_, i) => ({
    id: 'c' + i, createdAt: NOW - 10 * 86400000, dueAt: NOW,
    level: 1, ease: 2.5, intervalDays: 2,
    fsrs: { s: 5, d: 5, reps: 5, lapses: 0, lastReviewedAt: NOW, state: 'review' },
  }));
  const r = forecastDue(cards, 30, { now: NOW, rating: 2 });
  assert.equal(r.byDay[0].count, 30, '首日全部到期');
  // 正常评分间隔是天级，不会触发当天重学上限，后续应有间隔而非每天到期
  assert.ok(r.byDay[1].count < 30, `次日不应仍是全量，实际 ${r.byDay[1].count}`);
  assert.ok(r.totalDue < 30 * 30, '总量不应退化成"每天全量"');
});
