// 用 echarts 真实的建图入口验证「边有没有被静默丢弃」
//
// 背景：ECharts 的 graph / sankey 系列都经过 createGraphFromNodeEdge，
// 节点注册键是 `retrieve(node.id, node.name, index)`——**只要节点带了 id，
// 边就只能按 id 匹配**；用 name 建边时 `graph.addEdge()` 查不到节点会静默 return，
// 既不抛错也不告警，表现为「节点全在、连线全无」。
// 这个坑编译器和类型检查都抓不到，只能对着真实实现验证，故留此测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { treeToFlat, sankeyNeedHeight } from '../src/algorithms/mindmap-graph.js';

const require = createRequire(import.meta.url);
let createGraphFromNodeEdge = null;
try {
  createGraphFromNodeEdge = require('echarts/lib/chart/helper/createGraphFromNodeEdge.js').default;
} catch {
  /* echarts 内部结构变更时跳过，不阻塞 CI */
}

const seriesModel = {
  get: (k) => (k === 'coordinateSystem' ? 'none' : undefined),
  getEncode: () => null,
  getSource: () => ({}),
  ecModel: {},
  option: {},
};

const TREE = {
  id: 'r', label: '操作系统', children: [
    { id: 'n1', label: '死锁', children: [{ id: 'n2', label: '银行家算法' }] },
    { id: 'n3', label: '调度' },
  ],
};

test('echarts 建图：treeToFlat 产出的每一条边都被真正建立（力导向/桑基不再散点）', (t) => {
  if (!createGraphFromNodeEdge) return t.skip('echarts 内部结构不可达');
  const { nodes, links } = treeToFlat(TREE);
  const g = createGraphFromNodeEdge(nodes, links, seriesModel, true);
  assert.equal(g.nodes.length, nodes.length);
  assert.equal(g.edges.length, links.length,
    `丢边了：期望 ${links.length} 条，实际建出 ${g.edges.length} 条`);
});

test('echarts 建图：反例——用 name 建边时全部被丢弃（守住这个坑不被改回去）', (t) => {
  if (!createGraphFromNodeEdge) return t.skip('echarts 内部结构不可达');
  const { nodes } = treeToFlat(TREE);
  const byName = new Map(nodes.map(n => [n.name, n]));
  const badLinks = [
    { source: '操作系统', target: '死锁' },
    { source: '操作系统', target: '调度' },
    { source: '死锁', target: '银行家算法' },
  ];
  const g = createGraphFromNodeEdge(nodes, badLinks, seriesModel, true);
  assert.equal(g.nodes.length, 4, '节点照样建出来（所以肉眼看不出异常）');
  assert.equal(g.edges.length, 0, '这正是「节点分离、没有关联」的成因：边被静默丢弃');
  assert.ok(byName.size === 4);
});

// round38：桑基图「太密集看不清」——容器高度随节点数撑高，防 nodeGap 被压没
test('sankeyNeedHeight：节点越多容器越高，降级阈值内返回 0，边界值稳定', (t) => {
  // 1) 小树（4 节点）→ 不低于 min-height 560
  assert.equal(sankeyNeedHeight(TREE), 560);
  // 2) 中等规模 → 随节点数增长（nodeGap 下限 14 区：h = 80 + n*(14+6)）
  const makeTree = (n) => {
    const children = [];
    for (let i = 0; i < n - 1; i++) children.push({ id: `c${i}`, name: `子节点${i}` });
    return { id: 'root', name: '根', children };
  };
  const h20 = sankeyNeedHeight(makeTree(20));
  const h50 = sankeyNeedHeight(makeTree(50));
  assert.ok(h50 > h20, `节点变多容器应更高：h50=${h50} <= h20=${h20}`);
  assert.ok(h20 > 560, '20 节点已超出 min-height，应被撑高');
  // 3) 超过降级阈值（>120 节点）→ 返回 0（视图层改走力导向，沿用默认高度）
  assert.equal(sankeyNeedHeight(makeTree(130)), 0);
  // 4) 上限 2400：n>50 时 gap 落回下限 14，h = 80 + 20n；n=117 → 2420 → 截断到 2400
  assert.equal(sankeyNeedHeight(makeTree(116)), 2400);
  assert.equal(sankeyNeedHeight(makeTree(117)), 2400);
  // 5) 非法输入不抛错
  assert.equal(sankeyNeedHeight(null), 560);
  assert.equal(sankeyNeedHeight({}), 560);
});
