// experiments/run-large.mjs —— 方向 A 论文【大规模】实验（真实运行、固定种子、结果可复现）
//
// 相对小样本版 run.mjs 的增强：
//   1) 样本量大幅扩大（R1 30 组×10000 条；R2 5 组×6000 条；R3 200 学习者；R4 3 漂移强度×30 学习者；
//      R5 101 点曲线；R6 新增异族真值 100 学习者）
//   2) 全部对比附带统计检验：bootstrap 95% CI、配对 t 检验、Cohen's d_z
//   3) R3b 基线敏感性分析：SM-2 的 rating→q 映射 3 种方案，检验结论稳健性
//   4) R4 漂移强度扫描：mild / moderate / severe
//   5) R6 异族真值（指数遗忘 + 简单乘法增长），直接回应「真值与调度器同族」的效度威胁
//
// 运行：node experiments/run-large.mjs
import {
  schedule, trainWeights, DEFAULT_WEIGHTS, retrievability, toFsrsGrade,
  initStability, initDifficulty, nextDifficulty, stabilityAfterRecall, stabilityAfterForget,
} from '../src/fsrs.js';
import { calibrationStats, computeCalibration } from '../src/algorithms/calibration.js';
import { generateSyntheticReviews, lcg } from '../src/algorithms/fsrs-benchmark.js';
import { adaptiveRetention } from '../src/algorithms/adaptive-retention.js';
import { calibratedRetention, calibrateFromStats } from '../src/algorithms/calibration-feedback.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86400000;
const T0 = 1_700_000_000_000; // 非 0 时间基准（避免 schedule() 的 opts.now||Date.now() 回退墙钟）
const __dir = dirname(fileURLToPath(import.meta.url));
// --smoke：极小样本快速跑通（仅用于验证脚本无运行时错误），--out=xxx 指定输出文件
const SMOKE = process.argv.includes('--smoke');
const SCALE = SMOKE ? 0.05 : 1; // 冒烟时把「学习者/组数」缩到 5%
const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT = outArg ? join(__dir, outArg.slice(6)) : join(__dir, 'results-large.json');
const K = (n) => Math.max(2, Math.round(n * SCALE));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const zeroFuzz = (w) => { const c = w.slice(); c[17] = 0; return c; }; // 关闭 Math.random 抖动

// ============================================================
// 统计工具（纯函数、确定性）
// ============================================================
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
function sd(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
}
function bootCI(arr, fn, { iters = 2000, seed = 20260902 } = {}) {
  const rng = lcg(seed);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const s = [];
    for (let j = 0; j < arr.length; j++) s.push(arr[Math.floor(rng() * arr.length)]);
    out.push(fn(s));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * iters)], out[Math.floor(0.975 * iters)]];
}
// 标准正态 CDF（Abramowitz & Stegun 7.1.26）
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-z * z / 2) *
    (0.319381530 * t - 0.356563782 * t * t + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
  return z > 0 ? 1 - p : p;
}
/**
 * 逐学习者真值抖动因子：分层抽样（stratified），恰好覆盖 [0.7, 1.3]，再做确定性洗牌。
 * 为什么不用 `lcg(salt + k*13)()`：那样每个 k 都是「新 LCG 的第一个输出」，
 * 而该输出是种子的确定性线性函数，k 递增时因子会单调扫过整个区间 —— 实测
 * 前 100 个学习者均值 0.856、后 100 个 1.147。任何只取「前 K 个学习者」的实验
 * （例如 60 学习者的 R3c）都会因此抽到系统性偏倚子样。分层抽样可彻底消除该混淆。
 */
