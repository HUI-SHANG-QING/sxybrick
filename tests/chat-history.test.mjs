// tests/chat-history.test.mjs —— AI 助手普通对话路径的历史滑动窗口（round86 P2-1）
//
// 背景：chatAI 此前把**全量**会话历史透传给 llmChat，长对话时请求体逐轮膨胀
// （慢/贵/400「上下文超限」/模型静默"失忆"）。Agent 路径有 slice(-12)（orchestrator.js:129），
// 普通对话路径无等价物 → trimChatHistory 在 chatAI 入口做窗口截断：
//   · 头部连续 system 永远保留；
//   · 其余以 user 为锚点保留最近 maxTurns 轮（不切碎轮对、本轮输入永远在）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimChatHistory } from '../src/ai.js';

function turn(n) {
  return [
    { role: 'user', content: `问${n}` },
    { role: 'assistant', content: `答${n}` },
  ];
}

test('不超过上限：原样返回（同一引用）', () => {
  const msgs = [{ role: 'system', content: 'S' }, ...turn(1), ...turn(2)];
  assert.equal(trimChatHistory(msgs, 16), msgs);
});

test('超过上限：system 全保留，只留最近 maxTurns 轮，且从 user 开始切（轮对完整）', () => {
  const system = [
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
  ];
  const msgs = [...system];
  for (let n = 1; n <= 30; n++) msgs.push(...turn(n));
  const out = trimChatHistory(msgs, 10);
  assert.equal(out.length, system.length + 20, '10 轮 = 20 条消息');
  assert.deepEqual(out.slice(0, 2), system, 'system 原样保留');
  // 从第 21 轮（0-indexed 20）开始：最后 10 轮 = 第 21..30 轮
  assert.equal(out[2].role, 'user');
  assert.equal(out[2].content, '问21', '窗口起点是最近 10 轮里的第一轮 user');
  assert.equal(out[out.length - 1].content, '答30', '最后一轮 assistant 保留');
  assert.equal(out[out.length - 2].content, '问30', '本轮输入永远在');
  // 轮对完整性：user/assistant 严格交替
  for (let i = 2; i < out.length; i += 2) {
    assert.equal(out[i].role, 'user');
    assert.equal(out[i + 1].role, 'assistant');
  }
});

test('默认 16 轮；opts 覆盖语义由调用方传入，函数级支持 maxTurns=0 只留本轮', () => {
  const msgs = [];
  for (let n = 1; n <= 40; n++) msgs.push(...turn(n));
  assert.equal(trimChatHistory(msgs).length, 32 + 0, '默认 16 轮无 system');
  const out0 = trimChatHistory(msgs, 0);
  assert.equal(out0.length, 2, 'maxTurns=0 只剩本轮');
  assert.equal(out0[0].content, '问40');
});

test('边界：空数组 / 只有 system / 全 user 无 assistant 不炸', () => {
  assert.deepEqual(trimChatHistory([]), []);
  assert.deepEqual(trimChatHistory([{ role: 'system', content: 'S' }]), [{ role: 'system', content: 'S' }]);
  const users = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }];
  const out = trimChatHistory(users, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'c', '只保留最后一个 user');
});

test('非数组输入原样返回', () => {
  assert.equal(trimChatHistory(null), null);
  assert.equal(trimChatHistory(undefined), undefined);
  assert.equal(trimChatHistory('x'), 'x');
});
