// tests/networth.test.mjs —— 知识净值纯函数单测（Node 可测，不依赖浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentWeight, isReviewed, cardNetValue, cardIdealValue, computeNetWorth } from '../src/algorithms/networth.js';

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

test('isReviewed：NaN / Infinity / 非正数稳定度一律视为未复习（防 NaN 污染净值）', () => {
  // typeof NaN === 'number'，只查 typeof 会把它当成有效状态放进去，
  // 之后 retrievability → 单卡净值 → 全局总净值 → 按来源聚合全变 NaN，且不报错。
  for (const s of [NaN, Infinity, -Infinity, -1, 0]) {
    assert.equal(isReviewed(mkCard({ fsrs: { s, d: 5, reps: 3, last: NOW } })), false, `s=${s} 应视为未复习`);
  }
  assert.equal(isReviewed(mkCard({ fsrs: { s: 0.01, d: 5, reps: 3, last: NOW } })), true);
  // 端到端：含 NaN 的卡不得让总净值变成 NaN
  const nw = computeNetWorth([
    mkCard({ id: 'a', fsrs: { s: NaN, d: 5, reps: 3, last: NOW } }),
    mkCard({ id: 'b', fsrs: { s: 10, d: 5, reps: 3, last: NOW } }),
  ], NOW);
  assert.ok(Number.isFinite(nw.totalValue), `总净值不应是 NaN，实际 ${nw.totalValue}`);
  assert.ok(Number.isFinite(nw.retentionRate), `保持率不应是 NaN，实际 ${nw.retentionRate}`);
});

test('cardNetValue：未复习 = 0（不是全额）；刚复习 R=1 全额；9S 天 R=0.5 半额', () => {
  // ⚠️ 2026-08-30 修复：此前未复习卡按「原值全额」计（R 默认 1），
  //   于是导入 1000 张新卡 → 净值 1000+、知识保持率 100% ——
  //   「还没背过」被当成了「完全记住」。正确语义是 0：还没沉淀出任何已掌握的知识。
  assert.equal(cardNetValue(mkCard({ difficulty: 'challenge' }), NOW), 0, '未复习卡的净值为 0');
  // 原值（潜力）与净值分开：原值仍是 2
  assert.equal(cardIdealValue(mkCard({ difficulty: 'challenge' })), 2, '未复习卡仍有原值（潜力）');
  // 刚复习（elapsed=0）→ R=1 → 全额
  const justReviewed = mkCard({ fsrs: { s: 10, d: 5, reps: 2, last: NOW } });
  assert.equal(cardNetValue(justReviewed, NOW), 1);
  // 距上次复习 90 天（9*S=90）→ R=0.5 → 半额
  const half = mkCard({ fsrs: { s: 10, d: 5, reps: 2, last: NOW - 90 * DAY } });
  assert.equal(cardNetValue(half, NOW), 0.5);
});

test('computeNetWorth：汇总净值 / 保持率 / 状态分解', () => {
  const cards = [
    // 未复习 challenge+marked+source → 原值 2.7，净值 0（还没学过）
    mkCard({ id: 'a', subject: '计算机组成原理', difficulty: 'challenge', marked: true, source: '教材' }),
    // 已复习 basic，90 天前 → R=0.5 → 净值 0.5
    mkCard({ id: 'b', subject: '线性代数', fsrs: { s: 10, d: 5, reps: 2, last: NOW - 90 * DAY } }),
    // 刚复习 applied → R=1 → 净值 1.5
    mkCard({ id: 'c', subject: '操作系统', difficulty: 'applied', fsrs: { s: 10, d: 5, reps: 3, last: NOW } }),
  ];
  const r = computeNetWorth(cards, NOW);
  assert.equal(r.totalValue, 2.0);   // 0 + 0.5 + 1.5（未复习卡不计净值）
  assert.equal(r.idealValue, 5.2);   // 2.7 + 1.0 + 1.5（原值仍是全量潜力）
  assert.equal(r.reviewedIdeal, 2.5);// 1.0 + 1.5（保持率的分母 = 已学卡的原值）
  assert.equal(r.newIdeal, 2.7);     // 未学的潜力单列
  assert.equal(r.decayedValue, 0.5); // 已学部分的遗忘折旧
  assert.equal(r.retentionRate, 80); // round(2.0/2.5*100)=80
  assert.equal(r.newCount, 1);       // 卡 a 未复习
  assert.equal(r.reviewedCount, 2);
  assert.equal(r.masteredCount, 1);  // 只有卡 c R>=0.9
  assert.equal(r.totalCards, 3);
  // 按科目：三科各一条，按净值降序（未学的那科净值为 0，排最后）
  assert.equal(r.bySubject.length, 3);
  assert.equal(r.bySubject[0].subject, '操作系统');
  assert.equal(r.bySubject[0].value, 1.5);
  assert.equal(r.bySubject[0].retentionRate, 100);
  const newSubj = r.bySubject.find(s => s.subject === '计算机组成原理');
  assert.equal(newSubj.value, 0);
  assert.equal(newSubj.retentionRate, 0, '整科都没学过时保持率为 0，不是 100');
});

test('computeNetWorth：导入大量新卡不会虚增净值与保持率', () => {
  const newCards = Array.from({ length: 200 }, (_, i) => mkCard({ id: `n${i}` }));
  const r = computeNetWorth(newCards, NOW);
  assert.equal(r.totalValue, 0, '200 张全新卡 → 净值 0，不是 200+');
  assert.equal(r.retentionRate, 0, '一题没背过时保持率应为 0，不是 100%');
  assert.equal(r.newCount, 200);
  assert.ok(r.idealValue > 0, '原值（潜力）仍应统计出来');
});

test('computeNetWorth：空表与除零兜底', () => {
  const r = computeNetWorth([], NOW);
  assert.equal(r.totalValue, 0);
  assert.equal(r.retentionRate, 0);
  assert.equal(r.bySubject.length, 0);
});
