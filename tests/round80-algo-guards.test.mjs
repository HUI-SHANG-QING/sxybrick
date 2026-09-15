// tests/round80-algo-guards.test.mjs —— round80 审计的算法层回归（A1~A5 独立复现验证后固化）
//
// 背景：并行审计对 src/algorithms/ 的 16 个分析类文件做了专项数学审计，报 1 P1 + 4 P2。
// 本轮**独立复现验证**后的更正与结论：
//   · A1 的「直接驱动调度策略」**不成立**——`calibrateFromStats` 的 50 样本门槛挡住了反馈链
//     （实测 n=2 / n=49 → 目标保持率保持 0.9 不变）。真实影响是**展示层与 AI 拿到误导性结论**，
//     故降级为 P2 但照样要修：数字照给，**结论与处方只在样本足够时给**。
//   · A2/A3/A4/A5 全部可复现（本文件即为它们的闸门）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { calibrationStats, MIN_STATS_SAMPLES } from '../src/algorithms/calibration.js';
import { calibrateFromStats } from '../src/algorithms/calibration-feedback.js';
import { goldenHours, MIN_HOURS_SAMPLES } from '../src/algorithms/golden-hours.js';
import { attributeMistakes } from '../src/algorithms/mistakeAttribution.js';

// ---------------- A1：小样本不给结论 ----------------

test('A1：样本不足时不下结论（数字照给，处方不给）', () => {
  const small = calibrationStats([{ predR: 0.9, rating: 0 }, { predR: 0.9, rating: 2 }]);
  assert.equal(small.n, 2);
  assert.equal(small.reliable, false, 'n=2 必须标记为不可靠');
  assert.equal(small.verdict, '样本不足', '不得输出「偏乐观/偏悲观」这种结论');
  assert.match(small.note, /样本太少/);
  assert.ok(!/应上调|可下调/.test(small.note), '不得给出"上调/下调目标保持率"这类处方');
  assert.equal(typeof small.bias, 'number', '偏差数字本身仍要给（客观统计量）');

  // 边界：门槛之上恢复正常结论
  const rows = [];
  for (let i = 0; i < MIN_STATS_SAMPLES; i += 1) rows.push({ predR: 0.95, rating: 0 });
  const big = calibrationStats(rows);
  assert.equal(big.reliable, true);
  assert.ok(big.verdict.includes('乐观'));
  assert.match(big.note, /上调/, '样本足够时应恢复处方');
});

test('A1-b：调度反馈链本就有 50 样本门槛（P1 定级不成立的关键证据）', () => {
  const small = calibrationStats([{ predR: 0.9, rating: 0 }, { predR: 0.9, rating: 2 }]);
  assert.equal(calibrateFromStats(0.9, small), 0.9, '小样本结论不得改变目标保持率（即不得改变复习间隔）');
  const rows49 = Array.from({ length: 49 }, (_, i) => ({ predR: 0.9, rating: i % 2 ? 0 : 2 }));
  assert.equal(calibrateFromStats(0.9, calibrationStats(rows49)), 0.9, 'n=49 仍被挡住');
  const rows50 = Array.from({ length: 50 }, (_, i) => ({ predR: 0.9, rating: i % 2 ? 0 : 2 }));
  assert.notEqual(calibrateFromStats(0.9, calibrationStats(rows50)), 0.9, 'n=50 门槛之上才允许反馈');
});

// ---------------- A2：rating 缺失不得当「遗忘」 ----------------

test('A2：rating 缺失/非法的行整行剔除，不得静默算成「遗忘」', () => {
  const rows = [
    { predR: 0.9, rating: undefined },
    { predR: 0.9, rating: null },
    { predR: 0.9, rating: NaN },
    { predR: 0.9, rating: '2' },
    { predR: 0.9, rating: 2 },   // 合法
    { predR: 0.9, rating: 2 },   // 合法
  ];
  const s = calibrationStats(rows);
  assert.equal(s.n, 2, '只有 rating 合法的 2 行参与统计');
  // 两条都是「记住」→ bias = 0.9 − 1 = −0.1（偏悲观）。若不剔除脏行，
  // 那条 undefined 会被当「遗忘」，bias 会被抬到 +0.4 这种假「乐观」结论。
  assert.ok(Math.abs(s.bias - (-0.1)) < 1e-9, '不得因脏行把 bias 抬成假乐观（实际 ' + s.bias + '）');
});

test('A2-b：rating=0 仍然是合法的「遗忘」（falsy 陷阱）', () => {
  const s = calibrationStats([
    { predR: 0.9, rating: 0 },
    { predR: 0.9, rating: 0 },
  ]);
  assert.equal(s.n, 2, 'rating=0 必须计入，不能被当缺失去掉');
  assert.ok(s.bias > 0.8, '两条都忘了 → 预测 0.9 实际 0 → bias 接近 0.9');
});

// ---------------- A3：黄金时段最小样本 ----------------

test('A3：1 条记录不得推出「建议安排在 X 点」的作息处方', () => {
  const h = new Array(24).fill(0); h[3] = 1;
  const r = goldenHours(h);
  assert.equal(r.hasData, true, '有 1 条数据仍算"有数据"');
  assert.equal(r.reliable, false);
  assert.ok(!/建议把复习安排在/.test(r.label), '单个样本不得产出作息建议');
  assert.match(r.label, /还太少/);
  assert.equal(r.peakHour, 3, '分布数字仍保留（客观统计）');

  const h2 = new Array(24).fill(0); h2[9] = MIN_HOURS_SAMPLES;
  const r2 = goldenHours(h2);
  assert.equal(r2.reliable, true);
  assert.match(r2.label, /建议把复习安排在/, '样本足够时恢复建议');
});

// ---------------- A4/A5：归因算法入参守卫 ----------------

test('A4：非数组入参不得崩溃（undefined/null/字符串都返回空数组）', () => {
  for (const bad of [undefined, null, 'x', 42, {}]) {
    assert.doesNotThrow(() => attributeMistakes(bad), `attributeMistakes(${String(bad)}) 不得抛错`);
    assert.deepEqual(attributeMistakes(bad), [], `attributeMistakes(${String(bad)}) 应返回空数组`);
  }
  // 单卡仍返回单簇（既有语义不变）
  const one = attributeMistakes([{ id: 'c1', front: '停止-等待协议', subject: '计网' }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].size, 1);
});

test('A5：卡片缺 front 时不得产出 "undefined" 概念名', () => {
  const clusters = attributeMistakes([
    { id: 'c1', back: 'B1', subject: '计算机网络', tags: [] },
    { id: 'c2', back: 'B2', subject: '计算机网络', tags: [] },
  ]);
  for (const c of clusters) {
    assert.notEqual(c.concept, 'undefined', '缺 front 不得让字符串 "undefined" 变成知识点名');
    assert.ok(!String(c.concept).includes('undefined'), `概念名不得含 undefined（实际 ${c.concept}）`);
  }
});
