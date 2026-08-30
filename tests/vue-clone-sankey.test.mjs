import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { treeToFlat, sankeyFromTree } from '../src/algorithms/mindmap-graph.js';

// 1) 复现联动分析 DataCloneError：Vue reactive proxy 不能被 IndexedDB structuredClone
test('reactive proxy 直接 structuredClone 会抛 DataCloneError（联动分析写库根因）', () => {
  const proxy = reactive({ id: '1', title: '会话', cardIds: '[]', updatedAt: Date.now() });
  assert.throws(() => structuredClone(proxy), (e) => e.name === 'DataCloneError');
  // dbRow 采用的脱壳姿势可克隆
  assert.doesNotThrow(() => structuredClone(JSON.parse(JSON.stringify(proxy))));
});

// 2) 桑基图「一串字母」根因：节点同时带 id 时 ECharts sankey 会把 id 当 label 文本。
//    因此 sankeyFromTree 必须产出「只含 name、不含 id」的节点，links 用 name 匹配。
test('sankeyFromTree 节点只含 name、links 用 name 匹配（堵住字母 bug）', () => {
  const root = {
    id: 'a1', label: '中心主题',
    children: [
      { id: 'b1', label: '子节点一', children: [] },
      { id: 'b2', label: '子节点二', children: [] },
    ],
  };
  const toChart = (n) => ({ name: n.label, id: n.id, children: (n.children || []).map(toChart) });
  const data = toChart(root);

  // 反例：treeToFlat 给的 nodes 带 id —— 旧代码直接喂 sankey 就会渲染字母
  const flat = treeToFlat(data);
  assert.ok(flat.nodes.every((n) => 'id' in n), 'treeToFlat 节点带 id（这是旧 bug 来源）');

  // 修复姿势
  const { nodes, links } = sankeyFromTree(data);
  assert.ok(nodes.every((n) => typeof n.name === 'string' && !('id' in n)), 'sankey 节点不应含 id');
  assert.deepEqual(nodes.map((n) => n.name), ['中心主题', '子节点一', '子节点二']);
  assert.deepEqual(links, [
    { source: '中心主题', target: '子节点一' },
    { source: '中心主题', target: '子节点二' },
  ]);
});

// 3) 同名节点在 treeToFlat 已合并，sankey 用 name 当键不会冲突
test('sankeyFromTree 同名节点合并后 link 指向合并名（无孤儿边）', () => {
  const root = {
    id: 'r', label: '根',
    children: [
      { id: 'x', label: '公共', children: [] },
      { id: 'y', label: '分支', children: [{ id: 'z', label: '公共', children: [] }] },
    ],
  };
  const toChart = (n) => ({ name: n.label, id: n.id, children: (n.children || []).map(toChart) });
  const { nodes, links } = sankeyFromTree(toChart(root));
  // 两个「公共」应合并成一个节点
  assert.equal(nodes.filter((n) => n.name === '公共').length, 1);
  const orphans = links.filter((l) => !nodes.some((n) => n.name === l.source) || !nodes.some((n) => n.name === l.target));
  assert.equal(orphans.length, 0, '不应有定位不到的孤儿边');
});
