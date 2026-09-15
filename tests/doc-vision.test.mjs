// tests/doc-vision.test.mjs —— 资料库文件（扫描 PDF / 图片）接入多模态分析
// 背景（2026-09-13 用户核心诉求）：卡片/笔记里的图片能送 AI 了，但**资料库文件不在那条链路上**——
// 扫描型 PDF 文本层为空、图表型 PDF 只有零散标题、图片资料压根没文本，
// 结果「上传了资料问 AI，却只能说识别到标题」。本测试锁定修复后的行为：
//   1) 形态分类 + 内容画像（文本量/页数/密度/疑似扫描件/能否视觉）
//   2) docVisionContent：图片型直送、PDF 渲染页面（护栏 ≤3 页）、渲染失败降级为空
//   3) askDoc：有文本→文本检索；无文本/疑似扫描件→视觉（via='vision'）；都无法→明确引导（via='blocked'）
//   4) 统计与推荐把资料库的 PDF/图片算进来（否则推荐会漏掉最需要视觉的数据）
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  docKindOf, docContentProfile, docVisionContent, DOC_VISION_LIMIT,
} from '../src/services/doc-vision.js';
import { askDoc, buildDocVisionPrompt } from '../src/utils/docs-qa.js';
import { statImageAssets, recommendMode } from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

