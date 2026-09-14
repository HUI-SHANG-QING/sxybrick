// tests/ai-structured.test.mjs —— AI 回复里的结构化 JSON 识别与渲染
// 背景（2026-09-14 用户反馈）：模型把工具结果原样抄出来当回答，
// 用户看到一坨 {"type":"list","data":{...}}。要求按类型渲染：list → 列表、graph → 图。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStructuredReply, structuredToMarkdown, isGraphReply, normalizeGraphData, normalizeStructuredFinal,
} from '../src/utils/ai-structured.js';

test('识别：整段 JSON（含 ```json 包裹）才认定为结构化回复', () => {
  const plain = '{"type":"list","data":{"items":[{"title":"A"}]},"note":"共 1 条"}';
  const fenced = '```json\n' + plain + '\n```';
  for (const t of [plain, fenced]) {
    const p = parseStructuredReply(t);
    assert.ok(p, '应被识别');
    assert.equal(p.type, 'list');
    assert.equal(p.note, '共 1 条');
  }
});

test('不误伤：正文里夹带 JSON、缺 type/data、非对象一律不动', () => {
  assert.equal(parseStructuredReply('看下这段 JSON {"a":1} 是什么'), null, '正文夹带不识别');
  assert.equal(parseStructuredReply('{"a":1}'), null, '没有 type/data 不识别');
  assert.equal(parseStructuredReply('[1,2,3]'), null);
  assert.equal(parseStructuredReply('普通回答'), null);
  assert.equal(parseStructuredReply(''), null);
});

test('list → 有序列表（标题加粗 + 明细）', () => {
  const p = parseStructuredReply(JSON.stringify({
    type: 'list',
    data: { items: [{ title: '第一张卡', detail: '计算机网络' }, { title: '第二张卡' }] },
    note: '共 2 条',
  }));
  const md = structuredToMarkdown(p);
  assert.match(md, /^共 2 条/);
  assert.match(md, /1\. \*\*第一张卡\*\* — 计算机网络/);
  assert.match(md, /2\. \*\*第二张卡\*\*/);
});

test('table → Markdown 表格（数组行 / 对象行都支持）', () => {
  const arr = structuredToMarkdown(parseStructuredReply(JSON.stringify({
    type: 'table', data: { columns: ['科目', '数量'], rows: [['计算机网络', 7], ['线性代数', 4]] },
  })));
  assert.match(arr, /\| 科目 \| 数量 \|/);
  assert.match(arr, /\| 计算机网络 \| 7 \|/);

  const obj = structuredToMarkdown(parseStructuredReply(JSON.stringify({
    type: 'table', data: { rows: [{ name: 'A', score: 90 }] },
  })));
  assert.match(obj, /\| name \| score \|/);
  assert.match(obj, /\| A \| 90 \|/);
});

test('cards → 问答对；未知类型走通用渲染（仍是可读文本，不是 JSON）', () => {
  const cards = structuredToMarkdown(parseStructuredReply(JSON.stringify({
    type: 'cards', data: { items: [{ front: '什么是死锁', back: '互相等待资源' }] },
  })));
  assert.match(cards, /\*\*1\. 什么是死锁\*\*/);
  assert.match(cards, /互相等待资源/);

  const other = structuredToMarkdown(parseStructuredReply(JSON.stringify({
    type: 'whatever', data: { 待复习: 11, 掌握度: '0%' },
  })));
  assert.match(other, /\*\*待复习\*\*：11/);
  assert.ok(!other.includes('{'), '通用渲染也不应残留裸 JSON');
});

test('graph → 不转 Markdown（交给图表组件）', () => {
  const p = parseStructuredReply(JSON.stringify({
    type: 'graph', data: { nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], links: [{ source: 'a', target: 'b' }] },
  }));
  assert.equal(structuredToMarkdown(p), null);
  assert.equal(isGraphReply(p), true);
});

