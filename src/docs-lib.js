// 资料库服务层（Phase 6 学习资料中枢）
// 上传（OPFS + docFiles 元数据）→ 解析队列（串行、进度、可取消）→ 全文入库（docTexts）
// → 向量索引（embeddings，复用 retrieval.indexDoc）
// 约定：新数据先落 db 再进 sync；docFiles 已登记 sync-manifest（只同步元数据），
//       docTexts 为本地表（全文不同步），原文件存 OPFS（不跨设备）。

import { db, uid } from './db.js';
import {
  buildDocMeta, normalizeOpfsPath, saveFileToOpfs, readFileFromOpfs,
  deleteFileFromOpfs, statOpfs, requestPersist, assertDocTransition, routeParser,
} from './utils/opfs.js';
import { parseFile, assertParsedOk } from './utils/parsers.js';
import { indexDoc } from './agent/retrieval.js';
import { createCard } from './repo.js';
import { draftToCardPayload, validateDraft } from './utils/card-drafts.js';

const IDB_FALLBACK_MAX = 10 * 1024 * 1024; // OPFS 不可用时 ≤10MB 文件降级 IndexedDB

// ---------- 上传 ----------

/**
 * 上传文件：写 OPFS（分块+进度）→ docFiles 行 → 自动入队解析。
 * @param {File} file
 * @param {object} opts { subject?, onProgress?(written,total) }
 * @returns {Promise<object>} docFiles 行
 */
export async function uploadFile(file, opts = {}) {
  const meta = buildDocMeta(file, { id: uid(), subject: opts.subject, createdAt: Date.now() });
  const parserId = routeParser(meta.ext);
  if (!parserId) {
    meta.status = 'failed';
    meta.error = `暂不支持 ${meta.ext || '未知'} 格式`;
  } else {
    try {
      const opfsPath = `${meta.id}_${normalizeOpfsPath(meta.name)}`;
      await saveFileToOpfs(opfsPath, file, opts.onProgress);
      meta.storage = 'opfs';
      meta.opfsPath = opfsPath;
    } catch (e) {
      // OPFS 不可用 → 小文件降级 IndexedDB（Dexie 直接存 Blob）
      if (meta.size <= IDB_FALLBACK_MAX) {
        meta.storage = 'idb';
        meta.blob = file;
      } else {
        meta.status = 'failed';
        meta.error = `OPFS 写入失败：${e?.message || e}`;
      }
    }
  }
  await db.docFiles.put(meta);
  if (meta.status !== 'failed') enqueueParse(meta.id);
  return meta;
}

// ---------- 解析队列（串行：防几百 MB 大文件并发挤爆内存） ----------

const queue = [];
let draining = false;

export function enqueueParse(docId) {
  queue.push(docId);
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      await parseDoc(id);
    }
  } finally {
    draining = false;
  }
}

/** 取原文件 Blob（OPFS / IndexedDB 降级），本机无原文返回 null */
export async function getFileBlob(row) {
  if (!row) return null;
  if (row.storage === 'opfs' && row.opfsPath) return readFileFromOpfs(row.opfsPath);
  if (row.storage === 'idb') return row.blob || null;
  return null;
}

/**
 * 解析单个文件：状态机 uploading→parsing→ready/failed。
 * 成功后自动 indexDoc 建向量索引（失败不阻塞 ready）。
 * @returns {Promise<{ok:boolean, textLen?:number, pageCount?:number, error?:string}>}
 */
export async function parseDoc(docId, opts = {}) {
  const row = await db.docFiles.get(docId);
  if (!row) return { ok: false, error: '资料不存在' };
  try { assertDocTransition(row.status, 'parsing'); }
  catch (e) { return { ok: false, error: e.message }; }
  const t = Date.now();
  await db.docFiles.update(docId, { status: 'parsing', error: null, updatedAt: t });
  try {
    const blob = await getFileBlob(row);
    if (!blob) throw new Error('本机无原文件（跨设备同步的元数据无法解析）');
    const result = await parseFile(row.ext, blob, {
      onPage: opts.onPage,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    assertParsedOk(result, row.size);
    const text = result.text;
    await db.docTexts.put({ id: docId, text, textLen: text.length, updatedAt: Date.now() });
    const patch = { status: 'ready', textLen: text.length, error: null, updatedAt: Date.now() };
    if (result.pageCount) patch.pageCount = result.pageCount;
    await db.docFiles.update(docId, patch);
    // 向量索引（fire-and-forget：失败不阻塞解析完成，可稍后重建）
    try {
      await indexDoc({ id: docId, text, subject: row.name });
    } catch (e) {
      console.warn('[docs-lib] 向量索引失败（可稍后重建）:', e?.message || e);
    }
    return { ok: true, textLen: text.length, pageCount: result.pageCount };
  } catch (e) {
    const msg = String(e?.message || e);
    await db.docFiles.update(docId, { status: 'failed', error: msg, updatedAt: Date.now() });
    return { ok: false, error: msg };
  }
}

/** 失败重试 / 重新解析 */
export async function retryParse(docId) {
  return parseDoc(docId);
}

// ---------- 查询 / 删除 ----------

export async function listDocFiles() {
  return db.docFiles.orderBy('updatedAt').reverse().toArray();
}

export async function getDocFile(id) {
  return (await db.docFiles.get(id)) || null;
}

/** 解析全文（本地表） */
export async function getDocText(id) {
  return (await db.docTexts.get(id))?.text || '';
}

/** 删除：原文件（OPFS）→ docFiles → docTexts → embeddings → 墓碑 */
export async function deleteDocFile(id) {
  const row = await db.docFiles.get(id);
  if (!row) return;
  if (row.storage === 'opfs' && row.opfsPath) await deleteFileFromOpfs(row.opfsPath);
  await db.docFiles.delete(id);
  await db.docTexts.delete(id);
  await db.embeddings.where('sourceId').equals(id).delete();
  await db.tombstones.put({ id, kind: 'docFile', deletedAt: Date.now() });
}

// ---------- 存储健康 ----------

export async function getStorageInfo() {
  return statOpfs();
}

export async function ensurePersist() {
  return requestPersist();
}

// ---------- 自动建卡（用户选择制） ----------

/**
 * 用户确认后的草稿批量入库。
 * ⚠️ 仅在用户点「确认导入」后调用；默认绝不自动建卡。
 * @param {Array<{front:string,back:string}>} drafts 用户编辑后的最终草稿
 * @param {object} opts { subject, source(docFiles.id) }
 * @returns {Promise<Array>} 创建的卡片
 */
export async function confirmDrafts(drafts, opts = {}) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (!list.length) return [];
  const created = [];
  for (const d of list) {
    const err = validateDraft(d);
    if (err) throw new Error(`第 ${created.length + 1} 张卡片${err}`);
    created.push(await createCard(draftToCardPayload(d, opts)));
  }
  return created;
}
