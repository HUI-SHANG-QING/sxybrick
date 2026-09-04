// src/fsrs.js
// FSRS-4.5（Free Spaced Repetition Scheduler）实现 —— 用机器学习拟合每用户遗忘曲线
// 对标 SM-2：实测节省 20~30% 复习时间达到同等记忆保持率
//
// 设计：
//   - 纯函数、零依赖（无 IndexedDB / window），可在 Web Worker 与 Node 单测中运行
//   - 核心方程：可提取性 R = (1 + t/(9S))^-1（幂律，FSRS-4.5）
//   - 状态：每卡 { s: 稳定度, d: 难度[1..10], reps: 复习次数, last: 上次复习时间 }
//   - 19 个权重 w[0..18]，冷启动用全局默认；ML 训练器用用户真实评分历史拟合
//
// 评分映射：SxyBrick rating {0:没记住, 1:还模糊, 2:记住了} → FSRS grade {1:again, 2:hard, 3:good}
//   （SxyBrick 无 easy 档；FSRS grade 4 仅在 ML 数据充分时由训练器触及）

// ---------- 默认权重（FSRS-4.5 优化器输出的全局先验，冷启动用） ----------
// 索引语义：
//   w0..w2  初始稳定度 S0(again/hard/good)
//   w3      easy 档稳定度乘子（S0(easy)=w2*w3）
//   w4      初始难度 D0 基准
//   w5      难度随评分的斜率
//   w6      难度均值回归系数
//   w7..w10 回忆后稳定度更新参数
//   w11..w14 遗忘后稳定度更新参数
//   w15     hard 惩罚因子（<1：hard 的增长量小于 good）
//   w16     easy 加成因子（>1：easy 的整体稳定度大于 good）
//   w17     间隔抖动系数
//   w18     稳定度上限
//
// ⚠️ 方向铁律（2026-08-29 修正）：w15 是「惩罚」必须 <1，w16 是「加成」必须 >1。
// 历史缺陷：w15/w16 曾分别写成 2.61 / 0.00，导致「还模糊」的间隔是「记住了」的 2.61 倍，
// 语义完全反向——越不会的卡片反而越晚复习。现除修正默认值外，
// stabilityAfterRecall 内部也对 w15 做了 ≤1 钳制，使方向错误在结构上不可能发生。
export const DEFAULT_WEIGHTS = [
  0.40,  // w0  S0(again)
  0.60,  // w1  S0(hard)
  2.40,  // w2  S0(good)
  5.80,  // w3  easy 乘子
  4.93,  // w4  初始难度基准
  0.94,  // w5  难度斜率
  0.86,  // w6  难度均值回归
  // ---- 回忆后稳定度更新：S' = S·(1 + e^w7·(11-D)·S^-w8·(e^(w9(1-R))-1)·w10·hard·easy) ----
  // ⚠️ 2026-08-30 重标定（此前是 P0 级缺陷）：
  //   旧值 w7=1.49 / w8=0.14 / w9=0.94 / w10=2.18 在 R=0.9、D≈5 下单步倍率 **×6.1**，
  //   实测间隔序列 2.4 → 14.7 → 73 → 305 → 365 天：一张卡连按 4 次「记住了」就跳到一年，
  //   复习节奏被彻底毁掉（且第 3 次 level 就满级，UI 显示「已掌握」）。
  //   w10 是上游 FSRS 不存在的额外乘子，正是它把倍率从 ≈2.8 放大到 6.1，置 1。
  //   重标定目标：R=0.9 连续 good 的单步倍率 ≈2.6（S=2.4）并随 S 衰减到 ≈1.9（S=300），
  //   实测间隔序列 2.4 → 6.2 → 14 → 28 → 54 → 101 → 190 → 356 天 —— 标准 FSRS 曲线。
  0.976, // w7  回忆更新：e^w7 量级（ln 2.653）
  0.1192,// w8  回忆更新：S^-w8 衰减（越大，稳定度越高时增长越慢）
  1.0461,// w9  回忆更新：遗忘驱动项 (e^(w9*(1-R))-1)
  1.0,   // w10 回忆更新：整体缩放（上游 FSRS 无此项；1.0 = 不额外放大）
  0.05,  // w11 遗忘更新：量级
  0.34,  // w12 遗忘更新：D^-w12
  1.26,  // w13 遗忘更新：(S+1)^w13
  0.29,  // w14 遗忘更新：e^(-w14*R) 衰减
  0.29,  // w15 hard 惩罚（<1：hard 增长量约为 good 的 29% → 间隔更短）
  2.61,  // w16 easy 加成（>1：easy 稳定度约为 good 的 2.61 倍 → 间隔更长）
  0.20,  // w17 间隔抖动
  1.00,  // w18 稳定度上限（×10 天，即 S 上限=10*dflt→实际乘子，保留可训练）
];

