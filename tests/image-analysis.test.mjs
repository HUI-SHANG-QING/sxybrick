// 测试：图片分析聚合层（services/image-analysis.js）
// 覆盖：策略解析 / 推荐规则 / OCR 先行文字化 / 视觉兜底 / 多模态 content 组装 / 降级路径
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';
import {
  parseImageMode, resolveImagePolicy, recommendMode, recommendForCurrentData,
  enrichForLlm, textifyContent, imageIdsToVisionContent, normalizeVisionLimit,
} from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch {} });

const UUID1 = '550e8400-e29b-41d4-a716-446655440001';
const UUID2 = '550e8400-e29b-41d4-a716-446655440002';
const UUID3 = '550e8400-e29b-41d4-a716-446655440003';
const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

test('策略解析：缺省/非法值回退 auto，各档语义正确', () => {
  assert.equal(parseImageMode(undefined), 'auto');
  assert.equal(parseImageMode({}), 'auto');
  assert.equal(parseImageMode({ imageAnalysis: { mode: 'bogus' } }), 'auto');
  // round67 起 resolveImagePolicy 额外带出 visionLimit（可配的送图额度）
  assert.deepEqual(resolveImagePolicy({ imageAnalysis: { mode: 'auto' } }), { mode: 'auto', allowVisionFallback: true, visionLimit: 3 });
  assert.deepEqual(resolveImagePolicy({ imageAnalysis: { mode: 'ocrFirst' } }), { mode: 'ocrFirst', allowVisionFallback: false, visionLimit: 3 });
  assert.deepEqual(resolveImagePolicy({ imageAnalysis: { mode: 'visionFirst' } }), { mode: 'visionFirst', allowVisionFallback: false, visionLimit: 3 });
});

test('推荐规则：无图→auto；过半含图→visionFirst；其余→ocrFirst', () => {
  assert.equal(recommendMode({ imgRefs: 0, imgDocs: 0, docs: 10 }).mode, 'auto');
  assert.equal(recommendMode({ imgRefs: 12, imgDocs: 60, docs: 80 }).mode, 'visionFirst');
  assert.equal(recommendMode({ imgRefs: 5, imgDocs: 2, docs: 20 }).mode, 'ocrFirst');
  // 边界：恰好 50% 不算"过半"
  assert.equal(recommendMode({ imgRefs: 5, imgDocs: 5, docs: 10 }).mode, 'ocrFirst');
});

test('enrichForLlm：纯文字消息零开销原样返回', async () => {
  const r = await enrichForLlm([{ role: 'user', content: '没有图的纯问题' }], { settings: {} });
  assert.equal(r.vision, 0);
  assert.equal(r.messages[0].content, '没有图的纯问题');
});

test('enrichForLlm ocrFirst：占位符替换为 OCR 文字，失败图标注，永不视觉', async () => {
  await db.images.put({ id: UUID1, blob: blob(), name: 'a.jpg' });
  await db.images.put({ id: UUID2, blob: blob(), name: 'b.jpg' });
  const ocrFn = async (id) => (id === UUID1 ? '图里的文字ABC' : '');
  const r = await enrichForLlm(
    [{ role: 'user', content: `分析 sxy-img://${UUID1} 和 sxy-img://${UUID2}` }],
    { settings: { imageAnalysis: { mode: 'ocrFirst' } }, ocrFn },
  );
  const c = r.messages[0].content;
  assert.equal(r.vision, 0, 'ocrFirst 不得产生视觉调用');
  assert.ok(c.includes('图里的文字ABC'), '成功图应替换为 OCR 文字');
  assert.ok(c.includes('未能识别'), '失败图应标注');
  assert.ok(!c.includes('sxy-img://'), '占位符应全部清除');
});