test('normalizeGraphData：容错字段命名，且丢掉悬空/自环边', () => {
  const g = normalizeGraphData({
    vertices: [{ name: '停止等待' }, { name: '回退N帧' }, { name: '流量控制' }],
    edges: [
      { from: '停止等待', to: '流量控制', relation: '服务于' },
      { from: '回退N帧', to: '流量控制' },
      { from: '流量控制', to: '不存在的节点' },
      { from: '停止等待', to: '停止等待' },
    ],
    layout: 'force',
  });
  assert.equal(g.nodes.length, 3);
  assert.equal(g.nodes[1].name, '回退N帧');
  assert.equal(g.links.length, 2, '悬空边与自环边应被丢弃');
  assert.equal(g.links[0].label, '服务于');
  assert.equal(g.kind, 'force');
});

test('normalizeGraphData：无节点 → null（调用方降级为原文显示）', () => {
  assert.equal(normalizeGraphData({}), null);
  assert.equal(normalizeGraphData(null), null);
  assert.equal(normalizeGraphData({ nodes: [] }), null);
});

test('normalizeStructuredFinal：带引子的结构化 JSON 剥离成纯 JSON（出口净化）', () => {
  const json = '{"type":"list","data":{"items":[{"title":"A"}]}}';
  // 模型给 JSON 加了个短引子 → 剥离
  assert.equal(normalizeStructuredFinal(`结果如下：\n\n${json}`), json);
  assert.equal(normalizeStructuredFinal(`根据查询：${json}，共 1 条`), json);
  // 整段 JSON / 代码块本来就能被 parseStructuredReply 识别 → 原样
  assert.equal(normalizeStructuredFinal(json), json);
  assert.equal(normalizeStructuredFinal('```json\n' + json + '\n```'), '```json\n' + json + '\n```');
  // round44 N2：引子 + 围栏 + 正文里还有第二个 {...} 示例 → 首尾扫描会截进示例的 }，
  // 必须优先剥围栏（最强信号）而不是走兜底扫描
  assert.equal(
    normalizeStructuredFinal(`结果如下：\n\n\`\`\`json\n${json}\n\`\`\`\n\n例如其他格式 {"a":1} 仅供参考`),
    json,
  );
  // 围栏内容不是合法结构化 JSON（无 type+data）→ 走原兜底，不误剥
  assert.equal(
    normalizeStructuredFinal('结果：```json\n{"foo":1}\n```'),
    '结果：```json\n{"foo":1}\n```',
  );
  // 绝不误伤正文
  assert.equal(normalizeStructuredFinal('普通回答'), '普通回答');
  assert.equal(normalizeStructuredFinal(''), '');
  assert.equal(normalizeStructuredFinal('看下这段 JSON {"a":1} 是什么'), '看下这段 JSON {"a":1} 是什么');
  // 前后缀过长 → 判定为正文夹带，不动
  const longPrefix = '下面是详细的查询结果，请你仔细阅读每一个条目，然后针对其中的重点内容给我一个完整的分析说明：' + json;
  assert.equal(normalizeStructuredFinal(longPrefix), longPrefix);
  // 有 type 但无 data → 不算结构化回复，不动
  const noData = '结果：' + '{"type":"list"}';
  assert.equal(normalizeStructuredFinal(noData), noData);
});

test('提示协议与前端支持的类型一致（防止 Agent 提示改了、渲染没跟上）', async () => {
  const { STRUCTURED_REPLY_CONTRACT } = await import('../src/agent/agents/base.js');
  const { STRUCTURED_TYPES } = await import('../src/utils/ai-structured.js');
  const keys = Object.keys(STRUCTURED_REPLY_CONTRACT || {});
  assert.ok(keys.length >= 3, '协议至少要声明 list / table / graph');
  for (const k of keys) {
    assert.ok(STRUCTURED_TYPES.includes(k), `协议声明了 ${k}，但前端渲染未支持（会出现裸 JSON）`);
  }
  // 协议示例本身必须能被解析，否则模型照抄也是废的
  const { parseStructuredReply } = await import('../src/utils/ai-structured.js');
  for (const [k, sample] of Object.entries(STRUCTURED_REPLY_CONTRACT)) {
    const p = parseStructuredReply(sample);
    assert.equal(p?.type, k, `协议示例 ${k} 无法被解析`);
  }
});
