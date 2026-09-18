// src/agent/retrieval.js
// RAG 检索核心：把卡片/文档 chunk 化 → 生成 embedding → 存 IndexedDB → 混合检索 → top-k 注入
// 这是 Agent 的「眼睛」：从全量注入升级到检索增强注入，Agent 只看到与问题最相关的上下文
//
// 设计要点：
//   1) 卡片天然是 chunk（front+back 合为一条），文档按段落分块（500 字 + 50 字重叠）
//   2) 增量索引：只对新增/修改/缺向量的卡片文档生成 embedding，不全量重建
//   3) 混合检索：关键词命中（BM25 思路，词频加权）+ 语义相似（余弦）→ reranking 融合排序
//   4) 模型签名(modelSig)：embedding 模型变更时自动标记全量重建

import { db } from '../db.js';
import { embedBatch, embed, getModelSig, modelSigFor } from './embedding.js';
import { computeStaleItems } from './stale.js';
import { embeddingRowId, embeddingRowIdsFor } from './embedding-key.js';
import { scoreSemantic, scoreKeyword, fuseResults } from './retrieval-core.js';
// round67：RAG 片段是「图片进 AI 上下文」的主要入口，截断必须保护图片引用完整性
// （朴素 slice 会把 56 字符的 `![image](sxy-img://uuid)` 切成残缺 id → 图静默丢失）
import { clipText } from '../utils/clip.js';

const CHUNK_LEN = 500; // 文档分块长度
const CHUNK_OVERLAP = 50; // 分块重叠（避免切断语义）
const BATCH = 16; // embedding 批量大小

// ---------- 向量行的确定性主键 / 历史行归一（round112 P1）----------
// id 形态、以及「为什么不再用 uid()、为什么 id 里不放 modelSig」的完整推演见
// agent/embedding-key.js 的头注释（那里是唯一事实来源，本文件只消费它）。
const REKEY_FLAG = 'sxy_embeddings_rekey_v1'; // 一次性归一完成标记（本机 localStorage，不同步）

/** 行时间戳（非法值归 0，仅用于挑「同 chunk 多条历史行」里的赢家） */
function rowTs(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
}

/**
 * 删除一批向量行，**逐条写墓碑**（kind='embedding'）。
 *
 * 为什么必须写墓碑：embeddings 是同步表（merge:'idOnly'），absence ≠ deletion ——
 * 只删行不写墓碑时，对端/中枢持有的旧行会在下次同步被原样推回，
 * 「重新分块/重建索引后删掉的旧行」永远去不掉（跨端不收敛，即 P1 的另一半）。
 *
 * @param {Array} rows 候选行（调用方已按 sourceId 查出）
 * @param {Set<string>} keepIds 本次**紧接着就会被重写**的 id —— 绝不墓碑：
 *   同毫秒下 deletedAt 可能等于新行的 updatedAt，而 applyTombstones 判定
 *   `livenessTs <= deletedAt` 即删 → 会把刚落库的新行自己删掉。
 * @param {number} ts 删除时刻
 * @returns {Promise<number>} 实际删除行数
 */
async function dropEmbeddingRows(rows, keepIds, ts) {
  const stale = (rows || []).filter((r) => r && r.id && !keepIds.has(r.id));
  if (!stale.length) return 0;
  await db.transaction('rw', db.embeddings, db.tombstones, async () => {
    await db.embeddings.bulkDelete(stale.map((r) => r.id));
    await db.tombstones.bulkPut(stale.map((r) => ({ id: r.id, kind: 'embedding', deletedAt: ts })));
  });
  return stale.length;
}

function markRekeyDone() {
  try { localStorage.setItem(REKEY_FLAG, '1'); } catch { /* 无 localStorage（Node 单测）忽略 */ }
}

