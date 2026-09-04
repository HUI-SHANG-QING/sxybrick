// 回归测试：stringifyReply 把任意 Agent 回复归一化为「非空 string」。
// 历史坑（经验 934245）：orchestrator.runTask 早期把 LLM 原始结果（content === '' /
// null / 对象）直接透传给 AgentWorkbench 的 MarkdownRenderer → 整条回复是一行空白。
// 本测试锁定「绝不返回空字符串」这一不变量，杜绝 UI 空白行回归。
//
// reply.js 仅依赖 i18n 的 t()，可在 Node 下直接 import，无需 db / localStorage 垫片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stringifyReply } from '../src/agent/reply.js';

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

test('空字符串 → 回退到非空提示（不再是空白行）', () => {
  const out = stringifyReply('');
  assert.ok(isNonEmptyString(out), `期望非空 string，实际=${JSON.stringify(out)}`);
});

test('null → 回退到非空提示', () => {
  assert.ok(isNonEmptyString(stringifyReply(null)));
});

test('undefined → 回退到非空提示', () => {
  assert.ok(isNonEmptyString(stringifyReply(undefined)));
});

test('对象含 text 字段 → 返回该文本', () => {
  assert.equal(stringifyReply({ text: '这是答案' }), '这是答案');
});

test('对象含 content 字段 → 返回该文本', () => {
  assert.equal(stringifyReply({ content: 'content 答案' }), 'content 答案');
});

test('无可读字符串字段的纯对象 → JSON 序列化且非空', () => {
  const out = stringifyReply({ a: 1, b: [2, 3] });
  assert.ok(isNonEmptyString(out));
  assert.ok(out.includes('"a"'), '应保留结构化信息，而非空白');
});

test('合法非空字符串 → 原样透传', () => {
  assert.equal(stringifyReply('正常回复内容'), '正常回复内容');
});

test('数字 / 布尔 → 转成非空 string', () => {
  assert.equal(stringifyReply(42), '42');
  assert.equal(stringifyReply(false), 'false');
});

test('自定义 fallback 优先生效', () => {
  assert.equal(stringifyReply('', '兜底文案'), '兜底文案');
  assert.equal(stringifyReply(null, '兜底文案'), '兜底文案');
});

test('不变量：对全部非法输入都不返回空字符串', () => {
  for (const bad of ['', null, undefined, {}, [], { a: {} }]) {
    const out = stringifyReply(bad);
    assert.ok(isNonEmptyString(out), `输入 ${JSON.stringify(bad)} 不应产生空回复`);
  }
});
