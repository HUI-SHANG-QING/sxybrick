// Due Forecast（到期洪峰预测）
// 预测未来 N 天每天的到期卡量，含「复习后再次到期」的推进模拟。
// 纯函数、确定性：默认关闭 nextInterval 里的 Math.random 抖动（w[17]=0），Node 可直接单测。
// 与 FSRS 调度共用一个 schedule，保证预测口径与实际复习一致。

import { schedule, DEFAULT_WEIGHTS, DEFAULT_DESIRED_RETENTION } from '../fsrs.js';

const DAY = 24 * 60 * 60 * 1000;
// 最小有效推进量：下次到期与本次复习间隔不足 1 分钟，视为「当天重学」而非一次新排期，
// 不再继续迭代（否则会退化成在窗口内以 14 分钟为步长空转数百次）。
const MIN_STEP_MS = 60 * 1000;
// 同一天内允许的「当天重学」次数上限（again/hard 的间隔是亚日级，约 14 分钟）。
// 不封顶的后果：单次迭代只推进 14 分钟，maxIters=200 只够走约 48 小时，
// 于是 rating=0（文档里正是用来模拟「遗忘回炉洪峰」的场景）跑出来的 30 天预测
// 只有前 3 天有数、后 27 天恒为 0 —— 洪峰场景完全失效，还白烧 200 次 schedule()/卡。
// 到顶后跳到次日零点继续：真人第二天会再来复习，这才符合"每日到期量"的口径。
const MAX_SAME_DAY_STEPS = 3;

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

  // 「同一张卡同一天只计一次」：
  //   模拟的是「今天这张卡要复习吗」，而不是「今天要翻几次」。
  //   实测缺陷（rating=0 时）：again 的间隔是 0.01 天（14.4 分钟），
  //   reviewAt 恒等于 start、idx 恒等于 0，于是 1 张卡在 day0 被计数 ~100 次
  //   → 单卡预测出 totalDue=200 / peak=100 这种天文数字，容量规划完全失真。
  const counted = new Set(); // key: `${seq}|${idx}`
  let seq = 0; // 卡片序号（同 id 的卡可能重复出现，用序号去重更稳）

  for (const card of cards || []) {
    if (!card) continue;
    seq++;
    // round17 R17-23：`??` 不兜 dueAt=0 的脏数据——0 会被当作「今天到期」计入 backlog，
    // 洪峰预测虚高。0 视为无有效到期时间，退回 createdAt。
    const rawDue = card.dueAt;
    const firstDue = (Number.isFinite(rawDue) && rawDue > 0) ? rawDue : (card.createdAt ?? now);
    if (firstDue < start) backlog++; // 当前已逾期、待补的卡

    let due = firstDue;
    let state = card; // 传给 schedule 的「当前卡片状态」（含 fsrs）
    let guard = 0;
    let sameDaySteps = 0; // 同一自然日内的连续重学次数
    while (guard++ < maxIters) {
      if (due >= end) break; // 已超出预测窗口
      // 复习时刻：逾期卡今天补（reviewAt=start），未来卡按时（reviewAt=due）
      const reviewAt = Math.max(due, start);
      const idx = Math.floor((reviewAt - start) / DAY);
      const key = `${seq}|${idx}`;
      if (idx >= 0 && idx < n && !counted.has(key)) { counted.add(key); byDay[idx]++; total++; }
      // 模拟复习推进
      const next = schedule(state, rating, { now: reviewAt, weights, desiredRetention: desiredR });
      // 推进量太小（如 again 的 0.01 天）说明这张卡进入了「当天重学」循环，
      // 继续迭代只会反复命中同一天，直接退出本卡模拟。
      if (next.dueAt - reviewAt < MIN_STEP_MS) break;

      let advancedTo = next.dueAt;
      if (Math.floor((next.dueAt - start) / DAY) === idx) {
        // 仍在同一天 → 一次当天重学
        sameDaySteps += 1;
        if (sameDaySteps >= MAX_SAME_DAY_STEPS) {
          // 重学次数到顶：跳到次日零点，让这张卡在第二天继续参与模拟。
          // 注意 state.dueAt 仍记真实的 next.dueAt —— schedule 靠它算 elapsed 天数。
          advancedTo = startOfDay(next.dueAt) + DAY;
          sameDaySteps = 0;
        }
      } else {
        sameDaySteps = 0;
      }
      due = advancedTo;
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