test('enrichForLlm auto：OCR 失败的图自动视觉兜底（最多 1 张）', async () => {
  await db.images.put({ id: UUID1, blob: blob(), name: 'a.jpg' });
  await db.images.put({ id: UUID2, blob: blob(), name: 'b.jpg' });
  const ocrFn = async (id) => (id === UUID1 ? '图里的文字ABC' : '');
  const r = await enrichForLlm(
    [{ role: 'user', content: `分析 sxy-img://${UUID1} 和 sxy-img://${UUID2}` }],
    { settings: { imageAnalysis: { mode: 'auto' } }, ocrFn },
  );
  const last = r.messages[r.messages.length - 1];
  assert.equal(r.vision, 1, 'auto 兜底最多挂 1 张');
  assert.ok(Array.isArray(last.content), '末条 user 应变为多模态数组');
  assert.ok(last.content.some((p) => p.type === 'text'), '应保留 text 段');
  assert.ok(last.content.some((p) => p.type === 'image_url' && String(p.image_url.url).startsWith('data:')), '应挂 data URL 图片');
  assert.ok(JSON.stringify(last.content).includes('图里的文字ABC'), 'OCR 成功图的文字仍应保留');
});

test('enrichForLlm visionFirst：直接发图（≤3 张），不 OCR', async () => {
  await db.images.put({ id: UUID1, blob: blob(), name: 'a.jpg' });
  await db.images.put({ id: UUID2, blob: blob(), name: 'b.jpg' });
  await db.images.put({ id: UUID3, blob: blob(), name: 'c.jpg' });
  let ocrCalls = 0;
  const r = await enrichForLlm(
    [{ role: 'user', content: `看 sxy-img://${UUID1} sxy-img://${UUID2} sxy-img://${UUID3}` }],
    { settings: { imageAnalysis: { mode: 'visionFirst' } }, ocrFn: async () => { ocrCalls += 1; return 'X'; } },
  );
  assert.equal(ocrCalls, 0, 'visionFirst 不应触发 OCR');
  assert.equal(r.vision, 3, '最多挂 3 张');
  const last = r.messages[r.messages.length - 1];
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content.filter((p) => p.type === 'image_url').length, 3);
  // 行为变更（2026-09-13 round42）：正文里的占位符不再原样保留，而是替换为「已作为附图发送」标注。
  // 原因：模型看不懂 sxy-img://xxx，只看到一串占位符会答「只能识别到图片标题、看不到内容」，
  // 正是用户反馈「白搞」的场景（护栏截断后尤其明显）。
  const textSeg = last.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  assert.ok(!textSeg.includes('sxy-img://'), '占位符必须被替换为可读标注');
  assert.match(textSeg, /已作为附图发送/, '送出的图要有明确标注');
});

test('enrichForLlm 降级：图片行不存在 → 纯文字标注，不阻塞', async () => {
  const r = await enrichForLlm(
    [{ role: 'user', content: '分析 sxy-img://deadbeef-0000-4000-8000-000000000000' }],
    { settings: { imageAnalysis: { mode: 'auto' } }, ocrFn: async () => '不应被调用' },
  );
  assert.equal(r.vision, 0);
  assert.ok(typeof r.messages[0].content === 'string', '应降级为纯文字');
});

// ── round67：送图额度可配置（额度 = 张数，不是请求次数） ──────────────────

test('normalizeVisionLimit：合法值原样、脏值回退默认、超限夹到上限', () => {
  assert.equal(normalizeVisionLimit(5), 5);
  assert.equal(normalizeVisionLimit('8'), 8, '数字字符串应被接受');
  assert.equal(normalizeVisionLimit(undefined), 3, '缺省 → 默认 3');
  assert.equal(normalizeVisionLimit(null), 3);
  assert.equal(normalizeVisionLimit('abc'), 3);
  assert.equal(normalizeVisionLimit(0), 3, '0 张无意义 → 回退默认');
  assert.equal(normalizeVisionLimit(-5), 3);
  assert.equal(normalizeVisionLimit(NaN), 3);
  assert.equal(normalizeVisionLimit(Infinity), 3);
  assert.equal(normalizeVisionLimit(1e9), 20, '必须夹到上限，防账单失控');
  assert.equal(normalizeVisionLimit(3.7), 3, '向下取整');
});

