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

test('遗忘回炉：rating=0 间隔极短，同一天反复到期直到 maxIters', () => {
  const card = mkCard({ dueAt: START, fsrs: null }); // 新卡、今天到期
  const r = forecastDue([card], 30, { now: NOW, rating: 0, maxIters: 10 });
  assert.equal(r.byDay[0].count, 10);
  assert.equal(r.totalDue, 10);
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
