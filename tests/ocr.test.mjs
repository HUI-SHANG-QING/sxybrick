// tests/ocr.test.mjs —— Phase 6.5b OCR 测试
// 覆盖：ocr.js 纯函数（语言白名单/资源路径/文本归一/空判定/缩放/云端请求构造/响应解析）
//       + docs-lib.ocrDoc 黄金路径（图片上传→failed→OCR→ready→全文入库→索引→删除；mock recognize）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';

// ---------- 纯函数 ----------
import {
  normalizeOcrLang, buildOcrAssets, cleanOcrText, isOcrEmpty,
  fitCanvasSize, buildCloudOcrRequest, parseCloudOcrResponse,
  OCR_DEFAULT_LANG,
} from '../src/utils/ocr.js';
// ---------- IO ----------
import {
  uploadFile, ocrDoc, getDocText, deleteDocFile, getOcrSettings, saveOcrSettings,
} from '../src/docs-lib.js';
import { hybridSearch } from '../src/agent/retrieval.js';

after(async () => { try { await db.close(); } catch {} });

// Node 无 localStorage——mock 内存版（docs-lib 的 OCR 设置读写依赖）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
}

/** 等待异步解析队列把该文件置为 failed（图片上传后自动入队，parseDoc 对 image 抛错） */
async function waitFailed(id) {
  return waitFor(async () => {
    const r = await db.docFiles.get(id);
    return r?.status === 'failed' ? r : null;
  });
}

// ---------- 纯函数 ----------

test('normalizeOcrLang：默认/白名单/非法回退', () => {
  assert.equal(normalizeOcrLang(), OCR_DEFAULT_LANG);
  assert.equal(normalizeOcrLang(''), OCR_DEFAULT_LANG);
  assert.equal(normalizeOcrLang('eng'), 'eng');
  assert.equal(normalizeOcrLang('chi_sim+eng'), 'chi_sim+eng');
  assert.equal(normalizeOcrLang('chi_tra'), 'chi_tra');
  // 非法（路径/URL/命令注入）一律回默认
  assert.equal(normalizeOcrLang('../etc/passwd'), OCR_DEFAULT_LANG);
  assert.equal(normalizeOcrLang('https://evil.com/x'), OCR_DEFAULT_LANG);
  assert.equal(normalizeOcrLang('chi_sim; rm -rf'), OCR_DEFAULT_LANG);
});

test('buildOcrAssets：worker/core 本地化 + langPath 可配', () => {
  const a = buildOcrAssets('/sxybrick/', '');
  assert.equal(a.workerPath, '/sxybrick/ocr/worker.min.js');
  assert.equal(a.corePath, '/sxybrick/ocr/tesseract-core-simd-lstm.wasm.js');
  assert.equal(a.langPath, undefined);
  const b = buildOcrAssets('/sxybrick/', 'https://cdn.example.com/tessdata');
  assert.equal(b.langPath, 'https://cdn.example.com/tessdata');
  const c = buildOcrAssets('', '');
  assert.equal(c.workerPath, '/ocr/worker.min.js');
});

test('cleanOcrText：行尾空白/多余空行压缩/trim', () => {
  // 与 parsers.cleanExtractedText 同规则：\n{4,} 压成 \n\n\n（3 空行）
  assert.equal(cleanOcrText('  你好  \n\n\n\n\n世界  '), '你好\n\n\n世界');
  assert.equal(cleanOcrText('a \nb\t\nc'), 'a\nb\nc');
  assert.equal(cleanOcrText(null), '');
});

test('isOcrEmpty：中文不误判，空/纯标点判空', () => {
  assert.equal(isOcrEmpty(''), true);
  assert.equal(isOcrEmpty('   \n\t'), true);
  assert.equal(isOcrEmpty('。，！？…—·'), true); // 纯标点符号
  assert.equal(isOcrEmpty('你好世界'), false);   // 中文汉字必须算内容
  assert.equal(isOcrEmpty('2026 考研真题'), false);
  assert.equal(isOcrEmpty('abc'), false);
});

test('fitCanvasSize：长边压缩/短图不动/异常输入', () => {
  assert.deepEqual(fitCanvasSize(4000, 2000, 2000), { width: 2000, height: 1000, scale: 0.5 });
  assert.deepEqual(fitCanvasSize(1500, 1000, 2000), { width: 1500, height: 1000, scale: 1 });
  assert.deepEqual(fitCanvasSize(0, 0), { width: 0, height: 0, scale: 1 });
  assert.deepEqual(fitCanvasSize('abc', 100), { width: 0, height: 100, scale: 1 });
});