const _stratCache = new Map();
function stratifiedFactors(K, salt) {
  const key = K + ':' + salt;
  if (_stratCache.has(key)) return _stratCache.get(key);
  const rng = lcg(salt);
  const arr = Array.from({ length: K }, (_, i) => 0.7 + 0.6 * ((i + 0.5) / K));
  for (let i = K - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  _stratCache.set(key, arr);
  return arr;
}
function gtForLearner(k, K, salt) {
  const f = stratifiedFactors(K, salt)[k];
  return DEFAULT_WEIGHTS.map((w, i) => (i === 17 ? 0 : Math.max(0.01, w * f)));
}

/** 配对样本统计：a - b 的均值差、bootstrap CI、配对 t 检验、Cohen's d_z */
function pairedStats(a, b, { iters = 2000, seed = 20260902 } = {}) {
  const d = a.map((v, i) => v - b[i]);
  const n = d.length;
  const m = mean(d), s = sd(d), se = s / Math.sqrt(n);
  const t = se ? m / se : 0;
  const p = 2 * (1 - normalCDF(Math.abs(t)));
  const ci = bootCI(d, mean, { iters, seed });
  return {
    n,
    meanDiff: +m.toFixed(4),
    sd: +s.toFixed(4),
    se: +se.toFixed(4),
    t: +t.toFixed(3),
    p: p < 1e-12 ? 0 : +p.toFixed(6),
    cohensDz: s ? +(m / s).toFixed(3) : 0,
    ci95: [+ci[0].toFixed(4), +ci[1].toFixed(4)],
  };
}
/** 单样本描述统计 + 均值 bootstrap CI */
function describe(arr, { iters = 2000, seed = 20260902 } = {}) {
  const ci = bootCI(arr, mean, { iters, seed });
  return {
    n: arr.length,
    mean: +mean(arr).toFixed(4),
    sd: +sd(arr).toFixed(4),
    min: +Math.min(...arr).toFixed(4),
    max: +Math.max(...arr).toFixed(4),
    ci95: [+ci[0].toFixed(4), +ci[1].toFixed(4)],
  };
}

// ============================================================
// R1：校准质量（大规模：30 组 × 400 卡 × 25 次复习）
// ============================================================
function runR1() {
  const seeds = Array.from({ length: 30 }, (_, i) => 1000 + i * 7);
  const perSeed = [];
  const aggBuckets = new Map(); // 跨 seed 聚合分桶（样本量大 → 校准曲线平滑）
  for (const s of seeds) {
    const { reviews } = generateSyntheticReviews({ nCards: 400, reviewsPerCard: 25, seed: s });
    // 注意：generateSyntheticReviews 只产出 {cardId, rating, reviewedAt}，没有 predR。
    // calibrationStats 只统计「已带 predR」的记录 → 直接喂进去 n=0（指标空转）。
    // 必须用 computeCalibration 先按时间序回溯补估 predR（与产品线上逻辑一致）。
    const c = computeCalibration(reviews);
    perSeed.push({ seed: s, n: c.n, ece: c.ece, brier: c.brier, bias: c.bias });
    for (const b of c.buckets) {
      const key = b.lo.toFixed(2);
      const cur = aggBuckets.get(key) || { lo: b.lo, hi: b.hi, mid: b.mid, n: 0, predSum: 0, okSum: 0 };
      cur.n += b.n; cur.predSum += b.predMean * b.n; cur.okSum += b.actualRate * b.n;
      aggBuckets.set(key, cur);
    }
  }
  const buckets = [...aggBuckets.values()].sort((a, b) => a.lo - b.lo).map(b => ({
    lo: b.lo, hi: b.hi, mid: +((b.lo + b.hi) / 2).toFixed(3),
    n: b.n,
    predMean: +(b.predSum / b.n).toFixed(4),
    actualRate: +(b.okSum / b.n).toFixed(4),
  }));
  // 空输入对照：把「未补估 predR 的原始记录」直接喂给 calibrationStats，
  // 会得到 n=0、ece=null —— 这正是「指标空转（vacuous metric）」的陷阱，
  // 记录在此以证明 R1 走的是补估路径（computeCalibration）而非空跑。
  const { reviews: rawReviews } = generateSyntheticReviews({ nCards: 50, reviewsPerCard: 10, seed: 999 });
  const emptyInputControl = {
    calibrationStatsOnRaw: (({ n, ece, brier, bias }) => ({ n, ece, brier, bias }))(calibrationStats(rawReviews)),
    computeCalibrationOnRaw: (({ n, ece, brier, bias }) => ({ n, ece, brier, bias }))(computeCalibration(rawReviews)),
  };
  return {
    design: {
      seeds: seeds.length, nCards: 400, reviewsPerCard: 25, totalReviews: perSeed.reduce((a, r) => a + r.n, 0),
      role: 'pipeline control only',
      caveat: 'generateSyntheticReviews samples ratings from a FIXED distribution (75%/15%/10%) independent of predicted R, '
        + 'so observed success rate is ~0.9 by construction. A small ECE here only shows the pipeline runs and that the '
        + 'scheduler targets R~0.9; it is NOT evidence that the memory model is calibrated. See R1b for the '
        + 'memory-consistent calibration test that actually addresses RQ1.',
    },
    emptyInputControl,
    ece: describe(perSeed.map(r => r.ece)),
    brier: describe(perSeed.map(r => r.brier)),
    bias: describe(perSeed.map(r => r.bias)),
    perSeed,
    buckets,
  };
}

// ============================================================
// R1b：记忆一致性校准检验（对 R1 的实质性修正）
// ------------------------------------------------------------
// 问题：generateSyntheticReviews 的评分是按固定比例（75/15/10）随机抽的，
//       与当次复习的预测可提取性 R 完全独立 —— 观测成功率恒为 ~0.9。
//       在这种「随机标签」数据上跑校准，得到的小 ECE 只说明「调度器把间隔
//       安排在 R≈0.9、而随机标签的成功率恰好也≈0.9」，并不构成对记忆模型
//       校准性的任何证据。R1 因此只能作为管线冒烟测试，不能作为 RQ1 的证据。
//
// R1b 改用「记忆一致性」生成器：真值状态按 ground-truth 权重演化，
// 评分由真实可提取性采样得到（与第四节 B 的仿真真值完全一致）。
// 分两种条件：
//   matched    —— 真值权重 = 评估权重（自洽上界，应给出接近 0 的 ECE/bias）
//   mismatched —— 真值权重按逐学习者因子抖动（0.7~1.3，与 R3 一致）
// 同时报告 micro-ECE（按样本量加权，calibrationStats 的定义）与
// macro-ECE（各分桶 |delta| 的等权均值）两种口径：前者会被头部密集分桶稀释。
// ============================================================
function generateMemoryReviews({
  nCards = 400, reviewsPerCard = 25, seed = 1, desiredR = 0.9,
  jitter = false, timeJitter = 0.15,
} = {}) {
  const rng = lcg(seed);
  const ev = zeroFuzz(DEFAULT_WEIGHTS);
  const gt = jitter
    ? DEFAULT_WEIGHTS.map((w, i) => (i === 17 ? 0 : Math.max(0.01, w * (0.7 + lcg(seed * 31 + i)() * 0.6))))
    : ev.slice();
  const reviews = [];
  for (let i = 0; i < nCards; i++) {
    const cardId = 'mc-' + i;
    const d0 = 1 + Math.round(rng() * 9);
    let truth = null, sched = null, t = 0;
    for (let j = 0; j < reviewsPerCard; j++) {
      const now = Math.round(t);
      let rating;
      if (truth == null) {
        rating = sampleFirstRating(rng, d0);
        const g = toFsrsGrade(rating);
        truth = { s: initStability(g, gt), d: initDifficulty(g, gt), last: now };
      } else {
        const elapsed = Math.max(0, (now - truth.last) / DAY);
        const R = retrievability(truth.s, elapsed, gt);
        rating = rng() < R ? (rng() < 0.85 ? 2 : 1) : 0;
        const g = toFsrsGrade(rating);
        truth = g === 1
          ? { s: stabilityAfterForget(truth.s, truth.d, R, gt), d: truth.d, last: now }
          : { s: stabilityAfterRecall(truth.s, truth.d, R, g, gt), d: nextDifficulty(truth.d, g, gt), last: now };
      }
      // 预测可提取性：由「评估侧」调度器状态在复习前给出（与产品落盘 predR 同义）
      const predR = sched && sched.reps
        ? retrievability(sched.s, Math.max(0, (now - sched.last) / DAY), ev)
        : null;
      reviews.push({ cardId, rating, reviewedAt: now, predR });
      const r = schedule(sched ? { fsrs: sched } : {}, rating, { now, weights: ev, desiredRetention: desiredR });
      sched = r.fsrs;
      const gap = Math.max(0.5, r.intervalDays) * (1 - timeJitter + rng() * 2 * timeJitter);
      t = now + gap * DAY;
    }
  }
  return { reviews };
}

function runR1b() {
  const seeds = Array.from({ length: K(30) }, (_, i) => 7000 + i * 13);
  const run = (jitter) => {
    const rows = [];
    for (const s of seeds) {
      const { reviews } = generateMemoryReviews({ nCards: 400, reviewsPerCard: 25, seed: s, jitter });
      const c = calibrationStats(reviews);
      const macroEce = c.buckets.length
        ? c.buckets.reduce((a, b) => a + Math.abs(b.delta), 0) / c.buckets.length
        : null;
      rows.push({ seed: s, n: c.n, ece: c.ece, brier: c.brier, bias: c.bias, macroEce: +macroEce.toFixed(4), buckets: c.buckets });
    }
    return rows;
  };
  const matched = run(false), mismatched = run(true);
  const agg = (rows) => ({
    n: describe(rows.map(r => r.n)),
    ece: describe(rows.map(r => r.ece)),
    macroEce: describe(rows.map(r => r.macroEce)),
    brier: describe(rows.map(r => r.brier)),
    bias: describe(rows.map(r => r.bias)),
    eceVsMatched: null,
    pooledBuckets: (() => {
      const m = new Map();
      for (const r of rows) for (const b of r.buckets) {
        const cur = m.get(b.lo) || { lo: b.lo, hi: b.hi, mid: b.mid, n: 0, predSum: 0, okSum: 0 };
        cur.n += b.n; cur.predSum += b.predMean * b.n; cur.okSum += b.actualRate * b.n;
        m.set(b.lo, cur);
      }
      return [...m.values()].sort((a, b) => a.lo - b.lo).map(b => ({
        lo: b.lo, hi: b.hi, mid: b.mid, n: b.n,
        predMean: +(b.predSum / b.n).toFixed(4),
        actualRate: +(b.okSum / b.n).toFixed(4),
      }));
    })(),
  });
  const A = agg(matched), B = agg(mismatched);
  B.eceVsMatched = pairedStats(mismatched.map(r => r.ece), matched.map(r => r.ece));
  return {
    design: { seeds: seeds.length, nCards: 400, reviewsPerCard: 25, jitterFactor: [0.7, 1.3] },
    matched: A,
    mismatched: B,
  };
}

// ============================================================
// R2：训练器收敛（大规模：5 组独立历史，每组 300 卡 × 20 次）
// ============================================================
function lossOfFactory(reviews, weights0) {
  const byCard = new Map();
  for (const r of reviews) {
    const arr = byCard.get(r.cardId) || [];
    arr.push(r);
    byCard.set(r.cardId, arr);
  }
  /**
   * @param {number[]} weights
   * @param {number} fromIdx 只统计「每张卡第 fromIdx 次及以后」的复习（0 = 全部，样本内）
   *                         用于时间切分的样本外（held-out）评估：状态仍从头 replay，
   *                         只是不计入损失，等价于「用前 k 次复习练出来的状态预测第 k+1 次」。
   */
  return function lossOf(weights, fromIdx = 0, toIdx = Infinity) {
    let total = 0, n = 0;
    for (const [, arr] of byCard) {
      let state = null;
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i];
        const grade = toFsrsGrade(r.rating);
        const prev = state && state.reps ? state : null;
        if (prev && i >= fromIdx && i < toIdx) {
          const elapsed = Math.max(0, (r.reviewedAt - prev.last) / DAY);
          const R = retrievability(prev.s, elapsed, weights);
          const y = r.rating >= 2 ? 1 : 0;
          const p = clamp(R, 1e-6, 1 - 1e-6);
          total += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
          n++;
        }
        if (!prev) {
          state = { s: initStability(grade, weights), d: initDifficulty(grade, weights), reps: 1, last: r.reviewedAt };
        } else {
          const elapsed = Math.max(0, (r.reviewedAt - prev.last) / DAY);
          const R = retrievability(prev.s, elapsed, weights);
          const S = grade === 1 ? stabilityAfterForget(prev.s, prev.d, R, weights) : stabilityAfterRecall(prev.s, prev.d, R, grade, weights);
          state = { s: S, d: nextDifficulty(prev.d, grade, weights), reps: prev.reps + 1, last: r.reviewedAt };
        }
      }
    }
    return { loss: n ? total / n : null, n };
  };
}

