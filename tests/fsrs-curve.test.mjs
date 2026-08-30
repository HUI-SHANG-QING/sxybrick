// tests/fsrs-curve.test.mjs —— FSRS 调度曲线的**行为级**回归（2026-08-30 P0 修复）
//
// 为什么要这个测试：权重是 19 个魔法数字，单元测试只逐个验证公式，
// 谁也不会发现「连按 4 次记住了 → 间隔跳到 365 天」这种组合出来的荒谬行为。
// 这里锁的是**端到端的可观察行为**：连续 good 的间隔序列必须落在合理区间。
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEIGHTS, MAX_STABILITY, schedule, stabilityAfterRecall, nextInterval, retrievability,
} from '../src/fsrs.js';

const DAY = 86400000;
// 关掉间隔抖动（w17=0），否则断言不可复现
const W = (() => { const w = DEFAULT_WEIGHTS.slice(); w[17] = 0; return w; })();

/** 模拟：一张卡每次都「到期当天复习 + 评分 rating」，返回间隔序列 */
function simulate(rating, n = 8, opts = {}) {
  let state = {};
  let now = opts.now ?? Date.now();
  const intervals = [];
  for (let i = 0; i < n; i++) {
    const r = schedule(state, rating, { weights: W, now, desiredRetention: 0.9 });
    state = { fsrs: r.fsrs, difficulty: 'basic' };
    intervals.push(r.intervalDays);
    now += Math.round(r.intervalDays * DAY);
  }
  return intervals;
}

test('P0 回归：连续 good 的间隔序列是「标准 FSRS 曲线」，不是 4 步跳到一年', () => {
  const seq = simulate(2, 8);
  // 修复前：2.4 → 14.7 → 73 → 305 → 365 → 365 …
  // 修复后：2.4 → 6.2 → 15.2 → 34.6 → 74.9 → 154.5 → 305 → 365
  assert.ok(seq[0] >= 1 && seq[0] <= 5, `首间隔应在 1~5 天，实际 ${seq[0]}`);
  for (let i = 1; i < 6; i++) {
    const ratio = seq[i] / seq[i - 1];
    assert.ok(ratio >= 1.2 && ratio <= 3.2,
      `第 ${i + 1} 步倍率应在 1.2~3.2（间隔增长过慢=永不毕业，过快=直接跳一年），实际 ${ratio.toFixed(2)}（${seq[i - 1].toFixed(1)}→${seq[i].toFixed(1)}）`);
  }
  // 关键回归点：第 4 次复习（index 3）不应已经触顶 365
  assert.ok(seq[3] < 100, `第 4 次复习间隔不应已经 >100 天，实际 ${seq[3].toFixed(1)}`);
  // 单调不减
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1] - 1e-9, `间隔必须单调不减：${seq[i - 1]} → ${seq[i]}`);
  }
});

test('方向性：again < hard < good（越不会越早复习）', () => {
  const base = { fsrs: { s: 20, d: 5, reps: 5, last: Date.now() - 20 * DAY } };
  const now = Date.now();
  const iv = (rating) => schedule(base, rating, { weights: W, now, desiredRetention: 0.9 }).intervalDays;
  const again = iv(0), hard = iv(1), good = iv(2);
  assert.ok(again < hard, `again(${again}) 必须小于 hard(${hard})`);
  assert.ok(hard < good, `hard(${hard}) 必须小于 good(${good})`);
  assert.ok(again <= 1, `again 应立刻重学（≤1 天），实际 ${again}`);
});

test('方向性：难度越高，同等评分下间隔越短', () => {
  const s = stabilityAfterRecall(20, 9, 0.9, 3, W); // 高难度 D=9
  const e = stabilityAfterRecall(20, 1, 0.9, 3, W); // 低难度 D=1
  assert.ok(s < e, `高难度卡的稳定度增长必须更慢：D=9 → ${s.toFixed(2)}，D=1 → ${e.toFixed(2)}`);
});

test('稳定度封顶：长期全对的卡 S 不会涨到离谱值', () => {
  let s = 20;
  for (let i = 0; i < 200; i++) s = stabilityAfterRecall(s, 1, 0.9, 3, W);
  assert.ok(s <= MAX_STABILITY, `S 必须封顶在 ${MAX_STABILITY}，实际 ${s}`);
  assert.ok(Number.isFinite(s), 'S 必须是有限值');

  // 端到端：连按 30 次 good，intervalDays 也绝不超过 365
  const seq = simulate(2, 30);
  for (const d of seq) assert.ok(d <= 365, `间隔上限 365 天被突破：${d}`);
});

test('可提取性 R 的语义：时间越久 R 越低，且恒在 (0,1]', () => {
  assert.ok(Math.abs(retrievability(10, 0) - 1) < 1e-9, '刚复习完 R=1');
  assert.ok(retrievability(10, 10) < retrievability(10, 1), '间隔越久 R 越低');
  assert.ok(retrievability(10, 1e9) > 0, 'R 恒 > 0');
  assert.ok(Number.isFinite(retrievability(0, 0)), 'S=0 不产生 NaN');
});

test('nextInterval：目标保持率越高 → 间隔越短；且恒在 [0.01, 365]', () => {
  assert.ok(nextInterval(20, 0.95, W) < nextInterval(20, 0.8, W), 'R* 越高间隔越短');
  for (const r of [0.5, 0.9, 0.99]) {
    const d = nextInterval(1e9, r, W);
    assert.ok(d <= 365 && d > 0, `超大 S 下的间隔必须被夹到 365 内，实际 ${d}`);
  }
  assert.ok(Number.isFinite(nextInterval(NaN, 0.9, W)), 'S=NaN 不产生 NaN');
});

test('NaN 污染不进入 dueAt（卡不会永久消失）', () => {
  for (const bad of [{ s: NaN, d: 5, reps: 3, last: Date.now() }, { s: 10, d: NaN, reps: 3, last: Date.now() }, { s: Infinity, d: 5, reps: 3, last: Date.now() }]) {
    const r = schedule({ fsrs: bad }, 2, { weights: W, now: Date.now() });
    assert.ok(Number.isFinite(r.dueAt), `dueAt 必须是有限值，实际 ${r.dueAt}`);
    assert.ok(Number.isFinite(r.intervalDays) && r.intervalDays > 0, `intervalDays 异常：${r.intervalDays}`);
  }
});
