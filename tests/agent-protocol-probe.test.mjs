// tests/agent-protocol-probe.test.mjs —— 举一反三：各种「非本项目协议」的模型输出会怎样
//
// 背景：round133 修了 DSML（`＜｜｜DSML｜｜＞`）泄漏。本测试**不只盯 DSML**，
//   而是把「模型可能吐出来的、非本项目 `<tool>/<args>/<final>` 协议的形态」一次性探一遍，
//   找出**还有哪些会原样泄漏到用户屏幕**（用户看到的就是一堆标签/指令乱码）。
//
// 判据（对用户可见行为）：
//   · 形态是「工具调用」→ parseToolCall 应识别它，**或**至少 parseFinal 不得把它当回答；
//   · 形态是「思考过程」→ 不应把思考正文当最终回答（除非同时有真实正文）；
//   · 形态是「正常回答」→ parseFinal 必须原样返回（**这是回归基线，不能被误伤**）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/agent/tools/index.js';
import { parseToolCall, parseFinal, containsDsmlCall } from '../src/agent/agents/base.js';

const S = '｜｜';
const CASES = [
  {
    name: 'DSML（round133 已修）',
    text: `<${S}DSML${S} calls><${S}DSML${S} invoke name="search_cards"><${S}DSML${S} parameter name="q" string="true">x<${S}DSML${S} parameter></${S}DSML${S} invoke></${S}DSML${S} calls>`,
    kind: 'toolcall',
  },
  {
    name: 'XML 风格 function_calls',
    text: '<function_calls><invoke name="search_cards"><parameter name="q">x</parameter></invoke></function_calls>',
    kind: 'toolcall',
  },
  {
    name: '<tool_call> JSON（OpenAI 风格裸标签）',
    text: '<tool_call>{"name":"search_cards","arguments":{"q":"x"}}</tool_call>',
    kind: 'toolcall',
  },
  {
    name: 'Qwen 风格特殊分隔符',
    text: '<|tool_calls_section_begin|><|tool_call|>{"name":"search_cards","arguments":{"q":"x"}}<|tool_call|><|tool_calls_section_end|>',
    kind: 'toolcall',
  },
  {
    name: 'ReAct 老格式 Action/Action Input',
    text: 'Action: search_cards\nAction Input: {"q":"x"}',
    kind: 'toolcall',
  },
  {
    name: '带 thinking 标签的思考过程',
    text: '<thinking>用户想要最新的卡片，我应该先查卡片库。</thinking>这是给你的回答。',
    kind: 'answer_with_thinking',
    expectContains: '这是给你的回答',
  },
  {
    name: 'DeepSeek <think> 标签',
    text: '<think>先查卡片库</think>这是给你的回答。',
    kind: 'answer_with_thinking',
    expectContains: '这是给你的回答',
  },
  {
    name: '```json 围栏包裹的正常回答（回归基线）',
    text: '这是给你的回答。',
    kind: 'answer',
    expectContains: '这是给你的回答',
  },
  {
    name: '纯正常回答（回归基线）',
    text: '复习计划建议先从线性代数第四章开始。',
    kind: 'answer',
    expectContains: '线性代数',
  },
  {
    name: '数学公式里的尖括号（回归基线）',
    text: '当 a < b 且 c > d 时成立。',
    kind: 'answer',
    expectContains: 'a < b',
  },
];

test('探针：非本项目协议的形态不能被当成最终回答泄漏给用户', () => {
  const leaks = [];
  const report = [];
  for (const c of CASES) {
    const tc = parseToolCall(c.text);
    const fin = parseFinal(c.text);
    const looksLikeCall = c.kind === 'toolcall';
    if (looksLikeCall && fin !== null) {
      leaks.push(`【${c.name}】被当成回答返回了：${JSON.stringify(String(fin).slice(0, 80))}`);
    }
    if (c.kind === 'answer' && fin === null) {
      leaks.push(`【${c.name}】正常回答被误判为 null（回归风险！）`);
    }
    if (c.expectContains && (fin === null || !String(fin).includes(c.expectContains))) {
      leaks.push(`【${c.name}】丢掉了正文「${c.expectContains}」，得到：${JSON.stringify(fin)}`);
    }
    report.push(`  ${c.name.padEnd(34)} toolCall=${tc ? tc.name : '—'}  final=${fin === null ? 'null' : JSON.stringify(String(fin).slice(0, 46))}`);
  }
  console.log('=== 探针结果 ===');
  for (const r of report) console.log(r);
  if (leaks.length) {
    console.log('\n=== 泄漏/回归清单 ===');
    for (const l of leaks) console.log('  ❌ ' + l);
  }
  assert.deepEqual(leaks, [], `存在泄漏或回归：\n${leaks.join('\n')}`);
});

test('回归基线：原协议与自由文本行为不变', () => {
  assert.equal(parseFinal('<final>标准回答</final>'), '标准回答');
  assert.equal(parseFinal('没有任何标签的自由文本'), '没有任何标签的自由文本');
  const tc = parseToolCall('<tool>get_stats</tool><args>{}</args>');
  assert.equal(tc.name, 'get_stats');
  // 流式抢救：只有开始标签的 <final>
  assert.equal(parseFinal('<final>被砍断的正文'), '被砍断的正文');
});
