// experiments/run-integrity.mjs —— 学术诚信 / 不端风险自检实验
//
// 目的：不以「我们保证没造假」自证，而是用可复现的实验把每一条可能的造假指控
//      变成可测量的量。全部检查均为「独立重实现 + 与产品实现交叉校验」。
//
// 覆盖的指控类型：
//   A1 指标造假（metric gaming）：校准指标是否具有判别力？负对照（权重错配）能否被检出？
//   A2 参数挑选（tuning to win）：反馈增益 gain 是否被调到「效果最好」的档位？
//   A3 结果不可复现：同种子重复运行是否逐位一致？
//   A4 选择性报告（cherry-picking）：是否只报了对己有利的样本？给出完整分布与胜率。
//   A5 零效应/安慰剂对照：同一配置换随机种子，差异是否为 0（测量管线本身有无伪效应）？
//   A6 多重比较 / p-hacking：统计了多少个检验？Bonferroni–Holm 校正后还剩几个显著？
//   A7 论文数值与结果文件不一致（fabrication）：逐格核对论文结果表格中的数字。
//   A8 溯源：记录本次结果由哪些源码文件（sha256）与哪个 git commit 产生。
//
// 运行：node experiments/run-integrity.mjs [--smoke]
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  schedule, DEFAULT_WEIGHTS, retrievability, toFsrsGrade,
  initStability, initDifficulty, nextDifficulty, stabilityAfterRecall, stabilityAfterForget,
} from '../src/fsrs.js';
import { calibrationStats, computeCalibration } from '../src/algorithms/calibration.js';
import { generateSyntheticReviews, lcg } from '../src/algorithms/fsrs-benchmark.js';
import { calibratedRetention, calibrateFromStats } from '../src/algorithms/calibration-feedback.js';

const DAY = 86400000;
const T0 = 1_700_000_000_000;
const __dir = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const SCALE = SMOKE ? 0.1 : 1;
const K = (n) => Math.max(3, Math.round(n * SCALE));
const OUT = join(__dir, 'results-integrity.json');

// ---------------- 基础统计 ----------------
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
function sd(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function fullStats(a) {
  const s = [...a].sort((x, y) => x - y);
  return {
    n: a.length,
    mean: +mean(a).toFixed(4),
    sd: +sd(a).toFixed(4),
    median: +quantile(s, 0.5).toFixed(4),
    p05: +quantile(s, 0.05).toFixed(4),
    p25: +quantile(s, 0.25).toFixed(4),
    p75: +quantile(s, 0.75).toFixed(4),
    p95: +quantile(s, 0.95).toFixed(4),
    min: +s[0].toFixed(4),
    max: +s[s.length - 1].toFixed(4),
  };
}
/** Wilson 二项比例置信区间 */
function wilsonCI(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [+Math.max(0, c - h).toFixed(4), +Math.min(1, c + h).toFixed(4)];
}
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-z * z / 2) *
    (0.319381530 * t - 0.356563782 * t * t + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
  return z > 0 ? 1 - p : p;
}
function pairedStats(a, b) {
  const d = a.map((v, i) => v - b[i]);
  const n = d.length, m = mean(d), s = sd(d), se = s / Math.sqrt(n);
  const t = se ? m / se : 0;
  return { n, meanDiff: +m.toFixed(4), sd: +s.toFixed(4), t: +t.toFixed(3), p: +(2 * (1 - normalCDF(Math.abs(t)))).toFixed(6), cohensDz: s ? +(m / s).toFixed(3) : 0 };
}