function trainWithTrace(reviews, opts = {}) {
  const lossOf = lossOfFactory(reviews, opts.weights);
  const w0 = (opts.weights || DEFAULT_WEIGHTS).slice();
  // trainFromIdx/trainToIdx：只在「每卡第 trainFromIdx ~ trainToIdx-1 次复习」上计损失（默认全部 = 样本内）
  const tFrom = opts.trainFromIdx ?? 0;
  const tTo = opts.trainToIdx ?? Infinity;
  const evalTo = (w) => lossOf(w, tFrom, tTo);
  const iters = opts.iters || 80, lr = opts.lr || 0.02, eps = opts.eps || 1e-3;
  const trace = [];
  let best = evalTo(w0), weights = w0;
  trace.push({ iter: 0, loss: best.loss == null ? null : +best.loss.toFixed(4) });
  for (let it = 0; it < iters; it++) {
    const grad = new Array(weights.length).fill(0);
    for (let i = 0; i < weights.length; i++) {
      const up = weights.slice(); up[i] += eps;
      const dn = weights.slice(); dn[i] -= eps;
      const lu = evalTo(up).loss ?? best.loss ?? 0;
      const ld = evalTo(dn).loss ?? best.loss ?? 0;
      grad[i] = (lu - ld) / (2 * eps);
    }
    const gn = Math.hypot(...grad) || 1;
    const next = weights.map((wi, i) => Math.max(0.01, wi - lr * (grad[i] / gn)));
    const cand = evalTo(next);
    if (cand.loss != null && (best.loss == null || cand.loss < best.loss)) {
      weights = next; best = cand;
    } else break;
    trace.push({ iter: it + 1, loss: +best.loss.toFixed(4) });
  }
  return { trace, beforeLoss: trace[0].loss, afterLoss: best.loss, samples: best.n, weights };
}

