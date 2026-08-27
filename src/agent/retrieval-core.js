// 检索打分 / 融合的纯逻辑层（无 IO、无 Dexie 依赖，可独立单测）。
// 抽出原因：原 retrieval.js 的 semanticSearch/keywordSearch 各自全表扫描，
// hybridSearch 同时调用二者 → 每次混合检索 = 2 次全表扫（N1 性能债）。
// 这里把「打分」「融合」做成纯函数，编排层负责一次性加载后复用，避免重复扫描。
import { cosine } from './embedding.js';

/**
 * 语义打分：对每行的向量与查询向量做余弦相似度。
 * @param {number[]} qVec 查询向量
 * @param {Array<{vector?:number[]}>} rows embedding 行
 * @returns {Array<{row:object, score:number}>}
 */
export function scoreSemantic(qVec, rows) {
  if (!qVec || !rows.length) return [];
  return rows.map((row) => ({ row, score: cosine(qVec, row.vector || []) }));
}

/**
 * 关键词打分：在 chunk 文本里做 CJK bigram + 词项命中率（轻量全文检索）。
 * @param {string} query
 * @param {Array<{text?:string}>} rows
 * @returns {Array<{row:object, score:number}>}
 */
export function scoreKeyword(query, rows) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !rows.length) return [];
  const terms = new Set();
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  for (const ch of cjk) terms.add(ch);
  for (const w of q.split(/\s+/)) if (w) terms.add(w);
  if (!terms.size) return [];
  return rows.map((row) => {
    const text = (row.text || '').toLowerCase();
    let hits = 0;
    for (const t of terms) if (text.includes(t)) hits++;
    return { row, score: hits / terms.size };
  });
}

/**
 * 融合：同一 sourceId 取最高分 chunk，按加权得分排序 → top-k。
 * @param {Array<{row:object, score:number}>} sem 语义打分结果（已过滤/截断）
 * @param {Array<{row:object, score:number}>} kw 关键词打分结果（已过滤/截断）
 */
export function fuseResults(sem, kw, opts = {}) {
  const topK = opts.topK || 6;
  const semW = opts.semanticWeight ?? 0.65;
  const kwW = opts.keywordWeight ?? 0.35;
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
