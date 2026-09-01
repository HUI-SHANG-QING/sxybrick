// 知识图谱「ID 空间统一」回归测试
// 守住两类隐蔽故障：
//   1) 卡片ID 型边（from/to = UUID）与标签型边混存时，图谱必须收敛到同一套节点
//   2) ECharts 建图时「节点带 id → 边只能按 id 匹配」，用 name 建边会静默丢掉全部连线
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cardLabel, looksLikeRawId, resolveEdgeEnds, resolveGraph, edgesToForest, normalizeGraphEnds,
} from '../src/algorithms/graph-resolve.js';
import { treeToFlat, verifyLinks } from '../src/algorithms/mindmap-graph.js';
import { resolvePrereqPlan, kindOfEdge } from '../src/algorithms/prereq.js';
import { buildCandidates, nodeLabelOf } from '../src/algorithms/graphAuto.js';
import { SYNC_TABLES, shouldExportRow } from '../src/sync-manifest.js';

const C1 = { id: 'c33308d6-c106-48b9-a057-f39783ebf750', front: '死锁产生的四个必要条件', subject: '操作系统' };
const C2 = { id: 'mt8j0q35qzd4wkyf', front: '银行家算法的安全性判定', subject: '操作系统' };
const C3 = { id: 'aaaa1111-2222-3333-4444-555566667777', front: '二叉树的先序遍历', subject: '数据结构' };
const CARDS = [C1, C2, C3];

test('looksLikeRawId: 能识别 UUID 与旧版 base36 时间戳 id，但不误伤中文节点名', () => {
  assert.equal(looksLikeRawId(C1.id), true);
  assert.equal(looksLikeRawId('mt8j0q35qzd4wkyf'), true);
  assert.equal(looksLikeRawId('死锁产生的四个必要条件'), false);
  assert.equal(looksLikeRawId('📄 操作系统讲义.pdf'), false);
  assert.equal(looksLikeRawId(''), false);
});

test('cardLabel: 长文本按 30 字截断，与 recommendGraphEdges 口径一致', () => {
  assert.equal(cardLabel(C1), '死锁产生的四个必要条件');
  const long = { front: '一'.repeat(50) };
  assert.equal(cardLabel(long).length, 30);
});

test('resolveEdgeEnds: 优先用 fromCardId/toCardId 反查卡片正文', () => {
  const byId = new Map(CARDS.map(c => [c.id, c]));
  const r = resolveEdgeEnds(
    { from: '随便写的旧值', to: '另一个旧值', fromCardId: C1.id, toCardId: C2.id },
    byId,
  );
  assert.equal(r.fromLabel, C1.front);
  assert.equal(r.toLabel, C2.front);
  assert.equal(r.subject, '操作系统');
  assert.equal(r.fromMissing, false);
});

test('resolveEdgeEnds: 兼容历史脏数据——from/to 就是卡片 id 且没写 cardId 字段', () => {
  // 这正是用户库里那 2591 条边的形态：老版 graphAuto 把 UUID 直接写进 from/to
  const byId = new Map(CARDS.map(c => [c.id, c]));
  const r = resolveEdgeEnds({ from: C1.id, to: C2.id }, byId);
  assert.equal(r.fromLabel, C1.front);
  assert.equal(r.toLabel, C2.front);
  assert.equal(r.subject, '操作系统');
  assert.equal(r.fromMissing, false, '能在卡片表里查到就不该算失效');
});

test('resolveEdgeEnds: 卡片已删除 → 判定失效', () => {
  const byId = new Map(CARDS.map(c => [c.id, c]));
  const r = resolveEdgeEnds({ from: C1.id, to: C2.id, fromCardId: C1.id, toCardId: 'deleted-id' }, byId);
  assert.equal(r.toMissing, true);
});

