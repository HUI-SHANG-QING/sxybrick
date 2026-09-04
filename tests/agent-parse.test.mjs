// BUG-03 回归：parseToolCall 的 args 解析失败不再静默当 {}，而是带回 parseError。
// base.js 只依赖 registry/types（纯类定义），无需 db / localStorage / fetch 垫片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCall } from '../src/agent/agents/base.js';

test('parseToolCall：正常工具调用解析出 name/args/thought', () => {
  const raw = '让我查一下今天的复习情况\n<tool>get_stats</tool><args>{"subject":"数学"}</args>';
  const out = parseToolCall(raw);
  assert.ok(out);
  assert.equal(out.name, 'get_stats');
  assert.deepEqual(out.args, { subject: '数学' });
  assert.equal(out.parseError, null, '合法 JSON 无 parseError');
  assert.ok(out.thought.includes('让我查一下'), 'thought 应含工具标记前文字');
});

test('parseToolCall：非法 JSON args 回灌 parseError（不再静默 {}）', () => {
  const raw = '<tool>get_stats</tool><args>{subject: 数学}</args>';
  const out = parseToolCall(raw);
  assert.ok(out);
  assert.equal(out.name, 'get_stats');
  assert.deepEqual(out.args, {});
  assert.ok(out.parseError, '非法 JSON 应带 parseError');
  assert.equal(out.argsRaw, '{subject: 数学}', '保留原始参数串供回灌');
});

test('parseToolCall：args 是数组/标量 → 判为 parseError', () => {
  assert.ok(parseToolCall('<tool>x</tool><args>[1,2]</args>').parseError, '数组应拒');
  assert.ok(parseToolCall('<tool>x</tool><args>"hi"</args>').parseError, '字符串应拒');
  assert.ok(parseToolCall('<tool>x</tool><args>null</args>').parseError, 'null 应拒');
});

test('parseToolCall：无 <tool> 标记返回 null', () => {
  assert.equal(parseToolCall('这是一段普通回答'), null);
});

test('parseToolCall：空 args 标签按空对象处理，无 parseError', () => {
  const out = parseToolCall('<tool>search</tool><args></args>');
  assert.ok(out);
  assert.deepEqual(out.args, {});
  assert.equal(out.parseError, null);
});
