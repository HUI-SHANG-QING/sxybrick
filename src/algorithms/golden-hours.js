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
export const MIN_HOURS_SAMPLES = 10; // 低于此总样本量只给分布、不给"建议这样安排"的处方

export function goldenHours(hourly, opts = {}) {
  // 审计 A9：windowSize 只保下界 → >24 时每个起点都覆盖全 24 小时多次，bestSum 恒等、
  // bestStart 停在 0、end 出现 >23 的模值，结果失真。环形滑动窗要求 windowSize ∈ [1,24]，
  // 上界一并钳制；h 长度也补零到 24，防御调用方少传。
  const windowSize = Math.max(1, Math.min(24, Number(opts.windowSize) || 3));
  const raw = hourly || [];
  const h = [];
  for (let i = 0; i < 24; i++) h.push(Number(raw[i]) || 0);
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

  // round80 审计 A3：**1 条记录也算不出"黄金时段"**。此前 total≥1 就输出
  // 「你通常在 3:00 复习最集中，建议安排在 1:00–4:00」——单个样本推出的作息建议是误导。
  // 分布数字照给（peakHour/bestWindow 是客观统计），处方文案只在样本够时给。
  const reliable = total >= MIN_HOURS_SAMPLES;
  return {
    peakHour,
    bestWindow: { start: bestStart, end, count: bestSum },
    total,
    hasData: true,
    reliable,
    label: reliable
      ? `你通常在 ${peakHour}:00 复习最集中，建议把复习安排在 ${bestStart}:00–${endLabel}:00 黄金时段`
      : `复习记录还太少（${total} 条，建议 ≥${MIN_HOURS_SAMPLES} 条），暂时看不出黄金时段，先多复习几天。`,
  };
}