/**
 * 把历史「随机 id」向量行归一到确定性 id（一次性、幂等、有界）。
 *
 * 为什么非做不可：升级前每台设备各自 uid() 建行 → 同一个 chunk 在库里躺着 N 条**异 id** 行，
 * 且都是「有效行」（没有墓碑语义能让它们消失）。只改写入逻辑修不了**已存在**的重复：
 * 这些行不会再被任何写入路径触碰。这里逐行原地改键（**保留原向量**，不重算、不花 token），
 * 并给旧 id 写墓碑令对端/中枢一并丢弃 —— 两端各跑一遍后就收敛到同一个 id。
 *
 * 赢家规则（两台设备独立计算也必须一致，故全部是可比较的量）：
 *   已是确定性 id > updatedAt 新 > id 字典序大者。
 *
 * @param {{maxRows?:number, force?:boolean}} [opt] maxRows 限制本次处理的 chunk 组数（分批迁移）；
 *   force=true 忽略完成标记（供「重置索引」类入口显式重跑）。
 * @returns {Promise<{scanned:number, rekeyed:number, merged:number, done:boolean}>}
 */
export async function migrateLegacyEmbeddingIds(opt = {}) {
  const maxRows = Number.isInteger(opt.maxRows) && opt.maxRows > 0 ? opt.maxRows : 5000;
  const doneFlag = (() => { try { return localStorage.getItem(REKEY_FLAG) === '1'; } catch { return false; } })();
  if (doneFlag && !opt.force) return { scanned: 0, rekeyed: 0, merged: 0, done: true };

  const rows = await db.embeddings.toArray();
  if (!rows.length) { markRekeyDone(); return { scanned: 0, rekeyed: 0, merged: 0, done: true }; }

  // 按确定性 id 分组：一组 = 同一个 chunk 的全部历史行（正常情况下只有 1 条）
  const groups = new Map();
  for (const r of rows) {
    const cid = embeddingRowId(r.sourceType, r.sourceId, r.chunkIdx);
    if (!cid) continue; // 无 sourceId 的脏行不碰（保持原样，交由人工/后续清理）
    const g = groups.get(cid);
    if (g) g.push(r); else groups.set(cid, [r]);
  }

  const kill = [];  // 需删除（含墓碑）的行 id
  const write = []; // 需按确定性 id 重写的行（内容不变，仅改键）
  let rekeyed = 0, merged = 0;
  let processed = 0, truncated = false;
  for (const [cid, g] of groups) {
    if (processed >= maxRows) { truncated = true; break; }
    processed++;
    const rank = (r) => (r.id === cid ? 2 : 0); // 已是确定性 id 者优先
    const winner = g.slice().sort((a, b) => (rank(b) - rank(a))
      || (rowTs(b.updatedAt) - rowTs(a.updatedAt))
      || String(b.id).localeCompare(String(a.id)))[0];
    for (const r of g) if (r !== winner) kill.push(r.id);
    if (g.length > 1) merged += g.length - 1;
    if (winner.id !== cid) {
      // 旧随机 id：先删（带墓碑）再以确定性 id 写回同一份向量
      kill.push(winner.id);
      write.push({ ...winner, id: cid });
      rekeyed++;
    }
  }

  const ts = Date.now();
  const CHUNK = 500; // 分批：一次 bulkPut 上万行会长时间占住事务，低端机上可能触发超时
  for (let i = 0; i < kill.length; i += CHUNK) {
    const ks = kill.slice(i, i + CHUNK);
    await db.transaction('rw', db.embeddings, db.tombstones, async () => {
      await db.embeddings.bulkDelete(ks);
      await db.tombstones.bulkPut(ks.map((id) => ({ id, kind: 'embedding', deletedAt: ts })));
    });
  }
  for (let i = 0; i < write.length; i += CHUNK) {
    await db.embeddings.bulkPut(write.slice(i, i + CHUNK));
  }

  // 只有在「整表都过了一遍」时才落完成标记；被 maxRows 截断则下次启动继续
  if (!truncated) markRekeyDone();
  return { scanned: rows.length, rekeyed, merged, done: !truncated };
}