test('resolveGraph: 卡片ID 型边 与 标签型边 收敛到同一节点（核心修复）', () => {
  const raw = [
    // 标签型（智能推荐 / AI 生成）
    { id: 'e1', from: C1.front, to: C2.front, fromCardId: C1.id, toCardId: C2.id, label: '相关', subject: '操作系统' },
    // 卡片ID 型（老版 graphAuto）
    { id: 'e2', from: C2.id, to: C3.id, label: '相关', kind: 'auto' },
  ];
  const { nodes, edges, stats } = resolveGraph(raw, CARDS);
  const names = nodes.map(n => n.label).sort();
  assert.deepEqual(names, [C1.front, C2.front, C3.front].sort(), '三种写法必须收敛成 3 个节点，而不是 5 个');
  assert.equal(edges.length, 2);
  assert.equal(stats.missing, 0);
  // C2 同时被两种写法引用 → 图是连通的（度=2）
  // round15 P2：edges.from/to 是节点键（cardId 优先），不再是 label 文本
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) || 0) + 1);
    deg.set(e.to, (deg.get(e.to) || 0) + 1);
  }
  assert.equal(deg.get(C2.id), 2, 'C2 是两条边的桥梁 → 说明两套 ID 空间真的打通了（端点键=cardId）');
});

test('resolveGraph: subject 从卡片补回，不再全落「未分类」', () => {
  const raw = [{ id: 'e1', from: C1.id, to: C3.id }]; // 老版：无 subject 字段
  const { edges } = resolveGraph(raw, CARDS);
  // 两端跨科目，取起点科目
  assert.equal(edges[0].subject, '操作系统');
});

test('resolveGraph: 失效边默认排除，开关可保留', () => {
  const raw = [
    { id: 'ok', from: C1.front, to: C2.front, fromCardId: C1.id, toCardId: C2.id },
    { id: 'dead', from: '已删除卡片-1', to: '已删除卡片-2', fromCardId: 'gone-1', toCardId: 'gone-2' },
  ];
  const a = resolveGraph(raw, CARDS);
  assert.equal(a.edges.length, 1);
  assert.equal(a.stats.missing, 1);
  const b = resolveGraph(raw, CARDS, { includeMissing: true });
  assert.equal(b.edges.length, 2);
});

test('resolveGraph: 资料边（📄 前缀）不被误判为失效', () => {
  const raw = [{ id: 'd1', from: '📄 操作系统讲义.pdf', to: C1.front, toCardId: C1.id, label: '涵盖', type: 'doc-card', docId: 'doc-1' }];
  const { edges, stats } = resolveGraph(raw, CARDS);
  assert.equal(stats.missing, 0);
  assert.equal(edges[0].from, '📄 操作系统讲义.pdf');
});

test('edgesToForest: 有环不丢节点、不死循环', () => {
  const edges = [
    { from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' }, // 三元环
    { from: 'D', to: 'A' },
  ];
  const { root } = edgesToForest(edges);
  const seen = new Set();
  (function walk(n) { if (!n) return; seen.add(n.name); (n.children || []).forEach(walk); })(root);
  for (const n of ['A', 'B', 'C', 'D']) assert.ok(seen.has(n), `${n} 不该被环吞掉`);
});

test('edgesToForest: 森林（多根）会包一层虚拟根', () => {
  const { root, virtual } = edgesToForest([{ from: 'A', to: 'B' }, { from: 'C', to: 'D' }]);
  assert.equal(virtual, true);
  assert.equal(root.children.length, 2);
});

test('edgesToForest: labelMap 把键翻译回显示名（R16-2，P2-7 后 from/to 是 cardId 的回归锚点）', () => {
  // resolveGraph 输出：from/to = 稳定键（cardId 优先），nodes = [{id, label}]
  const cards = [
    { id: 'card-1', front: '死锁的四个必要条件' },
    { id: 'card-2', front: '银行家算法' },
  ];
  const raw = [
    { id: 'e1', from: '死锁的四个必要条件', to: '银行家算法', fromCardId: 'card-1', toCardId: 'card-2', label: '相关', subject: 'OS' },
  ];
  const { edges, nodes } = resolveGraph(raw, cards);
  const labelMap = new Map((nodes || []).map(n => [n.id, n.label]));
  const { root, virtual } = edgesToForest(edges, { rootLabel: '📚 知识图谱', labelMap });
  assert.equal(virtual, false, '单条边不成森林');
  // 节点显示名必须是中文 label，绝不能是 cardId 内部键
  assert.equal(root.name, '死锁的四个必要条件', '根节点显示 label 而非 cardId');
  assert.equal(root.children[0].name, '银行家算法', '子节点显示 label 而非 cardId');
  // 不传 labelMap 时退回字面量（保持旧行为）
  const { root: rawRoot } = edgesToForest(edges);
  assert.equal(rawRoot.name, 'card-1', '无 labelMap 时键字面量原样（即 R16-2 修复前的表现）');
});

// ---------- ECharts graph 端点归一化 ----------

test('normalizeGraphEnds: AI 用节点名建边时，自动映射回 id（否则边会被 echarts 静默丢弃）', () => {
  const nodes = [
    { id: 'card-1', name: '死锁的四个必要条件' },
    { id: 'card-2', name: '银行家算法' },
  ];
  // LLM 常常不按要求返回 id，而是返回语义名
  const { edges, dropped } = normalizeGraphEnds(nodes, [
    { source: '死锁的四个必要条件', target: '银行家算法', label: '相关' },
  ]);
  assert.equal(dropped, 0);
  assert.equal(edges[0].source, 'card-1');
  assert.equal(edges[0].target, 'card-2');
  assert.equal(edges[0].label, '相关', '其余字段要保留');
});

test('normalizeGraphEnds: 本地分析器用 id 建边时原样通过', () => {
  const nodes = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }];
  const { edges, dropped } = normalizeGraphEnds(nodes, [{ source: 'a', target: 'b' }]);
  assert.equal(dropped, 0);
  assert.deepEqual([edges[0].source, edges[0].target], ['a', 'b']);
});

