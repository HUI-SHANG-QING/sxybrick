// src/agent/embedding-key.js
// 向量行的**确定性主键**（round112 P1：修「多设备向量重复堆积」）。
//
// 事故：retrieval.js 过去用 uid()（randomUUID）当 embeddings 行的 id。
//   同一张卡在 A/B 两台设备各建一次索引 → 两条**不同 id** 的行；
//   而 sync-manifest 对 embeddings 是 merge:'idOnly'（同 id 幂等、异 id 各留）→
//   两端都保留 → 向量行数随设备数倍增；hybridSearch 里同一张卡占多个位；
//   更快撞 FULLSCAN_ROW_LIMIT=3000；rebuildIndex 只清本端、又无墓碑
//   （idOnly 下 absence ≠ deletion）→ 对端旧行被推回，跨端永远不收敛。
// 修法：id 由 (sourceType, sourceId, chunkIdx) 确定性推导 —— 两端对同一份源数据
//   必然算出同一个 id，idOnly 合并天然幂等，**一个 chunk 全库只有一行**。
//
// 为什么 id 里**不**放 modelSig（并行审计方案原本建议放）：
//   ① modelSig 的职责是「这行的向量是哪个模型算的」，它已经作为**字段**存着，
//      stale.js 的 isEmbeddingStale 靠它判定重建 —— 放进 id 不会多出任何能力；
//   ② 反而有害：两端配置不同（手机无 key 走本地 256 维 / 电脑配了远程 1536 维）时，
//      放 modelSig 会让两端算出**不同 id** → 又回到「异 id 各留」→ 正是本次要修的重复堆积，
//      且这些异构行永远无法被对端清理（对本地是无用噪声，还占 FULLSCAN 名额）。
//   不放时：两端写同一个 id，idOnly 让本端保留自己的版本，modelSig 字段不匹配则触发
//      本端重建 —— 收敛，且不产生跨端互相删行的拉扯。
//
// 为什么不做 hash：id 只用于等值比较、不承载语义，拼接比 hash 更可读可调试，
//   且碰撞概率为 0（sourceId 是 uuid / chunkIdx 是整数 / sourceType 是枚举）。
//
// ⚠️ 改本模块的 id 形态时，必须同步检查三处（否则旧行变孤儿）：
//   ① repo.js restoreFromTrash 清理 embedding 墓碑用的前缀；
//   ② sync-dedup.js remapCardRefs 里 embeddings 行的 id 重算；
//   ③ retrieval.js migrateLegacyEmbeddingIds（把历史随机 id 归一到本形态）。
const SOURCE_TYPES = new Set(['card', 'doc']);

/** 该行是否带合法的源类型（严格：缺失/未知一律拒绝，绝**不猜**一个类型出来） */
function hasKnownSourceType(v) {
  return SOURCE_TYPES.has(v);
}

/** chunk 序号归一：非负整数之外一律 0（NaN/字符串/负数都不该产生第二个键空间） */
function normChunkIdx(v) {
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * 向量行的确定性 id。
 * @param {'card'|'doc'} sourceType 源类型
 * @param {string} sourceId 卡片/文档 id
 * @param {number} [chunkIdx] 分块序号（卡片恒为 0）
 * @returns {string} 形如 `embed-card-<id>-0`；sourceId 为空或源类型未知时返回 ''
 *   —— 调用方应据此**跳过**（保持原样），不要凭猜补一个类型。
 */
export function embeddingRowId(sourceType, sourceId, chunkIdx = 0) {
  const sid = String(sourceId ?? '').trim();
  // 源类型未知就**不给 id**（调用方据此原样跳过，不去猜类型）：
  // 猜错会把文档的行挂到 card 键下，而 indexDoc 只按 sourceType='doc' 清理 → 该行永远清不掉。
  if (!sid || !hasKnownSourceType(sourceType)) return '';
  return `embed-${sourceType}-${sid}-${normChunkIdx(chunkIdx)}`;
}

/** 某源全部向量行的 id 前缀（供墓碑/行清理按前缀匹配） */
export function embeddingIdPrefix(sourceType, sourceId) {
  const sid = String(sourceId ?? '').trim();
  if (!sid || !hasKnownSourceType(sourceType)) return '';
  return `embed-${sourceType}-${sid}-`;
}

/** 该行是否已是确定性 id（历史随机 id 行为 false，供迁移识别） */
export function isCanonicalEmbeddingRowId(row) {
  if (!row || !row.id) return false;
  return row.id === embeddingRowId(row.sourceType, row.sourceId, row.chunkIdx);
}

/** 某源的确定性 id 集合（文档分块：0..chunkCount-1） */
export function embeddingRowIdsFor(sourceType, sourceId, chunkCount) {
  const out = new Set();
  // round114 P2：**显式 0 必须返回空集**（源内容被清空 → 没有任何 chunk → 不该保留任何 id）。
  //   调用方 indexDoc 用它算 keepIds =「本次会被重写、故不写墓碑的 id」；
  //   若把 0 兜底成 1，keepIds 会含 `embed-<type>-<id>-0`，那块旧向量既不覆盖也不墓碑 → 幽灵行。
  //   仅对**未传/非法值**（undefined/NaN/负/非整数）保留 1 的向后兼容兜底。
  const n = Number.isInteger(chunkCount) ? Math.max(0, chunkCount) : 1;
  for (let i = 0; i < n; i++) {
    const id = embeddingRowId(sourceType, sourceId, i);
    if (id) out.add(id);
  }
  return out;
}