// 同一次会话内只跑一次归一（ensureIndex 在对话链路上，每次都全表扫代价不可接受）
let rekeyOnce = null;
function ensureRekeyOnce() {
  if (!rekeyOnce) {
    rekeyOnce = migrateLegacyEmbeddingIds().catch((e) => {
      console.warn('[retrieval] 向量行 id 归一失败（不影响检索，下次启动重试）:', e?.message || e);
      return null;
    });
  }
  return rekeyOnce;
}

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
  // 同源历史行（旧版随机 id）就地清理 + 墓碑 → 一张卡全库只留一行。
  // 旧实现是 `existing?.id || uid()`（**沿用**已有随机 id）：那等于把随机 id 世代传承，
  // 两端各自的随机 id 永远合不到一起 —— 重复堆积就是这么产生的。
  const id = embeddingRowId('card', card.id, 0);
  const ts = Date.now();
  const prev = await db.embeddings.where('sourceId').equals(card.id).and((e) => e.sourceType === 'card').toArray();
  // round114 P2：正文为空（用户把正/背面清空，只剩图片或纯空白）时**不能直接 return**——
  // 那样同源旧向量既不覆盖也不墓碑，会变成「幽灵行」：AI 检索仍命中这张卡**已经不存在的旧正文**。
  // 正解：清空该卡全部向量并写墓碑（idOnly 下 absence ≠ deletion，必须墓碑），再返回。
  // indexDoc 曾同款（`chunks.length || 1`），一并修。
  if (!text.trim()) { await dropEmbeddingRows(prev, new Set(), ts); return; }
  const { vectors, degraded } = await embedBatch([text]);
  const vec = vectors[0];
  const rowSig = modelSigFor(getModelSig(), degraded);
  await dropEmbeddingRows(prev, new Set([id]), ts);
  await db.embeddings.put({
    id,
    sourceType: 'card',
    sourceId: card.id,
    chunkIdx: 0,
    text,
    vector: vec,
    subject: card.subject || '',
    updatedAt: ts,
    modelSig: rowSig,
  });
}

/** 索引单篇文档：分块后逐块生成 embedding */
/** 文档 subject 提取（round19 R19-4 根治）：调用方统一传 doc.subject，
 *  旧路径也可能传 doc.title；二者皆空则归入「未分类」。避免 subject 恒空导致
 *  带 subject 的检索（loadEmbeddingRows 走 subject 索引）永远命中不到。 */
export function docSubject(doc) {
  return String(doc?.subject || doc?.title || '').trim();
}

export async function indexDoc(doc) {
  if (!doc?.id) return;
  const chunks = chunkText(doc.content || doc.text || '');
  const modelSig = getModelSig();
  const subject = docSubject(doc);
  const ts = Date.now();
  // 本次要写的 id 集合（确定性）。删除**不在集合内**的旧行：
  //   · 历史随机 id 行 —— 不清就等于「同一块文档两份向量」，且旧行为对端常驻；
  //   · 重新分块后不再存在的块（旧文更长 → 现在只有 3 块，旧的第 4/5 块必须消失）
  //     —— 必须写墓碑，否则对端/中枢会把它们推回来（idOnly 下 absence ≠ deletion）。
  // 集合内的 id 由下方 put 原地覆盖，故不墓碑（同 ms 自删风险，见 dropEmbeddingRows）。
  // round114 P2：chunkCount 传**真实值**（含 0）。此前写 `chunks.length || 1` 是错的：
  //   chunks.length===0（文档内容被清空 / 解析出空文本）时，`|| 1` 让 keepIds 含 `embed-doc-<id>-0`，
  //   于是旧的第 0 块向量既不被覆盖（下方 `if (!chunks.length) return` 早退）也不被墓碑 →
  //   残留幽灵行，AI 检索仍会命中**该文档已经不存在的内容**。
  const keepIds = embeddingRowIdsFor('doc', doc.id, chunks.length);
  const prev = await db.embeddings.where('sourceId').equals(doc.id).and((e) => e.sourceType === 'doc').toArray();
  await dropEmbeddingRows(prev, keepIds, ts);
  if (!chunks.length) return;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const { vectors: vecs, degraded } = await embedBatch(batch);
    const now = Date.now();
    const rowSig = modelSigFor(modelSig, degraded);
    for (let j = 0; j < batch.length; j++) {
      await db.embeddings.put({
        id: embeddingRowId('doc', doc.id, i + j),
        sourceType: 'doc',
        sourceId: doc.id,
        chunkIdx: i + j,
        text: batch[j],
        vector: vecs[j],
        subject,
        updatedAt: now,
        modelSig: rowSig,
      });
    }
  }
}

