// round61 回归：调度算法的「设计不变量」——用极端/畸形状态验证核心性质不被破坏。
//
// 为什么用不变量而不是具体数值：具体数值会随权重演进失效，而下面这些是**设计承诺**：
//   ① 任何输入都不得产出 NaN/Infinity 的 dueAt —— 源码注释明确：`dueAt <= now` 对 NaN 恒 false，
//      该卡会**永久消失于复习队列**（静默丢卡，用户无从察觉）。
//   ② 间隔必须落在 [0.01, 365] 天内且为有限数。
//   ③ 单调性：评分越差间隔越短（again ≤ hard ≤ good）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, DEFAULT_WEIGHTS } from '../src/fsrs.js';
import { computeNext } from '../src/srs.js';

const NOW = Date.UTC(2026, 8, 15, 4, 0, 0);
const DAY = 86400000;

// 覆盖：正常 / 零值 / 负值 / 超大值 / NaN / Infinity / 字符串 / 缺字段
const FSRS_STATES = [
  undefined, null, {},
  { s: 1, d: 5, reps: 1, last: NOW - DAY },
  { s: 0, d: 0, reps: 1, last: NOW },
  { s: -5, d: -3, reps: 3, last: NOW - 10 * DAY },
  { s: 1e9, d: 1e9, reps: 1e6, last: NOW - 1e6 * DAY },
  { s: 0.001, d: 0.001, reps: 0, last: 0 },
  { s: NaN, d: 5, reps: 1, last: NOW },
  { s: 1, d: NaN, reps: 1, last: NOW },
  { s: 1, d: 5, reps: 1, last: NaN },
  { s: Infinity, d: 5, reps: 1, last: NOW },
  { s: '1', d: '5', reps: '1', last: NOW },
  { s: 1, d: 5, reps: -3, last: NOW + 999 * DAY }, // last 在未来
];

test('round61 算法不变量：任何卡片状态 × 任何评分 → dueAt 必须有限且在未来', () => {
  for (const fsrs of FSRS_STATES) {
    for (const rating of [0, 1, 2]) {
      const r = schedule({ id: 'x', front: 'f', back: 'b', fsrs }, rating, { now: NOW });
      const tag = `fsrs=${JSON.stringify(fsrs)} rating=${rating}`;
      assert.ok(r, `${tag}：应返回结果`);
      assert.ok(Number.isFinite(r.dueAt), `${tag}：dueAt 必须有限，实际 ${r.dueAt}（NaN 会让卡永久消失于队列）`);
      assert.ok(r.dueAt > NOW, `${tag}：dueAt 必须在未来，实际 ${r.dueAt} vs now=${NOW}`);
      assert.ok(Number.isFinite(r.intervalDays), `${tag}：intervalDays 必须有限，实际 ${r.intervalDays}`);
      assert.ok(r.intervalDays >= 0.01 && r.intervalDays <= 365, `${tag}：间隔越界 = ${r.intervalDays}`);
      assert.ok(Number.isFinite(r.fsrs?.s) && r.fsrs.s > 0, `${tag}：稳定度必须为有限正值，实际 ${r.fsrs?.s}`);
      assert.ok(Number.isFinite(r.fsrs?.d), `${tag}：难度必须有限，实际 ${r.fsrs?.d}`);
      assert.ok(Number.isFinite(r.fsrs?.reps) && r.fsrs.reps >= 1, `${tag}：reps 必须 ≥1，实际 ${r.fsrs?.reps}`);
    }
  }
});

test('round61 算法不变量：评分越差间隔越短（again ≤ hard ≤ good）', () => {
  const base = { id: 'x', front: 'f', back: 'b', fsrs: { s: 8, d: 5, reps: 5, last: NOW - 8 * DAY } };
  const iv = (rating) => schedule(base, rating, { now: NOW }).intervalDays;
  const again = iv(0), hard = iv(1), good = iv(2);
  assert.ok(again <= hard, `答错(${again}) 应 ≤ 困难(${hard})`);
  assert.ok(hard <= good, `困难(${hard}) 应 ≤ 良好(${good})`);
  assert.ok(again <= 1, `答错后应立刻重学（≤1 天），实际 ${again}`);
});

test('round61 算法不变量：desiredRetention=0 不得被误当成「未传」（?? 而非 ||）', () => {
  const card = { id: 'x', front: 'f', back: 'b', fsrs: { s: 8, d: 5, reps: 5, last: NOW - 8 * DAY } };
  const r0 = schedule(card, 2, { now: NOW, desiredRetention: 0 });
  const rDefault = schedule(card, 2, { now: NOW });
  assert.ok(Number.isFinite(r0.dueAt) && r0.dueAt > NOW, 'desiredRetention=0 也必须产出合法的未来 dueAt');
  assert.notEqual(r0.intervalDays, rDefault.intervalDays, '0 是合法取值，不应被 || 回退成默认 0.9');
});

test('round61 算法不变量：SM-2 computeNext 对畸形卡片同样不得产出非有限 dueAt', () => {
  // ⚠️ 刻意**不含 null/undefined**：那不是可达输入——repo.review 有
  //    `if (!card) throw new Error('卡片不存在')` 守卫（repo.js:947），
  //    凭空造一个不可达输入来"发现缺陷"是假阳性。
  //    这里只覆盖**可达**的畸形：字段缺失/NaN/越界/字符串/超大值。
  const CARDS = [
    {},
    { ease: NaN, level: NaN, intervalDays: NaN, reps: NaN },
    { ease: 1e9, level: 1e9, intervalDays: 1e9, reps: 1e9 },
    { ease: -99, level: -5, intervalDays: -7, reps: -2 },
    { ease: '2.5', level: '2', intervalDays: '3', reps: '1' },
    { difficulty: 'challenge' },
    { difficulty: 99 },
  ];
  for (const c of CARDS) {
    for (const rating of [0, 1, 2]) {
      const r = computeNext(c, rating, 1, false, { now: NOW });
      const tag = `card=${JSON.stringify(c)} rating=${rating}`;
      assert.ok(Number.isFinite(r.dueAt), `${tag}：dueAt 必须有限，实际 ${r.dueAt}`);
      assert.ok(r.dueAt > NOW, `${tag}：dueAt 必须在未来`);
      if (r.fsrs) assert.ok(Number.isFinite(r.fsrs.s), `${tag}：fsrs.s 必须有限`);
    }
  }
});
