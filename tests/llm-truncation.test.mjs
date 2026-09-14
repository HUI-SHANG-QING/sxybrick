// round49 回归：LLM 截断自动续写 + 默认输出上限 + 低上限端点降级重试
// 背景：旧默认 max_tokens=2000，长回答（分析多张图 / 完整学习路径 / 长解析）必被
// finish_reason='length' 截断 —— 要么把半截回答丢给用户，要么抛错让上层"降级本地模式"。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/agent/llm.js';

const CFG = { baseUrl: 'http://mock.local', apiKey: 'k', model: 'm' };
const okRes = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });

test('chat：finish_reason=length 时自动续写并拼接（不再把半截回答丢给用户）', async () => {
  const bodies = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return okRes({ choices: [{ message: { content: '前半段…' }, finish_reason: 'length' }], usage: {} });
    }
    return okRes({ choices: [{ message: { content: '后半段。' }, finish_reason: 'stop' }], usage: {} });
  };
  try {
    const out = await chat([{ role: 'user', content: '你好' }], CFG, {});
    assert.equal(out, '前半段…后半段。', '应把续写内容拼接到原回答之后');
    assert.equal(bodies.length, 2, '应发起一次续写请求');
    assert.equal(bodies[0].max_tokens, 4096, '默认输出上限已由 2000 提到 4096');
    assert.ok(
      bodies[1].messages.some((m) => m.role === 'assistant' && m.content === '前半段…'),
      '续写请求应回灌已输出内容',
    );
    assert.ok(
      bodies[1].messages.some((m) => m.role === 'user' && /接着写/.test(m.content)),
      '续写请求应带「从中断处接着写」指令',
    );
  } finally { globalThis.fetch = orig; }
});

test('chat：正常结束（finish_reason=stop）不触发续写', async () => {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    return okRes({ choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }], usage: {} });
  };
  try {
    assert.equal(await chat([{ role: 'user', content: '你好' }], CFG, {}), '完整回答');
    assert.equal(n, 1, '不应发起续写请求');
  } finally { globalThis.fetch = orig; }
});

test('chat：调用方自定义 maxTokens 时不被默认值覆盖', async () => {
  let seen = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen = JSON.parse(init.body).max_tokens;
    return okRes({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
  };
  try {
    await chat([{ role: 'user', content: '你好' }], CFG, { maxTokens: 8000 });
    assert.equal(seen, 8000);
  } finally { globalThis.fetch = orig; }
});

test('chat：端点拒绝 max_tokens 时降级重试（不为修截断反把请求打死）', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body).max_tokens);
    if (seen.length === 1) {
      return { ok: false, status: 400, text: async () => '{"error":{"message":"max_tokens is too large"}}', json: async () => ({}) };
    }
    return okRes({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: {} });
  };
  try {
    assert.equal(await chat([{ role: 'user', content: '你好' }], CFG, {}), 'OK');
    assert.deepEqual(seen, [4096, 2000], '第二次应以更小的 max_tokens 重试');
  } finally { globalThis.fetch = orig; }
});
