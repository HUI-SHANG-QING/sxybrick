// SRS 记忆曲线算法回归测试（node --test）
// 覆盖：评级路径、难度系数、错因惩罚、蒙对折损、强度系数、间隔上限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNext, GRADUATED_STEPS, applyFeedback } from '../src/srs.js';

const base = { level: 0, ease: 2.5 };

test('记住了：等级+1、ease 上升、间隔进入学习梯度', () => {
  const n = computeNext(base, 2, 1, false, {});
  assert.equal(n.level, 1);
  assert.ok(n.ease > 2.5);
  assert.equal(n.intervalDays, GRADUATED_STEPS[0]);
  assert.ok(n.dueAt > Date.now());
});

test('没记住：等级回退到 0、10 分钟后重学、ease 下降', () => {
  const n = computeNext({ level: 4, ease: 2.5 }, 0, 1, false, {});
  assert.equal(n.level, 2); // 遗忘回退 level-2
  assert.ok(n.intervalDays < 0.01); // 10 分钟级
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