test('normalizeGraphEnds: 定位不到的边被计数剔除，不产生悬空端点', () => {
  const nodes = [{ id: 'a', name: '甲' }];
  const { edges, dropped } = normalizeGraphEnds(nodes, [
    { source: 'a', target: '不存在的节点' },
    { source: '甲', target: 'a' },
  ]);
  assert.equal(dropped, 1);
  assert.equal(edges.length, 1);
  assert.deepEqual([edges[0].source, edges[0].target], ['a', 'a']);
});

test('normalizeGraphEnds: 节点只有 name 没有 id 时，退化为按 name 连接', () => {
  const nodes = [{ name: '甲' }, { name: '乙' }];
  const { edges, dropped } = normalizeGraphEnds(nodes, [{ source: '甲', target: '乙' }]);
  assert.equal(dropped, 0);
  assert.deepEqual([edges[0].source, edges[0].target], ['甲', '乙']);
});

// ---------- 导图建边：ECharts 的静默丢边坑 ----------

test('treeToFlat: 每条 link 的两端都能按 id 在 nodes 里找到（ECharts 建图口径）', () => {
  const tree = {
    id: 'n1', label: '操作系统', children: [
      { id: 'n2', label: '死锁', children: [{ id: 'n3', label: '银行家算法' }] },
      { id: 'n4', label: '调度' },
    ],
  };
  const { nodes, links } = treeToFlat(tree);
  assert.equal(nodes.length, 4);
  assert.equal(links.length, 3);
  const v = verifyLinks(nodes, links);
  assert.equal(v.ok, true, `存在悬空边: ${JSON.stringify(v.orphans)}`);
});

test('treeToFlat: 同名节点合并后，边指向保留下来的那个节点（不产生悬空边）', () => {
  const tree = {
    id: 'r', label: '根', children: [
      { id: 'a', label: '同名', children: [{ id: 'c1', label: '叶1' }] },
      { id: 'b', label: '同名', children: [{ id: 'c2', label: '叶2' }] },
    ],
  };
  const { nodes, links } = treeToFlat(tree);
  // 根 + 「同名」合并成 1 个 + 叶1 + 叶2 = 4；不合并则是 5
  assert.equal(nodes.length, 4, '两个「同名」应合并为 1 个节点');
  assert.equal(nodes.filter(n => n.name === '同名').length, 1);
  const v = verifyLinks(nodes, links);
  assert.equal(v.ok, true, `同名合并后出现了悬空边: ${JSON.stringify(v.orphans)}`);
  // 叶1、叶2 的边都要挂在合并后那个「同名」节点上（而不是各挂一个互不相干的副本）
  const sameNode = nodes.find(n => n.name === '同名');
  const fromSame = links.filter(l => l.source === sameNode.id).map(l => l.target).sort();
  const leaves = nodes.filter(n => /^叶/.test(n.name)).map(n => n.id).sort();
  assert.deepEqual(fromSame, leaves);
});

test('treeToFlat: 历史导图缺 id 时自动补齐，不会退化成 undefined 端点', () => {
  const tree = { label: '根', children: [{ label: '子' }] };
  const { nodes, links } = treeToFlat(tree);
  for (const n of nodes) assert.ok(n.id, '节点 id 不能为空');
  assert.equal(verifyLinks(nodes, links).ok, true);
});