function runR2() {
  const seeds = [11, 22, 33, 44, 55];
  const runs = seeds.map(s => {
    const { reviews } = generateSyntheticReviews({ nCards: 300, reviewsPerCard: 20, seed: s });
    const perturbed = DEFAULT_WEIGHTS.map((w, i) => (i === 17 ? w : w * 0.5));
    const r = trainWithTrace(reviews, { weights: perturbed.slice(), iters: 80, lr: 0.02 });
    return {
      seed: s, samples: r.samples, iters: r.trace.length - 1,
      beforeLoss: r.beforeLoss, afterLoss: +r.afterLoss.toFixed(4),
      improvement: +(r.beforeLoss - r.afterLoss).toFixed(4),
      trace: r.trace,
    };
  });
  // 对照组：默认权重在同样数据上的 loss（训练是否真的优于不训练）
  const baselineRuns = seeds.map(s => {
    const { reviews } = generateSyntheticReviews({ nCards: 300, reviewsPerCard: 20, seed: s });
    const lossOf = lossOfFactory(reviews, DEFAULT_WEIGHTS);
    const r = lossOf(DEFAULT_WEIGHTS);
    return { seed: s, defaultLoss: +r.loss.toFixed(4), n: r.n };
  });
  return {
    design: { seeds: seeds.length, nCards: 300, reviewsPerCard: 20 },
    before: describe(runs.map(r => r.beforeLoss)),
    after: describe(runs.map(r => r.afterLoss)),
    improvement: describe(runs.map(r => r.improvement)),
    iterations: describe(runs.map(r => r.iters)),
    trainedVsDefault: pairedStats(runs.map(r => r.afterLoss), baselineRuns.map(r => r.defaultLoss)),
    defaultLoss: describe(baselineRuns.map(r => r.defaultLoss)),
    perSeed: runs.map(r => ({ seed: r.seed, samples: r.samples, iters: r.iters, beforeLoss: r.beforeLoss, afterLoss: r.afterLoss, improvement: r.improvement, trace: r.trace })),
    representativeTrace: runs[0].trace,
  };
}

// ============================================================
// R2b：样本外（held-out）泛化检验
// ------------------------------------------------------------
// R2 只证明「训练能把样本内 log-loss 降下来」——这本身可能只是过拟合。
// R2b 做时间切分：每卡前 14 次复习用于训练，第 15 次及以后用于测试，
// 对比「训练后权重」与「默认权重」在测试段上的 log-loss。
// 若训练后权重不能击败默认权重，则 R2 的结论只能表述为「拟合改善」，不能表述为「泛化改善」。
// ============================================================
function runR2b() {
  const seeds = [11, 22, 33, 44, 55];
  const TRAIN_UPTO = 14; // 每卡前 14 次复习参与训练（index 0..13）
  const rows = seeds.map(s => {
    const { reviews } = generateSyntheticReviews({ nCards: 300, reviewsPerCard: 20, seed: s });
    const lossOf = lossOfFactory(reviews, DEFAULT_WEIGHTS);
    const perturbed = DEFAULT_WEIGHTS.map((w, i) => (i === 17 ? w : w * 0.5));
    const trained = trainWithTrace(reviews, {
      weights: perturbed.slice(), iters: 80, lr: 0.02, trainFromIdx: 0, trainToIdx: TRAIN_UPTO,
    }).weights;
    const trainLossTrained = lossOf(trained, 0, TRAIN_UPTO).loss;
    const trainLossDefault = lossOf(DEFAULT_WEIGHTS, 0, TRAIN_UPTO).loss;
    const testLossTrained = lossOf(trained, TRAIN_UPTO).loss;
    const testLossDefault = lossOf(DEFAULT_WEIGHTS, TRAIN_UPTO).loss;
    return {
      seed: s,
      trainLossTrained: +trainLossTrained.toFixed(4),
      trainLossDefault: +trainLossDefault.toFixed(4),
      testLossTrained: +testLossTrained.toFixed(4),
      testLossDefault: +testLossDefault.toFixed(4),
      trainGain: +(trainLossDefault - trainLossTrained).toFixed(4),
      testGain: +(testLossDefault - testLossTrained).toFixed(4),
    };
  });
  return {
    design: { seeds: seeds.length, nCards: 300, reviewsPerCard: 20, trainReviewsPerCard: TRAIN_UPTO, testReviewsPerCard: 20 - TRAIN_UPTO },
    train: {
      trained: describe(rows.map(r => r.trainLossTrained)),
      default: describe(rows.map(r => r.trainLossDefault)),
      gain: describe(rows.map(r => r.trainGain)),
      trainedVsDefault: pairedStats(rows.map(r => r.trainLossTrained), rows.map(r => r.trainLossDefault)),
    },
    test: {
      trained: describe(rows.map(r => r.testLossTrained)),
      default: describe(rows.map(r => r.testLossDefault)),
      gain: describe(rows.map(r => r.testGain)),
      trainedVsDefault: pairedStats(rows.map(r => r.testLossTrained), rows.map(r => r.testLossDefault)),
    },
    perSeed: rows,
  };
}

// ============================================================
// 通用：ground-truth 采样与仿真（FSRS 家族真值）
// ============================================================
function sampleRating(rng, s, d, elapsed, gt) {
  const R = retrievability(s, elapsed, gt);
  return rng() < R ? (rng() < 0.85 ? 2 : 1) : 0;
}
function sampleFirstRating(rng, d) {
  const R0 = clamp(0.85 - (d - 1) * 0.03, 0.5, 0.9);
  return rng() < R0 ? (rng() < 0.85 ? 2 : 1) : 0;
}

// SM-2 基线（标准 Anki 版），rating→q 映射可配置（敏感性分析用）
function sm2Review(st, q, now) {
  if (q < 3) { st.ef = Math.max(1.3, st.ef - 0.2); st.reps = 0; st.interval = 1; }
  else {
    if (st.reps === 0) st.interval = 1;
    else if (st.reps === 1) st.interval = 6;
    else st.interval = Math.round(st.interval * st.ef);
    st.ef = st.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    st.ef = Math.max(1.3, st.ef); st.reps += 1;
  }
  st.due = now + st.interval * DAY;
  return st;
}
const SM2_MAPS = {
  generous: [1, 3, 4],  // 记住=Easy(ease 不变)、模糊=Good(-0.14)
  neutral: [1, 2, 3],   // 记住=Good(-0.14)、模糊=Hard(-0.32)
  harsh: [1, 2, 2],     // 记住=Hard(-0.32)、模糊=Hard(-0.32)
};

