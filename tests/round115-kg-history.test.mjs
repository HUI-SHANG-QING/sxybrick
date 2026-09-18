// tests/round115-kg-history.test.mjs —— round115：知识图谱「生成历史」+ 渲染崩溃防护
//
// 两份东西要钉住：
//   A. 历史快照的反解（mindmapToGraph）：导图树 → 节点+关联。
//      这是纯函数，直接测行为：正常还原、科目后缀、异常边跳过、自环跳过、重复去重。
//   B. 渲染防护（KnowledgeGraph.vue 内的两处关键修复）。.vue 无法在 node --test 里挂载，
//      按本项目既有做法用「源码形态闸门」兜底 —— 防止后续改动把防护悄悄回退：
//        · setOption 前必须 clear()：避开 ECharts tree 的增量更新路径
//          （TreeView.js 的 removeNodeEdge 里有 `sourceSymbolEl.__edge` 无保护解引用，
//            会给用户报 "Cannot read properties of null (reading '__edge')" 并留下空白画布）
//        · 树状渲染失败必须自动降级为力导向，保证「生成成功却一片空白」不再出现
//        · 历史快照标题必须带规模标签（否则列表里分不清是哪一次生成）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mindmapToGraph, stripSubject, extractSubject } from '../src/utils/kg-history.js';

// ---------------------------------------------------------------- A. 反解

test('mindmapToGraph：把导图树还原成知识点节点 + 关联边', () => {
  const g = mindmapToGraph({
    root: {
      id: 'kg-root', label: '知识图谱',
      children: [
        { id: 'kg-1', label: '二叉树（数据结构）', children: [
          { id: 'kg-1-2', label: '前置→ 树的遍历（数据结构）', children: [] },
        ] },
        { id: 'kg-2', label: '树的遍历（数据结构）', children: [] },
      ],
    },
  });
  assert.equal(g.nodes.length, 2, '两个知识点 → 两个节点');
  assert.deepEqual(g.nodes[0], { id: '1', label: '二叉树', subject: '数据结构' },
    'id 去掉 kg- 前缀；label 去掉科目后缀；科目单独带出（供分类着色）');
  assert.equal(g.edges.length, 1, '一条关联 → 一条边');
  assert.deepEqual(g.edges[0], { from: '1', to: '2', label: '前置' },
    '边要接回目标节点，关系名取箭头前的那段');
});

test('mindmapToGraph：目标不可解析的边一律跳过（宁可少线也不画错线）', () => {
  const g = mindmapToGraph({
    root: { children: [
      { id: 'kg-1', label: '甲（数学）', children: [
        { id: 'x1', label: '依赖→ 完全不存在的知识点', children: [] },
        { id: 'x2', label: '这条没有箭头，解析不出目标', children: [] },
      ] },
    ] },
  });
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 0, '接不到目标的边必须丢弃，不能挂在错的节点上');
});

test('mindmapToGraph：自环与重复关系被剔除', () => {
  const g = mindmapToGraph({
    root: { children: [
      { id: 'kg-1', label: '甲', children: [
        { id: 'a', label: '自指→ 甲', children: [] },
        { id: 'b', label: '对比→ 乙', children: [] },
        { id: 'c', label: '对比→ 乙', children: [] },
      ] },
      { id: 'kg-2', label: '乙', children: [] },
    ] },
  });
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1, '自环丢弃；同一对节点的同一关系只保留一条');
  assert.deepEqual(g.edges[0], { from: '1', to: '2', label: '对比' });
});

test('mindmapToGraph：异常输入不抛错、返回空结果（历史数据可能来自旧版本或手改）', () => {
  for (const bad of [null, undefined, {}, { root: null }, { root: {} }, { root: { children: null } }]) {
    const g = mindmapToGraph(bad);
    assert.equal(g.nodes.length, 0);
    assert.equal(g.edges.length, 0);
  }
});

test('stripSubject / extractSubject：科目后缀的取与去', () => {
  assert.equal(stripSubject('二叉树（数据结构）'), '二叉树');
  assert.equal(stripSubject('没有科目'), '没有科目');
  assert.equal(extractSubject('二叉树（数据结构）'), '数据结构');
  assert.equal(extractSubject('没有科目'), '');
  assert.equal(stripSubject(null), '', 'null 安全');
});

// ---------------------------------------------------------------- B. 源码形态闸

const SRC = readFileSync(new URL('../src/views/KnowledgeGraph.vue', import.meta.url), 'utf8');

test('渲染防护：setOption 前必须 chart.clear()（避开 ECharts tree 的 __edge 崩溃路径）', () => {
  const i = SRC.indexOf('chart.setOption(opt, true)');
  assert.ok(i > 0, '必须仍走 notMerge 的 setOption');
  const before = SRC.slice(0, i);
  assert.ok(before.lastIndexOf('chart.clear()') > before.lastIndexOf('function render('),
    'render() 里 setOption 之前必须 clear()：否则 ECharts tree 走增量更新，'
    + 'TreeView 的 removeNodeEdge 会因 sourceSymbolEl 为 null 抛 "reading \'__edge\'"，画布变空白');
});

test('渲染防护：数据为空时也要清掉旧图（不留上一次的残图）', () => {
  assert.match(SRC, /if \(!nodes\.value\.length\) \{ try \{ chart\?\.clear\(\); \}/,
    'nodes 为空时必须 clear，否则容器里残留上次渲染结果');
});

test('渲染防护：树状失败必须自动降级为力导向（保证用户看得到图）', () => {
  assert.match(SRC, /treeFallback/, '降级提示必须存在');
  assert.match(SRC, /layout\.value = 'force'/, '降级必须真的切到 force 布局');
});

test('历史标签：快照标题必须带规模（节点数/关联数）', () => {
  assert.match(SRC, /aiGraphMeta/, '标题要拼上 aiGraphMeta，否则列表里分不清哪次是哪次');
  assert.match(SRC, /generatedNodes\.value\.length, e: generatedEdges\.value\.length/,
    '规模必须取真实的节点数 / 关联数');
});

test('历史入口：本模块内可查看历史快照（不再只存在于思维导图页）', () => {
  assert.match(SRC, /listMindmaps/, '要读 mindmaps 取历史快照');
  assert.match(SRC, /historyBtn/, '要有历史入口按钮');
  assert.match(SRC, /restoreHistory/, '要能把历史载回画布');
});

test('自审补充：删除历史、覆盖式载入都必须二次确认', () => {
  // 本项目所有删除操作（删会话/清记忆/删分组/删卡片）都走 confirmDialog，
  // 这里漏了就是交互不一致，且用户误点一下快照就没了；
  // 载入会覆盖画布上未保存的生成结果，也必须先问一句。
  assert.match(SRC, /import \{ confirmDialog \} from '\.\.\/utils\/confirm\.js'/, '要引入项目的确认对话框');
  assert.match(SRC, /historyDeleteConfirm/, '删除历史必须先确认');
  assert.match(SRC, /historyLoadConfirm/, '覆盖式载入必须先确认');
  // 载入的确认只应在「画布上已有生成结果」时触发，不能变成每次都打扰用户
  assert.match(SRC, /if \(generatedNodes\.value\.length\) \{[\s\S]{0,200}?historyLoadConfirm/,
    '载入确认必须限定在「画布已有生成结果」的前提下');
});
