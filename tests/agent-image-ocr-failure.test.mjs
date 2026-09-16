// tests/agent-image-ocr-failure.test.mjs —— round88（OCR 失败可诊断）
//
// 背景：用户反馈「还是看不到图片」。上一轮已修「图在本机不存在」的措辞（missing vs unreadable），
// 但 OCR 这一侧还留着一个同类的诊断黑洞 —— `enrichForLlm` 的 OCR 循环里是：
//     } catch { text = ''; }   // 识别失败：留空
// 于是「识别抛异常」与「识别成功但图里没字」被压成同一句「未能识别文字，未纳入分析」。
// 用户拿到这句话根本无法行动：
//   · 云端 OCR 密钥错了 / 端点写错 → 该去改设置；
//   · 本地 Tesseract 语言包下载失败（离线环境最常见）→ 该换模式或放通网络；
//   · 单张 30s 超时 / 用户取消 → 该重试，而不是判死；
//   · 图太糊 / 图里本来就没字 / 识别语言不匹配 → 才是真的「没识别出文字」。
// 更隐蔽的一条：旧实现**连失败也写进会话内 OCR 缓存** —— 网络抖一下，
// 这张图在整个会话里就永久「未能识别」，用户重试多少次都没用。
//
// 本文件钉住四态标注 + 失败不缓存 + auto 兜底不白送。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { enrichForLlm, explainOcrFailure } from '../src/services/image-analysis.js';
import { putImage } from '../src/images.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const OCR_ONLY = { imageAnalysis: { mode: 'ocrFirst', visionLimit: 4, imageQuality: 'high' } };
const AUTO = { imageAnalysis: { mode: 'auto', visionLimit: 4, imageQuality: 'high' } };

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });

const ID_OK = '00000000-0000-4000-8000-000000000011';
const ID_FAIL = '00000000-0000-4000-8000-000000000012';
const ID_EMPTY = '00000000-0000-4000-8000-000000000013';
const ID_GONE = '00000000-0000-4000-8000-000000000014';

async function seed() {
  await db.images.clear();
  await putImage(ID_OK, pngBlob(), 'image/png');
  await putImage(ID_FAIL, pngBlob(), 'image/png');
  await putImage(ID_EMPTY, pngBlob(), 'image/png');
}

/**
 * 取出消息里的**纯文本**部分。
 * 注意：送图成功时 content 会变成多模态数组（text + image_url），
 * 直接 `String(content)` 会得到 "[object Object],[object Object]" —— 断言会假失败。
 */
function textOf(messages) {
  return messages.map((m) => {
    const c = m?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (p?.type === 'text' ? p.text : '')).join('');
    return '';
  }).join('\n');
}

const msgOf = (id, md) => (String(md).match(new RegExp(`【图片\\(${id}\\)[^】]*】[\\s\\S]{0,200}`)) || [''])[0];

// ---------------- A. 真实原因必须露出来（复现已跑过：修复前 401 一个字都看不到） ----------------

test('#130 OCR 抛异常：真实错误码必须出现在标注里（修复前被 catch 吞成「未能识别文字」）', async () => {
  await seed();
  const ocrFn = async (id) => {
    if (id === ID_FAIL) throw new Error('云端 OCR 失败 HTTP 401');
    return 'ok';
  };
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: `看图 sxy-img://${ID_FAIL}` }],
    { settings: OCR_ONLY, ocrFn },
  );
  const out = textOf(messages);
  // 断言的是「能自救的人话」而不是原始错误码：翻译成「密钥无效或无权限」比丢一个 401 有用得多
  assert.match(out, /(密钥|权限)/, '真实原因必须带出来——被吞掉的话用户只会反复重传图片');
  assert.ok(!/未能识别文字/.test(out), '不得再退回那句什么都说明不了的旧文案');
});

// ---------------- B. 四态标注 ----------------

test('#130 识别报错：必须带出真实原因，并给出「下一步怎么办」', async () => {
  await seed();
  const ocrFn = async (id) => {
    if (id === ID_FAIL) throw new Error('云端 OCR 失败 HTTP 401');
    return 'ok';
  };
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: `看图 sxy-img://${ID_FAIL}` }],
    { settings: OCR_ONLY, ocrFn },
  );
  const out = textOf(messages);
  assert.match(out, /(密钥|权限)/, '要说人话：HTTP 401 = 密钥/权限问题（比丢一个 401 更有用）');
  assert.match(out, /(先多模态|设置)/, '必须给下一步（ocrFirst 从不送图，得告诉用户去哪改）');
  assert.ok(!/未识别（超出本次/.test(out), '不能被误标成「超出上限」');
});

test('#130 识别成功但图里没字：与「识别失败」是两回事，措辞必须分开', async () => {
  await seed();
  const ocrFn = async () => ''; // 跑通了，但一个字都没识别出来
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: `看图 sxy-img://${ID_EMPTY}` }],
    { settings: OCR_ONLY, ocrFn },
  );
  const out = String(messages[0].content);
  assert.match(out, /(没识别出|未识别到|没有文字)/, '应说明是「没识别出文字」');
  assert.ok(!/(识别失败|识别出错)/.test(out), '没报错就不能说成识别失败（会把用户引去查 OCR 配置）');
  assert.match(out, /(过暗|过糊|没有文字|语言)/, '要给出「图太糊 / 图里没字 / 语言不匹配」这些可能原因');
});

