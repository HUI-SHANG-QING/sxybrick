// tests/embedding-provider.test.mjs —— round110：向量检索可单独指定供应商
//
// 背景：embedding 此前只能读**聊天配置**的 baseUrl/apiKey —— 用 DeepSeek 聊天（它没有 /embeddings 端点）时，
// 向量检索永久只能跑本地 256 维降级算法，「配一个 embeddings 供应商」这件事根本做不到。
// 新增三个可选字段（embeddingBaseUrl / embeddingApiKey / embeddingModel）后：
//   · 填了 → 用填的；没填 → 逐项回退聊天配置（**老用户行为必须完全不变**）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getModelSig, probeEmbedding } from '../src/agent/embedding.js';
import { db } from '../src/db.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const setCfg = (o) => localStorage.setItem('sxy_ai_config', JSON.stringify(o));
beforeEach(() => { localStorage.removeItem('sxy_ai_config'); });

test('向后兼容：未填 embedding* 字段时签名与旧实现逐字一致（老用户零迁移）', () => {
  setCfg({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash' });
  // 旧实现：api:${baseUrl}:${embeddingModel || 'text-embedding-3-small'}
  assert.equal(getModelSig(), 'api:https://api.deepseek.com:text-embedding-3-small');
});

test('未配 key 时签名回落本地（行为不变）', () => {
  setCfg({ baseUrl: 'https://api.deepseek.com', apiKey: '' });
  assert.equal(getModelSig(), 'local:bigram-256');
});

test('独立供应商生效：签名指向新 base + 新 model（⇒ 旧向量会被判过期并自动重建）', () => {
  setCfg({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash',
    embeddingBaseUrl: 'https://api.siliconflow.cn/v1/', embeddingApiKey: 'ek', embeddingModel: 'BAAI/bge-m3',
  });
  assert.equal(getModelSig(), 'api:https://api.siliconflow.cn/v1/:BAAI/bge-m3');
});

test('部分填写：只填 baseUrl 时 key/model 仍逐项回退聊天配置', () => {
  setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', embeddingBaseUrl: 'https://api.siliconflow.cn/v1' });
  assert.equal(getModelSig(), 'api:https://api.siliconflow.cn/v1:text-embedding-3-small');
});

test('DeepSeek 限制只针对「有效配置」：聊天用 DeepSeek + 向量指向别家 → 会真的尝试远程', async () => {
  setCfg({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash',
    embeddingBaseUrl: 'https://api.siliconflow.cn/v1', embeddingApiKey: 'ek', embeddingModel: 'BAAI/bge-m3',
  });
  const r = await probeEmbedding(); // 测试环境的 fetch 是桩（ok:false）→ 远程失败后降级本地
  assert.equal(r.remote, true, '配了非 DeepSeek 的向量供应商时必须尝试远程（此前会被永久判为不支持）');
  assert.equal(r.dim, 256, '远程失败应安全降级为本地 256 维，而不是抛错');
  assert.equal(r.degraded, true);
});

test('聊天就是 DeepSeek 且未配向量供应商 → 直接本地降级、不发远程请求（开箱即用不变）', async () => {
  setCfg({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash' });
  const r = await probeEmbedding();
  assert.equal(r.remote, false);
  assert.equal(r.dim, 256);
});

test('远程可用时：维度取自真实响应，且标记为非降级', async () => {
  setCfg({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'ek', embeddingModel: 'bge-m3' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ index: 0, embedding: new Array(8).fill(0.1) }], usage: { total_tokens: 3 } }),
    text: async () => '',
  });
  try {
    const r = await probeEmbedding();
    assert.equal(r.remote, true);
    assert.equal(r.degraded, false);
    assert.equal(r.dim, 8, '维度必须来自真实响应（用于发现"换模型后维度不匹配"这类问题）');
  } finally { globalThis.fetch = orig; }
});