/** FSRS 家族真值仿真 */
function simulateFsrsTruth(gtWeights, scheduler, M, horizonDays, seed, { warmupDays = 60, sm2Map = 'generous', desiredR = 0.9 } = {}) {
  const rng = lcg(seed);
  const cards = [];
  for (let i = 0; i < M; i++) cards.push({ id: 'c' + i, trueState: null, d: 1 + Math.round(rng() * 9), fsrsState: null, sm2State: null, due: 0 });
  let reviews = 0, retentionSum = 0, retentionCnt = 0;
  let weights = DEFAULT_WEIGHTS.slice();
  const history = [];
  let trained = false;
  const isFsrs = scheduler !== 'sm2';
  for (let day = 0; day < horizonDays; day++) {
    const now = T0 + day * DAY;
    if (scheduler === 'fsrs-trained' && !trained && day >= warmupDays && history.length >= 8) {
      const res = trainWeights(history, new Map(), { iters: 60, lr: 0.02 });
      if (res.loss != null) weights = zeroFuzz(res.weights);
      trained = true;
    }
    for (const c of cards) {
      if (c.due > now) continue;
      let grade;
      if (c.trueState == null) {
        const rating = sampleFirstRating(rng, c.d);
        grade = toFsrsGrade(rating);
        c.trueState = { s: initStability(grade, gtWeights), d: initDifficulty(grade, gtWeights), last: now };
      } else {
        const elapsed = (now - c.trueState.last) / DAY;
        const rating = sampleRating(rng, c.trueState.s, c.trueState.d, elapsed, gtWeights);
        grade = toFsrsGrade(rating);
        const R = retrievability(c.trueState.s, elapsed, gtWeights);
        if (grade === 1) c.trueState = { s: stabilityAfterForget(c.trueState.s, c.trueState.d, R, gtWeights), d: c.trueState.d, last: now };
        else c.trueState = { s: stabilityAfterRecall(c.trueState.s, c.trueState.d, R, grade, gtWeights), d: nextDifficulty(c.trueState.d, grade, gtWeights), last: now };
      }
      const rating = grade === 1 ? 0 : (grade === 2 ? 1 : 2);
      reviews++;
      history.push({ cardId: c.id, rating, reviewedAt: now });
      if (isFsrs) {
        const r = schedule(c.fsrsState ? { fsrs: c.fsrsState } : {}, rating, { now, weights: zeroFuzz(weights), desiredRetention: desiredR });
        c.fsrsState = r.fsrs; c.due = r.dueAt;
      } else {
        const q = SM2_MAPS[sm2Map][rating];
        c.sm2State = c.sm2State || { ef: 2.5, reps: 0, interval: 0, due: 0 };
        c.sm2State = sm2Review(c.sm2State, q, now);
        c.due = c.sm2State.due;
      }
    }
    let sum = 0, cnt = 0;
    for (const c of cards) {
      if (c.trueState == null) continue;
      sum += retrievability(c.trueState.s, (now + DAY - c.trueState.last) / DAY, gtWeights);
      cnt++;
    }
    if (cnt > 0) { retentionSum += sum / cnt; retentionCnt++; }
  }
  return { reviews, avgRetention: retentionCnt ? +(retentionSum / retentionCnt).toFixed(4) : 0 };
}

// ============================================================
// R3：调度器对比（200 学习者 × 80 卡 × 180 天，同族真值）
// ============================================================
function runR3() {
  const M = 80, horizonDays = 180, K2 = K(200);
  const rows = [];
  for (let k = 0; k < K2; k++) {
    const gt = gtForLearner(k, K2, 100000);
    const base = 300000 + k * 1000;
    if (k % 25 === 0) console.log(`  R3 learner ${k}/${K2}`);
    rows.push({
      k,
      sm2: simulateFsrsTruth(gt, 'sm2', M, horizonDays, base + 1, { sm2Map: 'generous' }),
      fsrsDefault: simulateFsrsTruth(gt, 'fsrs-default', M, horizonDays, base + 2),
      fsrsTrained: simulateFsrsTruth(gt, 'fsrs-trained', M, horizonDays, base + 3, { warmupDays: 60 }),
    });
  }
  const grab = key => rows.map(r => r[key].reviews);
  const grabR = key => rows.map(r => r[key].avgRetention);
  const savingsPct = (a, b) => rows.map(r => ((r[a].reviews - r[b].reviews) / r[a].reviews) * 100);
  return {
    design: { learners: K2, cardsPerLearner: M, horizonDays, warmupDays: 60, sm2Map: 'generous' },
    reviews: {
      sm2: describe(grab('sm2')),
      fsrsDefault: describe(grab('fsrsDefault')),
      fsrsTrained: describe(grab('fsrsTrained')),
    },
    retention: {
      sm2: describe(grabR('sm2')),
      fsrsDefault: describe(grabR('fsrsDefault')),
      fsrsTrained: describe(grabR('fsrsTrained')),
    },
    paired: {
      defaultVsSm2Reviews: pairedStats(grab('fsrsDefault'), grab('sm2')),
      trainedVsSm2Reviews: pairedStats(grab('fsrsTrained'), grab('sm2')),
      defaultVsSm2Retention: pairedStats(grabR('fsrsDefault'), grabR('sm2')),
      trainedVsSm2Retention: pairedStats(grabR('fsrsTrained'), grabR('sm2')),
      trainedVsDefaultRetention: pairedStats(grabR('fsrsTrained'), grabR('fsrsDefault')),
    },
    savingsPct: {
      defaultVsSm2: describe(savingsPct('sm2', 'fsrsDefault')),
      trainedVsSm2: describe(savingsPct('sm2', 'fsrsTrained')),
    },
    // 逐学习者明细：用于分布透明性审计（是否有选择性报告、是否由离群值驱动）
    perLearner: rows.map((r, i) => ({
      k: i,
      sm2Reviews: r.sm2.reviews, fsrsDefaultReviews: r.fsrsDefault.reviews, fsrsTrainedReviews: r.fsrsTrained.reviews,
      sm2R: r.sm2.avgRetention, fsrsDefaultR: r.fsrsDefault.avgRetention, fsrsTrainedR: r.fsrsTrained.avgRetention,
      savingsDefaultPct: +(((r.sm2.reviews - r.fsrsDefault.reviews) / r.sm2.reviews) * 100).toFixed(3),
      savingsTrainedPct: +(((r.sm2.reviews - r.fsrsTrained.reviews) / r.sm2.reviews) * 100).toFixed(3),
    })),
  };
}