// ============================================================
// A1：校准指标判别力（负对照）
// ============================================================
/** 独立重实现的校准评估：与 production calibrationStats 同构，但权重可配置 */
function auditCalibration(reviews, weights) {
  const byCard = new Map();
  for (const r of reviews) {
    if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
    byCard.get(r.cardId).push(r);
  }
  const rows = [];
  for (const list of byCard.values()) {
    const arr = [...list].sort((a, b) => (a.reviewedAt || 0) - (b.reviewedAt || 0));
    let s = null, d = null, last = null;
    for (const r of arr) {
      const t = r.reviewedAt || 0;
      const grade = toFsrsGrade(r.rating);
      if (s !== null && last !== null) rows.push({ predR: retrievability(s, Math.max(0, (t - last) / DAY), weights), rating: r.rating });
      if (s === null) { s = initStability(grade, weights); d = initDifficulty(grade, weights); }
      else {
        const R = retrievability(s, Math.max(0, (t - last) / DAY), weights);
        s = r.rating > 0 ? stabilityAfterRecall(s, d, R, grade, weights) : stabilityAfterForget(s, d, R, weights);
        d = nextDifficulty(d, grade, weights);
      }
      last = t;
    }
  }
  // ECE / Brier / bias（与 calibration.js 同定义）
  const width = 0.1;
  const bins = new Map();
  let brierSum = 0, predSum = 0, okSum = 0;
  for (const r of rows) {
    const pred = Math.min(1, Math.max(0, r.predR));
    const actual = r.rating > 0 ? 1 : 0;
    brierSum += (pred - actual) ** 2; predSum += pred; okSum += actual;
    const idx = Math.min(Math.floor(pred / width), 9);
    if (!bins.has(idx)) bins.set(idx, { n: 0, predSum: 0, ok: 0 });
    const b = bins.get(idx); b.n++; b.predSum += pred; b.ok += actual;
  }
  const n = rows.length;
  let ece = 0;
  for (const b of bins.values()) ece += (b.n / n) * Math.abs(b.ok / b.n - b.predSum / b.n);
  return { n, ece: +ece.toFixed(4), brier: +(brierSum / n).toFixed(4), bias: +(predSum / n - okSum / n).toFixed(4) };
}

function runA1() {
  const seeds = [1000, 1007, 1014];
  // A1a：审计实现 vs 产品实现（权重相同时应逐位一致）
  const agreement = seeds.map(s => {
    const { reviews } = generateSyntheticReviews({ nCards: 200, reviewsPerCard: 20, seed: s });
    // 产品侧必须用 computeCalibration（会补估 predR）；
    // 直接调 calibrationStats(raw) 会得到 n=0 —— 这正是 A1 要暴露的「指标空转」陷阱。
    const prod = computeCalibration(reviews);
    const vacuous = calibrationStats(reviews); // 负对照：空转路径
    const aud = auditCalibration(reviews, DEFAULT_WEIGHTS);
    return {
      seed: s, nProd: prod.n, nAudit: aud.n,
      prod: { ece: prod.ece, brier: prod.brier, bias: prod.bias },
      audit: { ece: aud.ece, brier: aud.brier, bias: aud.bias },
      vacuousPath: { n: vacuous.n, ece: vacuous.ece, brier: vacuous.brier, bias: vacuous.bias },
      maxAbsDiff: +Math.max(
        Math.abs(prod.ece - aud.ece), Math.abs(prod.brier - aud.brier), Math.abs(prod.bias - aud.bias),
        Math.abs(prod.n - aud.n),
      ).toFixed(6),
    };
  });

  // A1b：负对照 —— 数据由 W0 生成，评估时刻意用「错配权重」，指标必须恶化
  const factors = [1.0, 0.95, 0.9, 0.75, 0.5, 1.05, 1.1, 1.25, 1.5, 2.0];
  const negControl = {};
  for (const f of factors) {
    const rows = seeds.map(s => {
      const { reviews } = generateSyntheticReviews({ nCards: 200, reviewsPerCard: 20, seed: s });
      const w = DEFAULT_WEIGHTS.map((v, i) => (i === 17 ? 0 : Math.max(0.01, v * f)));
      return auditCalibration(reviews, w);
    });
    negControl['x' + f] = {
      factor: f,
      ece: fullStats(rows.map(r => r.ece)),
      brier: fullStats(rows.map(r => r.brier)),
      bias: fullStats(rows.map(r => r.bias)),
    };
    console.log(`  A1b factor=${f}: ECE=${negControl['x' + f].ece.mean} Brier=${negControl['x' + f].brier.mean} bias=${negControl['x' + f].bias.mean}`);
  }
  return { a1a_agreement: agreement, a1b_negativeControl: negControl, factors };
}