test('#130 用户取消：单独标注「已取消」，不能说成识别失败（重试即可，不用改配置）', async () => {
  await seed();
  const ctrl = new AbortController();
  ctrl.abort();
  const ocrFn = async () => '不该被调用';
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: `看图 sxy-img://${ID_OK}` }],
    { settings: OCR_ONLY, ocrFn, signal: ctrl.signal },
  );
  const out = String(messages[0].content);
  assert.match(out, /取消/, '取消要单独说（用户会直接重试，不需要去改任何配置）');
  assert.ok(!/识别失败/.test(out), '取消不是识别失败');
});

test('#130 图在本机不存在：仍走上一轮修好的「本机图库没有这张图」（不得被本轮改动回退）', async () => {
  await seed();
  const { messages } = await enrichForLlm(
    [{ role: 'user', content: `看图 sxy-img://${ID_GONE}` }],
    { settings: OCR_ONLY, ocrFn: async () => 'x' },
  );
  assert.match(String(messages[0].content), /本机图库里没有这张图/);
});

// ---------------- C. 失败不得写缓存 ----------------

test('#130 失败不写缓存：网络抖一下后，重试这一次就该拿到文字', async () => {
  await seed();
  let n = 0;
  const ocrFn = async () => {
    n += 1;
    if (n === 1) throw new Error('Failed to fetch');
    return '第二次成功了';
  };
  const md = `看图 sxy-img://${ID_OK}`;
  await enrichForLlm([{ role: 'user', content: md }], { settings: OCR_ONLY, ocrFn });
  const again = await enrichForLlm([{ role: 'user', content: md }], { settings: OCR_ONLY, ocrFn });
  assert.equal(n, 2, '失败不该被缓存 → 第二次必须真的再识别一次');
  assert.match(String(again.messages[0].content), /第二次成功了/, '重试就该成功，而不是被旧失败判死');

  // 成功的结果照常缓存：第三次不再调用识别
  const third = await enrichForLlm([{ role: 'user', content: md }], { settings: OCR_ONLY, ocrFn });
  assert.equal(n, 2, '成功结果应被缓存（省下重复识别的开销）');
  assert.match(String(third.messages[0].content), /第二次成功了/);
});

// ---------------- D. auto 兜底：别给不存在的图白送一次 ----------------

test('#130 auto 兜底：识别失败的图改送原图；本机没图的不得再白送一次', async () => {
  await seed();
  const ocrFn = async (id) => {
    if (id === ID_FAIL) throw new Error('云端 OCR 失败 HTTP 500');
    return '';
  };
  const { messages, vision } = await enrichForLlm(
    [{ role: 'user', content: `看图 sxy-img://${ID_FAIL} 和 sxy-img://${ID_GONE}` }],
    { settings: AUTO, ocrFn },
  );
  assert.equal(vision, 1, '识别失败的图应兜底送 1 张给多模态');
  const out = textOf(messages).replace(/\s+/g, ' ');
  assert.match(out, /作为附图发送/, '送成功的要改回「已作为附图发送」');
  assert.match(out, /识别失败/, '兜底时也要把真实原因带出来，别只说「未能识别」');
  assert.match(out, new RegExp(`图片\\(${ID_GONE}\\)[^】]*】`));
  assert.ok(
    /本机图库里没有这张图/.test(msgOf(ID_GONE, out)),
    '本机没图的必须保持「本机图库里没有这张图」，不能因为兜底失败就改写',
  );
});

// ---------------- E. 原因分类（纯函数，逐条可测） ----------------

test('#130 explainOcrFailure：按真实错误给出能自救的分类', () => {
  const cases = [
    [new Error('云端 OCR 失败 HTTP 401'), 'auth'],
    [new Error('云端 OCR 失败 HTTP 403'), 'auth'],
    [new Error('云端 OCR 失败 HTTP 429'), 'cloud'],
    [new Error('云端 OCR 失败 HTTP 500'), 'server'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    [new Error('Failed to fetch'), 'network'],
    [new Error('loadLang failed for chi_sim'), 'assets'],
    [new Error('完全没见过的新错误 xyz'), 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [err, kind] of cases) {
    assert.equal(explainOcrFailure(err).kind, kind, `分类错误：${String(err?.message || err)}`);
  }
  assert.match(explainOcrFailure(new Error('云端 OCR 失败 HTTP 401')).text, /密钥|权限/);
  assert.match(explainOcrFailure(new Error('Failed to fetch')).text, /连不上|网络/);
  assert.match(explainOcrFailure(new Error('loadLang failed')).text, /语言包|引擎/);
  assert.ok(explainOcrFailure(undefined).text.length > 0, '未知原因也要有话可说，不能空');
});
