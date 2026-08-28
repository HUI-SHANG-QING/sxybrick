// tests/source-trace.test.mjs —— 源→卡→数据全血缘纯函数单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSource, aggregateBySource, traceCardLineage, sourceOverview,
} from '../src/algorithms/source-trace.js';

const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime();
const DAY = 86400000;

function mkCard(over = {}) {
  return {
    id: over.id ?? 'c1', front: 'f', back: 'b', subject: 's',
    source: over.source ?? '', difficulty: 'basic', marked: false,
    dueAt: over.dueAt ?? NOW + 30 * DAY,
    fsrs: over.fsrs ?? null,
    sourceCardId: over.sourceCardId ?? '',
    ...over,
  };
}

test('normalizeSource：去首尾空格、压缩内部空白、限长 60', () => {
  assert.equal(normalizeSource('  考研  数学  '), '考研 数学');
  assert.equal(normalizeSource(''), '');
  assert.equal(normalizeSource('a'.repeat(100)).length, 60);
});

test('aggregateBySource：按来源聚合卡片/复习/到期/错题/净值', () => {
  const cards = [
    mkCard({ id: 'a', source: 'MOOC', fsrs: { s: 10, d: 5, reps: 2, last: NOW } }),        // 已复习
    mkCard({ id: 'b', source: 'MOOC', dueAt: NOW - DAY }),                                    // 到期未复习
    mkCard({ id: 'c', source: 'MOOC', marked: true }),                                        // 错题
    mkCard({ id: 'd', source: '真题' }),
  ];
  const agg = aggregateBySource(cards, NOW);
  assert.equal(agg.length, 2);
  const mooc = agg.find(a => a.source === 'MOOC');
  assert.equal(mooc.cards, 3);
  assert.equal(mooc.reviewed, 1);
  assert.equal(mooc.due, 1);
  assert.equal(mooc.marked, 1);
  assert.equal(mooc.mastery, 33); // 1/3 = 33%
  assert.equal(agg[0].source, 'MOOC'); // 按卡片数降序
});

test('aggregateBySource：无来源归入「（无来源）」', () => {
  const agg = aggregateBySource([mkCard({ id: 'a' }), mkCard({ id: 'b', source: '' })], NOW);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].source, '（无来源）');
  assert.equal(agg[0].cards, 2);
});

test('traceCardLineage：变式链 + 同源卡追溯', () => {
  const parent = mkCard({ id: 'p', source: 'MOOC' });
  const child1 = mkCard({ id: 'v1', source: 'MOOC', sourceCardId: 'p' }); // 变式
  const child2 = mkCard({ id: 'v2', source: 'MOOC', sourceCardId: 'p' }); // 变式
  const sibling = mkCard({ id: 's', source: 'MOOC' });                    // 同源（非变式）
  const other = mkCard({ id: 'o', source: '真题' });
  const cards = [parent, child1, child2, sibling, other];

  const t = traceCardLineage(parent, cards);
  assert.equal(t.source, 'MOOC');
  assert.equal(t.variantOf, null);
  assert.equal(t.variants.length, 2);
  assert.equal(t.sameSourceCount, 1); // 只有 sibling 是非变式的同源卡

  const tv = traceCardLineage(child1, cards);
  assert.equal(tv.variantOf, 'p');
  assert.equal(tv.variants.length, 2); // parent + child2（双向 sourceCardId）
});

test('sourceOverview：汇总来源数/变式数/无来源数', () => {
  const cards = [
    mkCard({ id: 'a', source: 'MOOC' }),
    mkCard({ id: 'b', source: 'MOOC', sourceCardId: 'a' }),
    mkCard({ id: 'c' }), // 无来源
  ];
  const o = sourceOverview(cards, NOW);
  assert.equal(o.totalSources, 2);   // MOOC + （无来源）
  assert.equal(o.variantCount, 1);
  assert.equal(o.untraced, 1);
});
