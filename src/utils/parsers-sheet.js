// Excel 表格文本化：SheetJS 全表读取，每 sheet 每行拼接（保留表头）
import * as XLSX from 'xlsx';
import { rowsToText } from './parsers.js';

/**
 * @param {Blob} blob xlsx/xls/csv 文件
 * @returns {Promise<{text:string, sheetCount:number}>}
 */
export async function extractSheetText(blob) {
  const buf = await blob.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const parts = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    parts.push(`【工作表：${name}】\n${rowsToText(rows)}`);
  }
  return { text: parts.join('\n\n'), sheetCount: wb.SheetNames.length };
}
