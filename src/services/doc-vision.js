// src/services/doc-vision.js
// 资料库文件（PDF / 图片）→ 多模态视觉源 聚合层。
//
// 为什么需要它（2026-09-13 用户核心诉求）：
//   卡片/笔记正文里的图片走 sxy-img:// 占位符，已经能被 image-analysis 富集成
//   OCR 文字或视觉图；但**资料库里的文件不在那条链路上**：
//     · 扫描型 PDF：文本层是空的，extractPdfText 抽出近乎为空 → 问 AI 永远「查不到内容」；
//     · 图表/公式型 PDF：文本层只有零散标题，图表语义全丢；
//     · 图片型资料（png/jpg）：压根没有文本可抽。
//   结果就是用户说的「上传了资料，问 AI 却只能说识别到标题」。
//   本模块把这三类文件渲染成可发给多模态模型的内容（OpenAI 视觉格式）。
//
// 设计要点：
//   1. 复用既有资产：原始文件在 docBlobs（本地表）、PDF 渲染走 utils/parsers-pdf.js
//      （与 ocrDoc 同一套 pdfjs 懒加载），压缩复用 image-analysis.compressImageBlob；
//   2. 零新增依赖、零新增 API Key——多模态复用「AI 设置」里已有的接口/模型；
//   3. 费用护栏：单次最多 3 页/张（DOC_VISION_LIMIT），可被调用方收紧；
//   4. 全程可降级：无 Blob（OPFS 外置）、Node 无 canvas、渲染失败 → 返回空数组，
//      调用方退回纯文本并给出明确提示，绝不静默失败。

import { getDb } from '../db.js';
// 压缩走 utils 层（不 import image-analysis —— 那会与其形成静态环；
// image-analysis 侧改用动态 import 引入本模块的统计，见 recommendForCurrentData）
import { compressImageBlob } from '../utils/img-compress.js';

/** 单次送多模态的最大页数/图片数**默认值**（费用护栏；与 image-analysis 的送图额度默认 3 一致） */
export const DOC_VISION_LIMIT = 3;
/** 硬上限：调用方可按用户配置传更大的 maxPages，但绝不越过此线（防账单失控） */
export const DOC_VISION_MAX = 20;

/** 「疑似扫描件」判定阈值：每页可提取字符数低于此值，视为文本层不可用 */
export const SCAN_DENSITY_THRESHOLD = 80;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/** 文件扩展名（小写，无点） */
export function extOf(name = '') {
  const s = String(name);
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

/**
 * 资料形态分类。
 * @returns {'image'|'pdf'|'text'|'other'}
 */
export function docKindOf(file) {
  const ext = extOf(file?.name || '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'tex', 'csv', 'docx', 'doc', 'xlsx', 'xls'].includes(ext)) return 'text';
  return 'other';
}

/**
 * 资料内容画像：文本量 / 页数 / 密度 / 是否疑似扫描件 / 能否走视觉。
 * 纯读，不改库（不新增同步字段，避免动 sync-manifest 契约）。
 * @param {string} docId docFiles.id
 * @returns {Promise<{kind:string, textLen:number, pageCount:number, density:number|null,
 *   suspectedScan:boolean, hasBlob:boolean, canVision:boolean, reason:string}>}
 */
export async function docContentProfile(docId) {
  const db = getDb();
  const file = await db.docFiles.get(docId);
  if (!file) {
    return { kind: 'other', textLen: 0, pageCount: 0, density: null, suspectedScan: false, hasBlob: false, canVision: false, reason: 'not-found' };
  }
  const kind = docKindOf(file);
  const textRow = await db.docTexts.get(docId);
  const textLen = String(textRow?.text || '').length;
  const pageCount = Number(file.pageCount) || 0;
  // 密度只在「知道页数」时有意义：PDF 有页数；图片/文本类按 1 页算
  const density = pageCount > 0 ? textLen / pageCount : (kind === 'pdf' ? null : textLen);
  // 扫描件判定：只在**知道页数**时按密度判（extractPdfText 会写 pageCount，真实 PDF 基本都有）。
  // 无页数信息时不判——单页小文档（如几行 txt 转的 PDF）文本天然就少，误判会让正常资料
  // 白白走视觉（多花钱、还可能失败）。
  const suspectedScan = kind === 'pdf' && pageCount > 0 && density < SCAN_DENSITY_THRESHOLD;
  const hasBlob = await hasOriginalBlob(docId);
  const canVision = hasBlob && (kind === 'pdf' || kind === 'image');
  return {
    kind, textLen, pageCount, density, suspectedScan, hasBlob, canVision,
    reason: !hasBlob ? 'no-blob' : (!canVision ? 'kind-not-visual' : (suspectedScan ? 'suspected-scan' : 'ok')),
  };
}

async function hasOriginalBlob(docId) {
  try {
    const db = getDb();
    if (!db?.docBlobs) return false;
    const row = await db.docBlobs.get(docId);
    return !!row?.blob;
  } catch {
    return false;
  }
}

/**
 * 生成某份资料的视觉内容（OpenAI 视觉 content 片段）。
 * 图片型资料 → 整图压缩；PDF → 前 N 页渲染压缩。
 * @param {string} docId
 * @param {object} [opts] { maxPages?: number, pageOffset?: number, signal?: AbortSignal,
 *                          renderPdfPagesFn?: Function }  // 测试注入点
 * @returns {Promise<Array<{type:'image_url',image_url:{url:string}}>>}
 *   空数组 = 无法产出（无 Blob / Node 无 canvas / 渲染失败）→ 调用方降级
 */
export async function docVisionContent(docId, opts = {}) {
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages) || DOC_VISION_LIMIT, DOC_VISION_MAX));
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  const file = await db.docFiles.get(docId);
  if (!file) return [];
  const kind = docKindOf(file);
  if (kind !== 'pdf' && kind !== 'image') return [];

  let blob = null;
  try {
    blob = (await db.docBlobs?.get(docId))?.blob || null;
  } catch { /* 无 docBlobs 环境按无 Blob 处理 */ }
  if (!blob) return [];

  try {
    if (kind === 'image') {
      const url = await compressImageBlob(blob, { maxEdge: opts.maxEdge, quality: opts.quality });
      return url ? [{ type: 'image_url', image_url: { url } }] : [];
    }
    // PDF：渲染页面为 JPEG（测试可注入 renderPdfPagesFn，避免依赖 canvas）
    const render = opts.renderPdfPagesFn
      || (await import('../utils/parsers-pdf.js')).renderPdfPages;
    const pages = await render(blob, {
      maxPages,
      pages: Array.isArray(opts.pages) ? opts.pages : undefined,
      signal: opts.signal,
    });
    return (pages || [])
      .filter((p) => p?.dataUrl)
      .map((p) => ({ type: 'image_url', image_url: { url: p.dataUrl } }));
  } catch {
    return []; // 渲染失败不阻塞：调用方退回纯文本
  }
}
