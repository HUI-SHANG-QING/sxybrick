// 测试：导出纯函数（Node-only，无浏览器依赖）
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 给出 --experimental-vm-modules 时 tojson 也能用
const exp = await import('../src/utils/exporters.js');
const {
  toJSON, toCSV, mdTable,
  exportCardsToJSON, exportCardsToCSV, exportCardsToMarkdown,
  exportMemosToJSON, exportMemosToMarkdown, exportMemosToCSV,
  exportNotesToJSON, exportNotesToMarkdown,
  exportGraphToJSON, exportGraphToGraphML, exportGraphToMarkdown,
  exportLibraryToJSON, exportLibraryToMarkdown,
  defaultFilename, triggerDownload,
} = exp;

// ──────────────── 底层工具 ────────────────

test('toJSON：包裹 meta + 漂亮格式', () => {
  const out = JSON.parse(toJSON([{ a: 1 }]));
  assert.equal(out.app, 'SxyBrick');
  assert.equal(out.exportFormatVersion, 1);
  assert.match(out.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(out.kind, undefined);  // meta 不传 kind
  assert.deepEqual(out.payload, [{ a: 1 }]);
});

test('toJSON：自定义 meta 合并', () => {
  const out = JSON.parse(toJSON({ x: 1 }, { meta: { kind: 'notes', count: 1 } }));
  assert.equal(out.kind, 'notes');
  assert.equal(out.count, 1);
});

test('toCSV：RFC 4180 转义（含 , " 换行）', () => {
  const out = toCSV(['A', 'B', 'C'], [
    ['x', 'y', 'z'],
    ['含,逗号', '含"双引号', '普通'],
    ['多\n行', 'CR\r\nLF', 'tab\\t'],
  ]);
  // 字段含特殊字符必须整体加双引号 + 重复双引号
  assert.match(out, /"含,逗号"/);
  assert.match(out, /"含""双引号"/);
  assert.match(out, /"多\n行"/);
  // 行分隔符必须 CRLF
  assert.match(out, /\r\n/);
  assert.equal(out.endsWith('\r\n'), true);
});

test('toCSV：withBOM 加 UTF-8 字节序标记', () => {
  const a = toCSV(['A'], [['x']]);
  const b = toCSV(['A'], [['x']], { withBOM: true });
  assert.equal(a.charCodeAt(0), 'A'.charCodeAt(0));
  assert.equal(b.charCodeAt(0), 0xFEFF);   // UTF-8 BOM = U+FEFF = 65279
});

test('mdTable：表头 + 表格 + 空数据兜底', () => {
  assert.match(mdTable(['a', 'b'], [['x', 'y']]), /a \| b/);
  assert.match(mdTable(['a'], []), /_（无数据）_/);
  // pipe 必须转义
  assert.match(mdTable(['x'], [['a|b']]), /a\\\|b/);
});

test('defaultFilename：合法时间戳 + 非法字符清洗', () => {
  const f = defaultFilename('a/b:c?d', '.json');
  assert.match(f, /^a_b_c_d-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
});

test('triggerDownload：Node 环境直接返回 blob（不会崩）', () => {
  const blob = new Blob(['x']);
  const ret = triggerDownload(blob, 'x.txt');
  assert.equal(ret, blob);  // 原样返回用于测试断言
});

// ──────────────── Cards ────────────────

const sampleCards = [
  { id: 'c1', front: 'Cache 替换策略有哪些？', back: 'LRU/FIFO/随机', subject: '计组', tags: ['存储'], ease: 2.5, level: 3, intervalDays: 5, dueAt: 1700000000000, createdAt: 1699000000000 },
  { id: 'c2', front: '冯诺依曼结构', back: '运算器+控制器+存储器+IO', subject: '计组', tags: [], ease: 2.0, level: 2, intervalDays: 3, dueAt: null, createdAt: null },
];

test('exportCardsToJSON：含 kind/count meta', () => {
  const out = JSON.parse(exportCardsToJSON(sampleCards));
  assert.equal(out.kind, 'cards');
  assert.equal(out.count, 2);
  assert.equal(out.payload.length, 2);
});

test('exportCardsToCSV：含 BOM + thead 顺序', () => {
  const csv = exportCardsToCSV(sampleCards);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  // 表头第一个 cell 是 ID（含 BOM）
  assert.match(csv, /^﻿ID,正面/);
  assert.match(csv, /正面,背面,科目,标签/);
  // tags 数组合并为逗号
  assert.match(csv, /存储/);
});

test('exportCardsToMarkdown：表头 + 卡片计数 + 元数据', () => {
  const md = exportCardsToMarkdown(sampleCards, { subject: '计组' });
  assert.match(md, /^# 卡片导出/);
  assert.match(md, /科目：计组/);
  assert.match(md, /共 2 张/);
  assert.match(md, /正面 \| 背面/);
});

// ──────────────── Memos ────────────────

const sampleMemos = [
  { id: 'm1', text: '买牛奶', important: true, urgent: true, createdAt: 1699000000000 },
  { id: 'm2', text: '看论文', important: true, urgent: false, createdAt: 1698000000000 },
  { id: 'm3', text: '刷小红书', important: false, urgent: false, createdAt: 1697000000000 },
];

test('exportMemosToJSON：返回 JSON 含 memos 数组', () => {
  const out = JSON.parse(exportMemosToJSON(sampleMemos));
  assert.equal(out.kind, 'memos');
  assert.deepEqual(out.payload, sampleMemos);
});

test('exportMemosToCSV：象限映射正确', () => {
  const csv = exportMemosToCSV(sampleMemos);
  // 中文象限值不含特殊字符（无 ", , \r \n），所以 csvEscape 不加双引号 —— 直接匹配
  assert.match(csv, /重要×紧急/);
  assert.match(csv, /重要×非紧急/);
  assert.match(csv, /非重要×非紧急/);
  // 含 , 的中文字段也不需要引号
  assert.match(csv, /买牛奶/);
});

test('exportMemosToMarkdown：表头 + 备忘数', () => {
  const md = exportMemosToMarkdown(sampleMemos);
  assert.match(md, /备忘录导出/);
  assert.match(md, /共 3 条/);
  // MEMO_COLS 顺序 = ID, 备忘, 象限, 创建时间
  assert.match(md, /备忘 \| 象限/);
});

// ──────────────── Notes ────────────────

const sampleNotes = [
  { id: 'n1', title: '线代第四章', category: '线代', tags: ['矩阵', '特征值'], content: '重要定理：可逆 ⇔ 行满秩。', updatedAt: 1699000000000 },
];

test('exportNotesToJSON：notes schema', () => {
  const out = JSON.parse(exportNotesToJSON(sampleNotes));
  assert.equal(out.kind, 'notes');
  assert.deepEqual(out.payload, sampleNotes);
});

test('exportNotesToMarkdown：分级标题 + 标签', () => {
  const md = exportNotesToMarkdown(sampleNotes);
  assert.match(md, /^# 笔记导出/);
  assert.match(md, /## 线代第四章 `线代`/);
  assert.match(md, /可逆 ⇔/);
  // tags 出现在二级标题附近
  assert.match(md, /矩阵, 特征值/);
});

// ──────────────── Graph ────────────────

const sampleEdges = [
  { from: 'Cache', to: '替换策略', label: '相关', type: 'card-card', subject: '计组', docId: '', createdAt: 1699000000000 },
  { from: '真题2009.pdf', to: 'Cache', label: '涵盖', type: 'doc-card', subject: '计组', docId: 'doc1', createdAt: 1699000000000 },
];

test('exportGraphToJSON：节点去重 + 边表', () => {
  const out = JSON.parse(exportGraphToJSON(sampleEdges));
  assert.equal(out.kind, 'graph');
  assert.equal(out.nodes, 3);  // Cache, 替换策略, 真题2009.pdf
  assert.equal(out.edges, 2);
  // 节点集合（含中文，按 sort 实际顺序）
  const ids = out.payload.nodes.map(n => n.id).sort();
  // JS 默认 sort 按 Unicode 码点：中文字符 '替'(0x66FF) < '真'(0x771F) < '缓'(0x7F13)
  assert.deepEqual(ids, ['Cache', '替换策略', '真题2009.pdf'].sort());
});

test('exportGraphToGraphML：标准 XML + 可被解析', () => {
  const xml = exportGraphToGraphML(sampleEdges);
  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.match(xml, /<graphml /);
  // 节点数 = 去重 3 个
  const nodes = xml.match(/<node id="/g) || [];
  assert.equal(nodes.length, 3);
  // 边数 = 2
  const edges = xml.match(/<edge source="/g) || [];
  assert.equal(edges.length, 2);
  // 转义：含 . / 都正常，docId 含 .pdf 也应 OK
  assert.match(xml, /真题2009\.pdf/);
});

test('exportGraphToMarkdown：表头 + 关系映射', () => {
  const md = exportGraphToMarkdown(sampleEdges);
  assert.match(md, /关系 \| 终点/);
  assert.match(md, /涵盖/);
  assert.match(md, /doc-card/);
});

// ──────────────── Library ────────────────

const sampleFiles = [
  { id: 'f1', name: '真题2009.pdf', subject: '计组', type: 'pdf', status: 'ready', sizeText: '1.2 MB', createdAt: 1699000000000 },
  { id: 'f2', name: '讲义.docx', subject: '线代', type: 'docx', status: 'ready', sizeText: '200 KB', createdAt: 1698000000000 },
];

test('exportLibraryToJSON：调用 textLen 计数', async () => {
  const out = JSON.parse(exportLibraryToJSON(sampleFiles, () => 1234));
  const f1 = out.payload.find(x => x.id === 'f1');
  assert.equal(f1.textLen, 1234);
});

test('exportLibraryToMarkdown：表头 + 资料数', () => {
  const md = exportLibraryToMarkdown(sampleFiles, () => 100);
  assert.match(md, /# 资料库导出/);
  assert.match(md, /共 2 个资料/);
  // DOC_COLS 顺序 = ID, 文件名, 科目, 类型, 状态, 大小, 文本字数, 上传时间
  assert.match(md, /文件名 \| 科目/);
});

// ──────────────── 黄金路径：导出全部 4 个视图类型 ────────────────

test('黄金路径：cards + memos + graph + library 导出无报错', () => {
  assert.doesNotThrow(() => exportCardsToJSON(sampleCards));
  assert.doesNotThrow(() => exportCardsToCSV(sampleCards));
  assert.doesNotThrow(() => exportMemosToMarkdown(sampleMemos));
  assert.doesNotThrow(() => exportMemosToCSV(sampleMemos));
  assert.doesNotThrow(() => exportGraphToJSON(sampleEdges));
  assert.doesNotThrow(() => exportGraphToGraphML(sampleEdges));
  assert.doesNotThrow(() => exportLibraryToJSON(sampleFiles, () => 0));
  assert.doesNotThrow(() => exportLibraryToMarkdown(sampleFiles, () => 0));
});
