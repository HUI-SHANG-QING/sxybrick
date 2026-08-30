// 资料库服务层（Phase 6 学习资料中枢）
// 上传（OPFS + docFiles 元数据）→ 解析队列（串行、进度、可取消）→ 全文入库（docTexts）
// → 向量索引（embeddings，复用 retrieval.indexDoc）
// 约定：新数据先落 db 再进 sync；docFiles 已登记 sync-manifest（只同步元数据），
//       docTexts 为本地表（全文不同步），原文件存 OPFS（不跨设备）。

import { db, uid } from './db.js';
import {
  buildDocMeta, normalizeOpfsPath, saveFileToOpfs, readFileFromOpfs,
  deleteFileFromOpfs, statOpfs, requestPersist, assertDocTransition, routeParser,
  opfsWritableSupported,
} from './utils/opfs.js';
import { parseFile, assertParsedOk } from './utils/parsers.js';
import {
  cleanOcrText, isOcrEmpty, fitCanvasSize, normalizeOcrLang,
  buildOcrAssets, buildCloudOcrRequest, parseCloudOcrResponse,
} from './utils/ocr.js';
import { indexDoc } from './agent/retrieval.js';
import { createCard, createGraphEdge } from './repo.js';
import { draftToCardPayload, validateDraft } from './utils/card-drafts.js';
import { cardInDoc, buildDocCardEdges, excerptAround, traceCardDocId } from './utils/doc-graph.js';

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
    meta.error = `暂不支持 ${meta.ext || '未知'} 格式（支持 PDF / Word / Excel / CSV / TXT / MD / 图片）`;
  } else if (!opfsWritableSupported()) {
    // 提前探测：Firefox / Safari 有 OPFS 根目录但没有 createWritable，
    // 硬试只会抛出 "h.createWritable is not a function" 这种看不懂的错。
    await fallbackToIdb(meta, file, '当前浏览器不支持原文件落盘（OPFS 写入不可用），已改用 IndexedDB 暂存');
  } else {
    try {
      const opfsPath = `${meta.id}_${normalizeOpfsPath(meta.name)}`;
      await saveFileToOpfs(opfsPath, file, opts.onProgress);
      meta.storage = 'opfs';
      meta.opfsPath = opfsPath;
    } catch (e) {
      await fallbackToIdb(meta, file, `OPFS 写入失败：${e?.message || e}`);
    }
  }
  try {
    await db.docFiles.put(meta);
  } catch (e) {
    // 元数据落库失败＝这次上传彻底失败，给出人话而不是让调用方拿到一个裸 Dexie 错误
    throw new Error(`资料元数据写入失败（可能是浏览器存储空间不足）：${e?.message || e}`);
  }
  if (meta.status !== 'failed') enqueueParse(meta.id);
  return meta;
}

/**
 * 降级到 IndexedDB 暂存原文件。
 * ⚠️ Blob 存进独立的 docBlobs 本地表，**不能**塞进 docFiles：
 * docFiles 是同步表（sync-manifest 已登记），一旦带上二进制，
 * 每次备份/跨设备同步都会把整个文件打包进 JSON，包体爆炸且对端毫无用处。
 */
async function fallbackToIdb(meta, file, reason) {
  if (Number(meta.size || 0) > IDB_FALLBACK_MAX) {
    meta.status = 'failed';
    meta.error = `${reason}；且文件超过 ${IDB_FALLBACK_MAX / 1024 / 1024}MB 无法降级暂存，请换用 Chrome / Edge 上传`;
    return;
  }
  try {
    await db.docBlobs.put({ id: meta.id, blob: file, size: meta.size, updatedAt: Date.now() });
    meta.storage = 'idb';
  } catch (e) {
    meta.status = 'failed';
    meta.error = `${reason}；IndexedDB 暂存也失败（${e?.message || e}）`;
  }
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
  // 兼容历史数据：早期版本把 Blob 直接放在 docFiles.blob 上
  if (row.storage === 'idb') {
    if (row.blob) return row.blob;
    const b = await db.docBlobs.get(row.id);
    return b?.blob || null;
  }
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
    // 知识图谱联动（fire-and-forget：资料 → 覆盖卡片建「涵盖」边）
    void linkDocToCards(docId).catch((e) => console.warn('[docs-lib] 自动关联卡片失败:', e?.message || e));
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

/** 删除：原文件（OPFS）→ docFiles → docTexts → embeddings → 图谱边 → 墓碑 */
export async function deleteDocFile(id) {
  const row = await db.docFiles.get(id);
  if (!row) return;
  if (row.storage === 'opfs' && row.opfsPath) await deleteFileFromOpfs(row.opfsPath);
  await db.docFiles.delete(id);
  await db.docBlobs.delete(id); // 降级暂存的原始 Blob（本地表）
  await db.docTexts.delete(id);
  await db.embeddings.where('sourceId').equals(id).delete();
  await db.graphEdges.filter((e) => e.docId === id).delete(); // 清理资料 → 卡片图谱边
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

// ---------- OCR（6.5b：本地 Tesseract 优先，可选云端） ----------

const OCR_SETTINGS_KEY = 'sxybrick_ocr_settings';

/** OCR 设置读写（本机偏好 localStorage，不进同步）：
 *  { lang, langPath, cloud: { enabled, endpoint, apiKey, model } } */
export function getOcrSettings() {
  if (typeof localStorage === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(OCR_SETTINGS_KEY)) || {}; }
  catch { return {}; }
}

export function saveOcrSettings(patch) {
  const next = { ...getOcrSettings(), ...patch };
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(OCR_SETTINGS_KEY, JSON.stringify(next));
  }
  return next;
}

