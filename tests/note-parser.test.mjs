// 测试：笔记解析器 (纯函数)
import { test } from 'node:test';
import assert from 'node:assert/strict';
const {
  recognizeWikiLinks, inferNodeType, findBacklinks, renderWikiLinks,
  extractTags, countChars, summarize, validateNote, normalizeNotePayload,
  NODE_TYPES,
} = await import('../src/utils/note-parser.js');

// ──────────────── inferNodeType ────────────────

test('inferNodeType：c/d/n 前缀识别', () => {
  assert.equal(inferNodeType('c123'), NODE_TYPES.CARD);
  assert.equal(inferNodeType('d-abc'), NODE_TYPES.DOC);
  assert.equal(inferNodeType('note0001'), NODE_TYPES.NOTE);
  assert.equal(inferNodeType('xxxxx'), NODE_TYPES.UNKNOWN);
  assert.equal(inferNodeType(''), NODE_TYPES.UNKNOWN);
  assert.equal(inferNodeType(null), NODE_TYPES.UNKNOWN);
});

// ──────────────── recognizeWikiLinks ────────────────

test('recognizeWikiLinks：基本识别', () => {
  const r = recognizeWikiLinks('复习 [[c123]] 与 [[d-doc1]] 的关联');
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 'c123', alias: 'c123', type: NODE_TYPES.CARD, raw: '[[c123]]' });
  assert.deepEqual(r[1], { id: 'd-doc1', alias: 'd-doc1', type: NODE_TYPES.DOC, raw: '[[d-doc1]]' });
});

test('recognizeWikiLinks：带别名', () => {
  const r = recognizeWikiLinks('参考 [[c123|Cache替换]] 和 [[d1|真题2009]]');
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 'c123');
  assert.equal(r[0].alias, 'Cache替换');
  assert.equal(r[1].id, 'd1');
  assert.equal(r[1].alias, '真题2009');
});

test('recognizeWikiLinks：空文本/无链接', () => {
  assert.equal(recognizeWikiLinks('').length, 0);
  assert.equal(recognizeWikiLinks(null).length, 0);
  assert.equal(recognizeWikiLinks('hello world').length, 0);
});

test('recognizeWikiLinks：未识别也保留 raw', () => {
  const r = recognizeWikiLinks('看 [[xxx]] 不要 [[yyy|别名]] ');
  assert.equal(r.length, 2);
  assert.equal(r[0].type, NODE_TYPES.UNKNOWN);
  assert.equal(r[0].raw, '[[xxx]]');
  assert.equal(r[1].type, NODE_TYPES.UNKNOWN);
});

// ──────────────── findBacklinks ────────────────

test('findBacklinks：返回所有引用 target 的笔记 id 集合', () => {
  const notes = [
    { id: 'n1', content: '看 [[c123]] 的内容' },
    { id: 'n2', content: '不相关' },
    { id: 'n3', content: '同时引用 [[c123]] 和 [[d1]]' },
  ];
  const r1 = findBacklinks(notes, 'c123');
  assert.ok(r1.has('n1'));
  assert.ok(r1.has('n3'));
  assert.equal(r1.size, 2);
  const r2 = findBacklinks(notes, 'd1');
  assert.ok(r2.has('n3'));
  assert.equal(r2.size, 1);
  const r3 = findBacklinks(notes, 'not-exist');
  assert.equal(r3.size, 0);
});

// ──────────────── renderWikiLinks ────────────────

test('renderWikiLinks：生成 HTML 并注入 data-id / data-type', () => {
  const out = renderWikiLinks('复习 [[c123]] 与 [[d1|真题]]', (id, type) => `#/view/${type}/${id}`);
  assert.match(out, /data-id="c123"/);
  assert.match(out, /data-type="card"/);
  assert.match(out, /href="#\/view\/card\/c123"/);
  // 别名作为显示文本
  assert.match(out, /真题/);
  // XSS 防护：未指定的 <> 必须转义
  const out2 = renderWikiLinks('note [[xxx|<script>]]', () => '#');
  assert.match(out2, /&lt;script&gt;/);
  assert.doesNotMatch(out2, /<script>alert/);
});

// ──────────────── extractTags ────────────────

test('extractTags：从 title + content 提取 #标签', () => {
  assert.deepEqual(extractTags('线代 #矩阵 笔记', '考 #矩阵 与 #特征值 的关系'), ['矩阵', '特征值']);
});

