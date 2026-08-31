// src/utils/parsers-sheet.js
// 表格文本化：xlsx 走 exceljs，csv 走内置解析器（.xls 不再支持，给出明确提示）。
//
// 【为什么换掉 SheetJS(xlsx)】
//   xlsx@0.18.5 有两个高危漏洞：原型污染（CVE-2023-43622）与 ReDoS（CVE-2024-22363），
//   均发生在「解析不可信文件」路径上——本应用正是让用户上传自己的资料文件，属于可达面。
//   且补丁版 0.20.x **不在 npm 上**（npm dist-tag latest 至今仍是 0.18.5，官方只通过
//   自家 CDN 分发），离线优先 PWA 不宜依赖 CDN tgz，故整体迁移到 exceljs。
//
// 【能力差异（刻意接受，需在 UI 提示）】
//   exceljs 不支持 legacy .xls（Excel 97-2003 / OLE2 复合文档）。遇到该文件直接抛出
//   可读异常，引导用户另存为 .xlsx，而不是静默失败或保留高危依赖。
//
// 【格式判定】优先用调用方给的 ext，缺失时按魔数嗅探：
//   PK(0x50 0x4B)     → xlsx（OOXML 实为 zip）
//   D0CF11E0          → xls（OLE2 复合文档）→ 明确拒绝
//   其余              → csv（纯文本）

import ExcelJS from 'exceljs';
import { rowsToText } from './parsers.js';

/** exceljs 单元格值 → 展示文本（对齐原 SheetJS raw:false 的语义：取格式化后的可见内容） */
export function cellToText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(cellToText).join('');
  if (typeof v === 'object') {
    // 富文本单元格：{ richText: [{ text, font }] }
    if (Array.isArray(v.richText)) return v.richText.map((r) => String(r?.text ?? '')).join('');
    // 超链接单元格：{ text, hyperlink }
    if (typeof v.text === 'string') return v.text;
    // 错误单元格：{ error: '#N/A' }
    if ('error' in v) return String(v.error ?? '');
    // 公式单元格：{ formula, result } —— 取已计算结果；未计算则为 ''
    if ('result' in v) return cellToText(v.result);
    if ('sharedFormula' in v) return cellToText(v.result);
    return '';
  }
  return String(v);
}

/**
 * CSV 文本 → 行数组（RFC4180：引号包裹字段、"" 转义、CRLF/LF/CR、去 BOM）
 * 纯函数、零依赖，浏览器与 Node 都可测。
 */
export function parseCsvRows(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const endRow = () => { row.push(field); rows.push(row); row = []; field = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // 转义双引号
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') endRow();
    else if (c === '\r') { if (s[i + 1] === '\n') i++; endRow(); }
    else field += c;
  }
  // 收尾：最后一行（含文件以换行结尾时产生的一个空行，rowsToText 会滤掉）
  row.push(field);
  rows.push(row);
  return rows;
}

/** 按魔数嗅探文件格式，返回 'xlsx' | 'xls' | 'csv' */
export function sniffSheetKind(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) return 'xlsx'; // 'PK' → zip/OOXML
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls'; // OLE2
  return 'csv';
}

function sheetToRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const vals = row.values; // exceljs 为 1-based，下标 0 恒空
    const arr = [];
    for (let i = 1; i < vals.length; i++) arr.push(cellToText(vals[i]));
    rows.push(arr);
  });
  return rows;
}

/**
 * 读取表格文件为结构化行。
 * @param {Blob} blob
 * @param {object} [opts] { ext?: 'xlsx'|'xls'|'csv' } 给了就以它为准，否则按魔数嗅探
 * @returns {Promise<{sheets:Array<{name:string,rows:string[][]}>, sheetCount:number, kind:string}>}
 */
export async function extractSheetRows(blob, opts = {}) {
  const buf = await blob.arrayBuffer();
  const declared = String(opts.ext || '').toLowerCase();
  const kind = ['xlsx', 'xls', 'csv'].includes(declared) ? declared : sniffSheetKind(buf);

  if (kind === 'xls') {
    throw new Error('暂不支持旧版 .xls（Excel 97-2003）格式，请用 Excel/WPS 另存为 .xlsx 后重试');
  }
  if (kind === 'csv') {
    const rows = parseCsvRows(new TextDecoder('utf-8').decode(buf));
    return { sheets: [{ name: 'CSV', rows }], sheetCount: 1, kind };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = wb.worksheets.map((ws) => ({ name: ws.name, rows: sheetToRows(ws) }));
  return { sheets, sheetCount: sheets.length, kind };
}

/**
 * 表格文件 → 全量文本（每个工作表带【工作表：名】标题）。
 * 保持旧签名 (blob, opts)，供 parsers.js 的 loadParser/parseFile 直接复用。
 */
export async function extractSheetText(blob, opts = {}) {
  const { sheets, sheetCount } = await extractSheetRows(blob, opts);
  const text = sheets
    .map((s) => `【工作表：${s.name}】\n${rowsToText(s.rows)}`)
    .join('\n\n');
  return { text, sheetCount };
}
