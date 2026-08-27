// tests/networth.test.mjs —— 知识净值纯函数单测（Node 可测，不依赖浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentWeight, isReviewed, cardNetValue, computeNetWorth } from '../src/algorithms/networth.js';

const DAY = 86400000;
const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime();

function mkCard(over = {}) {
  return {
    id: over.id ?? 'c1', front: 'f', back: 'b', subject: over.subject ?? '线性代数',
    difficulty: over.difficulty ?? 'basic', marked: over.marked ?? false,
    source: over.source ?? '', fsrs: over.fsrs ?? null,
    ...over,
  };
}

test('contentWeight：基础 1 + 难度/错题/来源加成', () => {
  assert.equal(contentWeight(mkCard()), 1);
  assert.equal(contentWeight(mkCard({ difficulty: 'applied' })), 1.5);
  assert.equal(contentWeight(mkCard({ difficulty: 'challenge' })), 2);
  assert.equal(contentWeight(mkCard({ marked: true })), 1.5);
  assert.equal(contentWeight(mkCard({ source: '教材' })), 1.2);
  assert.equal(contentWeight(mkCard({ difficulty: 'challenge', marked: true, source: '教材' })), 2.7);
});

test('isReviewed：有有效 fsrs 且 reps>=1 才算已复习', () => {
  assert.equal(isReviewed(mkCard()), false);
  assert.equal(isReviewed(mkCard({ fsrs: { s: 10, d: 5, reps: 0, last: NOW } })), false);
  assert.equal(isReviewed(mkCard({ fsrs: { s: 10, d: 5, reps: 1, last: NOW } })), true);
});

test('cardNetValue：未复习全额；刚复习 R=1 全额；9S 天 R=0.5 半额', () => {
  // 未复习 → 原值全额
  assert.equal(cardNetValue(mkCard({ difficulty: 'challenge' }), NOW), 2);
  // 刚复习（elapsed=0）→ R=1 → 全额
  const justReviewed = mkCard({ fsrs: { s: 10, d: 5, reps: 2, last: NOW } });
  assert.equal(cardNetValue(justReviewed, NOW), 1);
  // 距上次复习 90 天（9*S=90）→ R=0.5 → 半额
  const half = mkCard({ fsrs: { s: 10, d: 5, reps: 2, last: NOW - 90 * DAY } });
  assert.equal(cardNetValue(half, NOW), 0.5);
});

test('computeNetWorth：汇总净值 / 保持率 / 状态分解', () => {
  const cards = [
    // 未复习 challenge+marked+source → 原值 2.7，净值 2.7（全额）
    mkCard({ id: 'a', subject: '计算机组成原理', difficulty: 'challenge', marked: true, source: '教材' }),
    // 已复习 basic，90 天前 → R=0.5 → 净值 0.5
    mkCard({ id: 'b', subject: '线性代数', fsrs: { s: 10, d: 5, reps: 2, last: NOW - 90 * DAY } }),
    // 刚复习 applied → R=1 → 净值 1.5
    mkCard({ id: 'c', subject: '操作系统', difficulty: 'applied', fsrs: { s: 10, d: 5, reps: 3, last: NOW } }),
  ];
  const r = computeNetWorth(cards, NOW);
  assert.equal(r.totalValue, 4.7);   // 2.7 + 0.5 + 1.5
  assert.equal(r.idealValue, 5.2);   // 2.7 + 1.0 + 1.5
  assert.equal(r.decayedValue, 0.5); // 遗忘折旧
  assert.equal(r.retentionRate, 90); // round(4.7/5.2*100)=90
  assert.equal(r.newCount, 1);       // 卡 a 未复习
  assert.equal(r.reviewedCount, 2);
  assert.equal(r.masteredCount, 1);  // 只有卡 c R>=0.9
  assert.equal(r.totalCards, 3);
  // 按科目：三科各一条，按净值降序
  assert.equal(r.bySubject.length, 3);
  assert.equal(r.bySubject[0].subject, '计算机组成原理');
  assert.equal(r.bySubject[0].value, 2.7);
  assert.equal(r.bySubject[0].retentionRate, 100); // 未复习全额 → 保持率 100
});

test('computeNetWorth：空表与除零兜底', () => {
  const r = computeNetWorth([], NOW);
  assert.equal(r.totalValue, 0);
  assert.equal(r.retentionRate, 0);
  assert.equal(r.bySubject.length, 0);
});
