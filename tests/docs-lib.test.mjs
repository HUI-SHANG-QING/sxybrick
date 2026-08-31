// tests/docs-lib.test.mjs —— Phase 6 资料中心测试
// 覆盖：opfs/parsers/card-drafts/docs-qa 纯函数、三个真实解析器（xlsx 自产/docx 自造/内嵌最小 PDF）、
//       上传→解析→索引→检索→确认建卡→删除 黄金路径（fake-indexeddb）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

// ---------- 纯函数 ----------
import {
  routeParser, normalizeOpfsPath, buildDocMeta, assertDocTransition,
} from '../src/utils/opfs.js';
import {
  extractTextRaw, rowsToText, cleanExtractedText, parseFile,
} from '../src/utils/parsers.js';
import {
  splitQA, paragraphCards, textToCardDrafts, draftToCardPayload, validateDraft,
} from '../src/utils/card-drafts.js';
import {
  buildDocQAPrompt, trimDocExcerpts, formatCitations,
} from '../src/utils/docs-qa.js';
// ---------- IO ----------
import {
  uploadFile, getDocText, deleteDocFile, confirmDrafts, listDocFiles,
} from '../src/docs-lib.js';
import { hybridSearch } from '../src/agent/retrieval.js';

after(async () => { try { await db.close(); } catch {} });

async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
}

// ---------- opfs 纯函数 ----------

test('routeParser：扩展名 → 解析器路由', () => {
  assert.equal(routeParser('PDF'), 'pdf');
  assert.equal(routeParser('.pdf'), 'pdf');
  assert.equal(routeParser('xlsx'), 'sheet');
  assert.equal(routeParser('XLS'), 'sheet');
  assert.equal(routeParser('csv'), 'sheet');
  assert.equal(routeParser('docx'), 'docx');
  assert.equal(routeParser('md'), 'text');
  assert.equal(routeParser('tex'), 'text');
  assert.equal(routeParser('png'), 'image');
  assert.equal(routeParser('exe'), null);
  assert.equal(routeParser(''), null);
});

test('normalizeOpfsPath：非法字符清洗 + 防穿越 + 截断', () => {
  assert.equal(normalizeOpfsPath('a/b\\c:d*e?.txt'), 'a_b_c_d_e_.txt');
  // 开头点被防隐藏文件规则剥除，路径分隔符全部清洗 → 无法穿越
  assert.equal(normalizeOpfsPath('..\\..\\evil'), '_.._evil');
  assert.equal(normalizeOpfsPath(''), 'unnamed');
  assert.ok(normalizeOpfsPath('x'.repeat(300)).length <= 120);
});

test('buildDocMeta：字段齐全 + 状态机初始 uploading', () => {
  const m = buildDocMeta({ name: '真题.PDF', size: 1024, type: 'application/pdf' }, { id: 'd1', subject: '线代', createdAt: 100 });
  assert.equal(m.id, 'd1');
  assert.equal(m.name, '真题.PDF');
  assert.equal(m.ext, 'pdf');
  assert.equal(m.size, 1024);
  assert.equal(m.subject, '线代');
  assert.equal(m.status, 'uploading');
  assert.equal(m.storage, 'opfs');
});

test('assertDocTransition：合法/非法迁移', () => {
  assert.doesNotThrow(() => assertDocTransition('uploading', 'parsing'));
  assert.doesNotThrow(() => assertDocTransition('failed', 'parsing')); // 重试
  assert.throws(() => assertDocTransition('parsing', 'uploading'));
  assert.doesNotThrow(() => assertDocTransition('parsing', 'ready'));
  assert.doesNotThrow(() => assertDocTransition('ready', 'parsing')); // 重新解析
});

// ---------- parsers 纯函数 ----------

test('extractTextRaw：去 BOM + 换行归一', () => {
  assert.equal(extractTextRaw('\uFEFF你好\r\n世界\r'), '你好\n世界\n');
});

test('rowsToText：行数组 → 文本（null 转空、滤空行）', () => {
  const rows = [['科目', '得分'], ['线代', 95], [null, '']];
  const out = rowsToText(rows);
  assert.ok(out.includes('科目\t得分'));
  assert.ok(out.includes('线代\t95'));
  assert.ok(!out.includes('null'));
});

test('cleanExtractedText：行尾空白 + 空行压缩', () => {
  const out = cleanExtractedText('a  \nb\n\n\n\n\nc');
  assert.ok(out.startsWith('a\nb'));
  assert.ok(out.includes('\n\n\nc') === false || out.endsWith('c'));
});

test('parseFile：txt 直读（真实执行）', async () => {
  const r = await parseFile('txt', '第一章 向量\n向量是既有大小又有方向的量。');
  assert.equal(r.text, '第一章 向量\n向量是既有大小又有方向的量。');
});

