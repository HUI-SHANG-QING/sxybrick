// 判断一批卡片/文档中哪些需要重新生成 embedding（增量索引用）。
// 抽离为纯函数：① 便于单测（无需 Dexie/IndexedDB）；
// ② 让 getStaleCards/getStaleDocs 把「逐卡 N 次查询」降为「一次 anyOf 批量查询」。

/**
 * 单条是否需要重建 embedding。
 * @param {object} item 卡片或文档（需含 id、updatedAt）
 * @param {object|undefined} emb 已存在的 embedding 记录（按 sourceId 取到）
 * @param {string} modelSig 当前模型签名
 */
export function isEmbeddingStale(item, emb, modelSig) {
  if (!emb) return true;
  if (emb.modelSig !== modelSig) return true;
  return emb.updatedAt < (item.updatedAt || 0);
}

/**
 * 批量筛选过期项。
 * @param {Array} items 卡片/文档列表
 * @param {Map<string,object>} embById 以 sourceId 为键的 embedding 映射（一次批量查询得到）
 * @param {string} modelSig 当前模型签名
 * @param {number} [limit] 最多返回多少（默认全部）
 */
export function computeStaleItems(items, embById, modelSig, limit) {
  const out = [];
  const cap = limit ?? items.length;
  for (const it of items) {
    if (out.length >= cap) break;
    if (isEmbeddingStale(it, embById.get(it.id), modelSig)) out.push(it);
  }
  return out;
}
