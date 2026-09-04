// src/agent/embedding.js
// Embedding 适配器：RAG 检索增强的「眼睛」。
// 设计要点：
//   1) 有 API Key 时调远程 OpenAI 兼容 /v1/embeddings（text-embedding-3-small / bge-large-zh 等）
//   2) 无 API Key 或离线时降级到本地：中文双字 bigram + 英文词 + TF 哈希到 256 维向量
//   3) 本地降级虽不如语义 embedding 精准，但零依赖、离线可用、能捕捉关键词重叠
//   4) 余弦相似度检索由 retrieval.js 负责，本模块只管「把文本变成向量」
//   5) P2-27：远程 embedding 调用记录用量到本地 db.aiUsage（本地降级不计费不记录）

import { recordUsage } from '../utils/ai-usage.js';

const CFG_KEY = 'sxy_ai_config';
const LOCAL_DIM = 256; // 本地降级向量维度

// 直接从 localStorage 读配置（与 ai.js 同源，避免循环依赖）
function getCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', ...(c || {}) };
  } catch {
    return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash' };
  }
}

/** 模型签名：检测 embedding 模型变更（变更后需重建索引） */
export function getModelSig() {
  const cfg = getCfg();
  return cfg.apiKey
    ? `api:${cfg.baseUrl}:${cfg.embeddingModel || 'text-embedding-3-small'}`
    : 'local:bigram-256';
}

function hasKey() {
  return !!getCfg().apiKey;
}

// ---------- 远程 embedding：调用 OpenAI 兼容 /v1/embeddings ----------
async function remoteEmbed(texts) {
  const t0 = Date.now();
  const cfg = getCfg();
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = cfg.embeddingModel || 'text-embedding-3-small';
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Embedding 请求失败(${res.status})：${t.slice(0, 300)}`);
  }
  const data = await res.json();
  // OpenAI 兼容格式：data.data = [{ index, embedding: [...] }, ...]
  const arr = (data?.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  // P2-27：记录 embedding 用量（usage.total_tokens 优先，缺失时按字符估算）
  recordUsage({
    source: 'embedding', model,
    promptTokens: data?.usage?.total_tokens ?? texts.join(' ').length,
    completionTokens: 0,
    durationMs: Date.now() - t0,
    est: data?.usage?.total_tokens == null ? 1 : 0,
  }).catch(() => {});
  return arr.map((d) => d.embedding);
}

// ---------- 本地降级 embedding：bigram + 词频哈希 ----------

function tokenize(text) {
  const raw = String(text || '');
  const tokens = [];
  // 英文/数字：按空格分词 + 长词取 bigram
  const latin = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  for (const w of latin.split(/\s+/)) {
    if (!w) continue;
    tokens.push(w);
    if (w.length > 2) {
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    }
  }
  // 中文：双字 bigram + 单字
  const cjk = raw.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
  for (const ch of cjk) tokens.push(ch);
  return tokens;
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  return h;
}

function localEmbed(texts) {
  return texts.map((text) => {
    const tokens = tokenize(text);
    const vec = new Float32Array(LOCAL_DIM);
    for (const t of tokens) {
      vec[hashStr(t) % LOCAL_DIM] += 1; // TF 加权
    }
    // L2 归一化
    let norm = 0;
    for (let i = 0; i < LOCAL_DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Array(LOCAL_DIM);
    for (let i = 0; i < LOCAL_DIM; i++) out[i] = vec[i] / norm;
    return out;
  });
}

/**
 * 该配置指向的提供方是否不支持 /embeddings 端点。
 * DeepSeek 等仅提供 chat 不提供 embeddings，强行走远程必 4xx；
 * 直接本地降级，避免无谓网络请求与误导性报错（开箱即用性，N5）。
 */
function isEmbeddingsUnsupported(cfg) {
  const base = String(cfg.baseUrl || '').toLowerCase();
  return base.includes('deepseek');
}

/**
 * 批量生成 embedding
 * @param {string[]} texts
 * @returns {Promise<number[][]>} 向量数组
 */
export async function embedBatch(texts) {
  if (!texts.length) return [];
  // 远程仅在「有 key 且提供方支持 embeddings」时尝试；其余（无 key / DeepSeek 等）直接本地，零报错。
  const tryRemote = hasKey() && !isEmbeddingsUnsupported(getCfg());
  if (tryRemote) {
    try {
      return await remoteEmbed(texts);
    } catch (e) {
      // 远程失败时降级到本地，保证可用性（info 级，非报错）
      console.info('[embedding] 远程 embedding 不可用，已降级本地向量：', e.message);
    }
  }
  return localEmbed(texts);
}

/** 单条 embedding */
export async function embed(text) {
  const arr = await embedBatch([String(text || '')]);
  return arr[0];
}

/** 余弦相似度 */
export function cosine(a, b) {
  // BUG-01：维度不一致时绝不静默截断（旧实现 Math.min 只比较较短维，会把 1536 维
  // 远程向量当 256 维本地向量比，得出错误相似度）。这里直接判 0，逼上游走
  // modelSig 全量重建，而不是悄悄算错分。
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (!la || !lb || la !== lb) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < la; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = (Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1);
  return denom ? dot / denom : 0;
}

/** 本地降级维度（供 retrieval 模块校验） */
export const LOCAL_EMBED_DIM = LOCAL_DIM;
