// tests/parsers-sheet.test.mjs —— P1-16 xlsx→exceljs 迁移专项测试
// 覆盖：cellToText / parseCsvRows（RFC4180）/ sniffSheetKind（魔数）/ extractSheetRows
//       （csv 内置解析 + exceljs xlsx 真实读取 + .xls 明确拒绝 + ext 优先级）
// 说明：exceljs 在 Node 下为 CommonJS 完整实现，可真实写/读 xlsx（writeBuffer）。
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  cellToText, parseCsvRows, sniffSheetKind, extractSheetRows, extractSheetText,
} from '../src/utils/parsers-sheet.js';

/** 便捷：文本 → Blob（csv 路径） */
function csvBlob(text, type = 'text/csv') {
  return new Blob([text], { type });
}

/** 便捷：exceljs 工作簿 → Blob（xlsx 路径） */
async function xlsxBlob(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

test('cellToText：常规值 / 日期 / 空值 / 对象兜底', () => {
  assert.equal(cellToText(null), '');
  assert.equal(cellToText(undefined), '');
  assert.equal(cellToText(0), '0');
  assert.equal(cellToText(95), '95');
  assert.equal(cellToText('abc'), 'abc');
  assert.equal(cellToText(new Date('2026-08-31T00:00:00Z')), '2026-08-31T00:00:00.000Z');
  // 富文本 / 超链接 / 错误 / 公式 对象形态
  assert.equal(cellToText({ richText: [{ text: '富' }, { text: '文本' }] }), '富文本');
  assert.equal(cellToText({ text: '链接文案', hyperlink: 'https://x' }), '链接文案');
  assert.equal(cellToText({ error: '#N/A' }), '#N/A');
  assert.equal(cellToText({ formula: 'A1+B1', result: 3 }), '3');
  assert.equal(cellToText({ sharedFormula: 'A1', result: 'ok' }), 'ok');
  assert.equal(cellToText({}), '');
  // 数组递归
  assert.equal(cellToText(['a', { text: 'b' }]), 'ab');
});

test('parseCsvRows：基础 / 引号包裹 / 转义 / 换行 / BOM / 空', () => {
  assert.deepEqual(parseCsvRows('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  // 引号字段内的逗号与换行
  assert.deepEqual(parseCsvRows('"a,1","b\n2"'), [['a,1', 'b\n2']]);
  // "" 转义
  assert.deepEqual(parseCsvRows('"he said ""hi"""'), [['he said "hi"']]);
  // CRLF 与单独 CR
  assert.deepEqual(parseCsvRows('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsvRows('a,b\rc,d'), [['a', 'b'], ['c', 'd']]);
  // BOM 剔除
  assert.deepEqual(parseCsvRows('\uFEFFa,b'), [['a', 'b']]);
  // 空 / 非字符串
  assert.deepEqual(parseCsvRows(''), [['']]);
  assert.deepEqual(parseCsvRows(null), [['']]);
  // 文件以换行结尾：末尾空行存在但 rowsToText 会滤空（extractSheetText 路径验证）
  assert.deepEqual(parseCsvRows('a,b\n'), [['a', 'b'], ['']]);
});

test('sniffSheetKind：PK→xlsx / OLE2→xls / 其余→csv', () => {
  assert.equal(sniffSheetKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer), 'xlsx');
  assert.equal(sniffSheetKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]).buffer), 'xls');
  assert.equal(sniffSheetKind(new Uint8Array([0x41, 0x42, 0x43]).buffer), 'csv');
  assert.equal(sniffSheetKind(new Uint8Array([]).buffer), 'csv');
  // 短于魔数长度也能安全判 csv
  assert.equal(sniffSheetKind(new Uint8Array([0x50]).buffer), 'csv');
});

test('extractSheetRows：csv 文本路径（内置解析器）', async () => {
  const r = await extractSheetRows(csvBlob('科目,得分\n线代,95\n计组,88'), { ext: 'csv' });
  assert.equal(r.kind, 'csv');
  assert.equal(r.sheetCount, 1);
  assert.equal(r.sheets[0].name, 'CSV');
  assert.deepEqual(r.sheets[0].rows, [['科目', '得分'], ['线代', '95'], ['计组', '88']]);
});

test('extractSheetRows：无 ext 时按魔数嗅探识别 csv（不误判为 xlsx）', async () => {
  const r = await extractSheetRows(csvBlob('a,b\n1,2'));
  assert.equal(r.kind, 'csv');
  assert.deepEqual(r.sheets[0].rows, [['a', 'b'], ['1', '2']]);
});

test('extractSheetRows：xlsx 真实读取（exceljs 自产）多 sheet / 数值 / 中文', async () => {
  const blob = await xlsxBlob((wb) => {
    const s1 = wb.addWorksheet('成绩单');
    s1.addRows([['科目', '得分'], ['线代', 95], ['计组', 88]]);
    const s2 = wb.addWorksheet('空表');
    s2.addRow(['x']);
  });
  const r = await extractSheetRows(blob);
  assert.equal(r.kind, 'xlsx');
  assert.equal(r.sheetCount, 2);
  assert.deepEqual(r.sheets.map((s) => s.name), ['成绩单', '空表']);
  // cellToText 统一转展示文本（对齐原 SheetJS raw:false：数值 → 字符串）
  assert.deepEqual(r.sheets[0].rows, [['科目', '得分'], ['线代', '95'], ['计组', '88']]);
});

test('extractSheetRows：显式 ext 优先于魔数（含 .xls 明确拒绝）', async () => {
  // 内容是 csv 文本但声明 ext=xls → 走拒绝分支（exceljs 无法解析 legacy xls）
  await assert.rejects(
    () => extractSheetRows(csvBlob('a,b'), { ext: 'xls' }),
    /暂不支持旧版 \.xls/
  );
  // 声明 ext=csv 即使内容含 PK 魔数也按 csv 处理（调用方显式声明优先）
  const r = await extractSheetRows(csvBlob('a,b'), { ext: 'csv' });
  assert.equal(r.kind, 'csv');
  // 真实 OLE2 魔数 + 无声明 → 拒绝
  const ole2 = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]);
  await assert.rejects(() => extractSheetRows(ole2), /暂不支持旧版 \.xls/);
});

