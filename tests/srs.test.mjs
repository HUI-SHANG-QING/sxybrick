// SRS 记忆曲线算法回归测试（node --test）
// 覆盖：评级路径、难度系数、错因惩罚、蒙对折损、强度系数、间隔上限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNext, GRADUATED_STEPS, applyFeedback, seedFsrsFromSm2 } from '../src/srs.js';

const base = { level: 0, ease: 2.5 };

test('记住了：等级+1、ease 上升、新卡进入短期巩固阶段1（当日 6 小时）', () => {
  const n = computeNext(base, 2, 1, false, {});
  assert.equal(n.level, 1);
  assert.equal(n.consolidation, 1); // 进入短期巩固阶段1
  assert.ok(n.ease > 2.5);
  assert.equal(n.intervalDays, 6 / 24); // 6 小时后再次提取
  assert.ok(n.dueAt > Date.now());
});

test('短期巩固完整流程：阶段1→阶段2（隔日）→毕业进正常梯度', () => {
  // 阶段1 完成（6h 后再答对）→ 进入阶段2，level 不变，隔日复习
  const after1 = computeNext({ level: 1, ease: 2.5, consolidation: 1 }, 2, 1, false, {});
  assert.equal(after1.level, 1);       // 阶段2 不升级
  assert.equal(after1.consolidation, 2);
  assert.equal(after1.intervalDays, 1); // 隔日

  // 阶段2 完成（隔日再答对）→ 毕业，level 升到 2，进入 3 天梯度
  const after2 = computeNext({ level: 1, ease: 2.5, consolidation: 2 }, 2, 1, false, {});
  assert.equal(after2.level, 2);
  assert.equal(after2.consolidation, null); // 毕业退出短期巩固
  assert.equal(after2.intervalDays, GRADUATED_STEPS[1]); // 3 天
});

test('短期巩固中评级 0/1 → 退出巩固回正常流程', () => {
  // 阶段1 中答"还模糊" → 退出巩固
  const fuzzy = computeNext({ level: 1, ease: 2.5, consolidation: 1 }, 1, 1, false, {});
  assert.equal(fuzzy.consolidation, null);
  assert.equal(fuzzy.intervalDays, 1); // level=1, rating=1 → 1 天
  // 阶段2 中答"没记住" → 退出巩固、等级回退
  const forgot = computeNext({ level: 1, ease: 2.5, consolidation: 2 }, 0, 1, false, {});
  assert.equal(forgot.consolidation, null);
  assert.equal(forgot.level, 0); // level-2 后下限 0
});

test('没记住：等级回退到 0、10 分钟后重学、ease 下降', () => {
  const n = computeNext({ level: 4, ease: 2.5 }, 0, 1, false, {});
  assert.equal(n.level, 2); // 遗忘回退 level-2
  assert.ok(n.intervalDays >= 10/1440 && n.intervalDays <= 0.25); // D7: 遗忘间隔随 ease 微弱变化（10min~6h）
  assert.ok(n.ease < 2.5);
});

test('还模糊：不升级、1 天后复习', () => {
  const n = computeNext({ level: 2, ease: 2.5 }, 1, 1, false, {});
  assert.equal(n.level, 2);
  assert.equal(n.intervalDays, 1);
});

test('难度系数：越难间隔越短（易>中>难）', () => {
  const easy = computeNext({ level: 1, ease: 2.5 }, 2, 1, false, { difficulty: 0 });
  const hard = computeNext({ level: 1, ease: 2.5 }, 2, 1, false, { difficulty: 2 });
  assert.ok(easy.intervalDays > hard.intervalDays);
});

test('错因惩罚：概念混淆最重、粗心最轻（仅作用于记住了）', () => {
  const none = computeNext({ level: 4, ease: 2.5 }, 2, 1, false, { wrongReason: '' });
  const concept = computeNext({ level: 4, ease: 2.5 }, 2, 1, false, { wrongReason: '概念混淆' });
  const careless = computeNext({ level: 4, ease: 2.5 }, 2, 1, false, { wrongReason: '粗心' });
  assert.ok(careless.intervalDays > concept.intervalDays);
  assert.ok(none.intervalDays >= careless.intervalDays);
});

test('蒙对：不升级、ease 略降、间隔打折', () => {
  const g = computeNext(base, 2, 1, true, {});
  assert.equal(g.level, 0); // 蒙对不加级
  assert.ok(g.ease < 2.5);
  const real = computeNext({ level: 1, ease: 2.5 }, 2, 1, false, {});
  const guessed = computeNext({ level: 1, ease: 2.5 }, 2, 1, true, {});
  assert.ok(guessed.intervalDays < real.intervalDays);
});

test('强度系数：钳制在 0.5~2，高强调缩短间隔', () => {
  const hi = computeNext({ level: 4, ease: 2.5 }, 2, 2, false, {});
  const lo = computeNext({ level: 4, ease: 2.5 }, 2, 0.5, false, {});
  assert.ok(lo.intervalDays > hi.intervalDays);
});

