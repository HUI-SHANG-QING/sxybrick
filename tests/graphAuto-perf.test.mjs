// 自动建图的性能护栏：2591 张卡的量级下不能卡死主线程
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates } from '../src/algorithms/graphAuto.js';
import { tokenize } from '../src/algorithms/mistakeAttribution.js';

function makeCards(n) {
  const topics = ['死锁', '进程', '调度', '二叉树', '遍历', '图', '矩阵', '特征值', 'TCP', '路由', '指令', 'Cache'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = topics[i % topics.length];
    const b = topics[(i * 7 + 3) % topics.length];
    out.push(`card-${i} ${a}与${b}的关系是什么？ ${a}指的是${b}在系统中的作用，注意适用条件与常见误区。`);
  }
  return out;
}

test('2591 张卡：既跑得动，又不能因为过滤热门词而一条边都建不出来', () => {
  const texts = makeCards(2591);
  const sets = new Map(texts.map((t, i) => [`c${i}`, new Set(tokenize(t))]));

  const t0 = Date.now();
  const cand = buildCandidates(sets, { maxDf: 600, maxPairs: 300000 });
  const dt = Date.now() - t0;

  console.log(`    候选对 ${cand.size} 组，耗时 ${dt}ms`);
  // 全量两两比对是 2591*2590/2 ≈ 335 万对、每对一次集合交集 → 会卡死主线程
  assert.ok(dt < 5000, `倒排索引后仍耗时 ${dt}ms，算法退化了`);
  // 召回护栏：学科高频词（出现在几百张卡上）不能被整词丢弃，否则图谱一条边都没有
  assert.ok(cand.size > 1000, `只产出 ${cand.size} 组候选对——热门词被过滤过头了`);
});

test('冷门词优先：预算耗尽前，高区分度的配对一定先进来', () => {
  // 2 张冷门卡共享一个独有词；另有 300 张卡共享一个热门词
  const sets = new Map([['r1', new Set(['冷门术语'])], ['r2', new Set(['冷门术语'])]]) ;
  for (let i = 0; i < 300; i++) sets.set(`h${i}`, new Set(['热门词', 'u' + i]));
  const cand = buildCandidates(sets, { maxDf: 600, maxPairs: 500 });
  assert.equal(cand.get('r1|r2'), 1, '冷门词配对应优先于热门词进入预算');
});

test('候选对规模受 maxPairs 约束，不会随卡量平方爆炸', () => {
  const sets = new Map();
  // 所有卡共享同一批词 → 最坏情况（完全连通）
  for (let i = 0; i < 800; i++) sets.set(`c${i}`, new Set(['共同词一', '共同词二', '共同词三', 'uniq' + i]));
  const cand = buildCandidates(sets, { maxDf: 1000, maxPairs: 50000 });
  assert.ok(cand.size <= 50000 + 1000, `候选对 ${cand.size} 超出上限`);
});