// ---------- 增量索引：只处理过期/缺失的 ----------

/** 找出需要重新索引的卡片（新增/修改后未索引/模型签名不匹配） */
export async function getStaleCards(limit = 200) {
  const modelSig = getModelSig();
  // round93 P2：改为按 updatedAt 降序扫描——Dexie 无 orderBy 时按主键（uid()=randomUUID，纯随机）
  // 取前 N，会永远只扫「uuid 最靠前的固定 2×limit 张」，其余卡片编辑后永远进不了增量重建集合。
  const cards = await db.cards.orderBy('updatedAt').reverse().limit(limit * 2).toArray();
  // 一次批量查询拿到所有相关 embedding，避免在循环里逐卡 N 次查询（N2 性能回归）
  const ids = cards.map((c) => c.id);
  const embById = new Map(
    ids.length
      ? (await db.embeddings.where('sourceId').anyOf(ids).toArray()).map((e) => [e.sourceId, e])
      : []
  );
  return computeStaleItems(cards, embById, modelSig, limit);
}

/** 找出需要重新索引的文档（round19 R19-3 修复：联合扫描 db.docs 与 db.docFiles）。
 *  知识库文档存于 db.docFiles（docs-lib.js 的 indexDoc 以 docFiles.id 写 embedding），
 *  而 db.docs 是卡片笔记（repo.createDoc）。若只扫 db.docs，rebuildIndex 清空
 *  embeddings 后知识库向量永不重建 → 资料库问答静默失效。两表合并、按 id 去重。 */
export async function getStaleDocs(limit = 50) {
  const modelSig = getModelSig();
  const [docRows, fileRows] = await Promise.all([
    // round93 P2：两表同样按 updatedAt 降序，确保最近编辑的文档优先进增量重建。
    db.docs.orderBy('updatedAt').reverse().limit(limit * 2).toArray(),
    db.docFiles.orderBy('updatedAt').reverse().limit(limit * 2).toArray(),
  ]);
  // round26 M-3：原实现 docRows 优先于 fileRows 串行入列，docs 满额时 docFiles 被挤压
  // → 重建索引时知识库资料可能排队饿死。改交错取样（两表配额对称），公平轮转。
  const seen = new Set();
  const docs = [];
  const maxLen = Math.max(docRows.length, fileRows.length);
  for (let i = 0; i < maxLen; i++) {
    const a = docRows[i], b = fileRows[i];
    if (a?.id && !seen.has(a.id)) { seen.add(a.id); docs.push(a); }
    if (b?.id && !seen.has(b.id)) { seen.add(b.id); docs.push(b); }
  }
  const ids = docs.map((d) => d.id);
  const embById = new Map(
    ids.length
      ? (await db.embeddings.where('sourceId').anyOf(ids).toArray()).map((e) => [e.sourceId, e])
      : []
  );
  return computeStaleItems(docs, embById, modelSig, limit);
}