test('buildCloudOcrRequest：未配置返回 null；配置完整返回 OpenAI 兼容请求', () => {
  assert.equal(buildCloudOcrRequest('data:image/jpeg;base64,x', {}), null);
  assert.equal(buildCloudOcrRequest('data:image/jpeg;base64,x', { endpoint: 'x', apiKey: '' }), null);
  const req = buildCloudOcrRequest('data:image/jpeg;base64,x', {
    endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-test',
  });
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer sk-test');
  assert.equal(req.body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,x');
  assert.equal(req.body.temperature, 0);
});

test('parseCloudOcrResponse：字符串与数组两种形态', () => {
  assert.equal(parseCloudOcrResponse({ choices: [{ message: { content: '识别结果' } }] }), '识别结果');
  assert.equal(parseCloudOcrResponse({ choices: [{ message: { content: [{ type: 'text', text: 'A' }, 'B'] } }] }), 'AB');
  assert.equal(parseCloudOcrResponse({}), '');
  assert.equal(parseCloudOcrResponse(null), '');
});

// ---------- 黄金路径（mock recognize，验证状态机与入库链路） ----------

test('图片上传→failed（需 OCR）→ocrDoc→ready+全文+索引+删除', async () => {
  const png = new File(['fake-png-bytes'], '扫描真题.png', { type: 'image/png' });
  const row = await uploadFile(png, { subject: '计组' });
  const failed = await waitFailed(row.id);
  assert.equal(failed.status, 'failed'); // 图片不自动解析，等 OCR
  assert.match(failed.error, /OCR/);

  const mockRecognize = async (image, { lang } = {}) => {
    assert.ok(image); // 收到识别输入（测试环境无 canvas，直接收 Blob）
    assert.equal(lang, 'chi_sim+eng');
    return '第一题：冯诺依曼机由运算器、控制器、存储器、输入输出设备组成。\n\n第二题：Cache 的替换策略有 LRU、FIFO。';
  };

  const r = await ocrDoc(row.id, { lang: 'chi_sim+eng', recognize: mockRecognize });
  assert.equal(r.ok, true);
  assert.ok(r.textLen > 0);

  const updated = await db.docFiles.get(row.id);
  assert.equal(updated.status, 'ready');
  assert.equal(updated.ocr, true); // 标记 OCR 来源
  assert.equal(updated.textLen, r.textLen);

  // 全文完整入库（一毫不丢）
  const text = await getDocText(row.id);
  assert.match(text, /冯诺依曼机/);
  assert.match(text, /LRU、FIFO/);

  // 向量索引已建 → 单文件检索命中
  const hits = await hybridSearch('Cache 替换策略', { sourceId: row.id });
  assert.ok(hits.length >= 1);

  // 删除全清
  await deleteDocFile(row.id);
  assert.equal(await db.docFiles.get(row.id), undefined);
  assert.equal(await getDocText(row.id), '');
});

test('OCR 空结果→failed 且保留错误信息', async () => {
  const png = new File(['fake'], '空白图.png', { type: 'image/png' });
  const row = await uploadFile(png);
  await waitFailed(row.id);
  const r = await ocrDoc(row.id, { recognize: async () => '。！？…' }); // 纯标点=空
  assert.equal(r.ok, false);
  assert.match(r.error, /未识别到文字/);
  const updated = await db.docFiles.get(row.id);
  assert.equal(updated.status, 'failed');
  assert.match(updated.error, /未识别到文字/);
  await deleteDocFile(row.id);
});

test('OCR 识别器抛错→failed 不崩溃', async () => {
  const png = new File(['fake'], '坏图.png', { type: 'image/png' });
  const row = await uploadFile(png);
  await waitFailed(row.id);
  const r = await ocrDoc(row.id, { recognize: async () => { throw new Error('tesseract core 加载失败'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /tesseract core 加载失败/);
  assert.equal((await db.docFiles.get(row.id)).status, 'failed');
  await deleteDocFile(row.id);
});

test('OCR 设置读写（localStorage 模拟）', () => {
  const saved = saveOcrSettings({ lang: 'chi_sim', cloud: { enabled: true, endpoint: 'https://x/v1/chat/completions', apiKey: 'sk-1' } });
  assert.equal(saved.lang, 'chi_sim');
  const got = getOcrSettings();
  assert.equal(got.lang, 'chi_sim');
  assert.equal(got.cloud.enabled, true);
  // 局部 patch 不丢其他字段
  saveOcrSettings({ lang: 'eng' });
  assert.equal(getOcrSettings().lang, 'eng');
  assert.equal(getOcrSettings().cloud.apiKey, 'sk-1');
});
