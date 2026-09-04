// SRS 算法函数回归测试（node --test）
//
// 说明：本文件原计划测试 src/agent/analytics.js 的纯函数（getForgetRisk / getAssetHealth /
// 弱卡 / 易混对 / 六维画像等）。但 analytics.js 顶部 `import { db } from '../db.js'`，
// 而 db.js 用 Dexie(浏览器 IndexedDB)，每个导出函数都直接调用 db.* —— 在 Node 下无法
// 不依赖浏览器加载，因此按既定回退方案，改测 src/srs.js 中尚未被 srs.test.mjs 覆盖的算法：
//   1) wrongPenalty 枚举码（受控枚举，不再用中文子串嗅探）
//   2) wrongPenalty 中文回退（向后兼容旧数据包）
//   3) computeNext 中 consolidation 短期巩固状态机完整流程
//   4) computeNext 中 difficulty 难度梯度系数（basic/applied/challenge → 1.15/1.0/0.8）
//
// 注：wrongPenalty 是 srs.js 内部私有函数（未 export），但其在 computeNext 中对
// 「已毕业卡 + rating=2」的间隔施加：days = max(baseDays * wrongPenalty(reason), 10/1440)。
// 用输入 level=3：rating=2 后输出 level=4，lvl=4 命中 GRADUATED_STEPS[3] = 15 天，
// 远大于 10/1440，故 intervalDays / 15 = wrongPenalty(reason)，可间接精确验证惩罚系数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNext, GRADUATED_STEPS } from '../src/srs.js';

// 已毕业卡：输入 level=3 → 输出 level=4 → lvl=4 命中 GRADUATED_STEPS[3]=15 天，consolidation=null 触发错因惩罚
const grad = { level: 3, ease: 2.5 };
const TOL = 1e-9;

test('wrongPenalty 枚举码：CONCEPT_MIS=0.6 / MEMORY_WEAK=0.7 / CARELESS=0.9 / OTHER=1.0 / 空=1.0', () => {
  const base = computeNext(grad, 2, 1, false, { wrongReason: '' }).intervalDays;
  assert.ok(Math.abs(base - GRADUATED_STEPS[3]) < TOL, `base 应为 15 天，实得 ${base}`);
  const cases = [
    ['CONCEPT_MIS', 0.6],
    ['MEMORY_WEAK', 0.7],
    ['CARELESS', 0.9],
    ['OTHER', 1.0],
    ['', 1.0],
  ];
  for (const [reason, penalty] of cases) {
    const r = computeNext(grad, 2, 1, false, { wrongReason: reason }).intervalDays;
    const ratio = r / base;
    assert.ok(
      Math.abs(ratio - penalty) < TOL,
      `错因码 ${JSON.stringify(reason)} 期望惩罚 ${penalty}，实得 ${ratio}`,
    );
  }
  // 大小关系：概念混淆最重 < 记忆不牢 < 粗心 < 其他/空
  const concept = computeNext(grad, 2, 1, false, { wrongReason: 'CONCEPT_MIS' }).intervalDays;
  const memory = computeNext(grad, 2, 1, false, { wrongReason: 'MEMORY_WEAK' }).intervalDays;
  const careless = computeNext(grad, 2, 1, false, { wrongReason: 'CARELESS' }).intervalDays;
  assert.ok(concept < memory && memory < careless && careless <= base);
});

test('wrongPenalty 中文回退：概念混淆→0.6 / 粗心→0.9 / 记忆不牢→0.7（兼容旧数据）', () => {
  const base = computeNext(grad, 2, 1, false, { wrongReason: '' }).intervalDays;
  const cases = [
    ['概念混淆', 0.6],
    ['粗心', 0.9],
    ['记忆不牢', 0.7],
  ];
  for (const [reason, penalty] of cases) {
    const r = computeNext(grad, 2, 1, false, { wrongReason: reason }).intervalDays;
    const ratio = r / base;
    assert.ok(
      Math.abs(ratio - penalty) < TOL,
      `中文错因 ${reason} 期望 ${penalty}，实得 ${ratio}`,
    );
  }
  // 中文回退应与对应枚举码结果一致
  assert.equal(
    computeNext(grad, 2, 1, false, { wrongReason: '概念混淆' }).intervalDays,
    computeNext(grad, 2, 1, false, { wrongReason: 'CONCEPT_MIS' }).intervalDays,
  );
});