/** 增量索引：处理过期卡片+文档（轻量，可后台跑） */
export async function ensureIndex(maxCards = 50, maxDocs = 10) {
  // 会话内首次增量索引时顺带做一次历史随机 id 归一（幂等、有完成标记，之后调用零成本）。
  // 放在这里而不是 app 启动：① 它是 RAG 链路的前置数据卫生；② 避免拖慢首屏。
  await ensureRekeyOnce();
  const [staleCards, staleDocs] = await Promise.all([getStaleCards(maxCards), getStaleDocs(maxDocs)]);
  let indexed = 0;
  const modelSig = getModelSig();
  const now = Date.now();
  // 卡片批量索引
  for (let i = 0; i < staleCards.length; i += BATCH) {
    const batch = staleCards.slice(i, i + BATCH);
    const texts = batch.map(cardToText);
    const { vectors: vecs, degraded } = await embedBatch(texts);
    const rowSig = modelSigFor(modelSig, degraded);
    for (let j = 0; j < batch.length; j++) {
      const id = embeddingRowId('card', batch[j].id, 0);
      // 与 indexCard 同款：清掉同源历史行（含旧随机 id）并写墓碑，只留确定性 id 一行
      const prev = await db.embeddings.where('sourceId').equals(batch[j].id)
        .and((e) => e.sourceType === 'card').toArray();
      await dropEmbeddingRows(prev, new Set([id]), now);
      await db.embeddings.put({
        id,
        sourceType: 'card',
        sourceId: batch[j].id,
        chunkIdx: 0,
        text: texts[j],
        vector: vecs[j],
        subject: batch[j].subject || '',
        updatedAt: now,
        modelSig: rowSig,
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
  // 只清本端、**不写墓碑**，理由有三（此前审计把它当成"缺少墓碑"的缺陷，实测这样更对）：
  //   ① 被清掉的行全部是确定性 id，紧接着就被 ensureIndex 以**同一个 id** 原地重写；
  //      给它们写墓碑会有同毫秒自删风险（applyTombstones 判 `liveness <= deletedAt`）；
  //   ② 对端持有的同 id 行确实会被推回，但同 id 在 idOnly 下与本地行幂等合并 ——
  //      不再产生重复，也不会跨端来回删（随机 id 时代才会"永远清不掉"）；
  //   ③ 上万条墓碑是一次同步包体积尖峰，而收益为零。
  // 历史随机 id 行由 migrateLegacyEmbeddingIds 统一墓碑化（见其注释）。
  await db.embeddings.clear();
  return ensureIndex(9999, 999);
}

// ---------- 混合检索 ----------

/**
 * 加载待检索的 embedding 行。
 * 关键优化（N1）：当调用方提供 subject / sourceType 时，走 IndexedDB 索引
 * （embeddings 表已建 'subject'/'sourceType' 索引）做范围裁剪，避免全表扫描。
 * 未提供时退回全表扫描，行为与旧实现完全一致（向后兼容）。
 */
/**
 * 无过滤条件（全库检索）的安全上限：超过则拒绝而不是一次性载入。
 * 1536 维向量 ≈ 6KB/条，3 万条 ≈ 180MB 进 JS 堆，低端机必崩（M10）。
 * 全库语义检索是正当需求（Agent 跨科目找知识），因此不禁止，但用显式报错
 * 逼调用方在「限定范围」与「接受不完整检索」间做选择，而不是默默 OOM。
 */
export const FULLSCAN_ROW_LIMIT = 3000;

// BUG-01 延伸：embedding 模型变更后，存量行向量维度与新查询向量不一致（本地 256 vs 远程 1536）。
// cosine 已对维度不一致返回 0（不再静默截断），这里在编排层告警一次，提示应重建索引而非悄悄全 0。
function warnDimMismatch(qVec, rows) {
  if (!qVec?.length || !rows.length) return;
  const bad = rows.some((r) => r.vector && r.vector.length && r.vector.length !== qVec.length);
  if (bad) {
    console.warn(
      `[retrieval] 检测到 embedding 维度不一致（查询 ${qVec.length} 维 vs 存量行），语义检索将全部得 0；请重建索引或统一 embedding 模型。`,
    );
  }
}

async function loadEmbeddingRows(opts = {}) {
  const subject = opts.subject && String(opts.subject).trim();
  if (subject) return db.embeddings.where('subject').equals(subject).toArray();
  if (opts.sourceType) return db.embeddings.where('sourceType').equals(opts.sourceType).toArray();
  // 单文件问答：限定 sourceId（Phase 6.4 资料问答——embeddings 已建 sourceId 索引）
  if (opts.sourceId) return db.embeddings.where('sourceId').equals(opts.sourceId).toArray();
  const total = await db.embeddings.count();
  if (total > FULLSCAN_ROW_LIMIT) {
    throw new Error(`全库检索需限定 subject / sourceType / sourceId（当前 ${total} 条 embedding 行，超过 ${FULLSCAN_ROW_LIMIT} 的安全上限，全表载入会耗尽内存）`);
  }
  return db.embeddings.toArray();
}

/** 语义检索：用 query 的 embedding 对所有 chunk 做余弦相似度排序 */
export async function semanticSearch(query, opts = {}) {
  const topK = opts.topK || 8;
  const minScore = opts.minScore || 0.15;
  const qVec = await embed(query);
  const rows = await loadEmbeddingRows(opts);
  if (!rows.length) return [];
  warnDimMismatch(qVec, rows);
  return scoreSemantic(qVec, rows)
    .sort((a, b) => b.score - a.score)
    .filter((s) => s.score >= minScore)
    .slice(0, topK);
}

/** 关键词检索：在 chunk 文本里做子串/分词匹配（轻量全文检索） */
export async function keywordSearch(query, opts = {}) {
  const topK = opts.topK || 8;
  const rows = await loadEmbeddingRows(opts);
  if (!rows.length) return [];
  return scoreKeyword(query, rows)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 混合检索：语义 + 关键词 → reranking 融合排序 → top-k。
 * 关键优化（N1）：仅加载一次 embedding 行，语义与关键词两套打分复用同一批数据，
 * 不再各扫一次全表（旧实现 hybridSearch 会触发 2 次完整 toArray）。
 */
export async function hybridSearch(query, opts = {}) {
  const topK = opts.topK || 6;
  const semW = opts.semanticWeight ?? 0.65;
  const kwW = opts.keywordWeight ?? 0.35;
  const qVec = await embed(query);
  const rows = await loadEmbeddingRows(opts);
  if (!rows.length) return [];
  warnDimMismatch(qVec, rows);
  const semScored = scoreSemantic(qVec, rows)
    .filter((s) => s.score >= (opts.minScore ?? 0.1))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK * 3);
  const kwScored = scoreKeyword(query, rows)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK * 3);
  return fuseResults(semScored, kwScored, { topK, semanticWeight: semW, keywordWeight: kwW });
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
        `- [卡片·相似${score}%] [${c.subject || '未分类'}] Q: ${clipText(c.front, 80).replace(/\s+/g, ' ')} | A: ${clipText(c.back, 120).replace(/\s+/g, ' ')}`,
      );
    } else {
      const d = docMap.get(r.row.sourceId);
      const title = d?.title || r.row.subject || '文档片段';
      L.push(`- [文档·相似${score}%] ${title}: ${clipText(r.row.text, 150).replace(/\s+/g, ' ')}`);
    }
  }
  return L.join('\n');
}

// ---------- 索引状态 ----------

/** 获取索引健康状态（供 UI / get_index_status 展示） */
export async function getIndexStatus() {
  const [totalCards, totalDocs, totalFiles, indexedRows] = await Promise.all([
    db.cards.count(),
    db.docs.count(),
    db.docFiles.count(),
    db.embeddings.count(),
  ]);
  // R19-3 延伸：可索引文档有两源（db.docs 卡片笔记 + db.docFiles 知识库文件），
  // 分母只数 db.docs 会让 docCoverage 失真（docSources 含 docFiles.id 时可超 100%）。
  const docTotal = totalDocs + totalFiles;
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
    totalDocs: docTotal,
    indexedDocs: docSources.size,
    docCoverage: docTotal ? Math.round((docSources.size / docTotal) * 100) : 0,
    totalChunks: indexedRows,
    modelSig: getModelSig(),
  };
}
