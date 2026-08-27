// tests/embedding.test.mjs — embedding 适配器降级行为单测（N5 修复）
// 需要浏览器全局 shim：localStorage（读配置）+ fetch（远程 embedding）
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- 最小 localStorage / fetch shim ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let fetchCalls = 0;
let fetchImpl = null;
globalThis.fetch = (...args) => {
  fetchCalls++;
  return fetchImpl ? fetchImpl(...args) : Promise.reject(new Error('no fetch mock'));
};
function setCfg(cfg) {
  store.set('sxy_ai_config', JSON.stringify(cfg));
}
function reset() {
  store.clear();
  fetchCalls = 0;
  fetchImpl = null;
}

const { embedBatch, LOCAL_EMBED_DIM } = await import('../src/agent/embedding.js');

// ---------- 无 key：直接本地，不发网络请求 ----------

test('无 API Key → 本地 bigram 向量，零网络请求', async () => {
  reset();
  setCfg({}); // apiKey 缺失
  const out = await embedBatch(['计算机网络的三层结构', '操作系统调度']);
  assert.equal(fetchCalls, 0, '无 key 不应发起远程请求');
  assert.equal(out.length, 2);
  assert.equal(out[0].length, LOCAL_EMBED_DIM);
  const norm = Math.sqrt(out[0].reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, '向量应 L2 归一化');
});

// ---------- 默认 DeepSeek（无 embeddings 端点）→ 本地，无报错无请求 ----------

test('DeepSeek 默认配置（有 key 但无 /embeddings）→ 直接本地，不发请求', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash' });
  const out = await embedBatch(['缓冲区溢出是什么']);
  assert.equal(fetchCalls, 0, 'DeepSeek 无 embeddings 端点，应跳过远程');
  assert.equal(out.length, 1);
  assert.equal(out[0].length, LOCAL_EMBED_DIM);
});

// ---------- 支持 embeddings 的提供方 → 走远程 ----------

test('OpenAI 兼容端点 + key → 调远程 /embeddings', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' });
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
  });
  const out = await embedBatch(['hello world']);
  assert.equal(fetchCalls, 1, '应发起一次远程请求');
  assert.deepEqual(out[0], [0.1, 0.2, 0.3]);
});

// ---------- 远程失败 → 优雅降级本地（不抛错）----------

test('远程 embedding 失败 → 降级本地，不抛错', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' });
  fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  const out = await embedBatch(['fallback test']);
  assert.equal(fetchCalls, 1);
  assert.equal(out.length, 1, '失败应降级为本地向量而非抛错');
  assert.equal(out[0].length, LOCAL_EMBED_DIM);
});

test('空输入 → 空数组，无副作用', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  const out = await embedBatch([]);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(out, []);
});
