// tests/reply-stats.test.mjs
// AI 回复质量监控：stringifyReply fallback 计数器 + getReplyStats 快照
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringifyReply, getReplyStats, resetReplyStats } from '../src/agent/reply.js';

test('getReplyStats 初始状态：total=0, fallback=0, fallbackRate=0', () => {
  resetReplyStats();
  const s = getReplyStats();
  assert.equal(s.total, 0);
  assert.equal(s.fallback, 0);
  assert.equal(s.fallbackRate, 0);
  assert.deepEqual(s.reasons, {});
});

test('stringifyReply 合法非空 string 不计入 fallback', () => {
  resetReplyStats();
  const r = stringifyReply('hello world');
  assert.equal(r, 'hello world');
  const s = getReplyStats();
  assert.equal(s.total, 1);
  assert.equal(s.fallback, 0);
});

test('stringifyReply null 触发 fallback（reason=null）', () => {
  resetReplyStats();
  const r = stringifyReply(null);
  assert.ok(r.length > 0, '不应返回空串');
  const s = getReplyStats();
  assert.equal(s.total, 1);
  assert.equal(s.fallback, 1);
  assert.equal(s.reasons.null, 1);
});

test('stringifyReply 空串触发 fallback（reason=empty）', () => {
  resetReplyStats();
  stringifyReply('');
  const s = getReplyStats();
  assert.equal(s.fallback, 1);
  assert.equal(s.reasons.empty, 1);
});

test('stringifyReply 无可用字段的对象触发 fallback（reason=object）', () => {
  resetReplyStats();
  const r = stringifyReply({ foo: 123 });
  assert.ok(r.length > 0);
  const s = getReplyStats();
  assert.equal(s.fallback, 1);
  assert.equal(s.reasons.object, 1);
});

test('stringifyReply 有 text 字段的对象不计入 fallback', () => {
  resetReplyStats();
  const r = stringifyReply({ text: 'AI said this' });
  assert.equal(r, 'AI said this');
  const s = getReplyStats();
  assert.equal(s.fallback, 0);
});

test('fallbackRate 计算正确', () => {
  resetReplyStats();
  stringifyReply('ok');       // total=1, fb=0
  stringifyReply(null);       // total=2, fb=1
  stringifyReply('fine');     // total=3, fb=1
  stringifyReply(undefined);  // total=4, fb=2
  const s = getReplyStats();
  assert.equal(s.total, 4);
  assert.equal(s.fallback, 2);
  assert.equal(s.fallbackRate, 50); // 2/4 = 50%
});

test('resetReplyStats 清零所有计数', () => {
  resetReplyStats();
  stringifyReply(null);
  stringifyReply('');
  assert.equal(getReplyStats().total, 2);
  resetReplyStats();
  const s = getReplyStats();
  assert.equal(s.total, 0);
  assert.equal(s.fallback, 0);
  assert.deepEqual(s.reasons, {});
});

test('getReplyStats 返回快照（不暴露内部引用）', () => {
  resetReplyStats();
  stringifyReply(null);
  const s1 = getReplyStats();
  s1.total = 999;
  const s2 = getReplyStats();
  assert.notEqual(s2.total, 999, '快照应独立于内部状态');
});
