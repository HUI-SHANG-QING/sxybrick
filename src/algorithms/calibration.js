// src/algorithms/calibration.js —— 校准回测（Calibration Backtest）
// 学习科学最硬的检验：FSRS 预测的记忆概率 R vs 复习实际结果的分桶对比。
// 纯函数层（N9 模式）：不 import 任何 IO，Node 可直接单测。
// 数据流：
//   1) 新复习记录落盘时带 predR（repo.review 用复习前的 card.fsrs 状态计算）；
//   2) 历史记录无 predR → backfillCardCalibration 按时间序回溯模拟 FSRS 状态补估；
//   3) calibrationBuckets / calibrationStats 聚合出校准曲线 + Brier/ECE/偏差。

import {
  retrievability,
  toFsrsGrade,
  initStability,
  initDifficulty,
  nextDifficulty,
  stabilityAfterRecall,
  stabilityAfterForget,
} from '../fsrs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 单卡回溯模拟：按时间序重建 FSRS 状态，为每条复习估计「当时的预测 R」。
 * reviews 需按 reviewedAt 升序（内部会再排一次，乱序传入也安全）。
 * 已带 predR 的记录优先用落盘值（真实），模拟值只补缺。
 * 返回 [{ reviewedAt, rating, predR, simulated }]，首条复习无先验状态 → predR=null。
 */
export function backfillCardCalibration(reviews) {
  const rows = [...(reviews || [])].sort((a, b) => (a.reviewedAt || 0) - (b.reviewedAt || 0));
  const out = [];
  let s = null, d = null, last = null;
  for (const r of rows) {
    const t = r.reviewedAt || 0;
    const grade = toFsrsGrade(r.rating);
    let predR = null, simulated = false;
    if (typeof r.predR === 'number' && Number.isFinite(r.predR)) {
      predR = r.predR; // 落盘的真实预测
    } else if (s !== null && last !== null) {
      predR = retrievability(s, (t - last) / DAY_MS); // 回溯模拟补估
      simulated = true;
    }
    // 状态推进（无论 predR 来源，都用模拟链推进——落盘 predR 的记录推进后偏差极小）
    if (s === null) {
      s = initStability(grade); d = initDifficulty(grade);
    } else {
      const elapsed = Math.max(0, (t - last) / DAY_MS);
      const R = retrievability(s, elapsed);
      if (r.rating > 0) s = stabilityAfterRecall(s, d, R, grade);
      else s = stabilityAfterForget(s, d, R);
      d = nextDifficulty(d, grade);
    }
    last = t;
    out.push({ reviewedAt: t, rating: r.rating, predR, simulated });
  }
  return out;
}

/**
 * 校准分桶：把带 predR 的复习记录按预测 R 分桶，对比实际正确率。
 * rows: [{ predR, rating }]（rating 0/1/2）
 * width: 桶宽，默认 0.1（10 桶）
 * 返回桶数组（只含有样本的桶）：{ lo, hi, mid, n, predMean, actualRate, strictRate, delta }
 */
export function calibrationBuckets(rows, width = 0.1) {
  const w = width > 0 && width <= 0.5 ? width : 0.1;
  const byBucket = new Map();
  for (const r of rows || []) {
    if (typeof r.predR !== 'number' || !Number.isFinite(r.predR)) continue;
    const pred = Math.min(1, Math.max(0, r.predR));
    const idx = Math.min(Math.floor(pred / w), Math.ceil(1 / w) - 1);
    if (!byBucket.has(idx)) byBucket.set(idx, { n: 0, predSum: 0, ok: 0, strict: 0 });
    const b = byBucket.get(idx);
    b.n += 1; b.predSum += pred;
    if (r.rating > 0) b.ok += 1;       // 成功 = 没忘记（rating 1 或 2）
    if (r.rating === 2) b.strict += 1; // 严格 = 完全记住
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, b]) => {
      const lo = Number((idx * w).toFixed(2));
      const hi = Number(Math.min(1, (idx + 1) * w).toFixed(2));
      const predMean = b.n ? b.predSum / b.n : 0;
      const actualRate = b.n ? b.ok / b.n : 0;
      return {
        lo, hi, mid: Number(((lo + hi) / 2).toFixed(3)), n: b.n,
        predMean: Number(predMean.toFixed(4)),
        actualRate: Number(actualRate.toFixed(4)),
        strictRate: Number((b.n ? b.strict / b.n : 0).toFixed(4)),
        delta: Number((actualRate - predMean).toFixed(4)),
      };
    });
}

/**
 * 校准总统计：Brier 分数 / ECE / 总偏差 / 结论。
 * rows: [{ predR, rating }]
 */
export function calibrationStats(rows) {
  const valid = (rows || []).filter(r => typeof r.predR === 'number' && Number.isFinite(r.predR));
  const n = valid.length;
  if (!n) {
    return { n: 0, buckets: [], brier: null, ece: null, bias: null, verdict: '样本不足', note: '还没有可回测的复习记录（需先积累带 FSRS 状态的复习）。' };
  }
  let brierSum = 0, predSum = 0, okSum = 0;
  for (const r of valid) {
    const pred = Math.min(1, Math.max(0, r.predR));
    const actual = r.rating > 0 ? 1 : 0;
    brierSum += (pred - actual) ** 2;
    predSum += pred; okSum += actual;
  }
  const buckets = calibrationBuckets(valid);
  let ece = 0;
  for (const b of buckets) ece += (b.n / n) * Math.abs(b.delta);
  const bias = predSum / n - okSum / n;
  let verdict = '校准良好';
  if (bias > 0.05) verdict = '预测偏乐观（高估记忆）';
  else if (bias < -0.05) verdict = '预测偏悲观（低估记忆）';
  if (ece > 0.1) verdict += '，建议重新训练权重';
  return {
    n,
    buckets,
    brier: Number((brierSum / n).toFixed(4)),
    ece: Number(ece.toFixed(4)),
    bias: Number(bias.toFixed(4)),
    verdict,
    note: bias > 0.05
      ? '模型高估了你的记忆：实际忘得比预测多（间隔太长）。应上调目标保持率，让复习更频繁。'
      : bias < -0.05
        ? '模型低估了你的记忆：实际记得比预测牢（间隔太短）。可下调目标保持率减少复习量。'
        : '预测与实际基本一致，当前调度参数可信。',
  };
}

/**
 * 多卡聚合入口：按 cardId 分组回溯模拟后整体统计。
 * reviews: 全部复习记录（任意顺序）；cardsById 可选（未用，保留扩展位）。
 */
export function computeCalibration(reviews) {
  const byCard = new Map();
  for (const r of reviews || []) {
    if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
    byCard.get(r.cardId).push(r);
  }
  const rows = [];
  for (const list of byCard.values()) rows.push(...backfillCardCalibration(list));
  return calibrationStats(rows);
}
