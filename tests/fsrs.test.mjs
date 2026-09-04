// FSRS-4.5 调度算法测试（纯函数、零依赖，直接 import src/fsrs.js）
// 覆盖：评分映射 / 可提取性方程 / 初始稳定度与难度 / 状态更新 / 间隔反解（含抖动与夹取）/
//       schedule 编排（首次复习、后续复习、遗忘重学、initialStability、now 注入）/
//       trainWeights（样本不足短路、训练输出契约）/ mergeUserWeights（持久化权重校验）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEIGHTS,
  toFsrsGrade,
  retrievability,
  initStability,
  initDifficulty,
  nextDifficulty,
  stabilityAfterRecall,
  stabilityAfterForget,
  nextInterval,
  schedule,
  trainWeights,
  mergeUserWeights,
  serializeUserWeights,
  WEIGHT_SCHEMA_VERSION,
} from '../src/fsrs.js';

const DAY = 24 * 60 * 60 * 1000;
const T = Date.UTC(2026, 7, 27); // 固定"现在"
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// nextInterval 内部用 Math.random 做抖动；stub 成 0.5 → fuzz 恒等于 1，可精确断言
function withStableFuzz(fn) {
  const orig = Math.random;
  Math.random = () => 0.5;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

// ---------- 评分映射 ----------

test('toFsrsGrade: SxyBrick rating → FSRS grade 映射', () => {
  assert.equal(toFsrsGrade(0), 1, '0 没记住 → again(1)');
  assert.equal(toFsrsGrade(1), 2, '1 还模糊 → hard(2)');
  assert.equal(toFsrsGrade(2), 3, '2 记住了 → good(3)');
});

// ---------- 可提取性方程 R = (1 + t/(9S))^-1 ----------

test('retrievability: t=0 时 R=1', () => {
  assert.ok(near(retrievability(2.4, 0), 1));
});

test('retrievability: t=9S 时 R=0.5（幂律半衰期特性）', () => {
  assert.ok(near(retrievability(1, 9), 0.5));
});

test('retrievability: 随经过时间单调递减、随稳定度单调递增', () => {
  const r1 = retrievability(5, 3);
  const r2 = retrievability(5, 10);
  assert.ok(r2 < r1, '同样稳定度，隔更久 → 更难提取');
  const r3 = retrievability(10, 3);
  assert.ok(r3 > r1, '同样时间，稳定度更高 → 更容易提取');
});

test('retrievability: 非法输入被下夹（S≤0.01、t<0）不产生 NaN', () => {
  const r = retrievability(-5, 9);
  assert.ok(Number.isFinite(r) && r > 0 && r < 1);
  assert.ok(near(retrievability(5, -100), 1), '负时间视为刚复习完');
});

// ---------- 初始状态 ----------

test('initStability: 四档初始稳定度取自默认权重', () => {
  assert.ok(near(initStability(1), 0.40), 'again → w0');
  assert.ok(near(initStability(2), 0.60), 'hard → w1');
  assert.ok(near(initStability(3), 2.40), 'good → w2');
  assert.ok(near(initStability(4), 2.40 * 5.80), 'easy → w2*w3');
});

test('initDifficulty: 越难评分初始难度越高，且被夹在 [1,10]', () => {
  const dAgain = initDifficulty(1);
  const dHard = initDifficulty(2);
  const dGood = initDifficulty(3);
  const dEasy = initDifficulty(4);
  assert.ok(dEasy < dGood && dGood < dHard && dHard < dAgain, 'easy < good < hard < again');
  for (const d of [dAgain, dHard, dGood, dEasy]) assert.ok(d >= 1 && d <= 10);
});

// ---------- 状态更新 ----------

test('nextDifficulty: easy 降难度、hard 升难度，并均值回归', () => {
  const dEasy = nextDifficulty(5, 4);
  const dGood = nextDifficulty(5, 3);
  const dHard = nextDifficulty(5, 2);
  assert.ok(dEasy < dGood && dGood < dHard, '评分越高难度越低');
  // good 档显式公式：D - w5*0 + w6*(w4 - D)
  const expected = 5 + DEFAULT_WEIGHTS[6] * (DEFAULT_WEIGHTS[4] - 5);
  assert.ok(near(dGood, expected), 'good 档公式精确成立');
});

test('nextDifficulty: 极端输入仍夹在 [1,10]', () => {
  for (const D of [1, 5, 10]) {
    for (const grade of [1, 2, 3, 4]) {
      const d = nextDifficulty(D, grade);
      assert.ok(d >= 1 && d <= 10, `D=${D}, grade=${grade} → ${d}`);
    }
  }
});

test('stabilityAfterRecall: 成功回忆使稳定度增长', () => {
  const S = 5, D = 5, R = 0.5;
  const next = stabilityAfterRecall(S, D, R, 3);
  assert.ok(next > S, `good 回忆后稳定度 ${next} 应大于 ${S}`);
  assert.ok(Number.isFinite(next));
});

test('stabilityAfterForget: 遗忘使稳定度大幅回落（重学）', () => {
  const next = stabilityAfterForget(5, 5, 0.5);
  assert.ok(next < 5, '遗忘后稳定度应显著小于原值');
  assert.ok(next >= 0.01, '下界保护');
});

// ---------- 间隔反解 t = 9S(1/R* - 1) ----------

test('nextInterval: 无抖动时等于解析解', () => {
  const days = withStableFuzz(() => nextInterval(10, 0.9));
  assert.ok(near(days, 10), `S=10, R*=0.9 → 10 天，实际 ${days}`);
});

test('nextInterval: desiredR 被夹到 [0.5, 0.99]', () => {
  const dLow = withStableFuzz(() => nextInterval(10, 0.1)); // 夹到 0.5
  assert.ok(near(dLow, 90), 'R*=0.1 → 按 0.5 计算 → 90 天');
});

test('nextInterval: 上下界夹取（≥0.01 天、≤365 天）', () => {
  const dMax = withStableFuzz(() => nextInterval(1000, 0.9));
  assert.ok(near(dMax, 365), '超长间隔夹到 365 天');
  const dMin = withStableFuzz(() => nextInterval(0.001, 0.99));
  assert.ok(near(dMin, 0.01), '极短间隔夹到 0.01 天');
});

test('nextInterval: 抖动被 w17 限定在 ±20% 内', () => {
  for (let i = 0; i < 50; i++) {
    const days = nextInterval(10, 0.9);
    assert.ok(days >= 8 && days <= 12, `抖动越界：${days}`);
  }
});

// ---------- schedule 编排 ----------

test('schedule: 首次复习·遗忘（rating=0）→ 极短间隔 + again 初始状态', () => {
  const r = schedule({}, 0, { now: T });
  assert.ok(near(r.fsrs.s, 0.40), 'S0 = w0');
  assert.ok(near(r.fsrs.d, 6.81, 1e-9), 'D0 = 4.93 + 2*0.94');
  assert.equal(r.fsrs.reps, 1);
  assert.ok(near(r.intervalDays, 0.01), '遗忘 → 立刻重学');
  assert.ok(Math.abs(r.dueAt - (T + 0.01 * DAY)) <= 1, 'dueAt = now + 0.01 天');
  assert.equal(r.level, 0, 'S<1 → level 0');
  assert.equal(r.consolidation, null, 'FSRS 不复用 SM-2 巩固状态机');
});

// D1（round11 审计）：opts.now=0 是合法 epoch 值，不应被 || 替换为 Date.now()
// 修复前：opts.now=0 → nowTs=Date.now()，破坏测试确定性
// 修复后：opts.now=0 → nowTs=0，fsrs.last 严格可预测
test('schedule: opts.now=0（合法 epoch）应保留为 0，不被替换为 Date.now()', () => {
  const r = schedule({}, 2, { now: 0 });
  assert.equal(r.fsrs.last, 0, 'nowTs=0 应原样落进 fsrs.last');
  // dueAt = 0 + intervalDays*DAY，与 now=Date.now() 时算出的 intervalDays 一致
  // rating=2 首次复习 intervalDays ≈ 2.67，dueAt = 0 + 2.67*DAY > 0
  assert.ok(r.dueAt > 0, 'dueAt > 0（基于 intervalDays > 0）');
  assert.ok(r.dueAt < 365 * 86400000, 'dueAt 一年内（合理性）');
});

test('schedule: opts.now=undefined 应回退到 Date.now()（?? 语义）', () => {
  const before = Date.now();
  const r = schedule({}, 2, {});
  const after = Date.now();
  // rating=2 首次复习 intervalDays ≈ 2.4，fsrs.last 应在 before..after 区间
  assert.ok(r.fsrs.last >= before && r.fsrs.last <= after, 'nowTs 落在调用前后');
});

test('schedule: 显式 desiredRetention=0 也不被替换（与 now=0 同口径 ??)', () => {
  // 间隔反解公式在 R*=0 时会爆炸（除零），但 intervalDays 兜底 ≥ 0.01（见 L197-198 夹取）
  const r = withStableFuzz(() => schedule({}, 2, { now: T, desiredRetention: 0 }));
  assert.ok(r.intervalDays >= 0.01, 'R*=0 时 interval 至少 0.01');
});

test('schedule: 首次复习·记住（rating=2）→ 按目标保持率反解间隔', () => {
  const r = withStableFuzz(() => schedule({}, 2, { now: T }));
  assert.ok(near(r.fsrs.s, 2.40), 'S0 = w2');
  assert.ok(near(r.fsrs.d, 4.93, 1e-9));
  assert.ok(near(r.intervalDays, 2.4), 'S=2.4, R*=0.9 → 2.4 天');
  assert.ok(Math.abs(r.dueAt - (T + 2.4 * DAY)) <= 1);
  assert.ok(r.ease >= 1.3 && r.ease <= 2.8, 'ease 夹取在 SM-2 兼容区间');
});

test('schedule: 后续复习·回忆成功 → 稳定度增长、reps 递增', () => {
  const card = { fsrs: { s: 2.4, d: 4.93, reps: 1, last: T - 9 * DAY } };
  const r = schedule(card, 2, { now: T });
  assert.ok(r.fsrs.s > 2.4, '9 天后成功回忆 → 稳定度增长');
  assert.equal(r.fsrs.reps, 2);
  assert.equal(r.fsrs.last, T, 'last 更新为本次复习时刻');
  assert.ok(r.fsrs.d >= 1 && r.fsrs.d <= 10);
  assert.ok(r.intervalDays > 0.01, '回忆成功不走极短间隔');
});

test('schedule: 后续复习·遗忘 → 稳定度回落、极短间隔重学', () => {
  const card = { fsrs: { s: 8, d: 5, reps: 3, last: T - DAY } };
  const r = schedule(card, 0, { now: T });
  assert.ok(r.fsrs.s < 8, '遗忘后稳定度回落');
  assert.ok(near(r.intervalDays, 0.01), '遗忘 → 立刻重学');
  assert.equal(r.fsrs.reps, 4);
});

test('schedule: opts.initialStability 冷启动前测优先于默认 S0', () => {
  const r = schedule({}, 2, { now: T, initialStability: 5 });
  assert.ok(near(r.fsrs.s, 5), '前测估计应覆盖默认 w2');
});

test('schedule: opts.weights 自定义权重生效', () => {
  const w = DEFAULT_WEIGHTS.slice();
  w[2] = 10; // good 初始稳定度改大为 10
  const r = withStableFuzz(() => schedule({}, 2, { now: T, weights: w }));
  assert.ok(near(r.fsrs.s, 10), '自定义 w2 应被采用');
  assert.ok(near(r.intervalDays, 10), 'S=10 → 10 天');
});

// ---------- ML 训练器 ----------

test('trainWeights: 样本不足（<8 条）短路返回默认权重', () => {
  const r = trainWeights([{ cardId: 'a', rating: 2, reviewedAt: T }], new Map());
  assert.deepEqual(r.weights, DEFAULT_WEIGHTS);
  assert.equal(r.loss, null);
  assert.equal(r.samples, 0);
});

test('trainWeights: 足量样本 → 19 维有限权重与有限损失', () => {
  // 2 张卡 × 各 5 次复习（首条初始化状态，后续 8 条贡献损失）
  const cardsById = new Map([
    ['a', { fsrs: null, createdAt: T - 30 * DAY }],
    ['b', { fsrs: null, createdAt: T - 30 * DAY }],
  ]);
  const reviews = [];
  for (const id of ['a', 'b']) {
    let t = T - 20 * DAY;
    for (let i = 0; i < 5; i++) {
      reviews.push({ cardId: id, rating: i % 3 === 0 ? 1 : 2, reviewedAt: t });
      t += 3 * DAY;
    }
  }
  const r = trainWeights(reviews, cardsById, { iters: 3 });
  assert.equal(r.weights.length, 19);
  assert.ok(r.weights.every((v) => Number.isFinite(v) && v >= 0.01), '投影约束：非负且下界 0.01');
  assert.ok(typeof r.loss === 'number' && Number.isFinite(r.loss), `loss 应为有限数，实际 ${r.loss}`);
  assert.ok(r.samples >= 8, '损失样本数应 >= 8');
});

// ---------- 持久化权重合并 ----------

test('mergeUserWeights: v2 结构合法 → 原样返回副本', () => {
  const weights = DEFAULT_WEIGHTS.map((v, i) => v + i * 0.01);
  const stored = { v: WEIGHT_SCHEMA_VERSION, weights };
  const merged = mergeUserWeights(stored);
  assert.deepEqual(merged, weights);
  assert.notEqual(merged, weights, '返回副本而非引用');
});

test('mergeUserWeights: 长度不符 / 含负值 / 含 NaN / 非 v2 → 回退默认', () => {
  assert.deepEqual(mergeUserWeights(null), DEFAULT_WEIGHTS);
  assert.deepEqual(mergeUserWeights([1, 2, 3]), DEFAULT_WEIGHTS, '长度不是 19');
  const withNeg = DEFAULT_WEIGHTS.slice(); withNeg[7] = -0.5;
  assert.deepEqual(mergeUserWeights(withNeg), DEFAULT_WEIGHTS, '含负值（裸数组，schema 不符）');
  const withNaN = DEFAULT_WEIGHTS.slice(); withNaN[3] = NaN;
  assert.deepEqual(mergeUserWeights(withNaN), DEFAULT_WEIGHTS, '含 NaN');
  // v2 结构但内容非法
  assert.deepEqual(
    mergeUserWeights({ v: WEIGHT_SCHEMA_VERSION, weights: DEFAULT_WEIGHTS.slice(0, 5) }),
    DEFAULT_WEIGHTS, 'v2 但长度不足');
  const v2NaN = DEFAULT_WEIGHTS.slice(); v2NaN[3] = NaN;
  assert.deepEqual(
    mergeUserWeights({ v: WEIGHT_SCHEMA_VERSION, weights: v2NaN }),
    DEFAULT_WEIGHTS, 'v2 但含 NaN');
  // 未来/未知版本
  assert.deepEqual(
    mergeUserWeights({ v: 999, weights: DEFAULT_WEIGHTS.slice() }),
    DEFAULT_WEIGHTS, '版本不匹配');
});

test('serializeUserWeights ↔ mergeUserWeights: 往返一致', () => {
  const w = DEFAULT_WEIGHTS.map((v, i) => v * (1 + i * 0.001));
  const packed = serializeUserWeights(w);
  assert.ok(packed && packed.v === WEIGHT_SCHEMA_VERSION);
  assert.deepEqual(mergeUserWeights(packed), w);
  // 非法输入返回 null（调用方据此跳过写入）
  assert.equal(serializeUserWeights(null), null);
  assert.equal(serializeUserWeights([1, 2, 3]), null);
  assert.equal(serializeUserWeights(DEFAULT_WEIGHTS.map(() => NaN)), null);
});

// ---------- P0 回归：hard/easy 方向 ----------
// 历史缺陷：w15=2.61 作"hard 惩罚"、w16=0.00 作"easy 加成"，导致
// 「还模糊」的下次间隔是「记住了」的 2.61 倍 —— 越不会的卡反而越晚复习。
test('P0 回归: hard 的间隔必须短于 good，good 短于 easy', () => {
  withStableFuzz(() => {
    const base = { fsrs: { s: 5, d: 5, reps: 3, last: T - 5 * DAY } };
    const hard = schedule(base, 1, { now: T }); // 还模糊 → grade 2
    const good = schedule(base, 2, { now: T }); // 记住了 → grade 3
    assert.ok(hard.intervalDays < good.intervalDays,
      `hard(${hard.intervalDays}) 必须 < good(${good.intervalDays})`);
    assert.ok(hard.fsrs.s < good.fsrs.s,
      `hard 稳定度(${hard.fsrs.s}) 必须 < good(${good.fsrs.s})`);
    // easy(grade 4) 由 schedule 内部不可达，直接验证稳定度更新函数
    const sHard = stabilityAfterRecall(5, 5, 0.9, 2);
    const sGood = stabilityAfterRecall(5, 5, 0.9, 3);
    const sEasy = stabilityAfterRecall(5, 5, 0.9, 4);
    assert.ok(sHard < sGood, `stabilityAfterRecall hard(${sHard}) < good(${sGood})`);
    assert.ok(sEasy > sGood, `stabilityAfterRecall easy(${sEasy}) > good(${sGood})`);
  });
});

test('P0 回归: 即便权重被拟合到异常值，hard 也不得反超 good（结构保证）', () => {
  // 模拟训练器把 w15 推到 5.0（远超 1）——钳制后 hard 仍应 ≤ good
  const bad = DEFAULT_WEIGHTS.slice();
  bad[15] = 5.0;
  bad[16] = 0.01; // easy 加成也被压到 <1
  const sHard = stabilityAfterRecall(5, 5, 0.9, 2, bad);
  const sGood = stabilityAfterRecall(5, 5, 0.9, 3, bad);
  assert.ok(sHard <= sGood + 1e-9, `w15=5 被钳制后 hard(${sHard}) 仍应 ≤ good(${sGood})`);
  // 权重为 NaN/Infinity 时不得污染结果
  const nan = DEFAULT_WEIGHTS.slice();
  nan[15] = NaN;
  assert.ok(Number.isFinite(stabilityAfterRecall(5, 5, 0.9, 2, nan)), 'w15=NaN 不产生 NaN');
});

// ---------- P0 回归：NaN 防护 ----------
// 历史缺陷：fsrs 状态含 NaN 时 typeof NaN === 'number' 通过校验，
// 一路传播到 dueAt=NaN，而 `dueAt <= now` 对 NaN 恒为 false → 卡片永久消失于复习队列。
test('P0 回归: 坏 fsrs 状态不得产生 NaN 的 dueAt', () => {
  withStableFuzz(() => {
    const cases = [
      { fsrs: { s: NaN, d: 5, reps: 3, last: T - DAY } },
      { fsrs: { s: 5, d: NaN, reps: 3, last: T - DAY } },
      { fsrs: { s: 5, d: 5, reps: 3, last: NaN } },
      { fsrs: { s: Infinity, d: 5, reps: 3, last: T - DAY } },
      { fsrs: { s: 5, d: 5, reps: NaN, last: T - DAY } },
    ];
    for (const c of cases) {
      for (const rating of [0, 1, 2]) {
        const r = schedule(c, rating, { now: T });
        assert.ok(Number.isFinite(r.dueAt), `dueAt 必须有限（${JSON.stringify(c.fsrs)}, rating=${rating}）`);
        assert.ok(Number.isFinite(r.intervalDays) && r.intervalDays > 0, 'intervalDays 必须为正有限值');
        assert.ok(Number.isFinite(r.fsrs.s), '新稳定度必须有限');
        assert.ok(Number.isFinite(r.fsrs.d), '新难度必须有限');
      }
    }
  });
});

test('P0 回归: 默认权重方向正确（w15<1 惩罚 / w16>1 加成）', () => {
  assert.ok(DEFAULT_WEIGHTS[15] < 1, `w15(${DEFAULT_WEIGHTS[15]}) 是 hard 惩罚，必须 <1`);
  assert.ok(DEFAULT_WEIGHTS[16] > 1, `w16(${DEFAULT_WEIGHTS[16]}) 是 easy 加成，必须 >1`);
});