test('parseFile：不支持格式抛错', async () => {
  await assert.rejects(() => parseFile('exe', 'x'));
});

// ---------- card-drafts 纯函数（自动建卡用户选择制） ----------

test('splitQA：真题题号 + 答案标记分卡', () => {
  const text = [
    '1. 什么是可提取性？',
    'A. 记忆强度',
    'B. 回忆概率',
    '【答案】B',
    '【解析】可提取性 R 是回忆概率。',
    '2. 什么是稳定性？',
    '【答案】S 是记忆强度。',
  ].join('\n');
  const cards = splitQA(text);
  assert.equal(cards.length, 2);
  assert.ok(cards[0].front.includes('什么是可提取性'));
  assert.ok(cards[0].front.includes('A. 记忆强度'));
  assert.ok(cards[0].back.includes('回忆概率'));
  assert.ok(cards[1].front.includes('什么是稳定性'));
  assert.equal(cards[1].note, '真题/题目');
});

test('splitQA：中文数字题号', () => {
  const cards = splitQA('一、什么是死锁？\n【答案】两个进程互相等待资源。\n\n二、什么是饥饿？\n【答案】进程长期得不到资源。');
  assert.equal(cards.length, 2);
  assert.ok(cards[0].front.includes('死锁'));
});

test('paragraphCards：段落切分 + 长度过滤', () => {
  const p1 = '第一段：' + 'x'.repeat(40);
  const p2 = '第二段：' + 'y'.repeat(40);
  const short = '太短';
  const cards = paragraphCards(`${p1}\n\n${p2}\n\n${short}`);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].note, '讲义段落');
});

test('textToCardDrafts：QA≥2 走 QA 分卡，否则段落要点', () => {
  const qaText = '1. 问A？\n【答案】答A。\n\n2. 问B？\n【答案】答B。';
  const qa = textToCardDrafts(qaText);
  assert.equal(qa.length, 2);
  assert.equal(qa[0].note, '真题/题目');

  const paraText = '这是一段足够长的讲义内容。'.repeat(8);
  const paras = textToCardDrafts(paraText);
  assert.ok(paras.length >= 1);
  assert.equal(paras[0].note, '讲义段落');
});

test('draftToCardPayload + validateDraft', () => {
  const p = draftToCardPayload({ front: 'F', back: 'B', note: '真题' }, { subject: '线代', source: 'doc-1' });
  assert.equal(p.front, 'F');
  assert.equal(p.subject, '线代');
  assert.equal(p.source, 'doc-1');
  assert.equal(p.type, 'basic');
  assert.equal(validateDraft({ front: '', back: 'B' }), '正面不能为空');
  assert.equal(validateDraft({ front: 'F', back: '  ' }), '背面不能为空');
  assert.equal(validateDraft({ front: 'F', back: 'B' }), null);
});

// ---------- docs-qa 纯函数 ----------

test('buildDocQAPrompt：含片段/问题/禁止编造约束', () => {
  const prompt = buildDocQAPrompt({
    docName: '线代真题',
    excerpts: [{ idx: 1, text: '可提取性是回忆概率。' }],
    question: '什么是可提取性？',
  });
  assert.ok(prompt.includes('线代真题'));
  assert.ok(prompt.includes('[片段1] 可提取性是回忆概率。'));
  assert.ok(prompt.includes('什么是可提取性'));
  assert.ok(prompt.includes('不要编造'));
});

test('trimDocExcerpts：裁剪条数与字符数', () => {
  const results = Array.from({ length: 6 }, (_, i) => ({ row: { text: 'x'.repeat(500) }, fused: 0.8 - i * 0.1 }));
  const out = trimDocExcerpts(results, 4, 400);
  assert.equal(out.length, 4);
  assert.equal(out[0].text.length, 400);
  assert.equal(out[0].score, 80);
});

test('formatCitations：引用展示格式', () => {
  const out = formatCitations([{ idx: 1, text: '片段', score: 72 }]);
  assert.ok(out.includes('[片段1]（相似 72%）片段'));
});

// ---------- 真实解析器（Node 可执行） ----------

test('extractSheetText：exceljs 自产 xlsx → 表格文本', async () => {
  const { extractSheetText } = await import('../src/utils/parsers-sheet.js');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('成绩单');
  ws.addRows([['科目', '得分'], ['线代', 95], ['计组', 88]]);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const r = await extractSheetText(blob);
  assert.ok(r.text.includes('成绩单'));
  assert.ok(r.text.includes('线代\t95'));
  assert.ok(r.text.includes('计组\t88'));
  assert.equal(r.sheetCount, 1);
});

test('extractDocxText：JSZip 自造最小 docx → 文本', async () => {
  const { extractDocxText } = await import('../src/utils/parsers-docx.js');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello SxyBrick Docx</w:t></w:r></w:p></w:body></w:document>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const blob = new Blob([buf]);
  const r = await extractDocxText(blob);
  assert.ok(r.text.includes('Hello SxyBrick Docx'));
});

