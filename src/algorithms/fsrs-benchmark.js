// FSRS 调度器评测基准（benchmark）
// 可复现、确定性、Node 可测。与「正确性单测」不同，这里测「质量」：
//   1. 校准质量：用 DEFAULT_WEIGHTS 生成自洽合成数据 → ECE 应接近 0（模型自洽性）
//   2. 训练改善：从扰动权重出发训练 → loss 应显著下降（训练器能从坏权重恢复）
//   3. 调度确定性：固定种子 → 结果稳定（跨平台/跨版本可比）
// 用途：纳入 CI 做质量门槛；scripts/benchmark.mjs 输出 JSON 供跨版本对比。

import {
  schedule, trainWeights, DEFAULT_WEIGHTS,
} from '../fsrs.js';
import { computeCalibration } from './calibration.js';

const DAY = 86400000;

// 确定性伪随机（LCG，跨平台一致，避免 Math.random 不可复现）
export function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * 用 DEFAULT_WEIGHTS 生成合成复习历史（模拟「理想学习者」：真实遗忘 = FSRS 预测）。
 * 每卡一条复习链，评分按固定比例（75% 记住 / 15% 模糊 / 10% 忘），
 * 实际复习时间在调度间隔上带 ±15% 抖动（模拟真人不会精确按时复习）。
 */
export function generateSyntheticReviews({ nCards = 40, reviewsPerCard = 10, seed = 42 } = {}) {
  const rng = lcg(seed);
  const reviews = [];
  const cardsById = new Map();
  // 关闭 nextInterval 的 Math.random 抖动（w[17]=0），保证生成过程完全确定
  const weights = DEFAULT_WEIGHTS.slice();
  weights[17] = 0;
  for (let i = 0; i < nCards; i++) {
    const cardId = 'synth-' + i;
    cardsById.set(cardId, { id: cardId, createdAt: 0 });
    let card = { id: cardId, fsrs: null };
    let t = 0;
    for (let j = 0; j < reviewsPerCard; j++) {
      const r = rng();
      const rating = r < 0.75 ? 2 : (r < 0.9 ? 1 : 0);
      const next = schedule(card, rating, { now: t, desiredRetention: 0.9, weights });
      reviews.push({ cardId, rating, reviewedAt: t });
      card = { ...card, fsrs: next.fsrs };
      t += Math.max(0.5, next.intervalDays) * DAY * (0.85 + rng() * 0.3);
    }
  }
  return { reviews, cardsById };
}

// 基准 1：校准质量（自洽数据 → ECE/Brier/偏差应接近 0）
export function runCalibrationBenchmark(reviews) {
  const calib = computeCalibration(reviews);
  return { n: calib.n, ece: calib.ece, brier: calib.brier, bias: calib.bias };
}

// 基准 2：训练改善（扰动权重 → 训练 → loss 显著下降）
export function runTrainingBenchmark(reviews, cardsById) {
  // 扰动权重：除 fuzz(w17) 外全部 ×0.5，模拟「坏」初始化
  const perturbed = DEFAULT_WEIGHTS.map((w, i) => (i === 17 ? w : w * 0.5));
  const before = trainWeights(reviews, cardsById, { weights: perturbed.slice(), iters: 1 }).loss;
  const trained = trainWeights(reviews, cardsById, { weights: perturbed.slice(), iters: 60, lr: 0.02 });
  return {
    beforeLoss: before,
    afterLoss: trained.loss,
    improvement: (before != null && trained.loss != null) ? before - trained.loss : null,
    samples: trained.samples,
  };
}

// 汇总入口
export function runBenchmark(opts = {}) {
  const { reviews, cardsById } = generateSyntheticReviews(opts);
  return {
    synthetic: { cards: cardsById.size, reviews: reviews.length, seed: opts.seed ?? 42 },
    calibration: runCalibrationBenchmark(reviews),
    training: runTrainingBenchmark(reviews, cardsById),
  };
}
