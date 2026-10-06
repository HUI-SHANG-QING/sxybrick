// tests/agent-dsml-fallback.test.mjs —— DSML 工具调用格式的兜底解析（round133）
//
// 真实事故（用户提供对话记录）：模型输出的是 `<｜｜DSML｜｜ …>` 格式（服务商侧训练格式，
// **项目内 grep DSML 零匹配**，不是本项目协议），而本项目只认 `<tool>/<args>/<final>`。
// 症状链：
//   模型输出 DSML → parseToolCall 不匹配 → **工具没有被执行**
//   → parseFinal 的「整段当回答」分支把原文原样返回
//   → 用户屏幕上出现一堆 `<｜｜DSML｜｜ …>` 乱码
//   → 对话历史里存的就是这些标签，模型下一轮继续照抄 → 连续空转到步数耗尽
//   （用户记录里同一句「最新的卡片内容是什么」连续触发了 6 次空转）
//
// 形态用**用户提供的真实样本**逐字确认：分隔符 = U+FF5C（`｜`）× 2；
// `invoke` / `calls` 是正常开闭标签，`parameter` 是**自闭合**（无斜杠）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/agent/tools/index.js';
import { parseToolCall, parseFinal, parseDsmlToolCall, containsDsmlCall } from '../src/agent/agents/base.js';

const S = '｜｜';   // 全角分隔符（真实形态）

test('DSML 单参数调用能被解析出工具名与参数（真实样本形态）', () => {
  const raw = [
    `<${S}DSML${S} calls>`,
    `<${S}DSML${S} invoke name="search_cards">`,
    `<${S}DSML${S} parameter name="q" string="true">张宇<${S}DSML${S} parameter>`,
    `</${S}DSML${S} invoke>`,
    `</${S}DSML${S} calls>`,
  ].join('\n');
  const tc = parseToolCall(raw);
  assert.ok(tc, '应识别出工具调用（否则会被当成回答，乱码直接甩给用户）');
  assert.equal(tc.name, 'search_cards');
  assert.deepEqual(tc.args, { q: '张宇' });
  assert.equal(tc.parseError, null);
});

test('DSML 参数的 string="false" 还原为数字/布尔（显式 0 必须保住）', () => {
  const raw = [
    `<${S}DSML${S} calls>`,
    `<${S}DSML${S} invoke name="search_cards">`,
    `<${S}DSML${S} parameter name="limit" string="false">50<${S}DSML${S} parameter>`,
    `<${S}DSML${S} parameter name="familiar" string="false">0<${S}DSML${S} parameter>`,
    `<${S}DSML${S} parameter name="flag" string="false">true<${S}DSML${S} parameter>`,
    `</${S}DSML${S} invoke>`,
    `</${S}DSML${S} calls>`,
  ].join('\n');
  const tc = parseToolCall(raw);
  assert.deepEqual(tc.args, { limit: 50, familiar: 0, flag: true },
    '数字要还原成数字、true 要还原成布尔、**显式 0 不能被吞成字符串或默认值**（项目通则）');
});

test('DSML 无参数调用', () => {
  const raw = `<${S}DSML${S} calls><${S}DSML${S} invoke name="get_stats"></${S}DSML${S} invoke></${S}DSML${S} calls>`;
  const tc = parseToolCall(raw);
  assert.equal(tc.name, 'get_stats');
  assert.deepEqual(tc.args, {});
});

test('半角 || 分隔符同样识别（不同服务商版本可能用半角）', () => {
  const raw = '<||DSML|| calls><||DSML|| invoke name="get_stats"></||DSML|| invoke></||DSML|| calls>';
  assert.ok(parseDsmlToolCall(raw), '半角分隔符应被接受');
  assert.equal(parseToolCall(raw).name, 'get_stats');
});

test('出口过滤：含 DSML 的文本不是回答，parseFinal 必须返回 null（这��治"乱码"）', () => {
  const raw = [
    `<${S}DSML${S} calls>`,
    `<${S}DSML${S} invoke name="list_notes">`,
    `<${S}DSML${S} parameter name="q" string="true">补卡<${S}DSML${S} parameter>`,
    `</${S}DSML${S} invoke>`,
    `</${S}DSML${S} calls>`,
  ].join('\n');
  assert.equal(parseFinal(raw), null, 'DSML 绝不能被当成最终回答返回给用户');
  assert.equal(containsDsmlCall(raw), true);
});

test('截断的 DSML（只有开始标签、没有结束）也不泄漏', () => {
  const truncated = `<${S}DSML${S} calls><${S}DSML${S} invoke name="search_cards"><${S}DSML${S} parameter name="q" string="true">张宇`;
  assert.equal(parseFinal(truncated), null, '被砍断的 DSML 同样不是回答');
});

test('✅ 回归：原本的 <tool>/<args>/<final> 协议行为完全不变（不引入新问题）', () => {
  const raw = '<tool>search_cards</tool><args>{"q":"张宇","limit":5}</args>';
  const tc = parseToolCall(raw);
  assert.equal(tc.name, 'search_cards');
  assert.deepEqual(tc.args, { q: '张宇', limit: 5 });

  assert.equal(parseFinal('<final>这是给用户的回答</final>'), '这是给用户的回答');
  // 无标签的自由文本仍然整段返回（这是各调用方依赖的既有行为）
  assert.equal(parseFinal('就是一段普通回答'), '就是一段普通回答');
  // 只有 <tool> 没有 <final> → 不是回答
  assert.equal(parseFinal('<tool>x</tool><args>{}</args>'), null);
  // 思考文字仍能被提取
  const withThought = '先查一下卡片\n<tool>get_stats</tool><args>{}</args>';
  assert.equal(parseToolCall(withThought).thought, '先查一下卡片');
});

test('✅ 回归：args 非法 JSON 时仍回灌 parseError（BUG-03 的自我纠正闭环不能被绕过）', () => {
  const tc = parseToolCall('<tool>search_cards</tool><args>{坏掉的}</args>');
  assert.equal(tc.name, 'search_cards');
  assert.ok(tc.parseError, '非法 JSON 必须带 parseError，不能静默当 {}');
  assert.deepEqual(tc.args, {});
});

test('非 DSML 的尖括号内容不被误判成工具调用', () => {
  assert.equal(parseDsmlToolCall('数学公式：a < b 且 c > d'), null);
  assert.equal(containsDsmlCall('普通回答里提到 <div> 标签'), false);
  // 别的 XML 风格标签也不能被当成 DSML
  assert.equal(parseToolCall('<function_calls><invoke name="x"/></function_calls>'), null);
});