// ============================================================
// R3b：SM-2 基线敏感性（3 种 rating→q 映射 × 100 学习者）
// ============================================================
function runR3b() {
  const M = 80, horizonDays = 180, K2 = K(100);
  const out = {};
  for (const mapName of Object.keys(SM2_MAPS)) {
    const rows = [];
    for (let k = 0; k < K2; k++) {
      const gt = gtForLearner(k, K2, 200000);
      const base = 400000 + k * 1000;
      rows.push({
        sm2: simulateFsrsTruth(gt, 'sm2', M, horizonDays, base + 1, { sm2Map: mapName }),
        fsrsDefault: simulateFsrsTruth(gt, 'fsrs-default', M, horizonDays, base + 2),
      });
    }
    const grab = key => rows.map(r => r[key].reviews);
    const grabR = key => rows.map(r => r[key].avgRetention);
    const sav = rows.map(r => ((r.sm2.reviews - r.fsrsDefault.reviews) / r.sm2.reviews) * 100);
    out[mapName] = {
      sm2Reviews: describe(grab('sm2')),
      fsrsReviews: describe(grab('fsrsDefault')),
      sm2Retention: describe(grabR('sm2')),
      fsrsRetention: describe(grabR('fsrsDefault')),
      savingsPct: describe(sav),
      pairedReviews: pairedStats(grab('fsrsDefault'), grab('sm2')),
      pairedRetention: pairedStats(grabR('fsrsDefault'), grabR('sm2')),
      perLearnerSavingsPct: rows.map(r => +(((r.sm2.reviews - r.fsrsDefault.reviews) / r.sm2.reviews) * 100).toFixed(3)),
    };
    console.log(`  R3b map=${mapName} done`);
  }
  return { design: { learners: K2, cardsPerLearner: M, horizonDays, maps: Object.keys(SM2_MAPS) }, results: out };
}

// ============================================================
// R4：校准反馈闭环（3 漂移强度 × 30 学习者 × 100 卡 × 300 天）
// ============================================================
function simulateFeedback(gtWeights, strategy, M, horizonDays, seed, { gain = 1.0, baseR = 0.9 } = {}) {
  const rng = lcg(seed);
  const cards = [];
  for (let i = 0; i < M; i++) cards.push({ id: 'c' + i, trueState: null, d: 1 + Math.round(rng() * 9), fsrsState: null, due: 0 });
  let reviews = 0, retentionSum = 0, retentionCnt = 0;
  let desiredR = baseR;
  const history = [];
  const biasTrace = [];
  for (let day = 0; day < horizonDays; day++) {
    const now = T0 + day * DAY;
    if (strategy === 'feedback' && day > 0 && day % 20 === 0) {
      const calib = calibrationStats(history);
      desiredR = calibratedRetention(baseR, calib.bias, { gain });
      biasTrace.push({ day, bias: calib.bias, desiredR, n: calib.n });
    }
    for (const c of cards) {
      if (c.due > now) continue;
      let grade, rating;
      if (c.trueState == null) {
        rating = sampleFirstRating(rng, c.d);
        grade = toFsrsGrade(rating);
        c.trueState = { s: initStability(grade, gtWeights), d: initDifficulty(grade, gtWeights), last: now };
      } else {
        const elapsed = (now - c.trueState.last) / DAY;
        rating = sampleRating(rng, c.trueState.s, c.trueState.d, elapsed, gtWeights);
        grade = toFsrsGrade(rating);
        const R = retrievability(c.trueState.s, elapsed, gtWeights);
        if (grade === 1) c.trueState = { s: stabilityAfterForget(c.trueState.s, c.trueState.d, R, gtWeights), d: c.trueState.d, last: now };
        else c.trueState = { s: stabilityAfterRecall(c.trueState.s, c.trueState.d, R, grade, gtWeights), d: nextDifficulty(c.trueState.d, grade, gtWeights), last: now };
      }
      reviews++;
      const prev = c.fsrsState;
      let predR = null;
      if (prev && prev.reps) predR = retrievability(prev.s, Math.max(0, (now - prev.last) / DAY), DEFAULT_WEIGHTS);
      history.push({ cardId: c.id, rating, reviewedAt: now, predR });
      const r = schedule(prev ? { fsrs: prev } : {}, rating, { now, weights: zeroFuzz(DEFAULT_WEIGHTS), desiredRetention: desiredR });
      c.fsrsState = r.fsrs; c.due = r.dueAt;
    }
    let sum = 0, cnt = 0;
    for (const c of cards) {
      if (c.trueState == null) continue;
      sum += retrievability(c.trueState.s, (now + DAY - c.trueState.last) / DAY, gtWeights);
      cnt++;
    }
    if (cnt > 0) { retentionSum += sum / cnt; retentionCnt++; }
  }
  return { reviews, avgRetention: retentionCnt ? +(retentionSum / retentionCnt).toFixed(4) : 0, biasTrace, finalDesiredR: desiredR };
}

function runR4() {
  const DRIFTS = {
    mild: { w7: 0.85, w9: 0.90 },
    moderate: { w7: 0.70, w9: 0.75 },
    severe: { w7: 0.60, w9: 0.70 },
  };
  const M = 100, horizonDays = 300, K2 = K(30);
  const out = {};
  for (const [name, d] of Object.entries(DRIFTS)) {
    const rows = [];
    for (let k = 0; k < K2; k++) {
      const gt = DEFAULT_WEIGHTS.slice();
      gt[17] = 0;
      gt[7] = DEFAULT_WEIGHTS[7] * d.w7;
      gt[9] = DEFAULT_WEIGHTS[9] * d.w9;
      const base = 500000 + k * 1000;
      rows.push({
        fixed: simulateFeedback(gt, 'fixed', M, horizonDays, base + 1, {}),
        feedback: simulateFeedback(gt, 'feedback', M, horizonDays, base + 1, { gain: 1.0 }),
      });
    }
    const fR = rows.map(r => r.fixed.avgRetention);
    const bR = rows.map(r => r.feedback.avgRetention);
    // 偏差轨迹聚合（按 day 汇总）
    const byDay = new Map();
    for (const r of rows) {
      for (const p of r.feedback.biasTrace) {
        const cur = byDay.get(p.day) || { day: p.day, bias: [], desiredR: [], n: [] };
        cur.bias.push(p.bias); cur.desiredR.push(p.desiredR); cur.n.push(p.n);
        byDay.set(p.day, cur);
      }
    }
    const trace = [...byDay.values()].sort((a, b) => a.day - b.day).map(p => ({
      day: p.day,
      biasMean: +mean(p.bias).toFixed(4),
      biasSd: +sd(p.bias).toFixed(4),
      desiredRMean: +mean(p.desiredR).toFixed(4),
      nMean: Math.round(mean(p.n)),
    }));
    out[name] = {
      drift: d,
      fixed: { retention: describe(fR), reviews: describe(rows.map(r => r.fixed.reviews)) },
      feedback: { retention: describe(bR), reviews: describe(rows.map(r => r.feedback.reviews)) },
      retentionGain: pairedStats(bR, fR),
      reviewCost: pairedStats(rows.map(r => r.feedback.reviews), rows.map(r => r.fixed.reviews)),
      perLearnerRetentionGain: rows.map(r => +(r.feedback.avgRetention - r.fixed.avgRetention).toFixed(4)),
      trace,
    };
    console.log(`  R4 drift=${name} done (fixed ${mean(fR).toFixed(4)} -> feedback ${mean(bR).toFixed(4)})`);
  }
  return { design: { learners: K2, cardsPerLearner: M, horizonDays, gain: 1.0, baseR: 0.9, drifts: DRIFTS }, results: out };
}