test('consolidation 状态机完整流程：新卡→阶段1(6h)→阶段2(隔日)→毕业(3天)→正常梯度', () => {
  // 阶段0：新卡首次答对 → 进入阶段1（当日 6 小时巩固），level 0→1
  let n = computeNext({ level: 0, ease: 2.5 }, 2, 1, false, {});
  assert.equal(n.level, 1);
  assert.equal(n.consolidation, 1);
  assert.ok(Math.abs(n.intervalDays - 6 / 24) < TOL); // 6 小时

  // 阶段1 完成（6h 后再答对）→ 进入阶段2，level 不变，隔日
  n = computeNext({ level: n.level, ease: n.ease, consolidation: n.consolidation }, 2, 1, false, {});
  assert.equal(n.level, 1); // 阶段2 不升级
  assert.equal(n.consolidation, 2);
  assert.equal(n.intervalDays, 1); // 隔日

  // 阶段2 完成（隔日再答对）→ 毕业，level +1 → 2，进入正常 3 天梯度
  n = computeNext({ level: n.level, ease: n.ease, consolidation: n.consolidation }, 2, 1, false, {});
  assert.equal(n.level, 2);
  assert.equal(n.consolidation, null); // 毕业退出短期巩固
  assert.equal(n.intervalDays, GRADUATED_STEPS[1]); // 3 天

  // 毕业后正常升级：level 2→3，7 天梯度，consolidation 保持 null
  n = computeNext({ level: n.level, ease: n.ease }, 2, 1, false, {});
  assert.equal(n.level, 3);
  assert.equal(n.consolidation, null);
  assert.equal(n.intervalDays, GRADUATED_STEPS[2]); // 7 天
});

test('consolidation 中断：阶段中评级 0/1 → 退出巩固回正常流程', () => {
  // 阶段1 中答"还模糊" → 退出巩固，1 天后复习
  const fuzzy = computeNext({ level: 1, ease: 2.5, consolidation: 1 }, 1, 1, false, {});
  assert.equal(fuzzy.consolidation, null);
  assert.equal(fuzzy.level, 1);
  assert.equal(fuzzy.intervalDays, 1);
  // 阶段2 中答"没记住" → 退出巩固、等级回退 level-2（下限 0）
  const forgot = computeNext({ level: 1, ease: 2.5, consolidation: 2 }, 0, 1, false, {});
  assert.equal(forgot.consolidation, null);
  assert.equal(forgot.level, 0);
  assert.ok(forgot.intervalDays >= 10/1440 && forgot.intervalDays <= 0.25); // D7: 遗忘间隔随 ease 变化
});

test('difficulty 难度系数：basic=1.15 / applied=1.0 / challenge=0.8', () => {
  // 已毕业卡（输入 level=3 → 输出 level=4）rating=2：base = GRADUATED_STEPS[3]=15 天，再乘 DIFF_FACTOR[difficulty]
  // 字符串梯度 P3-E：basic/applied/challenge → 0/1/2 → DIFF_FACTOR[1.15, 1.0, 0.8]
  const applied = computeNext(grad, 2, 1, false, { difficulty: 'applied' }).intervalDays;
  const basic = computeNext(grad, 2, 1, false, { difficulty: 'basic' }).intervalDays;
  const challenge = computeNext(grad, 2, 1, false, { difficulty: 'challenge' }).intervalDays;

  // 精确比例（用容差避开浮点尾差）
  assert.ok(Math.abs(basic / applied - 1.15) < TOL, `basic 应为 1.15，实得 ${basic / applied}`);
  assert.ok(Math.abs(applied / applied - 1.0) < TOL, 'applied 应为 1.0');
  assert.ok(Math.abs(challenge / applied - 0.8) < TOL, `challenge 应为 0.8，实得 ${challenge / applied}`);

  // 顺序：易 > 中 > 难
  assert.ok(basic > applied && applied > challenge);

  // 字符串梯度与数值梯度等价：basic ≡ difficulty=0、applied ≡ 1、challenge ≡ 2
  assert.equal(
    computeNext(grad, 2, 1, false, { difficulty: 'basic' }).intervalDays,
    computeNext(grad, 2, 1, false, { difficulty: 0 }).intervalDays,
  );
  assert.equal(
    computeNext(grad, 2, 1, false, { difficulty: 'challenge' }).intervalDays,
    computeNext(grad, 2, 1, false, { difficulty: 2 }).intervalDays,
  );
});