// ---------- 前置依赖回溯：跨 ID 空间 ----------

test('resolvePrereqPlan: 卡片ID 型边与 cardId 字段型边都能回溯', () => {
  const mastered = new Set();
  const edges = [
    { from: 'P', to: 'X', kind: 'prereq' },                                        // 老写法
    { from: 'Q', to: 'P', fromCardId: 'Q', toCardId: 'P', kind: 'prereq' },        // 新写法
  ];
  const r = resolvePrereqPlan(edges, mastered, 'X');
  assert.deepEqual([...r.prereqCardIds].sort(), ['P', 'Q'], '必须多层回溯到 Q');
});

test('resolvePrereqPlan: 没有 kind 字段的 AI 生成边按 label 推断（不再被整条无视）', () => {
  assert.equal(kindOfEdge({ label: '前置' }), 'prereq');
  assert.equal(kindOfEdge({ label: '依赖' }), 'prereq');
  assert.equal(kindOfEdge({ label: '相关' }), 'related');
  assert.equal(kindOfEdge({ kind: 'prereq', label: '相关' }), 'prereq');

  const r = resolvePrereqPlan(
    [{ from: 'A', to: 'B', fromCardId: 'A', toCardId: 'B', label: '前置' }],
    new Set(), 'B',
  );
  assert.deepEqual(r.prereqCardIds, ['A'], 'AI 建的前置边必须参与回溯');
});

test('resolvePrereqPlan: 已掌握的前置不进练习集', () => {
  const r = resolvePrereqPlan(
    [{ from: 'A', to: 'B', kind: 'prereq' }],
    new Set(['A']), 'B',
  );
  assert.deepEqual(r.prereqCardIds, []);
});

// ---------- 自动建图候选对：倒排索引 ----------

test('buildCandidates: 只产出有共享 token 的对，且交集计数正确', () => {
  const sets = new Map([
    ['a', new Set(['x', 'y'])],
    ['b', new Set(['y', 'z'])],
    ['c', new Set(['w'])],
  ]);
  const m = buildCandidates(sets, { maxDf: 10, maxPairs: 1000 });
  assert.equal(m.get('a|b'), 1, 'a、b 共享 y');
  assert.equal(m.has('a|c'), false, 'a、c 无共享词，不该产生候选');
});

test('buildCandidates: maxDf 能挡住「热门词引爆组合数」', () => {
  const sets = new Map();
  for (let i = 0; i < 20; i++) sets.set('c' + i, new Set(['hot', 'uniq' + i]));
  const m = buildCandidates(sets, { maxDf: 5, maxPairs: 100000 });
  assert.equal(m.size, 0, 'hot 出现在 20 张卡上（> maxDf=5），不参与配对');
});

test('nodeLabelOf: 空卡片回退为空串（由调用方决定降级）', () => {
  assert.equal(nodeLabelOf(C1), C1.front);
  assert.equal(nodeLabelOf(null), '');
  assert.equal(nodeLabelOf({ front: '   ' }), '');
});

// ---------- 同步侧：派生数据不得进入同步包 ----------

test('shouldExportRow: kind=auto 的派生图谱边被排除，人工边照常同步', () => {
  const entry = SYNC_TABLES.find(t => t.table === 'graphEdges');
  assert.ok(entry, 'graphEdges 必须在同步清单里');
  assert.ok(typeof entry.exportFilter === 'function', 'graphEdges 必须带 exportFilter');

  assert.equal(shouldExportRow(entry, { kind: 'auto' }), false);
  assert.equal(shouldExportRow(entry, { kind: 'auto', from: 'a', to: 'b' }), false);
  assert.equal(shouldExportRow(entry, { from: 'a', to: 'b' }), true);
  assert.equal(shouldExportRow(entry, { type: 'doc-card', docId: 'd1' }), true);
});

test('shouldExportRow: 未配置 exportFilter 的表全部放行；过滤器抛错时保守放行', () => {
  assert.equal(shouldExportRow({ table: 'cards' }, { anything: 1 }), true);
  assert.equal(shouldExportRow(null, { anything: 1 }), true);
  const boom = { table: 'x', exportFilter: () => { throw new Error('boom'); } };
  assert.equal(shouldExportRow(boom, { a: 1 }), true, '过滤器异常不应导致数据被静默丢弃');
});