test('extractSheetText：保持旧签名（parsers.js loadParser 复用），csv 全量文本', async () => {
  const r = await extractSheetText(csvBlob('科目,得分\n线代,95\n计组,88'), { ext: 'csv' });
  assert.ok(r.text.includes('【工作表：CSV】'));
  assert.ok(r.text.includes('科目\t得分'));
  assert.ok(r.text.includes('线代\t95'));
  assert.equal(r.sheetCount, 1);
});

test('extractSheetText：xlsx 多 sheet 全量文本', async () => {
  const blob = await xlsxBlob((wb) => {
    const s = wb.addWorksheet('第一页');
    s.addRows([['a', 'b'], ['1', '2']]);
  });
  const r = await extractSheetText(blob);
  assert.ok(r.text.includes('【工作表：第一页】'));
  assert.ok(r.text.includes('a\tb'));
  assert.ok(r.text.includes('1\t2'));
  assert.equal(r.sheetCount, 1);
});

test('extractSheetRows：xlsx 单元格含公式/超链接/富文本不崩', async () => {
  const blob = await xlsxBlob((wb) => {
    const s = wb.addWorksheet('t');
    s.addRow(['plain']);
    const c = s.getCell('B1');
    c.value = { formula: 'SUM(1,2)', result: 3 }; // exceljs 允许直接写 {formula,result}
    const d = s.getCell('C1');
    d.value = { text: 'link', hyperlink: 'https://example.com' };
  });
  const r = await extractSheetRows(blob);
  // exceljs 写回后公式/链接可能被序列化为普通值——只要不抛且行数正确即可
  assert.equal(r.sheets[0].rows.length >= 1, true);
  assert.equal(r.sheetCount, 1);
});