// ============================================================
// R3c：保持率匹配的效率前沿
// ------------------------------------------------------------
// R3/R3b 的 "(reviews, retention)" 是二元组，不是同保持率下的比较：
// 一个调度器可能只是「站在这条权衡曲线的另一个位置」，而非更有效率。
// R3c 扫描 FSRS 的目标保持率（0.80/0.85/0.90/0.95）与 SM-2 的两种评分约定，
// 输出各条件的 (reviews, retention)，从而能在「保持率相近」的两点之间比较复习成本。
// ============================================================
function runR3c() {
  const M = 80, horizonDays = 180, K2 = K(60);
  const desiredRs = [0.80, 0.85, 0.90, 0.95];
  const maps = ['generous', 'neutral'];
  const fs = {}, sm = {};
  for (const dr of desiredRs) fs['R' + dr] = { reviews: [], retention: [], perLearner: [] };
  for (const m of maps) sm[m] = { reviews: [], retention: [], perLearner: [] };
  for (let k = 0; k < K2; k++) {
    const gt = gtForLearner(k, K2, 700000);
    const base = 800000 + k * 1000;
    for (const dr of desiredRs) {
      const r = simulateFsrsTruth(gt, 'fsrs-default', M, horizonDays, base + 2, { desiredR: dr });
      fs['R' + dr].reviews.push(r.reviews); fs['R' + dr].retention.push(r.avgRetention);
      fs['R' + dr].perLearner.push({ reviews: r.reviews, retention: r.avgRetention });
    }
    for (const m of maps) {
      const r = simulateFsrsTruth(gt, 'sm2', M, horizonDays, base + 1, { sm2Map: m });
      sm[m].reviews.push(r.reviews); sm[m].retention.push(r.avgRetention);
      sm[m].perLearner.push({ reviews: r.reviews, retention: r.avgRetention });
    }
    if (k % 25 === 0) console.log(`  R3c learner ${k}/${K2}`);
  }
  const pack = (o) => ({ reviews: describe(o.reviews), retention: describe(o.retention) });
  const out = { fsrs: {}, sm2: {} };
  for (const dr of desiredRs) out.fsrs['target' + dr] = pack(fs['R' + dr]);
  for (const m of maps) out.sm2[m] = pack(sm[m]);
  // 保持率匹配：为每个 SM-2 条件找最接近的 FSRS 目标档，比较复习次数
  const match = [];
  for (const m of maps) {
    const smR = sm[m].retention.reduce((a, b) => a + b, 0) / sm[m].retention.length;
    let best = null;
    for (const dr of desiredRs) {
      const fR = fs['R' + dr].retention.reduce((a, b) => a + b, 0) / fs['R' + dr].retention.length;
      const gap = Math.abs(fR - smR);
      if (!best || gap < best.gap) best = { dr, fR, gap };
    }
    const smV = sm[m].reviews, fV = fs['R' + best.dr].reviews;
    match.push({
      sm2Map: m,
      sm2Retention: +smR.toFixed(4),
      matchedFsrsTarget: best.dr,
      fsrsRetention: +best.fR.toFixed(4),
      retentionGap: +best.gap.toFixed(4),
      sm2Reviews: describe(smV).mean,
      fsrsReviews: describe(fV).mean,
      reviewsSavedPct: +(((describe(smV).mean - describe(fV).mean) / describe(smV).mean) * 100).toFixed(3),
      paired: pairedStats(fV, smV),
    });
  }
  return { design: { learners: K2, cardsPerLearner: M, horizonDays, fsrsTargets: desiredRs, sm2Maps: maps }, results: out, retentionMatched: match };
}

// ============================================================
// R5：自适应保持率（101 点曲线 + 10 个示例学科）
// ============================================================
function runR5() {
  const curve = Array.from({ length: 101 }, (_, i) => ({ mastery: i, retention: adaptiveRetention(i) }));
  const subjects = [
    { subject: '高等数学', mastery: 15 }, { subject: '线性代数', mastery: 30 },
    { subject: '数据结构', mastery: 45 }, { subject: '操作系统', mastery: 55 },
    { subject: '计算机网络', mastery: 60 }, { subject: '计算机组成原理', mastery: 70 },
    { subject: '编译原理', mastery: 80 }, { subject: '概率论', mastery: 85 },
    { subject: '英语词汇', mastery: 95 }, { subject: '政治理论', mastery: 50 },
  ];
  const freq = R => R / (1 - R);
  const fixedFreq = freq(0.9);
  const withFreq = subjects.map(s => ({
    ...s, retention: adaptiveRetention(s.mastery),
    relFrequency: +(freq(adaptiveRetention(s.mastery)) / fixedFreq).toFixed(3),
  }));
  return { design: { curvePoints: 101, subjects: subjects.length }, curve, subjects: withFreq, fixedRetention: 0.9 };
}

