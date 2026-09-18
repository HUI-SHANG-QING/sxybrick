// tests/round116-graph-node-id.test.mjs —— round116 P0：知识图谱「空白」真因 = 节点 id 重复
//
// 用户报：AI 生成图谱不显示；载入历史后提示「已载入历史快照：20 个知识点 / 25 条关联」，
//   但画布仍然一片空白（并曾报 `Cannot set properties of undefined (setting 'dataIndex')`）。
//
// 真因（已用 headless Chrome 实测复现）：
//   AI 返回的节点**经常没有 id 字段** → generate() 里 `id: String(n.id)` 得到字符串 "undefined"
//   → 多个节点 id 全相同。而 ECharts graph 系列遇到**重复节点 id** 会直接抛错
//   （`Cannot set properties of undefined (setting 'dataIndex')`）→ setOption 整个中断 → 画布空白。
//   存成历史快照后是 `kg-undefined`，反解回来依旧重复。
//   （对照实测：同一份数据只要 id 唯一 → 正常绘制 2.8 万像素；id 重复 → 0 像素且抛错。）
//
// 本文件钉住三层防线，任一层缺失都会让「重复 id」再次穿透到 ECharts：
//   ① 入口 generate()：空/重复 id 补成唯一 id（防患于未然）
//   ② 渲染 buildGraphData()：空/重复 id 的节点丢弃（最后一道防线，任何来源的数据都过这里）
//   ③ 反解 mindmapToGraph()：历史快照的 id 去重（老快照里的 kg-undefined 也要能画出）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mindmapToGraph } from '../src/utils/kg-history.js';

const SRC = readFileSync(new URL('../src/views/KnowledgeGraph.vue', import.meta.url), 'utf8');

// ---------------------------------------------------------------- ③ 反解层

test('mindmapToGraph：重复的节点 id 必须补成唯一（老快照里的 kg-undefined 也要能画）', () => {
  const g = mindmapToGraph({
    root: { id: 'kg-root', label: '知识图谱', children: [
      { id: 'kg-undefined', label: '甲（数据结构）', children: [] },
      { id: 'kg-undefined', label: '乙（数据结构）', children: [] },
      { id: 'kg-undefined', label: '丙（数据结构）', children: [] },
    ] },
  });
  assert.equal(g.nodes.length, 3, '三个知识点都要保留');
  assert.equal(new Set(g.nodes.map((n) => n.id)).size, 3,
    'id 必须两两不同：重复 id 会让 ECharts graph 抛 dataIndex 错、整图不显示');
  for (const n of g.nodes) {
    assert.ok(n.id && n.id !== 'undefined', 'id 不能是字符串 "undefined"');
  }
});

test('mindmapToGraph：id 缺失时也要给出唯一 id', () => {
  const g = mindmapToGraph({
    root: { children: [
      { label: '甲', children: [] },
      { label: '乙', children: [] },
    ] },
  });
  assert.equal(new Set(g.nodes.map((n) => n.id)).size, 2);
});

// ---------------------------------------------------------------- ① 入口层

test('generate()：必须规范化 AI 返回的节点 id（缺失/重复都补），并丢掉端点不存在的边', () => {
  assert.match(SRC, /const usedIds = new Set\(\);[\s\S]{0,400}?nid = `n\$\{i \+ 1\}`/,
    'AI 没给 id 时要补一个唯一的');
  assert.match(SRC, /\.filter\(e => usedIds\.has\(e\.from\) && usedIds\.has\(e\.to\) && e\.from !== e\.to\)/,
    '边必须两端都存在且非自环，否则会在图上连到空气或自己');
});

// ---------------------------------------------------------------- ② 渲染层

test('buildGraphData()：空/重复 id 的节点必须被丢弃（ECharts 的最后一道防线）', () => {
  assert.match(SRC, /const usedIds = new Set\(\);[\s\S]{0,400}?usedIds\.has\(id\)\) continue;/,
    '重复/空 id 的节点要跳过，不能直接 map 给 ECharts');
  assert.match(SRC, /\.filter\(e => usedIds\.has\(String\(e\?\.from\)\) && usedIds\.has\(String\(e\?\.to\)\)\)/,
    '端点已被丢弃的边要一并丢掉');
});

// ---------------------------------------------------------------- 假节点

test('跳转卡片：科目对不上时不能直接判「卡片不存在」，必须回退全库再找', () => {
  // 图谱节点的 subject 取自「边自带的 subject」（AI/Agent 编的科目名），常与卡片真实
  // subject 不一致；原实现按该科目硬过滤，过滤为空就提示「搜不到对应的卡片」——
  // 卡片其实在库里。这就是用户报的「假节点」。
  assert.match(SRC, /const inSubject = pick\(all\.filter\(c => \(c\.subject \|\| ''\) === sub\)\);/);
  assert.match(SRC, /return inSubject\.length \? inSubject : pick\(all\);/,
    '科目内没找到 → 回退全库');
});