function getBaseUrl() {
  return (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
}

// 全局单 worker 复用（tesseract.js 官方建议：一个 worker 多次 recognize，最后 terminate）
let ocrWorker = null;
let ocrWorkerLang = '';

/** 本地识别：懒加载 tesseract.js（独立分包），worker+core 本地化，语言数据 CDN（可配 langPath） */
async function recognizeLocal(image, lang, onProgress) {
  const cfg = getOcrSettings();
  const langId = normalizeOcrLang(lang || cfg.lang);
  if (ocrWorker && ocrWorkerLang !== langId) {
    try { await ocrWorker.terminate(); } catch { /* ignore */ }
    ocrWorker = null;
  }
  if (!ocrWorker) {
    const tesseract = await import('tesseract.js');
    ocrWorker = await tesseract.createWorker(langId, 1, {
      ...buildOcrAssets(getBaseUrl(), cfg.langPath),
      logger: (m) => onProgress?.(m.progress || 0),
    });
    ocrWorkerLang = langId;
  }
  const { data } = await ocrWorker.recognize(image);
  return data.text;
}

/** 默认识别入口：配置了云端（OpenAI 兼容视觉）走云端，否则本地 Tesseract */
async function defaultRecognize(image, { lang, onProgress } = {}) {
  const cloud = getOcrSettings().cloud;
  if (cloud?.enabled && cloud.endpoint && cloud.apiKey) {
    const req = buildCloudOcrRequest(image, cloud);
    const res = await fetch(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
    });
    if (!res.ok) throw new Error(`云端 OCR 失败 HTTP ${res.status}`);
    return parseCloudOcrResponse(await res.json());
  }
  return recognizeLocal(image, lang, onProgress);
}

/** 图片识别：createImageBitmap 取尺寸 → 长边压 2000px 画 canvas → dataURL 交识别（防大图爆内存） */
async function ocrImageBlob(blob, { recognize, lang, onProgress, signal }) {
  let source = blob;
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined' && document.createElement) {
    try {
      const bmp = await createImageBitmap(blob);
      const { width, height } = fitCanvasSize(bmp.width, bmp.height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
      bmp.close?.();
      source = canvas.toDataURL('image/jpeg', 0.85);
    } catch { /* 原样交给识别器内部处理 */ }
  }
  if (signal?.aborted) throw new DOMException('OCR 已取消', 'AbortError');
  return recognize(source, { lang, onProgress });
}

/** 扫描版 PDF 识别：pdfjs 逐页渲染（2x 缩放）canvas → 逐页识别 → 全文拼接（内存受控、可取消） */
async function ocrPdf(blob, { recognize, lang, onPage, onProgress, signal }) {
  // 动态 import：pdfjs-dist 保持懒加载分包，不进首屏/主 bundle
  const { getPdfjs } = await import('./utils/parsers-pdf.js');
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const total = doc.numPages;
  const pages = [];
  try {
    for (let i = 1; i <= total; i++) {
      if (signal?.aborted) throw new DOMException('OCR 已取消', 'AbortError');
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2 }); // 2x 提升小字号识别质量
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      onPage?.(i, total);
      const text = await recognize(dataUrl, { lang, onProgress: (p) => onProgress?.((i - 1 + p) / total) });
      pages.push(text);
      page.cleanup();
    }
  } finally {
    try { await doc.destroy?.(); } catch { /* ignore */ }
  }
  return pages.join('\n\n');
}