// ============================================================
// R6：异族真值（指数遗忘 + 简单乘法增长）——外部效度检验
// ============================================================
function gtExpRetrievability(s, elapsed) { return Math.pow(0.9, elapsed / Math.max(0.01, s)); }
function gtExpStability(s, d, R, recalled) {
  if (!recalled) return Math.max(0.1, s * 0.35);
  const diffPenalty = 1 - 0.06 * Math.max(0, d - 1);
  return Math.max(0.1, s * (1.6 + 0.6 * (1 - R)) * diffPenalty);
}
function simulateExpTruth(scheduler, M, horizonDays, seed, { warmupDays = 60, sm2Map = 'generous', desiredR = 0.9 } = {}) {
  const rng = lcg(seed);
  const cards = [];
  for (let i = 0; i < M; i++) cards.push({ id: 'c' + i, trueState: null, d: 1 + Math.round(rng() * 9), fsrsState: null, sm2State: null, due: 0 });
  let reviews = 0, retentionSum = 0, retentionCnt = 0;
  let weights = DEFAULT_WEIGHTS.slice();
  const history = [];
  let trained = false;
  const isFsrs = scheduler !== 'sm2';
  for (let day = 0; day < horizonDays; day++) {
    const now = T0 + day * DAY;
    if (scheduler === 'fsrs-trained' && !trained && day >= warmupDays && history.length >= 8) {
      const res = trainWeights(history, new Map(), { iters: 60, lr: 0.02 });
      if (res.loss != null) weights = zeroFuzz(res.weights);
      trained = true;
    }
    for (const c of cards) {
      if (c.due > now) continue;
      let rating;
      if (c.trueState == null) {
        rating = sampleFirstRating(rng, c.d);
        c.trueState = { s: 1.5 + rng() * 2.5, d: c.d, last: now };
      } else {
        const elapsed = (now - c.trueState.last) / DAY;
        const R = gtExpRetrievability(c.trueState.s, elapsed);
        rating = rng() < R ? (rng() < 0.85 ? 2 : 1) : 0;
        c.trueState = {
          s: gtExpStability(c.trueState.s, c.trueState.d, R, rating >= 1),
          d: c.trueState.d,
          last: now,
        };
      }
      reviews++;
      history.push({ cardId: c.id, rating, reviewedAt: now });
      if (isFsrs) {
        const r = schedule(c.fsrsState ? { fsrs: c.fsrsState } : {}, rating, { now, weights: zeroFuzz(weights), desiredRetention: desiredR });
        c.fsrsState = r.fsrs; c.due = r.dueAt;
      } else {
        const q = SM2_MAPS[sm2Map][rating];
        c.sm2State = c.sm2State || { ef: 2.5, reps: 0, interval: 0, due: 0 };
        c.sm2State = sm2Review(c.sm2State, q, now);
        c.due = c.sm2State.due;
      }
    }
    let sum = 0, cnt = 0;
    for (const c of cards) {
      if (c.trueState == null) continue;
      sum += gtExpRetrievability(c.trueState.s, (now + DAY - c.trueState.last) / DAY);
      cnt++;
    }
    if (cnt > 0) { retentionSum += sum / cnt; retentionCnt++; }
  }
  return { reviews, avgRetention: retentionCnt ? +(retentionSum / retentionCnt).toFixed(4) : 0 };
}

function runR6() {
  const M = 80, horizonDays = 180, K2 = K(100);
  const rows = [];
  for (let k = 0; k < K2; k++) {
    const base = 600000 + k * 1000;
    if (k % 25 === 0) console.log(`  R6 learner ${k}/${K2}`);
    rows.push({
      sm2: simulateExpTruth('sm2', M, horizonDays, base + 1, { sm2Map: 'generous' }),
      fsrsDefault: simulateExpTruth('fsrs-default', M, horizonDays, base + 2),
      fsrsTrained: simulateExpTruth('fsrs-trained', M, horizonDays, base + 3, { warmupDays: 60 }),
    });
  }
  const grab = key => rows.map(r => r[key].reviews);
  const grabR = key => rows.map(r => r[key].avgRetention);
  const sav = (a, b) => rows.map(r => ((r[a].reviews - r[b].reviews) / r[a].reviews) * 100);
  return {
    design: { learners: K2, cardsPerLearner: M, horizonDays, truthFamily: 'exponential + multiplicative growth', sm2Map: 'generous' },
    reviews: { sm2: describe(grab('sm2')), fsrsDefault: describe(grab('fsrsDefault')), fsrsTrained: describe(grab('fsrsTrained')) },
    retention: { sm2: describe(grabR('sm2')), fsrsDefault: describe(grabR('fsrsDefault')), fsrsTrained: describe(grabR('fsrsTrained')) },
    paired: {
      defaultVsSm2Reviews: pairedStats(grab('fsrsDefault'), grab('sm2')),
      defaultVsSm2Retention: pairedStats(grabR('fsrsDefault'), grabR('sm2')),
      trainedVsSm2Retention: pairedStats(grabR('fsrsTrained'), grabR('sm2')),
    },
    savingsPct: { defaultVsSm2: describe(sav('sm2', 'fsrsDefault')) },
    perLearnerSavingsPct: rows.map(r => +(((r.sm2.reviews - r.fsrsDefault.reviews) / r.sm2.reviews) * 100).toFixed(3)),
  };
}

// ============================================================
function main() {
  const t0 = Date.now();
  console.log('running R1 (calibration, large)...'); const R1 = runR1();
  console.log('running R1b (memory-consistent calibration)...'); const R1b = runR1b();
  console.log('running R2 (training, large)...'); const R2 = runR2();
  console.log('running R2b (held-out generalization)...'); const R2b = runR2b();
  console.log('running R3 (schedulers, 200 learners)...'); const R3 = runR3();
  console.log('running R3b (SM-2 baseline sensitivity)...'); const R3b = runR3b();
  console.log('running R3c (retention-matched efficiency frontier)...'); const R3c = runR3c();
  console.log('running R4 (feedback, drift sweep)...'); const R4 = runR4();
  console.log('running R5 (adaptive retention)...'); const R5 = runR5();
  console.log('running R6 (out-of-family truth)...'); const R6 = runR6();
  const result = {
    meta: {
      generatedAt: new Date().toISOString(),
      engine: 'SxyBrick FSRS-4.5 (finite-difference)',
      nWeights: DEFAULT_WEIGHTS.length,
      runtimeSeconds: +((Date.now() - t0) / 1000).toFixed(1),
      smoke: SMOKE,
      note: 'All randomness from deterministic LCG; scheduler Math.random fuzz disabled (w17=0) for reproducibility.',
    },
    R1, R1b, R2, R2b, R3, R3b, R3c, R4, R5, R6,
  };
  mkdirSync(__dir, { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('wrote', OUT, 'in', result.meta.runtimeSeconds, 's');
}
main();
