// src/agent/retrieval.js
// RAG 检索核心：把卡片/文档 chunk 化 → 生成 embedding → 存 IndexedDB → 混合检索 → top-k 注入
// 这是 Agent 的「眼睛」：从全量注入升级到检索增强注入，Agent 只看到与问题最相关的上下文
//
// 设计要点：
//   1) 卡片天然是 chunk（front+back 合为一条），文档按段落分块（500 字 + 50 字重叠）
//   2) 增量索引：只对新增/修改/缺向量的卡片文档生成 embedding，不全量重建
//   3) 混合检索：关键词命中（BM25 思路，词频加权）+ 语义相似（余弦）→ reranking 融合排序
//   4) 模型签名(modelSig)：embedding 模型变更时自动标记全量重建

import { db, uid } from '../db.js';
import { embedBatch, embed, cosine, getModelSig } from './embedding.js';

const CHUNK_LEN = 500; // 文档分块长度
const CHUNK_OVERLAP = 50; // 分块重叠（避免切断语义）
const BATCH = 16; // embedding 批量大小

// ---------- 文本预处理 ----------

/** 把卡片转成可索引的纯文本 */
function cardToText(c) {
  const tags = (c.tags || []).join(' ');
  return [c.front || '', c.back || '', c.subject || '', tags].filter(Boolean).join('\n');
}

/** 文档分块：按段落切，控制每块 ~CHUNK_LEN 字，带 CHUNK_OVERLAP 重叠 */
export function chunkText(text, maxLen = CHUNK_LEN, overlap = CHUNK_OVERLAP) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const chunks = [];
  // 先按双换行（段落）切，再合并/拆分到目标长度
  const paras = s.split(/\n{2,}/);
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxLen && buf) {
      chunks.push(buf);
      buf = buf.slice(-overlap) + '\n\n' + p; // 重叠：保留上一块尾部
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
    while (buf.length > maxLen * 1.5) {
      chunks.push(buf.slice(0, maxLen));
      buf = buf.slice(maxLen - overlap);
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks.filter(Boolean);
}

// ---------- 索引：生成 + 存储 embedding ----------

/** 索引单张卡片：生成 embedding 存入 db.embeddings（有则更新） */
export async function indexCard(card) {
  if (!card?.id) return;
  const text = cardToText(card);
  if (!text.trim()) return;
  const vec = await embed(text);
  const modelSig = getModelSig();
  const existing = await db.embeddings.where('sourceId').equals(card.id).first();
  await db.embeddings.put({
    id: existing?.id || uid(),
    sourceType: 'card',
    sourceId: card.id,
    chunkIdx: 0,
    text,
    vector: vec,
    subject: card.subject || '',
    updatedAt: Date.now(),
    modelSig,
  });
}

/** 索引单篇文档：分块后逐块生成 embedding */
export async function indexDoc(doc) {
  if (!doc?.id) return;
  const chunks = chunkText(doc.content || doc.text || '');
  const modelSig = getModelSig();
  await db.embeddings.where('sourceId').equals(doc.id).delete(); // 删除旧 chunk
  if (!chunks.length) return;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vecs = await embedBatch(batch);
    const now = Date.now();
    for (let j = 0; j < batch.length; j++) {
      await db.embeddings.put({
        id: uid(),
        sourceType: 'doc',
        sourceId: doc.id,
        chunkIdx: i + j,
        text: batch[j],
        vector: vecs[j],
        subject: doc.title || '',
        updatedAt: now,
        modelSig,
      });
    }
  }
}

// ---------- 增量索引：只处理过期/缺失的 ----------

/** 找出需要重新索引的卡片（新增/修改后未索引/模型签名不匹配） */
export async function getStaleCards(limit = 200) {
  const modelSig = getModelSig();
  const cards = await db.cards.limit(limit * 2).toArray();
  const stale = [];
  for (const c of cards) {
    if (stale.length >= limit) break;
    const emb = await db.embeddings.where('sourceId').equals(c.id).first();
    if (!emb || emb.modelSig !== modelSig || emb.updatedAt < (c.updatedAt || 0)) {
      stale.push(c);
    }
  }
  return stale;
}

/** 找出需要重新索引的文档 */
export async function getStaleDocs(limit = 50) {
  const modelSig = getModelSig();
  const docs = await db.docs.limit(limit * 2).toArray();
  const stale = [];
  for (const d of docs) {
    if (stale.length >= limit) break;
    const emb = await db.embeddings.where('sourceId').equals(d.id).first();
    if (!emb || emb.modelSig !== modelSig || emb.updatedAt < (d.updatedAt || 0)) {
      stale.push(d);
    }
  }
  return stale;
}

/** 增量索引：处理过期卡片+文档（轻量，可后台跑） */
export async function ensureIndex(maxCards = 50, maxDocs = 10) {
  const [staleCards, staleDocs] = await Promise.all([getStaleCards(maxCards), getStaleDocs(maxDocs)]);
  let indexed = 0;
  const modelSig = getModelSig();
  const now = Date.now();
  // 卡片批量索引
  for (let i = 0; i < staleCards.length; i += BATCH) {
    const batch = staleCards.slice(i, i + BATCH);
    const texts = batch.map(cardToText);
    const vecs = await embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      const existing = await db.embeddings.where('sourceId').equals(batch[j].id).first();
      await db.embeddings.put({
        id: existing?.id || uid(),
        sourceType: 'card',
        sourceId: batch[j].id,
        chunkIdx: 0,
        text: texts[j],
        vector: vecs[j],
        subject: batch[j].subject || '',
        updatedAt: now,
        modelSig,
      });
      indexed++;
    }
  }
  // 文档逐篇索引（因为要分块）
  for (const doc of staleDocs) {
    await indexDoc(doc);
    indexed++;
  }
  return { indexed, cards: staleCards.length, docs: staleDocs.length };
}