test('resolveImagePolicy：带出用户配置的送图额度', () => {
  assert.equal(resolveImagePolicy({ imageAnalysis: { mode: 'visionFirst' } }).visionLimit, 3);
  assert.equal(resolveImagePolicy({ imageAnalysis: { mode: 'visionFirst', visionLimit: 10 } }).visionLimit, 10);
  assert.equal(
    resolveImagePolicy({ imageAnalysis: { mode: 'ocrFirst', visionLimit: 10 } }).visionLimit, 10,
    '额度本身与模式无关（用不用由各模式决定）',
  );
});

test('端到端：调高额度后一次请求能带更多图（3 → 5，仍是单条消息）', async () => {
  const ids = [UUID1, UUID2, UUID3,
    '550e8400-e29b-41d4-a716-446655440004',
    '550e8400-e29b-41d4-a716-446655440005'];
  for (const id of ids) await db.images.put({ id, blob: blob(), name: `${id}.jpg` });
  const content = `看图 ${ids.map((i) => `sxy-img://${i}`).join(' ')}`;

  const r3 = await enrichForLlm([{ role: 'user', content }], {
    settings: { imageAnalysis: { mode: 'visionFirst' } },
  });
  assert.equal(r3.vision, 3, '默认额度 3');

  const r5 = await enrichForLlm([{ role: 'user', content }], {
    settings: { imageAnalysis: { mode: 'visionFirst', visionLimit: 5 } },
  });
  assert.equal(r5.vision, 5, '调高额度后应全部送出');
  const last = r5.messages[r5.messages.length - 1];
  assert.equal(last.content.filter((p) => p.type === 'image_url').length, 5, '一次请求带 5 张图');
  assert.equal(last.content.filter((p) => p.type === 'text').length, 1, '仍只有一条消息（一次请求，非多次）');
});

test('文案区分：额度内读不出的图不再被误报为「超出额度」', async () => {
  const r = await enrichForLlm(
    [{ role: 'user', content: '看 sxy-img://deadbeef-0000-4000-8000-000000000000' }],
    { settings: { imageAnalysis: { mode: 'visionFirst', visionLimit: 3 } } },
  );
  const c = r.messages[r.messages.length - 1].content;
  const seg = typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('');
  assert.match(seg, /读取失败/, '应如实说明是读取失败');
  assert.ok(!/超出本次送图额度/.test(seg), '不得误报为超出额度（否则用户会白重发一次）');
});

test('textifyContent：无图原文返回；有图产出分析副本（原文不变）', async () => {
  await db.images.put({ id: UUID1, blob: blob(), name: 'a.jpg' });
  const plain = '没有图的正文';
  const r0 = await textifyContent(plain, { ocrFn: async () => 'X' });
  assert.equal(r0.text, plain);

  const withImg = `带图正文 sxy-img://${UUID1} 结尾`;
  const r1 = await textifyContent(withImg, { ocrFn: async () => '识别出的文字' });
  assert.notEqual(r1.text, withImg, '应产出增强副本');
  assert.ok(r1.text.startsWith(withImg), '原文应完整保留在前');
  assert.ok(r1.text.includes('识别出的文字'), '应含 OCR 文本');
  assert.equal(r1.ocrDone, 1);
});

test('imageIdsToVisionContent：空 id 返回 []；有效 id 产出 data URL', async () => {
  await db.images.put({ id: UUID1, blob: blob(), name: 'a.jpg' });
  assert.deepEqual(await imageIdsToVisionContent([]), []);
  const out = await imageIdsToVisionContent([UUID1]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'image_url');
  assert.ok(out[0].image_url.url.startsWith('data:image/jpeg;base64,'), '应为 jpeg data URL');
});

test('recommendForCurrentData：端到端统计 + 推荐', async () => {
  await db.cards.put({ id: 't-c1', front: '纯文字卡', back: '' });
  await db.cards.put({ id: 't-c2', front: `带图 sxy-img://${UUID1}`, back: '' });
  const r = await recommendForCurrentData();
  assert.equal(r.stats.imgRefs, 1);
  assert.equal(r.stats.imgDocs, 1);
  assert.ok(r.stats.docs >= 2);
  assert.ok(['auto', 'ocrFirst', 'visionFirst'].includes(r.mode));
});