/** 造一份资料（含原始 Blob，模拟 docBlobs 里的文件） */
async function mkDoc({ name, text = '', pageCount = 0, blob = true }) {
  const id = `doc-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  await db.docFiles.put({
    id, name, status: text ? 'ready' : 'ready', subject: '测试',
    ...(pageCount ? { pageCount } : {}), createdAt: now, updatedAt: now,
  });
  if (text) await db.docTexts.put({ id, text, textLen: text.length, updatedAt: now });
  if (blob) await db.docBlobs.put({ id, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), size: 3, updatedAt: now });
  return id;
}

// ---------- 1) 形态分类 ----------

test('docKindOf：按扩展名分类（pdf / image / text / other）', () => {
  assert.equal(docKindOf({ name: '高数笔记.pdf' }), 'pdf');
  assert.equal(docKindOf({ name: 'scan.JPG' }), 'image');
  assert.equal(docKindOf({ name: 'note.md' }), 'text');
  assert.equal(docKindOf({ name: 'archive.zip' }), 'other');
  assert.equal(docKindOf({}), 'other');
});

// ---------- 2) 内容画像 ----------

test('docContentProfile：扫描件（20 页仅 40 字）→ suspectedScan 且可视觉', async () => {
  const id = await mkDoc({ name: '线代扫描.pdf', text: 'x'.repeat(40), pageCount: 20 });
  const p = await docContentProfile(id);
  assert.equal(p.kind, 'pdf');
  assert.equal(p.pageCount, 20);
  assert.equal(p.density, 2);
  assert.equal(p.suspectedScan, true, '每页 2 字 → 文本层不可用，应判为扫描件');
  assert.equal(p.canVision, true);
  await db.docFiles.delete(id); await db.docTexts.delete(id); await db.docBlobs.delete(id);
});

test('docContentProfile：正常文本 PDF（每页 500 字）→ 不是扫描件', async () => {
  const id = await mkDoc({ name: '讲义.pdf', text: 'y'.repeat(1000), pageCount: 2 });
  const p = await docContentProfile(id);
  assert.equal(p.suspectedScan, false);
  assert.equal(p.density, 500);
  assert.equal(p.reason, 'ok');
  await db.docFiles.delete(id); await db.docTexts.delete(id); await db.docBlobs.delete(id);
});

test('docContentProfile：原始文件缺失 → canVision=false 且 reason=no-blob', async () => {
  const id = await mkDoc({ name: '缺文件.pdf', text: '', pageCount: 3, blob: false });
  const p = await docContentProfile(id);
  assert.equal(p.hasBlob, false);
  assert.equal(p.canVision, false);
  assert.equal(p.reason, 'no-blob');
  await db.docFiles.delete(id);
});

test('docContentProfile：图片型资料天然可视觉（无文本层）', async () => {
  const id = await mkDoc({ name: '公式截图.png', text: '' });
  const p = await docContentProfile(id);
  assert.equal(p.kind, 'image');
  assert.equal(p.canVision, true);
  await db.docFiles.delete(id); await db.docBlobs.delete(id);
});

test('docContentProfile：不存在的资料 → 安全返回', async () => {
  const p = await docContentProfile('no-such-doc');
  assert.equal(p.canVision, false);
  assert.equal(p.reason, 'not-found');
});

// ---------- 3) 视觉内容产出 ----------

test('docVisionContent：图片型资料 → 1 个 image_url（Node 无 canvas 走原始 dataURL）', async () => {
  const id = await mkDoc({ name: '图.png', text: '' });
  const v = await docVisionContent(id);
  assert.equal(v.length, 1);
  assert.equal(v[0].type, 'image_url');
  assert.match(v[0].image_url.url, /^data:/);
  await db.docFiles.delete(id); await db.docBlobs.delete(id);
});

test('docVisionContent：默认护栏 3 页；调用方可放宽至硬上限内', async () => {
  const id = await mkDoc({ name: '扫描.pdf', text: '', pageCount: 10 });
  const stub = async (blob, opts) => Array.from(
    { length: Math.min(opts.maxPages, 10) },
    (_, i) => ({ page: i + 1, dataUrl: `data:image/jpeg;base64,P${i + 1}` }),
  );
  // round67：额度改为可配 —— 缺省仍是保守的 3 页；调用方（用户调高了送图额度）可放宽，
  // 但绝不能越过 DOC_VISION_MAX 硬上限。
  const def = await docVisionContent(id, { renderPdfPagesFn: stub });
  assert.equal(def.length, DOC_VISION_LIMIT, '缺省仍是最多 3 页（保守默认）');
  const wide = await docVisionContent(id, { maxPages: 99, renderPdfPagesFn: stub });
  assert.equal(wide.length, 10, '调用方放宽后按传入值送出（硬上限 20 之内）');
  assert.equal(wide[0].image_url.url, 'data:image/jpeg;base64,P1');
  await db.docFiles.delete(id); await db.docBlobs.delete(id);
});

test('docVisionContent：渲染抛错 → 返回空数组（调用方降级，不抛出）', async () => {
  const id = await mkDoc({ name: '坏.pdf', text: '', pageCount: 2 });
  const v = await docVisionContent(id, { renderPdfPagesFn: async () => { throw new Error('render failed'); } });
  assert.deepEqual(v, []);
  await db.docFiles.delete(id); await db.docBlobs.delete(id);
});

test('docVisionContent：非视觉形态（txt）→ 空数组', async () => {
  const id = await mkDoc({ name: 'a.txt', text: 'hello' });
  assert.deepEqual(await docVisionContent(id), []);
  await db.docFiles.delete(id); await db.docTexts.delete(id); await db.docBlobs.delete(id);
});

// ---------- 4) askDoc 分支 ----------

test('askDoc：无文本层的扫描件 → 走视觉路径（via=vision，不再是「尚未解析完成」）', async () => {
  const id = await mkDoc({ name: '扫描讲义.pdf', text: '', pageCount: 6 });
  const r = await askDoc(id, '这份资料讲了什么？', { renderPdfPagesFn: async () => [{ page: 1, dataUrl: 'data:image/jpeg;base64,AAA' }] });
  assert.equal(r.via, 'vision', '必须走视觉，而不是抛「尚未解析完成」');
  assert.equal(r.visionPages, 1);
  assert.ok(r.answer, '应返回可读回答（无 Key 时由离线兜底给出引导，不崩）');
  await db.docFiles.delete(id); await db.docBlobs.delete(id);
});

test('askDoc：疑似扫描件（有零散文本）也走视觉，并说明原因', async () => {
  const id = await mkDoc({ name: '图表.pdf', text: '第一章', pageCount: 30 });
  const r = await askDoc(id, '第三章的图说明了什么？', { renderPdfPagesFn: async () => [{ page: 1, dataUrl: 'data:image/jpeg;base64,BBB' }] });
  assert.equal(r.via, 'vision');
  assert.match(r.note, /扫描件|图片视觉/);
  await db.docFiles.delete(id); await db.docTexts.delete(id); await db.docBlobs.delete(id);
});

test('askDoc：无文本且无法视觉（缺原始文件）→ 明确引导而非静默「没找到」', async () => {
  const id = await mkDoc({ name: '丢失.pdf', text: '', pageCount: 3, blob: false });
  const r = await askDoc(id, '讲了什么？');
  assert.equal(r.via, 'blocked');
  assert.match(r.answer, /原始文件不在本机|无法/);
  assert.match(r.answer, /多模态|OCR/, '必须给出下一步可行操作');
  await db.docFiles.delete(id);
});

test('askDoc：不存在的问题/资料 → 明确报错', async () => {
  const id = await mkDoc({ name: 'x.pdf', text: 'abc' });
  await assert.rejects(() => askDoc(id, '   '), /问题不能为空/);
  await assert.rejects(() => askDoc('no-such', '问题'), /资料不存在/);
  await db.docFiles.delete(id); await db.docTexts.delete(id); await db.docBlobs.delete(id);
});

// ---------- 5) prompt 与推荐 ----------

test('buildDocVisionPrompt：要求读图并转述关键内容，而非只说「有一张图」', () => {
  const p = buildDocVisionPrompt({ docName: '线代.pdf', question: '第三题怎么解？', pageCount: 4, kind: 'pdf' });
  assert.match(p, /线代\.pdf/);
  assert.match(p, /第三题怎么解/);
  assert.match(p, /坐标轴|图例|趋势/, '图表型资料必须要求读出数值/趋势');
});

test('recommendMode：资料库有 PDF/图片 → 推荐 visionFirst（OCR 只会拿到零散标题）', () => {
  const rec = recommendMode({ imgRefs: 0, imgDocs: 0, docs: 10, docVisual: 2, docVisionPages: 40 });
  assert.equal(rec.mode, 'visionFirst');
  assert.match(rec.reason, /2 份|40 页/);
});

test('recommendMode：纯卡片文字数据 → auto（无图无资料）', () => {
  assert.equal(recommendMode({ imgRefs: 0, imgDocs: 0, docs: 10 }).mode, 'auto');
});

test('statImageAssets：把资料库里的 PDF/图片文件算进统计', async () => {
  const pdfId = await mkDoc({ name: '资料.pdf', text: 'z'.repeat(20), pageCount: 8 });
  const imgId = await mkDoc({ name: '图.png', text: '' });
  const stats = await statImageAssets();
  assert.ok(stats.docVisual >= 2, `docVisual 应包含这两份资料，实际 ${stats.docVisual}`);
  assert.ok(stats.docVisionPages >= 9, `页数应含 PDF 的 8 页 + 图片 1 页，实际 ${stats.docVisionPages}`);
  await db.docFiles.delete(pdfId); await db.docTexts.delete(pdfId); await db.docBlobs.delete(pdfId);
  await db.docFiles.delete(imgId); await db.docBlobs.delete(imgId);
});

// ---------- 6) visionFirst 正文明细：送图的/超限的都要有明确标注 ----------
// 用户反馈的「白搞」场景：护栏截断后，正文只留 sxy-img://xxx 占位符 → 模型以为看不到内容。
test('enrichForLlm(visionFirst)：送图与超限图片在正文里都有明确标注', async () => {
  const { enrichForLlm } = await import('../src/services/image-analysis.js');
  const { saveWordSettings } = await import('../src/word-repo.js');
  // 造 5 张图（护栏 3 张 → 后 2 张必然超限）
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    // id 必须是 UUID 形态：extractImageIds 的正则只认 [0-9a-f-]，随机字母串不会被识别
    const id = crypto.randomUUID();
    await db.images.put({ id, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), size: 3, updatedAt: Date.now() });
    ids.push(id);
  }
  const body = ids.map((id, i) => '图' + (i + 1) + '：![p' + (i + 1) + '](sxy-img://' + id + ')').join('\n');
  await saveWordSettings({ imageAnalysis: { mode: 'visionFirst' } });
  try {
    const r = await enrichForLlm([{ role: 'user', content: body }]);
    const last = r.messages[r.messages.length - 1];
    assert.ok(Array.isArray(last.content), '末条 user content 应变成多模态数组');
    assert.equal(r.vision, 3, '护栏：单次最多送 3 张');
    const text = last.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
    assert.match(text, /已作为附图发送/, '送出的图要有「已作为附图发送」标注');
    assert.match(text, /超出本次送图额度/, '超限的图要显式说明超额度，不能只留占位符');
    assert.ok(!text.includes('sxy-img://'), '正文里不应再残留占位符（模型看不懂）');
    assert.equal(last.content.filter((p) => p.type === 'image_url').length, 3);
  } finally {
    await saveWordSettings({ imageAnalysis: { mode: 'auto' } });
    for (const id of ids) await db.images.delete(id);
  }
});
