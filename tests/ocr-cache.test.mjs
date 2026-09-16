// tests/ocr-cache.test.mjs —— OCR 结果缓存（LRU 上限 + 版本签名）回归
// 背景（2026-09-14 审计）：OCR 缓存原先是 image-analysis 里一个裸 Map——
//   ① 没有上限：PWA 一天不关标签页，识别几百上千张图就一直堆在内存里；
//   ② 没有失效：图片被替换后，缓存里还是旧图的文字，AI 拿旧内容回答新图。
// 现下沉到 utils/ocr-cache.js：LRU 上限 + updatedAt 签名校验。
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  getOcr, setOcr, forgetOcr, clearOcrCache, ocrCacheSize, OCR_CACHE_LIMIT,
} from '../src/utils/ocr-cache.js';
import { enrichForLlm } from '../src/services/image-analysis.js';

after(async () => { try { clearOcrCache(); await db.close(); } catch { /* ignore */ } });

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

// ---------- 1) 基本读写 ----------

test('setOcr/getOcr：读回文本；空串也缓存（「这张图没文字」同样是结论）', () => {
  clearOcrCache();
  setOcr('a1', '识别结果', 100);
  setOcr('a2', '', 100);
  assert.equal(getOcr('a1', 100), '识别结果');
  assert.equal(getOcr('a2', 100), '', '空串应命中而不是未命中（避免反复重试识别）');
  assert.equal(getOcr('nope', 100), null, '未缓存返回 null');
});

test('签名不一致 → 未命中，并顺手清掉过期条目', () => {
  clearOcrCache();
  setOcr('b1', '旧图文字', 100);
  assert.equal(getOcr('b1', 200), null, '图片更新后不得复用旧 OCR 结果');
  assert.equal(getOcr('b1', 100), null, '过期条目已被清除');
  assert.equal(getOcr('b1'), '旧图文字'.length ? null : null);
});

test('不传签名时按「无签名」命中（调用方自行负责）', () => {
  clearOcrCache();
  setOcr('c1', 'x');
  assert.equal(getOcr('c1'), 'x');
});

// ---------- 2) LRU 上限 ----------

test(`LRU：超过 ${OCR_CACHE_LIMIT} 条淘汰最旧，且最近使用的不被淘汰`, () => {
  clearOcrCache();
  for (let i = 0; i < OCR_CACHE_LIMIT; i += 1) setOcr(`k${i}`, `v${i}`, 1);
  assert.equal(ocrCacheSize(), OCR_CACHE_LIMIT);
  // 触达最旧的一条，使其变成「最近使用」
  assert.equal(getOcr('k0', 1), 'v0');
  setOcr('newest', 'v-new', 1);
  assert.equal(ocrCacheSize(), OCR_CACHE_LIMIT, '插入后仍不超过上限');
  assert.equal(getOcr('k0', 1), 'v0', '最近使用过的条目应保留');
  assert.equal(getOcr('k1', 1), null, '真正的最旧条目（k1）被淘汰');
  assert.equal(getOcr('newest', 1), 'v-new');
});

test('forgetOcr / clearOcrCache：可定点失效与整体清空', () => {
  clearOcrCache();
  setOcr('d1', '1', 1);
  setOcr('d2', '2', 1);
  assert.equal(forgetOcr('d1'), 1);
  assert.equal(getOcr('d1', 1), null);
  assert.equal(getOcr('d2', 1), '2', '不应误伤其它条目');
  assert.equal(forgetOcr(['d2', '不存在']), 1);
  setOcr('d3', '3', 1);
  clearOcrCache();
  assert.equal(ocrCacheSize(), 0);
});

// ---------- 3) 与富集层的集成（签名驱动的复用/失效） ----------

test('enrichForLlm：同图二次调用复用 OCR；图片被替换后重新识别；图片删除后不复用', async () => {
  clearOcrCache();
  const id = crypto.randomUUID();
  await db.images.put({ id, blob: blob(), size: 3, updatedAt: 1000 });
  let calls = 0;
  const ocrFn = async () => { calls += 1; return `文字${calls}`; };
  const messages = [{ role: 'user', content: `看图 sxy-img://${id}` }];
  const settings = { imageAnalysis: { mode: 'ocrFirst' } };

  const r1 = await enrichForLlm(messages, { settings, ocrFn });
  assert.equal(calls, 1);
  assert.match(r1.messages[0].content, /文字1/);

  const r2 = await enrichForLlm(messages, { settings, ocrFn });
  assert.equal(calls, 1, '签名未变 → 必须复用缓存（省一次识别）');
  assert.match(r2.messages[0].content, /文字1/);

  // 图片被替换：updatedAt 推进 → 旧识别结果作废
  await db.images.put({ id, blob: blob(), size: 3, updatedAt: 2000 });
  const r3 = await enrichForLlm(messages, { settings, ocrFn });
  assert.equal(calls, 2, '图片更新后必须重新识别');
  assert.match(r3.messages[0].content, /文字2/);

  // 图片被删除：不得复用缓存里已删图片的旧文字
  await db.images.delete(id);
  const r4 = await enrichForLlm(messages, { settings, ocrFn });
  assert.equal(calls, 2, '图已删 → 不该再调识别');
  // round88：标注从笼统的「未能识别文字」细化为「本机图库里没有这张图」。
  // 本用例的断言意图（「删除后不得复用缓存」）不变，只是钉住更精确的措辞——
  // 行缺失是**数据侧**问题，与「图在但 OCR 没认出来」要分开说，否则用户会去折腾 OCR 设置。
  assert.match(r4.messages[0].content, /本机图库里没有这张图/, '应如实标注图已不在本机（不得复用缓存旧文字）');
});