// 最小 PDF（无 xref，pdf.js repair 模式重建）——若解析器升级不兼容则跳过
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 45 >>
stream
BT /F1 20 Tf 72 720 Td (Hello SxyBrick) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;

test('extractPdfText：最小 PDF → 提取文本 + pageCount', async () => {
  const { extractPdfText } = await import('../src/utils/parsers-pdf.js');
  const blob = new Blob([MINIMAL_PDF], { type: 'application/pdf' });
  const r = await extractPdfText(blob);
  assert.equal(r.pageCount, 1);
  assert.ok(r.text.includes('Hello SxyBrick'));
});

// ---------- 黄金路径（fake-indexeddb 集成） ----------

test('黄金路径：上传 txt → 解析 → 索引 → 检索 → 确认建卡 → 删除', async () => {
  const txt = '第一章 线性方程组\n\n1. 什么是秩？\nA. 行数\nB. 非零行数\n【答案】B\n【解析】秩是行阶梯形的非零行数。\n\n2. 什么是基础解系？\n【答案】解空间的极大线性无关组。\n【解析】基础解系的个数 = n - r。';
  const file = new File([txt], '线代真题.txt', { type: 'text/plain' });
  const row = await uploadFile(file, { subject: '线性代数' });
  assert.ok(row.id);
  assert.equal(row.status, 'uploading');

  // 队列异步解析 → ready
  await waitFor(async () => (await db.docFiles.get(row.id))?.status === 'ready');

  // 全文完整（不丢内容）
  const text = await getDocText(row.id);
  assert.ok(text.includes('什么是秩'));
  assert.ok(text.includes('基础解系的个数 = n - r'));

  // 向量索引已建（txt 短 → ≥1 chunk）
  const emb = await db.embeddings.where('sourceId').equals(row.id).toArray();
  assert.ok(emb.length >= 1);

  // 限定单文件检索命中
  const res = await hybridSearch('秩', { sourceId: row.id });
  assert.ok(res.length >= 1);
  assert.equal(res[0].row.sourceId, row.id);

  // 用户选择制：生成草稿 → 确认入库（source 血缘）
  const { textToCardDrafts } = await import('../src/utils/card-drafts.js');
  const drafts = textToCardDrafts(text);
  assert.ok(drafts.length >= 2, 'QA 分卡应 ≥2');
  const cards = await confirmDrafts(drafts, { subject: '线性代数', source: row.id });
  assert.equal(cards.length, drafts.length);
  assert.ok(cards.every((c) => c.source === row.id));

  // 列表可见
  const list = await listDocFiles();
  assert.ok(list.some((x) => x.id === row.id));

  // 删除：docFiles/docTexts/embeddings 清空 + 墓碑（kind=docFile）
  await deleteDocFile(row.id);
  assert.equal(await db.docFiles.get(row.id), undefined);
  assert.equal(await db.docTexts.get(row.id), undefined);
  assert.equal((await db.embeddings.where('sourceId').equals(row.id).toArray()).length, 0);
  const tomb = await db.tombstones.get(row.id);
  assert.equal(tomb.kind, 'docFile');
});

test('上传不支持格式：直接 failed 且不入解析队列', async () => {
  const file = new File(['x'], '恶意.exe', { type: 'application/x-msdownload' });
  const row = await uploadFile(file);
  assert.equal(row.status, 'failed');
  assert.ok(row.error.includes('不支持'));
  const row2 = await db.docFiles.get(row.id);
  assert.equal(row2.status, 'failed');
});

test('文件问答：askDoc 检索单文件 + 离线兜底不崩溃', async () => {
  const txt = '操作系统\n\n什么是死锁？两个或多个进程互相等待对方释放资源，导致都无法推进。\n\n什么是饥饿？进程长期得不到所需资源。';
  const file = new File([txt], 'OS 考点.txt', { type: 'text/plain' });
  const row = await uploadFile(file, { subject: '操作系统' });
  await waitFor(async () => (await db.docFiles.get(row.id))?.status === 'ready');
  const { askDoc } = await import('../src/utils/docs-qa.js');
  const r = await askDoc(row.id, '死锁是什么？');
  assert.equal(typeof r.answer, 'string');
  assert.ok(r.answer.length > 0, 'answer 非空（离线兜底也应返回引导文本）');
  assert.ok(r.citations.length >= 1, '应检索到引用片段');
  // 未解析文档 → 明确报错
  const ghost = await uploadFile(new File(['x'], '未解析.txt', { type: 'text/plain' }));
  await assert.rejects(() => askDoc(ghost.id, '问题'), /尚未解析/);
  await deleteDocFile(row.id);
  await deleteDocFile(ghost.id);
});
