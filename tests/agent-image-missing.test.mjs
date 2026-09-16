// tests/agent-image-missing.test.mjs —— round88 #129
//
// 核查目标（先复现、再定性，不靠猜）：
//   用户反馈「还是看不到图片」。image-analysis.js 里图片读不出来只有两种物理原因：
//     · missing    —— db.images 里**没有这一行**（跨设备同步没带图 / 已被删除 / 从备份导入时漏了图库）
//     · unreadable —— 行在，但解码/压缩失败（blob 损坏）
//   但 visionFirst 分支把它们**合并**成一句「读取失败（图片可能已被删除或无法解析），请确认该图仍在卡片中」，
//   而 OCR 分支更糟：行缺失时只写「未能识别文字，未纳入分析」——用户会以为「OCR 没认出来」，
//   于是去折腾 OCR 设置，而真相是这张图在本机根本不存在。这是**诊断误导**，不是功能缺陷。
//
// 本文件先钉住「行存在时管线确实是通的」（证明代码无缺陷、属数据侧缺失），
// 再钉住「missing 与 unreadable 必须给出可区分且可执行的说明」。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import {
  imageIdsToVisionContentMapped,
  enrichForLlm,
} from '../src/services/image-analysis.js';
import { putImage } from '../src/images.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const VISION = { imageAnalysis: { mode: 'visionFirst', visionLimit: 4, imageQuality: 'high' } };
const OCR_ONLY = { imageAnalysis: { mode: 'ocrFirst', visionLimit: 4, imageQuality: 'high' } };

/** 1×1 透明 PNG（最小的合法图片，用于证明「行存在 → 能送出去」） */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });

const ID_MISSING = '00000000-0000-4000-8000-000000000001';
const ID_PRESENT = '00000000-0000-4000-8000-000000000002';

async function seed() {
  await db.images.clear();
  await putImage(ID_PRESENT, pngBlob(), 'image/png');
}

// ---------------- A. 先证伪「代码坏了」 ----------------

test('复现：图片行存在时，压缩+dataURL 管线完全正常（证明不是代码缺陷）', async () => {
  await seed();
  const skips = [];
  const mapped = await imageIdsToVisionContentMapped([ID_PRESENT], { onSkip: (id, r) => skips.push([id, r]) });
  assert.equal(mapped.length, 1, '行存在时必须能转出视觉内容（Node 下走 blobToDataUrlRaw 兜底）');
  assert.equal(mapped[0].id, ID_PRESENT);
  assert.match(mapped[0].part.image_url.url, /^data:image\//, '要产出合法 data URL');
  assert.deepEqual(skips, [], '不该有任何跳过');
});

test('复现：图不存在时被标记为 missing（不是 unreadable）', async () => {
  await seed();
  const skips = [];
  const mapped = await imageIdsToVisionContentMapped([ID_MISSING], { onSkip: (id, r) => skips.push([id, r]) });
  assert.equal(mapped.length, 0);
  assert.deepEqual(skips, [[ID_MISSING, 'missing']], '原因必须是 missing —— 它是数据侧缺失，处置办法与解码失败完全不同');
});

test('复现：blob 损坏（行在但读不出）才标记为 unreadable', async () => {
  await db.images.put({ id: 'bad-blob', blob: null, mime: 'image/png', updatedAt: Date.now() });
  const skips = [];
  await imageIdsToVisionContentMapped(['bad-blob'], { onSkip: (id, r) => skips.push([id, r]) });
  assert.deepEqual(skips, [['bad-blob', 'unreadable']], '空 blob 应走 unreadable 分支（与 missing 区分开）');
  await db.images.delete('bad-blob');
});

// ---------------- B. 文案必须能区分两种原因（本轮要修的点） ----------------

test('#129 visionFirst：图不在本机图库时，说明必须点明「本机没有这张图」，不能笼统说「可能已被删除」', async () => {
  await seed();
  const md = `看图分析：\n![image](sxy-img://${ID_MISSING})`;
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: md }],
    { settings: VISION },
  );
  const out = messages.map((m) => String(m.content)).join('\n');
  assert.match(out, /行?.*(不存在|找不到|未同步)/, '要说清「本机图库里没有这一行」——用户才知道该去同步/重新导入');
  assert.ok(!/可能已被删除或无法解析/.test(out), '不能再把两种原因合并成一句含糊的话（会把用户引向错误排查方向）');
});

test('#129 visionFirst：行存在且能解码时，标注依然是「已作为附图发送」', async () => {
  await seed();
  const md = `看图：\n![image](sxy-img://${ID_PRESENT})`;
  const { messages, vision } = await enrichForLlm([{ role: 'user', content: md }], { settings: VISION });
  assert.equal(vision, 1);
  const out = messages.map((m) => JSON.stringify(m.content)).join('\n');
  assert.match(out, /已作为附图发送/, '正常路径的标注不能被本轮改动破坏');
});

test('#129 OCR 分支：行缺失时不得只说「未能识别文字」（那会把用户引去折腾 OCR 设置）', async () => {
  await seed();
  const md = `看图：\n![image](sxy-img://${ID_MISSING})`;
  const { messages } = await enrichForLlm([{ role: 'user', content: md }], { settings: OCR_ONLY });
  const out = messages.map((m) => String(m.content)).join('\n');
  assert.match(out, /(不存在|找不到|未同步)/, 'OCR 模式下也要说清「这张图不在本机」，而不是含糊的「未能识别」');
});

test('#129 预算超限与「图不存在」必须是两句话（预算问题不该让用户去查图片是否被删）', async () => {
  await seed();
  // 注意顺序：缺图放在**前面**。字节预算一旦耗尽，后面的 id 一律按 budget 跳过而不再查库
  //（这是刻意的优化：省掉超预算后几十次无用的 canvas/base64），所以缺图必须先被解析到。
  const md = `看图：\n![image](sxy-img://${ID_MISSING})\n![image](sxy-img://${ID_PRESENT})`;
  // 把字节预算压到 1 字节 → 缺图走 missing，存在的图走 budget
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: md }],
    { settings: VISION, bytesBudget: 1 },
  );
  const out = messages.map((m) => String(m.content)).join('\n');
  assert.match(out, /体积上限/, '预算超限要有专门说明');
  assert.match(out, /(不存在|没有这张图|未同步)/, '缺图要有另一套说明');
  assert.ok(!/读取失败/.test(out), '不应再出现把两种原因混在一起的旧文案');
});
