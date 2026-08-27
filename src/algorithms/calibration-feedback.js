// 校准闭环（Calibration Feedback）
// 把校准回测的偏差 bias（预测 R − 实际正确率）自动反馈到 desiredRetention，
// 让调度器「自我校正」——这是从「回测」走向「自动校准」的关键一步。
// 物理含义：nextInterval 公式 t = 9·S·(1/R − 1)，目标保持率越高 → 间隔越短 → 复习越频繁。
//   bias > 0（模型高估记忆、实际忘得多）→ 间隔太长 → 提高 desiredRetention；
//   bias < 0（模型低估记忆）→ 间隔太短 → 降低 desiredRetention。
// 纯函数、确定性，Node 可直接单测。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;

export const FEEDBACK_MIN = 0.80;
export const FEEDBACK_MAX = 0.95;
export const DEFAULT_MIN_SAMPLES = 50; // 样本不足时校准不可信
export const DEFAULT_GAIN = 0.5;       // 反馈增益：bias 每 1 个百分点 → 保持率调 0.5 个百分点

/**
 * 用偏差 bias 微调目标保持率。
 * @param {number} baseRetention 基础保持率（默认 0.9）
 * @param {number|null} bias      校准偏差（预测 − 实际），null/非法回退 base
 * @param {object} opts { gain, min, max }
 */
export function calibratedRetention(baseRetention, bias, opts = {}) {
  const base = Number(baseRetention) || 0.9;
  if (bias == null || !Number.isFinite(Number(bias))) return base;
  const k = opts.gain ?? DEFAULT_GAIN;
  const min = opts.min ?? FEEDBACK_MIN;
  const max = opts.max ?? FEEDBACK_MAX;
  return round2(clamp(base + k * Number(bias), min, max));
}

/**
 * 带样本量门槛的校准反馈：样本不足（n < minSamples）直接回退 baseRetention。
 * @param {number} baseRetention
 * @param {object} calib calibrationStats 的输出（{ n, bias, ece }）
 * @param {object} opts { minSamples, gain, min, max }
 */
export function calibrateFromStats(baseRetention, calib, opts = {}) {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  if (!calib || (calib.n ?? 0) < minSamples) return baseRetention;
  return calibratedRetention(baseRetention, calib.bias, opts);
}
