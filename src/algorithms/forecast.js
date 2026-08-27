// Due Forecast（到期洪峰预测）
// 预测未来 N 天每天的到期卡量，含「复习后再次到期」的推进模拟。
// 纯函数、确定性：默认关闭 nextInterval 里的 Math.random 抖动（w[17]=0），Node 可直接单测。
// 与 FSRS 调度共用一个 schedule，保证预测口径与实际复习一致。

import { schedule, DEFAULT_WEIGHTS, DEFAULT_DESIRED_RETENTION } from '../fsrs.js';

const DAY = 24 * 60 * 60 * 1000;

// 消除抖动权重：w[17] = 0 → nextInterval 的 fuzz 恒为 1，预测结果确定（均值口径）
export function noFuzzWeights(w = DEFAULT_WEIGHTS) {
  const out = w.slice();
  out[17] = 0;
  return out;
}

// 本地时间零点（毫秒时间戳）
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 本地日期 YYYY-MM-DD
export function isoDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 预测未来 days 天每日到期卡量。
 * @param {Array} cards  卡片数组（需含 dueAt / createdAt / fsrs 字段）
 * @param {number} days  预测窗口天数（默认 30）
 * @param {object} opts
 *   now:              参考时间戳（默认 Date.now()）
 *   weights:          FSRS 权重（默认 noFuzzWeights()，无抖动）
 *   desiredRetention: 目标保持率（默认 0.9）
 *   rating:           模拟复习评分 0/1/2（默认 2=记住；传 0 可模拟"遗忘回炉"洪峰）
 *   maxIters:         单卡模拟上限（默认 200，防极端短间隔死循环）
 * @returns {{
 *   days, start, byDay: [{date, count}],
 *   totalDue, backlog, peak: {date, count}, avgPerDay
 * }}
 */
export function forecastDue(cards, days = 30, opts = {}) {
  const n = Math.max(1, Math.floor(days));
  const now = opts.now ?? Date.now();
  const start = startOfDay(now);
  const end = start + n * DAY;
  const weights = opts.weights ?? noFuzzWeights();
  const desiredR = opts.desiredRetention ?? DEFAULT_DESIRED_RETENTION;
  const rating = opts.rating ?? 2;
  const maxIters = opts.maxIters ?? 200;

  const byDay = new Array(n).fill(0);
  let total = 0;
  let backlog = 0;

  for (const card of cards || []) {
    if (!card) continue;
    const firstDue = card.dueAt ?? card.createdAt ?? now;
    if (firstDue < start) backlog++; // 当前已逾期、待补的卡

    let due = firstDue;
    let state = card; // 传给 schedule 的「当前卡片状态」（含 fsrs）
    let guard = 0;
    while (guard++ < maxIters) {
      if (due >= end) break; // 已超出预测窗口
      // 复习时刻：逾期卡今天补（reviewAt=start），未来卡按时（reviewAt=due）
      const reviewAt = Math.max(due, start);
      const idx = Math.floor((reviewAt - start) / DAY);
      if (idx >= 0 && idx < n) { byDay[idx]++; total++; }
      // 模拟复习推进
      const next = schedule(state, rating, { now: reviewAt, weights, desiredRetention: desiredR });
      due = next.dueAt;
      state = { ...state, fsrs: next.fsrs, dueAt: next.dueAt, level: next.level, ease: next.ease, intervalDays: next.intervalDays };
    }
  }

  const byDayOut = byDay.map((count, i) => ({ date: isoDate(start + i * DAY), count }));

  let peak = { date: '', count: 0 };
  for (const b of byDayOut) if (b.count > peak.count) peak = { date: b.date, count: b.count };

  return {
    days: n,
    start,
    byDay: byDayOut,
    totalDue: total,
    backlog,
    peak,
    avgPerDay: Math.round((total / n) * 10) / 10,
  };
}
