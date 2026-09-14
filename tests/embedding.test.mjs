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

const { embedBatch, cosine, LOCAL_EMBED_DIM, modelSigFor } = await import('../src/agent/embedding.js');

// ---------- 无 key：直接本地，不发网络请求 ----------

test('无 API Key → 本地 bigram 向量，零网络请求', async () => {
  reset();
  setCfg({}); // apiKey 缺失
  const { vectors: out, degraded } = await embedBatch(['计算机网络的三层结构', '操作系统调度']);
  assert.equal(fetchCalls, 0, '无 key 不应发起远程请求');
  assert.equal(degraded, false, '无 key 是正常本地路径，不是降级');
  assert.equal(out.length, 2);
  assert.equal(out[0].length, LOCAL_EMBED_DIM);
  const norm = Math.sqrt(out[0].reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, '向量应 L2 归一化');
});

// ---------- 默认 DeepSeek（无 embeddings 端点）→ 本地，无报错无请求 ----------

test('DeepSeek 默认配置（有 key 但无 /embeddings）→ 直接本地，不发请求', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash' });
  const { vectors: out, degraded } = await embedBatch(['缓冲区溢出是什么']);
  assert.equal(fetchCalls, 0, 'DeepSeek 无 embeddings 端点，应跳过远程');
  assert.equal(degraded, false);
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
  const { vectors: out, degraded } = await embedBatch(['hello world']);
  assert.equal(fetchCalls, 1, '应发起一次远程请求');
  assert.equal(degraded, false, '远程成功不是降级');
  assert.deepEqual(out[0], [0.1, 0.2, 0.3]);
});

// ---------- 远程失败 → 优雅降级本地（不抛错）----------

test('远程 embedding 失败 → 降级本地，不抛错', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' });
  fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  const { vectors: out, degraded } = await embedBatch(['fallback test']);
  assert.equal(fetchCalls, 1);
  assert.equal(degraded, true, '远程失败必须标记降级（写入方据此落降级签名，防恢复后永久失配）');
  assert.equal(out.length, 1, '失败应降级为本地向量而非抛错');
  assert.equal(out[0].length, LOCAL_EMBED_DIM);
});

test('空输入 → 空数组，无副作用', async () => {
  reset();
  setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  const { vectors: out, degraded } = await embedBatch([]);
  assert.equal(fetchCalls, 0);
  assert.equal(degraded, false);
  assert.deepEqual(out, []);
});

// ---------- BUG-01：cosine 维度不一致不再静默截断 ----------

test('cosine：维度不一致返回 0（不静默截断）', () => {
  // 旧实现 Math.min 会把 3 维行当 2 维比，算出误导性相似度
  assert.equal(cosine([1, 0], [1, 0, 0]), 0, '维度不一致应判 0');
  assert.equal(cosine([1, 0, 0], [1, 0]), 0, '反向维度不一致也应判 0');
});

test('cosine：空/缺向量安全', () => {
  assert.equal(cosine([1, 0], []), 0, '空向量应判 0');
  assert.equal(cosine(undefined, [1, 0]), 0, '缺 a 应判 0');
  assert.equal(cosine(null, null), 0, '双空应判 0');
});

test('cosine：同维度计算正确（正交 0 / 同向 1）', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, '同向应接近 1');
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, '正交应为 0');
});
// ---------- 2026-09-14 审计 P2：降级签名 ----------

test('modelSigFor：正常批次用原签名；降级批次落降级签名', () => {
  const sig = 'api:https://api.openai.com/v1:text-embedding-3-small';
  assert.equal(modelSigFor(sig, false), sig, '非降级不改变签名');
  assert.equal(modelSigFor(sig, true), 'local:fallback:' + sig, '降级批次必须落降级签名');
  // 关键性质：降级签名 ≠ 恢复后的原签名 → computeStaleItems 判定过期 → 自动重建
  assert.notEqual(modelSigFor(sig, true), sig, '降级签名与原签名必须不同');
});