export const DEFAULT_DESIRED_RETENTION = 0.9; // 目标保持率 90%
// 稳定度上限（天）。与 nextInterval 的 365 天硬上限保持一致：
// 更大的 S 既调度不出来，又会在答错时污染 stabilityAfterForget。
export const MAX_STABILITY = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** SxyBrick rating(0/1/2) → FSRS grade(1/2/3) */
export function toFsrsGrade(rating) {
  const r = Number(rating);
  if (r === 0) return 1; // 没记住 → again
  if (r === 1) return 2; // 还模糊 → hard
  return 3;              // 记住了 → good
}

/** 可提取性 R = (1 + t/(9S))^-1，t=自上次复习经过天数 */
export function retrievability(S, elapsedDays, w = DEFAULT_WEIGHTS) {
  const s = Math.max(0.01, S);
  const t = Math.max(0, elapsedDays);
  return Math.pow(1 + t / (9 * s), -1);
}

/** 初始稳定度 S0（首次复习） */
export function initStability(grade, w = DEFAULT_WEIGHTS) {
  if (grade === 4) return Math.max(0.1, w[2] * w[3]); // easy
  if (grade === 1) return Math.max(0.1, w[0]);
  if (grade === 2) return Math.max(0.1, w[1]);
  return Math.max(0.1, w[2]); // good
}

/** 初始难度 D0 ∈ [1,10] */
export function initDifficulty(grade, w = DEFAULT_WEIGHTS) {
  return clamp(w[4] - (grade - 3) * w[5], 1, 10);
}

/** 难度更新（含均值回归到 w4） */
export function nextDifficulty(D, grade, w = DEFAULT_WEIGHTS) {
  const nextD = D - w[5] * (grade - 3); // 评分越高 → 难度下降
  const reverted = nextD + w[6] * (w[4] - nextD); // 均值回归到基准
  return clamp(reverted, 1, 10);
}

/**
 * 回忆后稳定度更新（grade>=2）
 *
 * 方向保证（2026-08-29）：hard 惩罚只作用于「增量项」并强制钳制在 (0,1]，
 * 因此 hard 的新稳定度恒 ≤ good，即使权重被训练器拟合到异常值也不会语义反向。
 * easy 加成作用于整体，同样恒 ≥ good（w16<1 时退化为 ≤1 的加成，不会反向）。
 */
export function stabilityAfterRecall(S, D, R, grade, w = DEFAULT_WEIGHTS) {
  const s = Math.max(0.01, S);
  const factor = Math.exp(w[7]) * (11 - D) * Math.pow(s, -w[8]) * (Math.exp(w[9] * (1 - R)) - 1);
  // hard 惩罚：仅缩放增长量，且钳制 ≤1（结构保证 hard ≤ good）
  const hardPenalty = grade === 2 ? clamp(Number.isFinite(w[15]) ? w[15] : 1, 0.01, 1) : 1;
  // easy 加成：缩放整体稳定度（训练器可把它拟合到 >1 或 <1，但不会改变 hard/good 序关系）
  const easyBonus = grade === 4 ? Math.max(0.01, Number.isFinite(w[16]) ? w[16] : 1) : 1;
  // 稳定度上限：不封顶的话，长期全对的卡 S 会一路涨到上千（实测旧权重下 S=1873），
  // 一旦答错，stabilityAfterForget 的 (S+1)^w13 项会把它打回一个与真实记忆强度无关的巨大值；
  // 且 nextInterval 早在 365 天就截断了，更大的 S 没有任何调度意义。
  const nextS = s * (1 + w[10] * factor * hardPenalty) * easyBonus;
  return clamp(nextS, 0.1, MAX_STABILITY);
}

