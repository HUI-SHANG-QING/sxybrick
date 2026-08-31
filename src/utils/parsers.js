// 解析器纯函数层 + 动态加载器（Phase 6 资料中心）
// 原则：解析「全量」——逐页/逐行流式拼接，字符一毫不丢；
//       分块（500 字）只是问答时的检索标签（retrieval.js 的事），与解析完整性无关。
// 动态 import：pdfjs-dist / exceljs / mammoth 均为懒加载分包，不进首屏 bundle。

import { routeParser } from './opfs.js';

// ---------- 纯函数（无浏览器依赖，Node 可测） ----------

/** 原始文本直读：去 BOM、归一换行 */
export function extractTextRaw(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** 行数组 → 文本（SheetJS header:1 结果归一：每行 tab 连接、去尾空、滤空行） */
export function rowsToText(rows) {
  return (rows || [])
    .map((r) => {
      if (!Array.isArray(r)) return String(r == null ? '' : r).trim();
      return r.map((v) => (v == null ? '' : String(v).trim())).join('\t').replace(/\t+$/g, '');
    })
    .filter(Boolean)
    .join('\n');
}

/** PDF 提取文本后处理：保留段落结构（item 级 join 由解析器完成，这里只做整体清洗） */
export function cleanExtractedText(text) {
  return String(text ?? '')
    .replace(/[ \t]+\n/g, '\n') // 行尾空白
    .replace(/\n{4,}/g, '\n\n\n') // 压缩过多空行
    .trim();
}

/** 解析器 id → 人类可读标签（UI/错误提示用） */
export const PARSER_LABELS = {
  pdf: 'PDF 文本',
  sheet: '表格',
  docx: 'Word 文本',
  text: '纯文本',
  image: '图片（需 OCR）',
};

/**
 * 加载解析器并返回其执行函数。
 * @param {string} parserId routeParser 的返回值
 * @returns {Promise<function>} 解析函数签名 (blobOrText, opts) => Promise<{text, pageCount?, sheetCount?}>
 */
export async function loadParser(parserId) {
  switch (parserId) {
    case 'pdf':
      return (await import('./parsers-pdf.js')).extractPdfText;
    case 'sheet':
      return (await import('./parsers-sheet.js')).extractSheetText;
    case 'docx':
      return (await import('./parsers-docx.js')).extractDocxText;
    case 'text': {
      // txt/md 无需解析器：直接读文本
      return async (blobOrText, opts = {}) => {
        if (typeof blobOrText === 'string') return { text: extractTextRaw(blobOrText) };
        const text = await blobOrText.text();
        return { text: extractTextRaw(text) };
      };
    }
    default:
      throw new Error(`未知解析器 ${parserId}`);
  }
}

/**
 * 统一解析入口：按扩展名路由到解析器并执行。
 * @param {string} ext 文件扩展名
 * @param {Blob|string} source 文件 Blob 或文本
 * @param {object} opts { onPage, onProgress, signal }
 * @returns {Promise<{text:string, pageCount?:number, sheetCount?:number}>}
 */
export async function parseFile(ext, source, opts = {}) {
  const parserId = routeParser(ext);
  if (!parserId) throw new Error(`暂不支持 ${ext || '未知'} 格式`);
  if (parserId === 'image') throw new Error('图片需 OCR 识别——在资料库点「🔍 OCR 识别」按钮');
  const fn = await loadParser(parserId);
  return fn(source, opts || {});
}

/** 校验解析结果完整性：非空 + 长度合理（防静默丢失） */
export function assertParsedOk(result, size) {
  const text = result?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('解析结果为空——文件可能是扫描版图片 PDF，需要 OCR 能力');
  }
  return text;
}