// ============================================================
// 通用仿真（本文件独立重实现，与 run-large.mjs 的 simulateFsrsTruth 互为交叉验证）
// ============================================================
function sampleFirstRating(rng, d) {
  const R0 = Math.min(0.9, Math.max(0.5, 0.85 - (d - 1) * 0.03));
  return rng() < R0 ? (rng() < 0.85 ? 2 : 1) : 0;
}
function sm2Review(st, q, now) {
  if (q < 3) { st.ef = Math.max(1.3, st.ef - 0.2); st.reps = 0; st.interval = 1; }
  else {
    if (st.reps === 0) st.interval = 1;
    else if (st.reps === 1) st.interval = 6;
    else st.interval = Math.round(st.interval * st.ef);
    st.ef = Math.max(1.3, st.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    st.reps += 1;
  }
  st.due = now + st.interval * DAY;
  return st;
}
const SM2_MAPS = { generous: [1, 3, 4], neutral: [1, 2, 3], harsh: [1, 2, 2] };

function simulate(gt, scheduler, M, horizonDays, seed, { sm2Map = 'generous', desiredR = 0.9 } = {}) {
  const rng = lcg(seed);
  const zeroFuzz = (w) => { const c = w.slice(); c[17] = 0; return c; };
  const cards = [];
  for (let i = 0; i < M; i++) cards.push({ id: 'c' + i, d: 1 + Math.round(rng() * 9), truth: null, fsrs: null, sm2: null, due: 0 });
  let reviews = 0, rSum = 0, rCnt = 0;
  const weights = zeroFuzz(DEFAULT_WEIGHTS);
  for (let day = 0; day < horizonDays; day++) {
    const now = T0 + day * DAY;
    for (const c of cards) {
      if (c.due > now) continue;
      let rating;
      if (c.truth == null) {
        rating = sampleFirstRating(rng, c.d);
        const g = toFsrsGrade(rating);
        c.truth = { s: initStability(g, gt), d: initDifficulty(g, gt), last: now };
      } else {
        const elapsed = (now - c.truth.last) / DAY;
        const R = retrievability(c.truth.s, elapsed, gt);
        rating = rng() < R ? (rng() < 0.85 ? 2 : 1) : 0;
        const g = toFsrsGrade(rating);
        c.truth = g === 1
          ? { s: stabilityAfterForget(c.truth.s, c.truth.d, R, gt), d: c.truth.d, last: now }
          : { s: stabilityAfterRecall(c.truth.s, c.truth.d, R, g, gt), d: nextDifficulty(c.truth.d, g, gt), last: now };
      }
      reviews++;
      if (scheduler === 'sm2') {
        c.sm2 = c.sm2 || { ef: 2.5, reps: 0, interval: 0, due: 0 };
        c.sm2 = sm2Review(c.sm2, SM2_MAPS[sm2Map][rating], now);
        c.due = c.sm2.due;
      } else {
        const r = schedule(c.fsrs ? { fsrs: c.fsrs } : {}, rating, { now, weights, desiredRetention: desiredR });
        c.fsrs = r.fsrs; c.due = r.dueAt;
      }
    }
    let sum = 0, cnt = 0;
    for (const c of cards) {
      if (c.truth == null) continue;
      sum += retrievability(c.truth.s, (now + DAY - c.truth.last) / DAY, gt); cnt++;
    }
    if (cnt > 0) { rSum += sum / cnt; rCnt++; }
  }
  return { reviews, avgRetention: rCnt ? +(rSum / rCnt).toFixed(4) : 0 };
}
/**
 * 逐学习者真值抖动因子：分层抽样（与主实验 run-large.mjs 的 gtForLearner 同构）。
 * 不用 `lcg(salt + k*13)()` —— 该写法使因子随 k 单调扫过区间，
 * 只取「前 K 个学习者」的实验会抽到偏倚子样（本审计脚本样本量更小，受影响更明显）。
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
function gtFor(k, K = 100, salt = 100000) {
  const f = stratifiedFactors(K, salt)[k];
  return DEFAULT_WEIGHTS.map((w, i) => (i === 17 ? 0 : Math.max(0.01, w * f)));
}

// ============================================================
// A2：反馈增益 gain 敏感性（参数是否被挑选）
// ============================================================
function simulateFeedback(gt, strategy, M, horizonDays, seed, { gain = 1.0, baseR = 0.9, gated = false, minSamples = 50 } = {}) {
  const rng = lcg(seed);
  const zeroFuzz = (w) => { const c = w.slice(); c[17] = 0; return c; };
  const cards = [];
  for (let i = 0; i < M; i++) cards.push({ id: 'c' + i, d: 1 + Math.round(rng() * 9), truth: null, fsrs: null, due: 0 });
  let reviews = 0, rSum = 0, rCnt = 0, desiredR = baseR;
  const history = [];
  const weights = zeroFuzz(DEFAULT_WEIGHTS);
  for (let day = 0; day < horizonDays; day++) {
    const now = T0 + day * DAY;
    if (strategy === 'feedback' && day > 0 && day % 20 === 0) {
      const calib = calibrationStats(history);
      desiredR = gated
        ? calibrateFromStats(baseR, calib, { minSamples, gain })
        : calibratedRetention(baseR, calib.bias, { gain });
    }
    for (const c of cards) {
      if (c.due > now) continue;
      let rating;
      if (c.truth == null) {
        rating = sampleFirstRating(rng, c.d);
        const g = toFsrsGrade(rating);
        c.truth = { s: initStability(g, gt), d: initDifficulty(g, gt), last: now };
      } else {
        const elapsed = (now - c.truth.last) / DAY;
        const R = retrievability(c.truth.s, elapsed, gt);
        rating = rng() < R ? (rng() < 0.85 ? 2 : 1) : 0;
        const g = toFsrsGrade(rating);
        c.truth = g === 1
          ? { s: stabilityAfterForget(c.truth.s, c.truth.d, R, gt), d: c.truth.d, last: now }
          : { s: stabilityAfterRecall(c.truth.s, c.truth.d, R, g, gt), d: nextDifficulty(c.truth.d, g, gt), last: now };
      }
      reviews++;
      const prev = c.fsrs;
      const predR = prev && prev.reps ? retrievability(prev.s, Math.max(0, (now - prev.last) / DAY), DEFAULT_WEIGHTS) : null;
      history.push({ cardId: c.id, rating, reviewedAt: now, predR });
      const r = schedule(prev ? { fsrs: prev } : {}, rating, { now, weights, desiredRetention: desiredR });
      c.fsrs = r.fsrs; c.due = r.dueAt;
    }
    let sum = 0, cnt = 0;
    for (const c of cards) {
      if (c.truth == null) continue;
      sum += retrievability(c.truth.s, (now + DAY - c.truth.last) / DAY, gt); cnt++;
    }
    if (cnt > 0) { rSum += sum / cnt; rCnt++; }
  }
  return { reviews, avgRetention: rCnt ? +(rSum / rCnt).toFixed(4) : 0 };
}

function runA2() {
  const DRIFTS = { mild: { w7: 0.85, w9: 0.90 }, moderate: { w7: 0.70, w9: 0.75 }, severe: { w7: 0.60, w9: 0.70 } };
  const gains = [0.25, 0.5, 1.0, 2.0];
  const K2 = K(20), M = 100, H = 300;
  const out = {};
  for (const [dname, d] of Object.entries(DRIFTS)) {
    const gt = DEFAULT_WEIGHTS.slice();
    gt[17] = 0; gt[7] = DEFAULT_WEIGHTS[7] * d.w7; gt[9] = DEFAULT_WEIGHTS[9] * d.w9;
    const fixedR = [], fixedV = [];
    for (let k = 0; k < K2; k++) {
      const r = simulateFeedback(gt, 'fixed', M, H, 500000 + k * 1000 + 1, {});
      fixedR.push(r.avgRetention); fixedV.push(r.reviews);
    }
    const perGain = {};
    for (const gain of gains) {
      for (const gated of [false, true]) {
        const fbR = [], fbV = [];
        for (let k = 0; k < K2; k++) {
          const r = simulateFeedback(gt, 'feedback', M, H, 500000 + k * 1000 + 1, { gain, gated });
          fbR.push(r.avgRetention); fbV.push(r.reviews);
        }
        const key = `gain${gain}${gated ? '_gated' : ''}`;
        perGain[key] = {
          gain, gated,
          retention: fullStats(fbR),
          reviews: fullStats(fbV),
          vsFixed: pairedStats(fbR, fixedR),
          reviewCost: pairedStats(fbV, fixedV),
        };
        console.log(`  A2 ${dname} ${key}: R ${mean(fixedR).toFixed(4)} -> ${mean(fbR).toFixed(4)} (d=${perGain[key].vsFixed.meanDiff})`);
      }
    }
    out[dname] = { drift: d, fixed: { retention: fullStats(fixedR), reviews: fullStats(fixedV) }, variants: perGain };
  }
  return { design: { learners: K2, cardsPerLearner: M, horizonDays: H, gains, drifts: Object.keys(DRIFTS) }, results: out };
}

// ============================================================
// A3：可复现性（同种子逐位一致）+ A5：零效应对照（换种子）
// ============================================================
function runA3A5() {
  const M = 60, H = 120;
  // A3：同种子跑两遍
  const rep = [];
  for (let k = 0; k < K(10); k++) {
    const gt = gtFor(k, K(10), 100000);
    const a = simulate(gt, 'fsrs-default', M, H, 300000 + k * 1000 + 2);
    const b = simulate(gt, 'fsrs-default', M, H, 300000 + k * 1000 + 2);
    rep.push({ k, identical: JSON.stringify(a) === JSON.stringify(b), a, b });
  }
  // A5：零效应对照（同配置、不同随机种子 → 差异应仅为抽样噪声）
  const nullPairs = [];
  for (let k = 0; k < K(60); k++) {
    const gt = gtFor(k, K(60), 100000);
    const a = simulate(gt, 'fsrs-default', M, H, 300000 + k * 1000 + 2);
    const b = simulate(gt, 'fsrs-default', M, H, 300000 + k * 1000 + 902);
    nullPairs.push({ reviewsDiff: a.reviews - b.reviews, retentionDiff: a.avgRetention - b.avgRetention });
  }
  return {
    a3_reproducibility: {
      runs: rep.length,
      allIdentical: rep.every(r => r.identical),
      mismatches: rep.filter(r => !r.identical).length,
    },
    a5_nullControl: {
      design: 'same scheduler, same ground truth, different RNG seed -> expected difference = 0',
      pairs: nullPairs.length,
      reviewsDiff: fullStats(nullPairs.map(p => p.reviewsDiff)),
      retentionDiff: fullStats(nullPairs.map(p => p.retentionDiff)),
      reviewsDiffAbsMean: +mean(nullPairs.map(p => Math.abs(p.reviewsDiff))).toFixed(4),
      retentionDiffAbsMean: +mean(nullPairs.map(p => Math.abs(p.retentionDiff))).toFixed(4),
    },
  };
}

// ============================================================
// A4：分布透明性（完整分布 + 胜率 + 独立实现与 run-large 的一致性）
// ============================================================
function runA4() {
  // 与主实验 R3 完全对齐（同样的分层真值因子、同样的随机种子），
  // 因此两个独立实现应给出逐学习者一致的结果 —— 这是最强的交叉验证。
  const M = 80, H = 180, K2 = K(200);
  const rows = [];
  for (let k = 0; k < K2; k++) {
    const gt = gtFor(k, K2, 100000);
    const sm2 = simulate(gt, 'sm2', M, H, 300000 + k * 1000 + 1, { sm2Map: 'generous' });
    const fsrs = simulate(gt, 'fsrs-default', M, H, 300000 + k * 1000 + 2);
    rows.push({ sm2Reviews: sm2.reviews, fsrsReviews: fsrs.reviews, sm2R: sm2.avgRetention, fsrsR: fsrs.avgRetention });
    if (k % 25 === 0) console.log(`  A4 learner ${k}/${K2}`);
  }
  const sav = rows.map(r => ((r.sm2Reviews - r.fsrsReviews) / r.sm2Reviews) * 100);
  const dR = rows.map(r => r.fsrsR - r.sm2R);
  const wins = sav.filter(v => v > 0).length;
  const losses = sav.filter(v => v < 0).length;
  const ties = sav.filter(v => v === 0).length;
  // 与 results-large.json（独立实现）的均值一致性
  let cross = null;
  try {
    const big = JSON.parse(readFileSync(join(__dir, 'results-large.json'), 'utf8'));
    const bigMean = big?.R3?.savingsPct?.defaultVsSm2?.mean;
    const bigCi = big?.R3?.savingsPct?.defaultVsSm2?.ci95;
    const myMean = mean(sav);
    cross = {
      runLargeMean: bigMean, runLargeCi95: bigCi,
      auditMean: +myMean.toFixed(4),
      absDiff: bigMean == null ? null : +Math.abs(bigMean - myMean).toFixed(4),
      withinRunLargeCI: bigCi ? (myMean >= bigCi[0] && myMean <= bigCi[1]) : null,
      note: '审计脚本独立重实现 vs run-large.mjs 主实验，两者均值应落在彼此置信区间内',
    };
  } catch (e) { cross = { error: String(e.message) }; }
  return {
    design: { learners: K2, cardsPerLearner: M, horizonDays: H, sm2Map: 'generous' },
    savingsPct: fullStats(sav),
    retentionDelta: fullStats(dR),
    winRate: {
      wins, losses, ties, n: rows.length,
      winRate: +(wins / rows.length).toFixed(4),
      winRateWilsonCI: wilsonCI(wins, rows.length),
    },
    worstCase: {
      minSavingsPct: +Math.min(...sav).toFixed(4),
      maxSavingsPct: +Math.max(...sav).toFixed(4),
      pctLearnersFsrsWorse: +(losses / rows.length * 100).toFixed(2),
    },
    crossImplementationCheck: cross,
    perLearnerSample: rows.slice(0, 20).map(r => ({
      sm2Reviews: r.sm2Reviews, fsrsReviews: r.fsrsReviews,
      savingsPct: +(((r.sm2Reviews - r.fsrsReviews) / r.sm2Reviews) * 100).toFixed(3),
      sm2R: r.sm2R, fsrsR: r.fsrsR,
    })),
  };
}

// ============================================================
// A6：多重比较校正（Bonferroni + Holm）
// ============================================================
function collectTests(obj, path = '', acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (typeof obj.p === 'number' && typeof obj.n === 'number' && typeof obj.meanDiff === 'number') {
    acc.push({ path, n: obj.n, meanDiff: obj.meanDiff, p: obj.p, t: obj.t });
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) collectTests(v, path ? `${path}.${k}` : k, acc);
  return acc;
}
function runA6() {
  let tests = [];
  let src = 'results-large.json';
  try {
    const big = JSON.parse(readFileSync(join(__dir, 'results-large.json'), 'utf8'));
    tests = collectTests(big);
  } catch (e) { src = 'results-large.json (missing: ' + e.message + ')'; }
  const alpha = 0.05;
  const m = tests.length || 1;
  const bonf = alpha / m;
  const sorted = [...tests].sort((a, b) => a.p - b.p);
  let holmCut = -1;
  sorted.forEach((t, i) => {
    t.bonferroniPass = t.p < bonf;
    t.holmThreshold = +(alpha / (m - i)).toFixed(6);
    t.holmPass = t.p < t.holmThreshold;
  });
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i].holmPass) { holmCut = i; break; }
  }
  if (holmCut >= 0) for (let i = holmCut; i < sorted.length; i++) sorted[i].holmPass = false;
  return {
    source: src,
    nTests: tests.length,
    alpha,
    bonferroniAlpha: +bonf.toFixed(6),
    nSignificantRaw: tests.filter(t => t.p < alpha).length,
    nSignificantBonferroni: tests.filter(t => t.bonferroniPass).length,
    nSignificantHolm: sorted.filter(t => t.holmPass).length,
    tests: sorted,
  };
}

// ============================================================
// A7：论文数值 ↔ 结果文件 逐格核对
// ============================================================
function numSetOf(obj, acc = new Set()) {
  if (typeof obj === 'number' && Number.isFinite(obj)) { acc.add(obj); return acc; }
  if (Array.isArray(obj)) { for (const v of obj) numSetOf(v, acc); return acc; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) numSetOf(v, acc); return acc; }
  return acc;
}
function runA7() {
  const files = ['paper/paper-direction-a-ieee.md', 'paper/paper-direction-a-ieee-zh.md', 'paper/paper-direction-a-ieee.tex'];
  const root = join(__dir, '..');
  const data = {};
  for (const f of ['experiments/results-large.json', 'experiments/results.json']) {
    try { data[f] = numSetOf(JSON.parse(readFileSync(join(root, f), 'utf8'))); } catch { /* ignore */ }
  }
  const all = new Set();
  for (const s of Object.values(data)) for (const v of s) all.add(v);
  const near = (x) => {
    for (const v of all) if (Math.abs(v - x) < 5e-3) return true;
    return false;
  };
  const out = [];
  for (const f of files) {
    let txt;
    try { txt = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const lines = txt.split(/\r?\n/);
    let inResults = false, header = '';
    lines.forEach((line, i) => {
      if (/^#{1,3}\s/.test(line)) {
        header = line.replace(/^#+\s*/, '');
        inResults = /(result|结果|experiment|实验|R[1-6]\b|finding)/i.test(header);
        return;
      }
      if (!inResults || !/^\s*\|/.test(line)) return;
      const cells = line.split('|');
      for (const cell of cells) {
        const m = cell.match(/-?\d+(\.\d+)?/g);
        if (!m) continue;
        for (const tok of m) {
          const v = Number(tok);
          if (!Number.isFinite(v)) continue;
          if (Math.abs(v) < 1e-9) continue;             // 0 / 1 等结构性数字
          if (Number.isInteger(v) && v >= 1900 && v <= 2100) continue; // 年份/引用
          if (!near(v)) out.push({ file: f, line: i + 1, section: header, token: tok, cell: cell.trim() });
        }
      }
    });
  }
  return { checkedFiles: files, resultFiles: Object.keys(data), unmatchedCount: out.length, unmatched: out };
}

// ============================================================
// A8：溯源（源码哈希 + git commit）
// ============================================================
function runA8() {
  const root = join(__dir, '..');
  const tracked = [
    'src/fsrs.js', 'src/algorithms/calibration.js', 'src/algorithms/calibration-feedback.js',
    'src/algorithms/adaptive-retention.js', 'src/algorithms/fsrs-benchmark.js',
    'experiments/run.mjs', 'experiments/run-large.mjs', 'experiments/run-integrity.mjs',
  ];
  const hashes = {};
  for (const f of tracked) {
    try { hashes[f] = createHash('sha256').update(readFileSync(join(root, f))).digest('hex').slice(0, 16); }
    catch { hashes[f] = null; }
  }
  let commit = null, dirty = null;
  try {
    commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
    dirty = execSync('git status --porcelain', { cwd: root }).toString().trim().split(/\r?\n/).filter(Boolean).length;
  } catch { /* ignore */ }
  return { node: process.version, platform: process.platform, gitCommit: commit, dirtyFiles: dirty, fileHashes: hashes };
}

// ============================================================
function main() {
  const t0 = Date.now();
  console.log('A0 provenance...'); const A8 = runA8();
  console.log('A1 metric discrimination (negative control)...'); const A1 = runA1();
  console.log('A2 gain sensitivity...'); const A2 = runA2();
  console.log('A3/A5 reproducibility + null control...'); const A35 = runA3A5();
  console.log('A4 distribution transparency...'); const A4 = runA4();
  console.log('A6 multiple comparisons...'); const A6 = runA6();
  console.log('A7 paper-vs-results number audit...'); const A7 = runA7();
  const result = {
    meta: {
      generatedAt: new Date().toISOString(), smoke: SMOKE,
      runtimeSeconds: +((Date.now() - t0) / 1000).toFixed(1),
      purpose: 'Academic-integrity self-audit for Direction-A paper',
    },
    A1, A2, A3: A35.a3_reproducibility, A4, A5: A35.a5_nullControl, A6, A7, A8,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('wrote', OUT, 'in', result.meta.runtimeSeconds, 's');
}
main();