/** 全量重建索引（模型变更或手动触发） */
export async function rebuildIndex() {
  await db.embeddings.clear();
  return ensureIndex(9999, 999);
}

// ---------- 混合检索 ----------

/** 语义检索：用 query 的 embedding 对所有 chunk 做余弦相似度排序 */
export async function semanticSearch(query, opts = {}) {
  const topK = opts.topK || 8;
  const minScore = opts.minScore || 0.15;
  const qVec = await embed(query);
  const all = await db.embeddings.toArray();
  if (!all.length) return [];
  const scored = all.map((row) => ({ row, score: cosine(qVec, row.vector || []) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= minScore).slice(0, topK);
}

/** 关键词检索：在 chunk 文本里做子串/分词匹配（轻量全文检索） */
export async function keywordSearch(query, opts = {}) {
  const topK = opts.topK || 8;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const terms = new Set();
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  for (const ch of cjk) terms.add(ch);
  for (const w of q.split(/\s+/)) if (w) terms.add(w);
  if (!terms.size) return [];

  const all = await db.embeddings.toArray();
  const scored = all.map((row) => {
    const text = (row.text || '').toLowerCase();
    let hits = 0;
    for (const t of terms) if (text.includes(t)) hits++;
    return { row, score: hits / terms.size };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

/** 混合检索：语义 + 关键词 → reranking 融合排序 → top-k */
export async function hybridSearch(query, opts = {}) {
  const topK = opts.topK || 6;
  const semW = opts.semanticWeight ?? 0.65;
  const kwW = opts.keywordWeight ?? 0.35;

  const [sem, kw] = await Promise.all([
    semanticSearch(query, { topK: topK * 3, minScore: 0.1 }),
    keywordSearch(query, { topK: topK * 3 }),
  ]);

  // 融合：同一 sourceId 取最高分 chunk，按加权得分排序
  const byId = new Map();
  for (const s of sem) {
    const key = s.row.sourceId;
    if (!byId.has(key) || byId.get(key).score < s.score) byId.set(key, s);
  }
  for (const k of kw) {
    const key = k.row.sourceId;
    if (!byId.has(key) || byId.get(key).score < k.score) byId.set(key, k);
  }

  const merged = [...byId.values()].map((item) => {
    const semScore = sem.find((s) => s.row.sourceId === item.row.sourceId)?.score || 0;
    const kwScore = kw.find((k) => k.row.sourceId === item.row.sourceId)?.score || 0;
    const fused = semScore * semW + kwScore * kwW;
    return { ...item, fused, semScore, kwScore };
  });
  merged.sort((a, b) => b.fused - a.fused);
  return merged.slice(0, topK);
}

// ---------- 上下文注入：把检索结果格式化为 Agent 可用文本 ----------

/** 从混合检索结果提取 sourceId → 卡片/文档详情，拼成上下文文本 */
export async function retrieveContext(query, opts = {}) {
  const results = await hybridSearch(query, opts);
  if (!results.length) return '';

  const cardIds = results.filter((r) => r.row.sourceType === 'card').map((r) => r.row.sourceId);
  const docIds = results.filter((r) => r.row.sourceType === 'doc').map((r) => r.row.sourceId);

  const [cards, docs] = await Promise.all([
    cardIds.length ? db.cards.where('id').anyOf(cardIds).toArray() : [],
    docIds.length ? db.docs.where('id').anyOf(docIds).toArray() : [],
  ]);
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  const docMap = new Map(docs.map((d) => [d.id, d]));

  const L = [];
  L.push('【检索增强·与问题最相关的卡片/文档片段】');
  for (const r of results) {
    const score = Math.round(r.fused * 100);
    if (r.row.sourceType === 'card') {
      const c = cardMap.get(r.row.sourceId);
      if (!c) continue;
      L.push(
        `- [卡片·相似${score}%] [${c.subject || '未分类'}] Q: ${String(c.front).slice(0, 80).replace(/\s+/g, ' ')} | A: ${String(c.back).slice(0, 120).replace(/\s+/g, ' ')}`,
      );
    } else {
      const d = docMap.get(r.row.sourceId);
      const title = d?.title || r.row.subject || '文档片段';
      L.push(`- [文档·相似${score}%] ${title}: ${r.row.text.slice(0, 150).replace(/\s+/g, ' ')}`);
    }
  }
  return L.join('\n');
}

// ---------- 索引状态 ----------

/** 获取索引健康状态（供 UI 展示） */
export async function getIndexStatus() {
  const [totalCards, totalDocs, indexedRows] = await Promise.all([
    db.cards.count(),
    db.docs.count(),
    db.embeddings.count(),
  ]);
  const cardSources = new Set(
    (await db.embeddings.where('sourceType').equals('card').toArray()).map((r) => r.sourceId),
  );
  const docSources = new Set(
    (await db.embeddings.where('sourceType').equals('doc').toArray()).map((r) => r.sourceId),
  );
  return {
    totalCards,
    indexedCards: cardSources.size,
    cardCoverage: totalCards ? Math.round((cardSources.size / totalCards) * 100) : 0,
    totalDocs,
    indexedDocs: docSources.size,
    docCoverage: totalDocs ? Math.round((docSources.size / totalDocs) * 100) : 0,
    totalChunks: indexedRows,
    modelSig: getModelSig(),
  };
}