/** 遗忘后稳定度更新（grade==1，重新学习） */
export function stabilityAfterForget(S, D, R, w = DEFAULT_WEIGHTS) {
  const s = Math.max(0.01, S);
  const nextS = w[11] * Math.pow(Math.max(0.1, D), -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(-w[14] * R);
  return Math.max(0.01, nextS);
}

/** 由目标保持率 R* 与稳定度 S 反解下次间隔（天）：t = 9·S·(1/R* - 1) */
export function nextInterval(S, desiredR = DEFAULT_DESIRED_RETENTION, w = DEFAULT_WEIGHTS) {
  const s = Math.max(0.01, S);
  const r = clamp(desiredR, 0.5, 0.99);
  let days = 9 * s * (1 / r - 1);
  // 抖动（fuzz）：避免同一天堆积过多卡，±w17
  const fuzz = 1 + (Math.random() - 0.5) * 2 * (Number.isFinite(w[17]) ? w[17] : 0);
  days *= fuzz;
  // NaN/Infinity 护栏：Math.max/Math.min 遇到 NaN 会返回 NaN，必须先挡
  if (!Number.isFinite(days)) days = 0.01;
  days = Math.max(0.01, Math.min(365, days));
  return days;
}

/**
 * FSRS 调度核心：给定卡片状态 + 本次评分，算出下次间隔与新状态
 * @param {object} card  卡片（可含 card.fsrs={s,d,reps,last}）
 * @param {number} rating 0/1/2
 * @param {object} opts { weights?, desiredRetention?, now? }
 * @returns {{ intervalDays, dueAt, fsrs:{s,d,reps,last}, level, ease, consolidation }}
 */
export function schedule(card, rating, opts = {}) {
  const w = opts.weights || DEFAULT_WEIGHTS;
  // H-1：|| 会把显式传 0（语义：极低目标保持率/不复习）误替换为 0.9——与调用方意图相反。
  // ?? 只对 undefined/null 回退：0 是合法取值，保持一致口径（forecast.js 早已用 ??）。
  const desiredR = opts.desiredRetention ?? DEFAULT_DESIRED_RETENTION;
  const nowTs = opts.now ?? Date.now();
  const grade = toFsrsGrade(rating);
  // NaN 防护：typeof NaN === 'number' 会让坏状态一路传播到 dueAt=NaN，
  // 而 `dueAt <= now` 对 NaN 恒为 false → 该卡将永久消失于复习队列。
  const fs = card?.fsrs;
  const prev = fs
    && Number.isFinite(fs.s) && Number.isFinite(fs.d) && Number.isFinite(fs.last)
    ? fs
    : null;

  let S, D, reps;
  if (!prev || !prev.reps) {
    // 首次复习：初始化（冷启动前测估计优先于默认 S0）
    S = (typeof opts.initialStability === 'number' && opts.initialStability > 0)
      ? Math.max(0.5, opts.initialStability)
      : initStability(grade, w);
    D = initDifficulty(grade, w);
    reps = 1;
  } else {
    const elapsedDays = Math.max(0, (nowTs - prev.last) / DAY_MS);
    const R = retrievability(prev.s, elapsedDays, w);
    if (grade === 1) {
      S = stabilityAfterForget(prev.s, prev.d, R, w);
    } else {
      S = stabilityAfterRecall(prev.s, prev.d, R, grade, w);
    }
    D = nextDifficulty(prev.d, grade, w);
    reps = prev.reps + 1;
  }
  // 兜底层：任何环节产出非有限值都回退到安全稳定度，绝不把 NaN/Infinity 写入 dueAt
  if (!Number.isFinite(S)) S = initStability(grade, w);
  if (!Number.isFinite(D)) D = initDifficulty(grade, w);
  if (!Number.isFinite(reps) || reps < 1) reps = 1;
  // 稳定度封顶（stabilityAfterRecall 内已钳，这里兜住 forget 分支与外部传入的异常值）
  S = clamp(S, 0.01, MAX_STABILITY);

  // 遗忘（没记住）：立刻重学，给极短间隔；否则按目标保持率反解
  // N3: grade===1 用 stabilityAfterForget 算出的低 S 通过 nextInterval 反解间隔（高 S 卡答错后自然更长）
  let intervalDays = grade === 1 ? Math.min(1, nextInterval(S, desiredR, w)) : nextInterval(S, desiredR, w);
  if (!Number.isFinite(intervalDays)) intervalDays = 0.01;
  intervalDays = Math.max(0.01, intervalDays);
  const dueAt = nowTs + Math.round(intervalDays * DAY_MS);

  // 派生 SM-2 兼容字段（供既有 UI/统计/体检复用，不影响 FSRS 真实状态）
  const level = S < 1 ? 0 : S < 3 ? 1 : S < 7 ? 2 : S < 15 ? 3 : 4;
  const ease = clamp(1.3 + Math.log2(Math.max(1, S)) * 0.3, 1.3, 2.8);

  return {
    intervalDays,
    dueAt,
    fsrs: { s: S, d: D, reps, last: nowTs },
    level,
    ease,
    consolidation: null, // FSRS 用稳定度本身处理短期间隔，不复用 SM-2 巩固状态机
  };
}

// ---------- ML 参数优化：用用户真实评分历史拟合 19 权重 ----------
// 损失：log-loss（二分类：回忆 vs 遗忘）。y = rating>=2 ? 1 : 0
// 优化：有限差分梯度下降（无解析梯度时鲁棒；19 维 × 2 次/参数/样本，离线训练可接受）
//
// @param reviews  [{ cardId, rating, reviewedAt }] 按时间升序
// @param cardsById Map(cardId → { fsrs:{s,d,reps,last} 初始空, createdAt })
// @param opts { weights?, iters?, lr?, desiredRetention?, eps? }
// @returns { weights, loss, samples }
export function trainWeights(reviews, cardsById, opts = {}) {
  const w0 = (opts.weights || DEFAULT_WEIGHTS).slice();
  const iters = Math.max(1, Math.min(200, opts.iters || 30));
  const lr = opts.lr || 0.01;
  const eps = opts.eps || 1e-3;
  if (!reviews || reviews.length < 8) return { weights: w0, loss: null, samples: 0 };

  // D4 优化：预构建轨迹（toFsrsGrade + Map 查找只做一次，lossOf 只重算 R + 状态推进）
  const cardTrajectories = [];
  for (const [cardId, arr] of (function() {
    const m = new Map();
    for (const r of reviews) { const a = m.get(r.cardId) || []; a.push(r); m.set(r.cardId, a); }
    return m;
  })()) {
    const card = cardsById.get(cardId);
    cardTrajectories.push({
      init: card?.fsrs?.reps ? null : card?.fsrs || null,
      reviews: arr.map(r => ({ grade: toFsrsGrade(r.rating), y: r.rating >= 2 ? 1 : 0, reviewedAt: r.reviewedAt })),
    });
  }

  function lossOf(weights) {
    let total = 0, n = 0;
    for (const { init, reviews: revs } of cardTrajectories) {
      let s, d, reps, last;
      if (!init) {
        const g0 = revs[0].grade;
        s = initStability(g0, weights); d = initDifficulty(g0, weights); reps = 1; last = revs[0].reviewedAt;
      } else {
        s = init.s; d = init.d; reps = 0; last = 0;
      }
      for (let j = 0; j < revs.length; j++) {
        const { grade, y, reviewedAt } = revs[j];
        if (reps > 0) {
          const elapsed = Math.max(0, (reviewedAt - last) / DAY_MS);
          const R = retrievability(s, elapsed, weights);
          const p = clamp(R, 1e-6, 1 - 1e-6);
          total += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
          n++;
        }
        if (reps === 0) {
          s = initStability(grade, weights); d = initDifficulty(grade, weights); reps = 1;
        } else {
          const elapsed = Math.max(0, (reviewedAt - last) / DAY_MS);
          const R = retrievability(s, elapsed, weights);
          s = grade === 1 ? stabilityAfterForget(s, d, R, weights) : stabilityAfterRecall(s, d, R, grade, weights);
          d = nextDifficulty(d, grade, weights);
          reps++;
        }
        last = reviewedAt;
      }
    }
    return { loss: n ? total / n : null, n };
  }

  let best = lossOf(w0);
  let weights = w0;
  let rate = lr; // 训练循环内可衰减的学习率（round19 R19-5）
  let plateau = 0;
  const LR_FLOOR = 1e-4;
  const PATIENCE = 4;
  for (let it = 0; it < iters; it++) {
    const grad = new Array(weights.length).fill(0);
    for (let i = 0; i < weights.length; i++) {
      const up = weights.slice(); up[i] += eps;
      const dn = weights.slice(); dn[i] -= eps;
      const lu = lossOf(up).loss ?? best.loss ?? 0;
      const ld = lossOf(dn).loss ?? best.loss ?? 0;
      grad[i] = (lu - ld) / (2 * eps);
    }
    // 归一化梯度（避免量纲不一致导致发散）
    const gn = Math.hypot(...grad) || 1;
    const next = weights.map((wi, i) => Math.max(0.01, wi - rate * (grad[i] / gn)));
    const cand = lossOf(next);
    if (cand.loss != null && (best.loss == null || cand.loss < best.loss - 1e-9)) {
      weights = next;
      best = cand;
      plateau = 0;
    } else {
      // round19 R19-5：注释承诺「缩小 lr 继续」，原代码却直接 break（首步不降即停、
      // 个性化权重≈默认）。改为：连续不降时衰减学习率继续探索，学习率见底或连续
      // plateau 达耐心上限才收尾，让有限差分训练真正收敛到个性化权重。
      plateau++;
      if (rate <= LR_FLOOR || plateau >= PATIENCE) break;
      rate *= 0.5;
    }
  }
  return { weights, loss: best.loss, samples: best.n };
}

/**
 * 权重数据结构版本（2026-08-29 引入）
 * v1 = 修正 hard/easy 方向之前的旧格式（裸数组），其 w15/w16 语义与现公式不兼容。
 * v2 = { v: 2, weights: number[] }，与 stabilityAfterRecall 的增量式 hard 惩罚一致。
 * 旧版本数据一律回退默认权重（用户重新训练即可），避免带着反向语义继续调度。
 */
export const WEIGHT_SCHEMA_VERSION = 2;

/** 序列化用户权重（写入 db.meta 前调用） */
export function serializeUserWeights(weights) {
  if (!Array.isArray(weights) || weights.length !== DEFAULT_WEIGHTS.length) return null;
  if (!weights.every(v => Number.isFinite(v) && v >= 0)) return null;
  return { v: WEIGHT_SCHEMA_VERSION, weights: weights.slice() };
}

/**
 * 加载用户 FSRS 权重（持久化于 db.meta['fsrsWeights']），无或不兼容则返回默认
 * 兼容两种入参：
 *   - 新版 { v: WEIGHT_SCHEMA_VERSION, weights: number[] }
 *   - 旧版裸数组（schema v1）→ 判定为不兼容，回退默认并交由调用方重新训练
 */
export function mergeUserWeights(stored) {
  const fallback = () => DEFAULT_WEIGHTS.slice();
  // 旧格式（裸数组）或任何非 v2 结构：一律回退默认
  if (Array.isArray(stored)) return fallback();
  if (!stored || stored.v !== WEIGHT_SCHEMA_VERSION) return fallback();
  const w = stored.weights;
  if (!Array.isArray(w) || w.length !== DEFAULT_WEIGHTS.length) return fallback();
  // 校验每个权重为有限正数，否则回退默认
  if (!w.every(v => Number.isFinite(v) && v >= 0)) return fallback();
  return w.slice();
}
