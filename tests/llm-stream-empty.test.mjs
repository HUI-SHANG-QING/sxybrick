// tests/llm-stream-empty.test.mjs —— round105：流式空响应的**原因诊断**
//
// 背景（用户实测）：「变式生成」报「AI 返回内容为空（可能被截断或模型异常），请重试」。
// 追链路：Cards.vue → genVariants() → chatAI()（默认 stream:true）→ parseLLMJsonArray('') → 抛该文案。
// 根因：llm.js 的**流式分支**只读 delta.content，既不读 delta.reasoning_content（推理模型），
// 也不读 finish_reason（截断信号），最后 `return full` 把空串**静默**交给上层 —— 而非流式分支
// 早已有细分诊断（293-303 行）。本文件钉住流式分支补齐后的四种原因分类。
import test from 'node:test';
import assert from 'node:assert/strict';

import { chat } from '../src/agent/llm.js';

const CFG = { baseUrl: 'http://mock.local', apiKey: 'k', model: 'm' };
const enc = new TextEncoder();

/** 造 SSE 假响应：script 每项是一段**原始 SSE 文本** */
function sseRaw(pieces) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i >= pieces.length) return { done: true, value: undefined };
            const p = pieces[i]; i += 1;
            return { done: false, value: enc.encode(p) };
          },
          async cancel() {},
        };
      },
    },
    json: async () => ({}),
    text: async () => '',
  };
}

const delta = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const contentChunk = (text, fr) => delta({ choices: [{ delta: { content: text }, ...(fr ? { finish_reason: fr } : {}) }] });
const reasoningChunk = (text, fr) => delta({ choices: [{ delta: { reasoning_content: text }, ...(fr ? { finish_reason: fr } : {}) }] });

function mockFetch(res) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => res;
  return () => { globalThis.fetch = orig; };
}

test('正常路径回归：流式有正文时原样返回（不因新增诊断而改变）', async () => {
  const restore = mockFetch(sseRaw([contentChunk('你'), contentChunk('好', 'stop'), 'data: [DONE]\n\n']));
  try {
    assert.equal(await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }), '你好');
  } finally { restore(); }
});

test('长回答回归：finish_reason=length 但**有正文**时必须返回部分内容，不得改判为空错误', async () => {
  const restore = mockFetch(sseRaw([contentChunk('半截回答'), delta({ choices: [{ delta: {}, finish_reason: 'length' }] })]));
  try {
    const out = await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true });
    assert.match(out, /半截回答/, '截断但有内容 → 交回部分内容（上层可能据此降级，而不是报空）');
  } finally { restore(); }
});

test('① 推理模型吃光预算：只吐 reasoning_content + finish_reason=length → 报「预算全花在推理上」', async () => {
  const restore = mockFetch(sseRaw([
    reasoningChunk('让我想想…'),
    reasoningChunk('还需要再想想…'),
    delta({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }),
      (e) => {
        assert.match(e.message, /推理/, '必须指出是推理过程吃掉了预算');
        assert.match(e.message, /max_tokens|普通对话模型/, '必须给出可行动作');
        assert.doesNotMatch(e.message, /可能被截断或模型异常/, '不得再落到笼统提示');
        return true;
      },
    );
  } finally { restore(); }
});

test('② 截断且无正文：finish_reason=length、无 reasoning → 报「被 max_tokens 截断」', async () => {
  const restore = mockFetch(sseRaw([delta({ choices: [{ delta: {}, finish_reason: 'length' }] })]));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }),
      (e) => { assert.match(e.message, /max_tokens/); return true; },
    );
  } finally { restore(); }
});

test('③ 只返回推理过程（无 length 标记）→ 报「改用普通对话模型」', async () => {
  const restore = mockFetch(sseRaw([reasoningChunk('思考中'), delta({ choices: [{ delta: {}, finish_reason: 'stop' }] })]));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }),
      (e) => { assert.match(e.message, /reasoning_content|推理/); assert.match(e.message, /普通对话模型/); return true; },
    );
  } finally { restore(); }
});

test('④ 服务端零字节空响应 → 报「未收到任何数据」并带状态码（不误导成模型问题）', async () => {
  const restore = mockFetch(sseRaw([]));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }),
      (e) => { assert.match(e.message, /未收到任何数据/); assert.match(e.message, /200/); return true; },
    );
  } finally { restore(); }
});

test('⑤ 有响应但正文为空（网关改写/内容过滤）→ 明确说「正文为空」，区别于网络问题', async () => {
  const restore = mockFetch(sseRaw([delta({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }),
      (e) => { assert.match(e.message, /正文为空/); assert.doesNotMatch(e.message, /未收到任何数据/); return true; },
    );
  } finally { restore(); }
});

test('非 SSE 网关回归：忽略 stream 直接回整段 JSON 时仍能取到正文', async () => {
  const whole = JSON.stringify({ choices: [{ message: { content: '整段正文' }, finish_reason: 'stop' }] });
  const restore = mockFetch(sseRaw([whole]));
  try {
    assert.equal(await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }), '整段正文');
  } finally { restore(); }
});

test('诊断文案必须写明**本次真实** max_tokens（让「设置没生效」一眼可见）', async () => {
  const restore = mockFetch(sseRaw([
    reasoningChunk('想'),
    delta({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true, maxTokens: 3000 }),
      (e) => {
        assert.match(e.message, /3000/, '要报出实际用的 max_tokens，否则用户无从判断设置有没有生效');
        return true;
      },
    );
  } finally { restore(); }
});
