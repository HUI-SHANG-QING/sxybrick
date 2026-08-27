// 黄金时段（golden hours）：从 24 小时复习时间分布中，找出最高效的复习时段。
// 学习科学依据：固定时段复习利于习惯养成与状态稳定；这里用真实历史分布找「最集中的连续时段」。
// 纯函数、确定性，Node 可直接单测。

/**
 * @param {Array} hourly 长度 24 的数组，每小时复习次数（getStats().hourly 的产物）
 * @param {object} opts { windowSize?: number } 连续时段窗口（默认 3 小时）
 * @returns {{
 *   peakHour: number|null, bestWindow: {start,end,count}|null,
 *   total: number, hasData: boolean, label: string
 * }}
 */
export function goldenHours(hourly, opts = {}) {
  const windowSize = Math.max(1, opts.windowSize ?? 3);
  const h = (hourly || []).map(v => Number(v) || 0);
  const total = h.reduce((s, v) => s + v, 0);

  if (!total) return { peakHour: null, bestWindow: null, total: 0, hasData: false, label: '暂无复习数据' };

  // 单小时峰值
  let peakHour = 0;
  for (let i = 1; i < 24; i++) if (h[i] > h[peakHour]) peakHour = i;

  // 连续 windowSize 小时窗口（环形：跨午夜）
  let bestStart = 0, bestSum = -1;
  for (let i = 0; i < 24; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) sum += h[(i + j) % 24];
    if (sum > bestSum) { bestSum = sum; bestStart = i; }
  }
  const end = (bestStart + windowSize - 1) % 24;
  const endLabel = (end + 1) % 24; // 结束小时（含），如 22-24 点窗口 end=23 → 结束 0 点

  return {
    peakHour,
    bestWindow: { start: bestStart, end, count: bestSum },
    total,
    hasData: true,
    label: `你通常在 ${peakHour}:00 复习最集中，建议把复习安排在 ${bestStart}:00–${endLabel}:00 黄金时段`,
  };
}