/**
 * OCR 识别单个文件：状态机 →parsing→ready/failed。
 * 图片直接识别；PDF 逐页渲染识别（扫描版）。成功自动 indexDoc（失败不阻塞 ready）。
 * @param {string} docId
 * @param {object} opts { lang?, onPage?, onProgress?, signal?, recognize? }
 *   recognize 为内部测试注入（默认 defaultRecognize）
 * @returns {Promise<{ok:boolean, textLen?:number, error?:string}>}
 */
export async function ocrDoc(docId, opts = {}) {
  const row = await db.docFiles.get(docId);
  if (!row) return { ok: false, error: '资料不存在' };
  try { assertDocTransition(row.status, 'parsing'); }
  catch (e) { return { ok: false, error: e.message }; }
  const t = Date.now();
  await db.docFiles.update(docId, { status: 'parsing', error: null, updatedAt: t });
  try {
    const blob = await getFileBlob(row);
    if (!blob) throw new Error('本机无原文件（跨设备同步的元数据无法 OCR）');
    const recognize = opts.recognize || defaultRecognize;
    const lang = opts.lang || getOcrSettings().lang;
    const isPdf = String(row.ext || '').toLowerCase() === 'pdf';
    const text = isPdf
      ? await ocrPdf(blob, { recognize, lang, onPage: opts.onPage, onProgress: opts.onProgress, signal: opts.signal })
      : await ocrImageBlob(blob, { recognize, lang, onProgress: opts.onProgress, signal: opts.signal });
    const clean = cleanOcrText(text);
    if (isOcrEmpty(clean)) throw new Error('OCR 未识别到文字：图片可能过暗/过糊，或语言不匹配，可换语言重试');
    await db.docTexts.put({ id: docId, text: clean, textLen: clean.length, updatedAt: Date.now() });
    await db.docFiles.update(docId, {
      status: 'ready', textLen: clean.length, error: null, updatedAt: Date.now(), ocr: true,
    });
    try { await indexDoc({ id: docId, text: clean, subject: row.name }); }
    catch (e) { console.warn('[docs-lib] 向量索引失败（可稍后重建）:', e?.message || e); }
    void linkDocToCards(docId).catch((e) => console.warn('[docs-lib] 自动关联卡片失败:', e?.message || e));
    return { ok: true, textLen: clean.length };
  } catch (e) {
    const msg = String(e?.message || e);
    await db.docFiles.update(docId, { status: 'failed', error: msg, updatedAt: Date.now() });
    return { ok: false, error: msg };
  }
}

// ---------- 知识图谱联动（Phase 6.6：资料 → 覆盖卡片「涵盖」边） ----------

/**
 * 把资料与它覆盖的卡片建「涵盖」边（资料成为图谱节点）。
 * 匹配：同 subject 卡片，且卡片 front 核心是资料全文子串（零 LLM/零新索引）。
 * 幂等：createGraphEdge 按 docId+to+label 去重。
 * @param {string} docId
 * @param {object} opts { limit=50 }
 * @returns {Promise<{created:number, skipped:number}>}
 */
export async function linkDocToCards(docId, opts = {}) {
  const doc = await db.docFiles.get(docId);
  if (!doc) return { created: 0, skipped: 0 };
  const text = await getDocText(docId);
  if (!text?.trim()) return { created: 0, skipped: 0 };
  const all = await db.cards.toArray();
  const subject = String(doc.subject || '');
  const pool = subject ? all.filter((c) => (c.subject || '') === subject) : all;
  const hits = pool.filter((c) => cardInDoc(c, text));
  const edges = buildDocCardEdges(doc, hits.slice(0, opts.limit ?? 50));
  let created = 0;
  let skipped = 0;
  for (const e of edges) {
    const r = await createGraphEdge({
      from: e.from, to: e.to, label: e.label, subject: e.subject, docId: e.docId, type: e.type,
    });
    if (r) created++; else skipped++;
  }
  return { created, skipped };
}

/**
 * 错题溯源：卡片 → 来源资料 + 原文上下文片段。
 * 优先走血缘（card.source = docFiles.id）；无血缘返回 null。
 * @param {string} cardId
 * @returns {Promise<{doc:{id,name,subject}, excerpt:string}|null>}
 */
export async function traceCardSource(cardId) {
  const card = await db.cards.get(cardId);
  if (!card) return null;
  const docId = traceCardDocId(card);
  if (!docId) return null;
  const doc = await db.docFiles.get(docId);
  if (!doc) return null;
  const text = await getDocText(docId);
  return {
    doc: { id: doc.id, name: doc.name, subject: String(doc.subject || '') },
    excerpt: excerptAround(text, card.front),
  };
}