test('extractTags：去重 + 转小写 + 排除空白字符', () => {
  const r = extractTags('#Cache #cache #CACHE #矩阵', '#矩阵 #算法 #数据结构');
  assert.ok(r.includes('cache'));
  assert.ok(r.includes('矩阵'));
  assert.ok(r.includes('算法'));
  assert.ok(r.includes('数据结构'));
});

test('extractTags：忽略过长的 #字串（>32 char）', () => {
  const long = 'a'.repeat(40);
  const r = extractTags(`#${long}`, '');
  assert.equal(r.length, 0);
});

// ──────────────── countChars ────────────────

test('countChars：忽略空白字符', () => {
  assert.equal(countChars('hello'), 5);
  assert.equal(countChars('  hello  world  '), 10);
  assert.equal(countChars('一 二 三'), 3);
  assert.equal(countChars(''), 0);
  assert.equal(countChars(null), 0);
});

// ──────────────── summarize ────────────────

test('summarize：去掉 [[]]、markdown 标记、连续空白', () => {
  const s = summarize('## 标题\n\n[[c123|卡片]] 主要内容：#tag1 #tag2 一些说明', { len: 30 });
  assert.match(s, /主要内容/);
  assert.match(s, /一些说明/);
  // 不应包含 [[
  assert.doesNotMatch(s, /\[\[/);
});

test('summarize：超长截断', () => {
  const long = 'a'.repeat(200);
  const s = summarize(long, { len: 50 });
  assert.ok(s.length <= 51); // 包含省略号 +1
  assert.match(s, /…/);
});

// ──────────────── validateNote ────────────────

test('validateNote：缺 title 报错', () => {
  const r = validateNote({ title: '', content: 'x' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /title/.test(e)));
});

test('validateNote：content 字段类型错', () => {
  const r = validateNote({ title: 'x', content: 123 });
  assert.equal(r.valid, false);
});

test('validateNote：tags 非数组', () => {
  const r = validateNote({ title: 'x', tags: 'a,b' });
  assert.equal(r.valid, false);
});

test('validateNote：通过', () => {
  const r = validateNote({ title: '线代笔记', tags: ['矩阵'], content: '...' });
  assert.equal(r.valid, true);
});

// ──────────────── normalizeNotePayload ────────────────

test('normalizeNotePayload：自动抽取双向链接到 linkedCardIds', () => {
  const out = normalizeNotePayload({
    title: '线代',
    content: '复习 [[c1]] [[c2]] 和 [[d1]]',
  });
  assert.deepEqual(out.linkedCardIds.sort(), ['c1', 'c2']);
  assert.equal(out.linkedDocId, 'd1');
  assert.match(out.category, /.*/);
});

test('normalizeNotePayload：合并用户给 + 文中 # tag', () => {
  const out = normalizeNotePayload({ title: 'X #自定义', content: '#缓存', tags: ['Cache', '矩阵'] });
  // 标签合并去重
  assert.ok(out.tags.includes('cache'));
  assert.ok(out.tags.includes('矩阵'));
  assert.ok(out.tags.includes('自定义'));
  assert.ok(out.tags.includes('缓存'));
});

test('normalizeNotePayload：自动补 createdAt/updatedAt', () => {
  const out = normalizeNotePayload({ title: 'T' });
  assert.ok(typeof out.createdAt === 'number');
  assert.ok(typeof out.updatedAt === 'number');
});

// 黄金路径
test('黄金路径：recognizeWikiLinks + normalizeNotePayload + validateNote', () => {
  const raw = {
    title: '线代第四章 #特征值',
    category: '线代',
    content: '重要定理：可逆 ⇔ 行满秩。参考 [[c1234]] 与 [[d-doc1|真题2009]] 的讲解。',
  };
  const norm = normalizeNotePayload(raw);
  const check = validateNote(norm);
  assert.equal(check.valid, true);
  assert.deepEqual(norm.linkedCardIds, ['c1234']);
  assert.equal(norm.linkedDocId, 'd-doc1');
  assert.ok(norm.tags.includes('特征值'));
  // 反向链接：c1234 与 d-doc1 都能找到该笔记
  const set = findBacklinks([{ id: 'N1', content: norm.content }], 'c1234');
  assert.ok(set.has('N1'));
});
