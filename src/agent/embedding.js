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

/**
 * 本次实际使用的 embeddings 配置（round110）。
 *
 * 为什么需要独立配置：embedding 与 chat 是两种能力、多数供应商也不同——
 * 用户完全可能「用 DeepSeek 聊天（不支持 /embeddings）+ 用另一家做向量」。
 * 此前 embedding 只能读聊天配置的 baseUrl/apiKey，于是只要聊天用 DeepSeek，
 * 向量检索就**永久只能跑本地降级算法**（256 维 bigram），语义召回形同虚设。
 * 新增三个可选字段（embeddingBaseUrl / embeddingApiKey / embeddingModel）：
 *   · 填了 → 用填的；没填 → 逐项回退到聊天配置（**老用户行为完全不变**）。
 */
function effectiveCfg() {
  const c = getCfg();
  const pick = (a, b) => (String(a || '').trim() || b);
  return {
    baseUrl: pick(c.embeddingBaseUrl, c.baseUrl),
    apiKey: pick(c.embeddingApiKey, c.apiKey),
    model: pick(c.embeddingModel, 'text-embedding-3-small'),
  };
}

/** 模型签名：检测 embedding 提供方/模型变更（变更后需重建索引） */
export function getModelSig() {
  const cfg = effectiveCfg();
  return cfg.apiKey
    ? `api:${cfg.baseUrl}:${cfg.model}`
    : 'local:bigram-256';
}

function hasKey() {
  return !!effectiveCfg().apiKey;
}

// ---------- 远程 embedding：调用 OpenAI 兼容 /v1/embeddings ----------
async function remoteEmbed(texts) {
  const t0 = Date.now();
  const cfg = effectiveCfg();
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = cfg.model;
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
 * 探针（供设置页「测试」按钮）：报告当前**实际**会走远程还是本地降级，以及向量维度。
 * 直接跑一次真实的 1 条向量请求——比"只校验格式"更能暴露问题（端点不存在/模型名写错/key 无效）。
 */
export async function probeEmbedding() {
  const eff = effectiveCfg();
  const remote = hasKey() && !isEmbeddingsUnsupported(eff);
  // 探针输入用 ASCII：这是发给 embedding 端点的一次性测试词（只看维度/远程与否，不看语义），
  // 非 UI 文案；写中文会被 i18n 数据层闸门（check-view-i18n --js）判为硬编码中文。
  const { vectors, degraded } = await embedBatch(['embedding probe test']);
  return {
    remote, degraded,
    dim: vectors?.[0]?.length || 0,
    baseUrl: eff.baseUrl,
    model: eff.model,
  };
}

/**
 * 批量生成 embedding
 * @param {string[]} texts
 * @returns {Promise<{ vectors: number[][], degraded: boolean }>}
 *   vectors: 向量数组；degraded: 本批是否实际使用了本地降级向量
 *
 * ⚠️ 2026-09-14 审计 P2：degraded 必须显式透出。
 * 旧实现失败静默降级、且调用方用 getModelSig()（只看配置）写行签名——
 * 远程恢复后查询向量 1536 维 vs 降级期间写入的 256 维行 cosine=0，
 * 而签名相同（配置没变）→ 这些行**永远不会被判定为过期重建**，语义检索永久丢失。
 * 写入方拿到 degraded 后应落「降级签名」（见 retrieval.js 的 modelSigFor），
 * 远程恢复后签名不匹配 → computeStaleItems 自动触发全量重建。
 */
export async function embedBatch(texts) {
  if (!texts.length) return { vectors: [], degraded: false };
  // 远程仅在「有 key 且提供方支持 embeddings」时尝试；其余（无 key / DeepSeek 等）直接本地，零报错。
  const tryRemote = hasKey() && !isEmbeddingsUnsupported(effectiveCfg());
  if (tryRemote) {
    try {
      const vectors = await remoteEmbed(texts);
      return { vectors, degraded: false };
    } catch (e) {
      // 远程失败时降级到本地，保证可用性（info 级，非报错）
      console.info('[embedding] 远程 embedding 不可用，已降级本地向量：', e.message);
      return { vectors: localEmbed(texts), degraded: true };
    }
  }
  return { vectors: localEmbed(texts), degraded: false };
}

/** 单条 embedding（返回向量；查询侧使用，不关心降级标记） */
export async function embed(text) {
  const { vectors } = await embedBatch([String(text || '')]);
  return vectors[0];
}

/**
 * 行签名：写入索引时的 modelSig。降级批次落「降级签名」，
 * 使远程恢复后（签名回到纯 api 签名）与存量行签名不匹配 → 自动重建。
 */
export function modelSigFor(sig, degraded) {
  return degraded ? `local:fallback:${sig}` : sig;
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