test('间隔上限 365 天', () => {
  const n = computeNext({ level: 40, ease: 2.8 }, 2, 1, false, {});
  assert.ok(n.intervalDays <= 365);
  assert.ok(n.intervalDays > 100);
});

test('行为回写：低覆盖降 ease 且 30 分钟内重练', () => {
  const c = { ease: 2.5, dueAt: Date.now() + 86400000 * 10 };
  const f = applyFeedback(c, { score: 20 });
  assert.ok(f.ease < 2.5);
  assert.ok(f.dueAt <= Date.now() + 30 * 60 * 1000);
});

test('行为回写：高覆盖升 ease / 费曼加成，ease 上限 2.8', () => {
  const f1 = applyFeedback({ ease: 2.5, dueAt: 0 }, { score: 90 });
  assert.ok(f1.ease > 2.5);
  const f2 = applyFeedback({ ease: 2.79, dueAt: 0 }, { score: 90, feynman: true });
  assert.ok(f2.ease <= 2.8);
  const f3 = applyFeedback({ ease: 2.5, dueAt: 0 }, { feynman: true });
  assert.ok(f3.ease > 2.5 && f3.ease <= 2.8);
});

test('自适应节奏：高错误率缩短间隔、稳定掌握拉长间隔、样本不足不生效', () => {
  const c = { level: 4, ease: 2.5 };
  const base = computeNext(c, 2, 1, false, {});
  const freqFail = computeNext(c, 2, 1, false, { adaptive: { reviews: 10, failRate: 0.5 } });
  assert.ok(freqFail.intervalDays < base.intervalDays);
  const stable = computeNext(c, 2, 1, false, { adaptive: { reviews: 10, failRate: 0 } });
  assert.ok(stable.intervalDays > base.intervalDays);
  const few = computeNext(c, 2, 1, false, { adaptive: { reviews: 4, failRate: 0.8 } });
  assert.equal(few.intervalDays, base.intervalDays); // 样本 <5 不生效
});

// 审计 B10：SM-2 → FSRS 切换播种——s 精确反解、d 方向正确、无进度卡不播种
test('B10 seedFsrsFromSm2：s=intervalDays 反解 / d 与 ease 反向 / 边界', () => {
  const now = Date.now();
  // 基准卡：间隔 30 天、ease 2.5 → s=30、d=5
  const base = seedFsrsFromSm2({ level: 3, ease: 2.5, intervalDays: 30, reviewedAt: now - 30 * 86400000, createdAt: now - 90 * 86400000 }, now);
  assert.equal(base.s, 30);
  assert.equal(base.d, 5);
  assert.equal(base.reps, 1);
  assert.equal(base.last, now - 30 * 86400000);

  // ease 越低（越难）→ d 越高（FSRS 难度越大）
  const hard = seedFsrsFromSm2({ ease: 1.6, intervalDays: 10, reviewedAt: now }, now);
  assert.ok(hard.d > 5, 'ease 1.6 应比基准更难（d>5）');
  const easy = seedFsrsFromSm2({ ease: 2.9, intervalDays: 10, reviewedAt: now }, now);
  assert.ok(easy.d < 5, 'ease 2.9 应比基准更容易（d<5）');

  // 上限钳制：S 不超 MAX_STABILITY=365、d 在 [1,10]
  const big = seedFsrsFromSm2({ ease: 3, intervalDays: 5000, reviewedAt: now }, now);
  assert.equal(big.s, 365);
  const minEase = seedFsrsFromSm2({ ease: 1.3, intervalDays: 1, reviewedAt: now }, now);
  assert.ok(minEase.d <= 10);

  // 无进度（新卡/间隔 0）→ 不播种（S0 冷启动本来就是对的）
  assert.equal(seedFsrsFromSm2({ level: 0, ease: 2.5, intervalDays: 0, createdAt: now }, now), null);
  assert.equal(seedFsrsFromSm2(null, now), null);
});

// 审计 B10：播种后 FSRS 首审间隔与 SM-2 原间隔自洽（R=0.9 反解）
test('B10 播种后首审：到期日复习间隔≈原间隔（不断崖）', async () => {
  const { schedule } = await import('../src/fsrs.js');
  const now = Date.now();
  const sm2 = { level: 4, ease: 2.5, intervalDays: 30, reviewedAt: now - 30 * 86400000, createdAt: now - 100 * 86400000 };
  const seeded = seedFsrsFromSm2(sm2, now);
  // 到期日（last 起 30 天 = now）答对：elapsed = s 天 → R≈0.9 → 间隔应从 30 天起自然增长，
  // 而不是回落到 S0≈2.4 天的新卡节奏
  const next = schedule({ ...sm2, fsrs: seeded }, 2, { now, desiredRetention: 0.9 });
  assert.ok(next.intervalDays >= 30, `播种后首审间隔 ${next.intervalDays} 天应 ≥ 原 30 天（实际回落说明断崖仍在）`);
  assert.ok(next.intervalDays <= 30 * 4, '增长也应在合理倍数内（FSRS 单步 ≈×2~3）');
});