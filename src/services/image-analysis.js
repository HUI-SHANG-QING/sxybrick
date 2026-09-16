// 图片分析聚合层：OCR 先行 + 视觉兜底（设计：docs/DESIGN-2026-09-15-image-analysis.md）
//
// 背景：AI 链路（对话/Agent/联动/RAG）原本只喂纯文字（retrieval.js chunkText），
// 卡片里的图片（sxy-img:// 占位符）对 AI 完全隐形。本模块在喂 AI 前把图片
// 文字化（OCR）或产出视觉引用（visionRefs，交 llm 侧发图给多模态模型）。
//
// 不变量：
// 1. 原文零污染——OCR 文本只进「分析副本」，不覆盖 doc.content（原文是用户的）；
// 2. 费用护栏——visionFirst 单次最多 3 张图；auto/ocrFirst 的视觉兜底最多 1 张；
// 3. 全链路可降级——OCR 失败不阻塞，最终退化为纯文字 + 明确标注「N 张图未纳入」；
// 4. 零新依赖——只复用 docs-lib（识别）/ images.js（存取）/ word-repo（设置）。
//
// 除卡片图片（sxy-img://）外，本模块还处理**资料库文件**的视觉引用 sxy-doc://<docId>[#<pages>]：
// 工具（agent/tools 的 read_doc）无法直接把图片塞进文本协议的返回值，所以在文本里留一个
// sxy-doc:// 引用，由这里统一渲染成页面图送给多模态——与 sxy-img:// 同构，复用同一套策略与护栏。
//
// settings.imageAnalysis.mode：
//   auto（默认）  = OCR 先行；OCR 不可用/全失败 → 视觉兜底（若允许）→ 纯文字+标注
//   ocrFirst     = 只 OCR，永不主动调视觉（省钱/离线）
//   visionFirst  = 含图内容直接发图给多模态（复用 AI 设置的接口/模型），OCR 仅视觉不可用时兜底

import { timeoutSignal, anySignal } from '../utils/abort.js';
import { getDb } from '../db.js';
import { getWordSettings } from '../word-repo.js';
import { extractImageIds } from '../images.js';
// ocrImageText：真正导出的单图识别入口（云端优先→本地 Tesseract，docs-lib 内部分级），
// 接收 File/Blob，返回清洗后的纯文本字符串；识别不到/失败时抛异常。
import { ocrImageText } from '../docs-lib.js';
import {
  compressImageBlob, resolveImageQuality, IMAGE_QUALITY_KEYS, IMAGE_QUALITY_DEFAULT,
} from '../utils/img-compress.js';
import { docKindOf, docContentProfile, docVisionContent } from './doc-vision.js';

export const IMG_MODES = ['auto', 'ocrFirst', 'visionFirst'];
// 送图额度：单次请求最多附带几张图。
// ⚠️ 一次 API 请求**可以携带多张图**（见 attachVisionToLastUser：content 数组里挂 N 个 image_url），
// 额度限制的是「张数」而不是「请求次数」。
//
// 张数上限放到 1000（用户要求「不要用人为数字卡我」），但**真正的瓶颈是请求体积**，不是张数：
// 每张图压缩后（1568px / JPEG q0.8）data URL 约 200–600KB，1000 张 ≈ 200–600MB ——
// 浏览器构造这么大的字符串会直接崩，上传也必然撞穿 chat() 的 60s 超时。
// 因此这里改用**字节预算**做真实护栏：小图能送很多张，大图自动收敛，永不 OOM。
// 超预算的图会被明确标注原因（而非静默丢弃），用户可减少张数或调低分辨率后重试。
export const VISION_LIMIT_DEFAULT = 3;
export const VISION_LIMIT_MAX = 1000;
// 单次请求图片总字节预算（base64 后的字符串长度）。24MB 是「家用宽带上行 + 60s 超时」下的稳妥值。
export const VISION_BYTES_BUDGET = 24 * 1024 * 1024;
const VISION_LIMIT_FALLBACK = 1; // auto/ocrFirst 的兜底：仅 OCR 全失败时补 1 张，保持保守
// round43 N5：OCR 文字化无总量护栏——多图消息（AI 回显带图上下文 / RAG 拼多张带图卡）
// 会逐张 OCR，每张最长 30s，叠加可拖慢所有 AI 链路数分钟。与 visionLimit 对称加上限；
// 超出的图直接标注「未识别（超出本次上限）」，不进 OCR 循环。
const OCR_TEXT_LIMIT = 8;

// ---- 设置解析 -------------------------------------------------------------

/** 解析当前图片分析模式（缺省 auto；非法值回退 auto，防御脏数据） */
export function parseImageMode(settings) {
  const m = settings?.imageAnalysis?.mode;
  return IMG_MODES.includes(m) ? m : 'auto';
}

/**
 * 模式语义展开。
 * @returns {{ mode, allowVisionFallback: boolean }}
 *   allowVisionFallback：OCR 全失败后是否允许把图交给多模态（auto 允许；ocrFirst 永不；
 *   visionFirst 本身就走视觉，该标志无意义=false）。
 */
export function resolveImagePolicy(settings) {
  const mode = parseImageMode(settings);
  return {
    mode,
    allowVisionFallback: mode === 'auto',
    // 用户配置的单次送图上限。只有「先多模态」把它当主路径额度用；
    // auto / ocrFirst 的视觉兜底仍保守取 1（那只是 OCR 失败后的补救，不该按用户额度放大）。
    visionLimit: normalizeVisionLimit(settings?.imageAnalysis?.visionLimit),
    // 图片质量档位：降低单张体积比放大字节预算更有效（同预算能装 3–4 倍张数，且不增崩溃风险）
    imageQuality: IMAGE_QUALITY_KEYS.includes(settings?.imageAnalysis?.imageQuality)
      ? settings.imageAnalysis.imageQuality
      : IMAGE_QUALITY_DEFAULT,
  };
}

/**
 * 送图额度归一化：非法 / 缺省 → VISION_LIMIT_DEFAULT；夹到 [1, VISION_LIMIT_MAX]。
 * 脏设置（'abc' / 0 / -5 / 1e9）一律兜住，绝不让它传导成「无限张图」把账单打爆。
 * @param {*} raw 设置里的原始值
 * @returns {number}
 */
export function normalizeVisionLimit(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return VISION_LIMIT_DEFAULT;
  return Math.min(n, VISION_LIMIT_MAX);
}

// ---- 图片 → 文本（OCR 先行） ----------------------------------------------

/**
 * 把含 sxy-img:// 占位符的正文「文字化」为 AI 分析副本。
 *
 * @param {string} content 原始正文（含 sxy-img://<id> 占位符）
 * @param {{ signal?: AbortSignal, mode?: string, settings?: object, ocrFn?: (id, blob) => Promise<string> }} [opts]
 *   ocrFn 为识别函数注入点（默认 ocrImageText，测试可打桩）
 * @returns {Promise<{ text: string, visionRefs: string[], ocrDone: number, ocrFailed: number }>}
 *   text：追加了 OCR 文本（或视觉/失败标注）的分析副本；无图时原样返回（零开销）；
 *   visionRefs：需要发图给多模态模型的图片 id（已按费用护栏截断）；
 *   ocrDone/ocrFailed：本次实际识别成功/失败的图片数。
 */
export async function textifyContent(content, opts = {}) {
  if (typeof content !== 'string' || !content) {
    return { text: content || '', visionRefs: [], ocrDone: 0, ocrFailed: 0 };
  }
  const ids = extractImageIds(content);
  if (!ids.length) return { text: content, visionRefs: [], ocrDone: 0, ocrFailed: 0 };

  const settings = opts.settings || (await getWordSettings());
  const policy = resolveImagePolicy(settings);
  const signal = opts.signal;

  // visionFirst：不 OCR，直接产出视觉引用（护栏截断），OCR 留作视觉不可用时的兜底由调用侧决定
  if (policy.mode === 'visionFirst') {
    return {
      text: content,
      visionRefs: ids.slice(0, policy.visionLimit),
      ocrDone: 0,
      ocrFailed: 0,
    };
  }

  // ocrFirst / auto：逐张识别（云端优先 → 本地 Tesseract，defaultRecognize 内部已分级）
  const db = getDb();
  const notes = [];
  let ocrDone = 0;
  let ocrFailed = 0;
  const visionFallback = [];

  for (let i = 0; i < ids.length; i += 1) {
    if (signal?.aborted) { ocrFailed += ids.length - i; break; }
    const id = ids[i];
    const row = await db.images.get(id);
    if (!row) {
      ocrFailed += 1;
      notes.push(`【图片${i + 1}】图片已不存在，未纳入文字分析`);
      continue;
    }
    // ocrImageText 返回清洗后的纯文本；识别不到/失败抛异常（内部已含 30s 超时 + 压缩）。
    // opts.ocrFn 为识别注入点（测试可打桩，避免真实 tesseract 依赖）
    let text;
    try {
      if (opts.ocrFn) {
        text = (await opts.ocrFn(id, row.blob)) || '';
      } else {
        // round82：统一到 utils/abort.js —— 原写法在新浏览器有效、旧浏览器静默退成"无超时"，
        // 语义随浏览器漂移。改用兼容版后两端一致（超时真的会生效）。
        const s = anySignal([signal, timeoutSignal(30000)]);
        text = await ocrImageText(row.blob, { signal: s });
      }
    } catch {
      text = ''; // 识别失败：留空，由下方 visionRefs 兜底或标注「未能识别」
    }
    if (text && text.trim()) {
      ocrDone += 1;
      notes.push(`【图片${i + 1} OCR 识别】\n${text.trim()}`);
    } else {
      ocrFailed += 1;
      if (policy.allowVisionFallback) visionFallback.push(id);
      notes.push(`【图片${i + 1}】未能识别文字，未纳入文字分析`);
    }
  }

  // auto：OCR 全失败（或部分失败）且允许视觉兜底 → 把失败的图交视觉（护栏：最多 1 张）
  const visionRefs = policy.allowVisionFallback
    ? visionFallback.slice(0, VISION_LIMIT_FALLBACK)
    : [];

  const text = ocrDone || ocrFailed
    ? `${content}\n\n--- 以下为 AI 分析用图片文字化内容（非用户原文）---\n${notes.join('\n\n')}`
    : content;
  return { text, visionRefs, ocrDone, ocrFailed };
}

// ---- 数据资产统计 + 策略推荐 ----------------------------------------------

/**
 * 统计系统内图片资产（纯读，毫秒级——量级 ≤ 几万行）。
 * @returns {Promise<{ imgRefs, imgUnique, imgDocs, docs, bySource: object }>}
 *   imgRefs：正文里图片占位符总数；imgUnique：去重后的图片 id 数；
 *   imgDocs/docs：含图文档数 / 总文档数（cards+notes+memos+docFiles）。
 */
export async function statImageAssets() {
  const db = getDb();
  let imgRefs = 0;
  let imgDocs = 0;
  const all = new Set();
  const bySource = {};

  const scan = (source, rows) => {
    let n = 0;
    for (const r of rows) {
      // ⚠️ 必须是「拼接所有正文字段」，不能用 `front || back || content`：
      // 卡片正面几乎总有文字，用短路或会让 back 永远不被扫描 ——
      // 而错题卡的图恰恰常放在背面（实测：多张背面带图的卡被整批漏统计）。
      const text = [r.front, r.back, r.content]
        .filter((x) => typeof x === 'string' && x).join('\n');
      const ids = text ? extractImageIds(text) : [];
      if (ids.length) {
        imgDocs += 1;
        n += 1;
        for (const id of ids) { imgRefs += 1; all.add(id); }
      }
    }
    if (n) bySource[source] = n;
  };

  // 一次取快照、多处复用：此前 cards/notes/memos 各查两遍、docFiles 查三遍
  // （scan 一遍 + 视觉型统计一遍 + docs 总数一遍），几千张卡时设置页「智能推荐」明显卡顿。
  const cardRows = (await db.cards.toArray()).filter((c) => c.front || c.back);
  const noteRows = await db.notes.toArray();
  const memoRows = await db.memos.toArray();
  const docRows = db.docFiles ? await db.docFiles.toArray() : [];

  scan('cards', cardRows);
  scan('notes', noteRows);
  scan('memos', memoRows);
  scan('docFiles', docRows);

  // 资料库的「视觉型文件」单独统计：pdf/图片文件不走 sxy-img:// 占位符，
  // 上面那轮 scan 一定漏掉它们——而扫描件/图表资料恰恰是最需要视觉分析的部分。
  let docVisual = 0;
  let docVisionPages = 0;
  try {
    for (const f of docRows) {
      const kind = docKindOf(f);
      if (kind === 'image') { docVisual += 1; docVisionPages += 1; }
      else if (kind === 'pdf') { docVisual += 1; docVisionPages += Math.max(1, Number(f.pageCount) || 1); }
    }
  } catch { /* 统计失败不影响主流程 */ }

  // 孤儿校验：占位符指向但 db.images 里没有的（不计入 imgUnique）。
  // 用一次 bulkGet 代替逐个 get——图片多时前者是一次事务，后者是 N 次往返。
  const refIds = [...all];
  const refRows = refIds.length ? await db.images.bulkGet(refIds) : [];
  const danglingIds = refIds.filter((_, i) => !refRows[i]);
  const live = refIds.length - danglingIds.length;

  const docs = cardRows.length + noteRows.length + memoRows.length + docRows.length;

  // imgDangling = 正文引用了、但库里已经找不到的图片数。
  // 这是「AI 说图片读取失败」的直接原因，必须暴露出来 —— 只报 imgUnique 会让用户看到
  // 「你只有 1 张图片」而正文里明明有十几处引用，完全无从判断是统计口径问题还是图真的丢了。
  return {
    imgRefs, imgUnique: live, imgDangling: danglingIds.length, danglingIds,
    imgDocs, docs, bySource, docVisual, docVisionPages,
  };
}

/**
 * 基于数据统计的策略推荐（保守、可解释；规则见设计文档第 2 节）。
 * @param {{ imgRefs, imgUnique, imgDocs, docs, docVisual?, docVisionPages? }} stats
 * @returns {{ mode: string, reason: string }}
 */
export function recommendMode(stats) {
  const { imgRefs = 0, imgDocs = 0, docs = 0, docVisual = 0, docVisionPages = 0 } = stats || {};
  if (!imgRefs && !docVisual) {
    return { mode: 'auto', reason: '当前数据里没有图片、也没有 PDF/图片型资料，任意策略效果相同（auto 已含兜底）' };
  }
  // 资料库里有 PDF/图片文件 → 这是「无文字层」的重灾区，视觉几乎是唯一解
  if (docVisual > 0) {
    return {
      mode: 'visionFirst',
      reason: `资料库有 ${docVisual} 份 PDF/图片型文件（约 ${docVisionPages} 页）——这类文件没有可提取的文字层（扫描件/图表），`
        + '只做 OCR 往往只能拿到零散标题，建议「先多模态」直接看图；代价是按张计费、需 AI 接口支持视觉模型（单次最多送 3 页）',
    };
  }
  const imgRatio = docs > 0 ? imgDocs / docs : 0;
  if (imgRatio > 0.5) {
    return {
      mode: 'visionFirst',
      reason: `过半文档（${imgDocs}/${docs}）核心是图片——直接看原图分析最准；代价是按张计费、需配置支持视觉的 AI 模型`,
    };
  }
  return {
    mode: 'ocrFirst',
    reason: `共 ${imgRefs} 张图片，多数文档以文字为主——先用 OCR 把图转文字再分析，免费/离线即可，个别图识别失败时 auto 模式还会自动切视觉兜底`,
  };
}

/**
 * 供设置页一行调用：统计 + 推荐（返回带 stats 的完整对象）。
 */
export async function recommendForCurrentData() {
  const stats = await statImageAssets();
  const rec = recommendMode(stats);
  return { ...rec, stats };
}

// ---- 视觉引用 → 多模态 content（供 agent 侧拼装 messages） -----------------

/**
 * 把图片 id 转成 OpenAI 视觉 content 数组（data URL，长边压缩到 ≤1568px、JPEG q0.8）。
 * @param {string[]} ids
 * @returns {Promise<Array<{type:'image_url',image_url:{url:string}}>>}（转换失败的 id 跳过）
 */
export async function imageIdsToVisionContent(ids) {
  return (await imageIdsToVisionContentMapped(ids)).map((x) => x.part);
}

/**
 * 同 imageIdsToVisionContent，但保留 id 映射 → [{ id, part }]。
 * 为什么需要：本函数会**跳过**「图片行不存在 / 压缩失败」的 id，只按返回数量去推「哪些图
 * 发出去了」会张冠李戴（曾把「图 A 已发送」的标注贴到实际发送的图 B 上，2026-09-14 审计发现）。
 * 调用方要写「已作为附图发送」这类标注时，必须用本函数拿精确 id。
 * @param {string[]} ids
 * @returns {Promise<Array<{id:string, part:{type:'image_url',image_url:{url:string}}}>>}
 */
export async function imageIdsToVisionContentMapped(ids, opts = {}) {
  if (!ids?.length) return [];
  let db;
  try {
    db = getDb();
  } catch {
    return []; // 无 IndexedDB 环境（如 SSR/测试）→ 无视觉内容，调用方自动降级
  }
  const onSkip = typeof opts.onSkip === 'function' ? opts.onSkip : null;
  const budget = Number.isFinite(opts.bytesBudget) ? opts.bytesBudget : VISION_BYTES_BUDGET;
  const out = [];
  let bytes = 0;
  let exhausted = false; // 超预算后不再读盘/压缩（否则白白跑几十次 canvas + base64）
  for (const id of ids) {
    if (exhausted) { onSkip?.(id, 'budget'); continue; }
    const row = await db.images.get(id);
    if (!row) { onSkip?.(id, 'missing'); continue; }
    // 质量档位决定单张体积（越省，同样的字节预算能装越多张）
    const dataUrl = await compressImageBlob(row.blob, { maxEdge: opts.maxEdge, quality: opts.quality });
    if (!dataUrl) { onSkip?.(id, 'unreadable'); continue; }
    // 字节预算：请求体积是硬约束（张数上限只是名义值，1000 张大图 = 数百 MB，物理上发不出去）
    if (bytes + dataUrl.length > budget) { exhausted = true; onSkip?.(id, 'budget'); continue; }
    bytes += dataUrl.length;
    out.push({ id, part: { type: 'image_url', image_url: { url: dataUrl } } });
  }
  return out;
}

// canvas 压缩 / dataURL 转换已下沉到 utils/img-compress.js——
// doc-vision.js（资料库文件 → 多模态）同样需要，若两边各自 import 对方就成静态环（dep:check 拦）。
// 这里 re-export 保持既有引用面（image-analysis.compressImageBlob）不变。
export { compressImageBlob, blobToDataUrlRaw } from '../utils/img-compress.js';

// ---- LLM 消息富集（AI 链路的唯一接线点） ----------------------------------

// 会话内 OCR 缓存：同一图片不重复识别（反复对话时 context 带同一批图占位符，命中即复用）。
// 已下沉到 utils/ocr-cache.js：带 LRU 上限（防长会话内存无界增长）与版本签名校验
// （图片行的 updatedAt 变了即视为失效 —— 避免拿着旧图的 OCR 结果回答新图的内容）。
import { getOcr, setOcr } from '../utils/ocr-cache.js';

// ---- 资料页视觉引用协议：sxy-doc://<docId>[#<pages>] --------------------------
// 为什么需要：Agent 的 ReAct 工具调用走「文本协议」返回（tool 消息是字符串），
// 无法直接把图片塞进返回值。于是规定工具在文本里留一个 sxy-doc:// 引用，
// 由本模块在 chat() 出口统一渲染成页面图交给多模态 —— 与 sxy-img:// 完全同构。
// pages 形如 "1,3-5"；缺省 = 前 N 页（N 由调用方的送图额度决定，硬上限 DOC_VISION_MAX）。
// 注意：这里返回**新建**的正则（不导出共享实例）——带 g 的正则对象在 matchAll/replace
// 之间共用会有 lastIndex 状态隐患，每个调用点各自持有一个最省心。
export function docRefRe() {
  return new RegExp('sxy-doc:\\/\\/([A-Za-z0-9_-]{6,})(?:#([0-9,\\-]+))?', 'g');
}

/** 解析 "#1,3-5" → [1,3,4,5]（非法片段忽略，上限由调用方按护栏截断） */
export function parsePageSpec(spec) {
  const out = new Set();
  for (const part of String(spec || '').split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      if (a >= 1 && b >= a && b - a <= 50) for (let i = a; i <= b; i += 1) out.add(i);
      continue;
    }
    if (/^\d+$/.test(seg)) { const n = Number(seg); if (n >= 1) out.add(n); }
  }
  return [...out].sort((a, b) => a - b);
}

/** 从文本里收集资料引用：docId → 页码数组（空数组 = 未指定，取默认前 N 页） */
export function extractDocRefs(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(docRefRe())) {
    const id = m[1];
    const pages = parsePageSpec(m[2]);
    if (!out.has(id)) out.set(id, []);
    if (pages.length) out.set(id, [...new Set([...out.get(id), ...pages])].sort((a, b) => a - b));
  }
  return out;
}

/**
 * 把喂给 LLM 的 messages 里的图片占位符富集为可分析内容——所有 AI 链路
 * （对话/Agent/卡片联动/子任务）的必经入口，一处覆盖全部。
 *
 * 策略（复用 resolveImagePolicy）：
 *  - visionFirst：含图则把前 3 张压缩图挂到最后一条 user message（多模态），不 OCR；
 *  - ocrFirst/auto：把每张图 OCR 成文字、替换占位符（带缓存）；
 *  - auto 额外：OCR 失败的图自动挂 1 张给视觉兜底（若多模态可用）。
 * 纯文字消息（无占位符）零开销原样返回。OCR 全失败也不阻塞——降级纯文字+标注。
 *
 * @param {Array<{role, content}>} messages OpenAI 格式消息（content 当前为字符串）
 * @param {{ settings?: object, ocrFn?: (id, blob) => Promise<string> }} [opts]
 *   settings 可传入以避免额外 DB 往返；ocrFn 为识别函数注入点（默认 ocrImageText，测试可打桩）
 * @returns {Promise<{ messages: Array, vision: number }>}
 *   messages：富集后的新数组（末条 user content 可能变为多模态数组）；
 *   vision：本次发给视觉模型的图片数（供记账/展示）。
 */
/**
 * 把 OCR 抛出的错误翻成「人能看懂 + 能自救」的一句话（round88）。
 *
 * 为什么必须有它：OCR 循环里原先是 `catch { text = '' }` —— 云端密钥失效 / 端点写错 /
 * 本地语言包下载失败 / 单张超时 / 用户取消，全部被压成同一句「未能识别文字，未纳入分析」。
 * 用户拿到这句话无法行动：明明是密钥过期，他却在反复重传图片、反复重试同一件错事。
 * 与 base.js 的 explainLlmFailure 是同一套思路（那个也是把「网络或服务异常」改细的）。
 *
 * @param {*} e OCR 抛出的错误（可能根本不是 Error）
 * @returns {{kind:string, text:string}} kind 供程序分支；text 是写给用户/模型看的原因
 */
export function explainOcrFailure(e) {
  const msg = String(e?.message || e || '');
  if (e?.name === 'AbortError' || /\baborted\b|已取消/i.test(msg)) {
    return { kind: 'timeout', text: '单张识别超时（30 秒）或被取消' };
  }
  const m = msg.match(/云端 OCR 失败 HTTP (\d{3})/);
  if (m) {
    const s = Number(m[1]);
    if (s === 401 || s === 403) return { kind: 'auth', text: '云端 OCR 的密钥无效或无权限' };
    if (s === 404) return { kind: 'cloud', text: '云端 OCR 的端点地址不对（HTTP 404）' };
    if (s === 429) return { kind: 'cloud', text: '云端 OCR 被限流（HTTP 429）' };
    if (s >= 500) return { kind: 'server', text: '云端 OCR 服务端出错（5xx）' };
    return { kind: 'cloud', text: `云端 OCR 被拒绝（HTTP ${s}）` };
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED|ENOTFOUND|网络/i.test(msg)) {
    return { kind: 'network', text: '云端 OCR 连不上（网络不可达，或端点地址写错）' };
  }
  if (/lang|traineddata|tesseract|wasm|worker/i.test(msg)) {
    return { kind: 'assets', text: '本地识别引擎或语言包加载失败（离线环境常缺语言包）' };
  }
  if (!msg) return { kind: 'unknown', text: '识别出错（未给出具体原因）' };
  return { kind: 'unknown', text: `识别出错（${msg.slice(0, 120)}）` };
}
export async function enrichForLlm(messages, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) return { messages, vision: 0 };

  // 收集两类引用：卡片/笔记正文图片（sxy-img://）与资料库文件页（sxy-doc://）
  const allIds = new Set();
  const docRefs = new Map();
  for (const m of messages) {
    if (typeof m?.content !== 'string') continue;
    for (const id of extractImageIds(m.content)) allIds.add(id);
    for (const [id, pages] of extractDocRefs(m.content)) {
      const prev = docRefs.get(id) || [];
      docRefs.set(id, [...new Set([...prev, ...pages])].sort((a, b) => a - b));
    }
  }
  if (!allIds.size && !docRefs.size) return { messages, vision: 0 };

  const settings = opts.settings || (await getWordSettings());
  const policy = resolveImagePolicy(settings);
  const ids = [...allIds];
  // 总视觉额度：visionFirst 3 张；auto 兜底 1 张；ocrFirst 0（永不主动调视觉）
  // 主路径（先多模态）按用户配置的额度送图；auto 的视觉兜底仍保守取 1；ocrFirst 不送
  const visionLimit = policy.mode === 'visionFirst'
    ? policy.visionLimit
    : (policy.allowVisionFallback ? Math.min(VISION_LIMIT_FALLBACK, policy.visionLimit) : 0);

  const textMap = new Map(); // 精确 token（sxy-img://id）→ 替换文本
  const docTextMap = new Map(); // docId → 替换文本（按正则整体替换，兼容 #pages 变体）
  const vision = [];

  // ---------- 卡片图片 ----------
  if (policy.mode === 'visionFirst' && ids.length) {
    const picked = ids.slice(0, visionLimit);
    // 收集「额度内却被跳过」的原因，用于给出准确标注（预算超限 vs 图读不出来）
    const skipReason = new Map();
    const mapped = await imageIdsToVisionContentMapped(picked, {
      onSkip: (id, reason) => skipReason.set(id, reason),
      bytesBudget: opts.bytesBudget, // 高级调用方/测试可覆盖；缺省走 VISION_BYTES_BUDGET
      ...resolveImageQuality(policy.imageQuality), // 质量档位 → 单张体积（同预算装更多张）
    });
    for (const x of mapped) vision.push(x.part);
    // 精确「哪些 id 真的送出去了」——不能用 picked.slice(0, v.length) 推（中间项可能被跳过）
    const sent = new Set(mapped.map((x) => x.id));
    const budgetMB = Math.round(VISION_BYTES_BUDGET / 1024 / 1024);
    ids.forEach((id, i) => {
      let note;
      if (sent.has(id)) {
        note = `【图片${i + 1}：已作为附图发送，请直接看图分析】`;
      } else if (i >= picked.length) {
        // 压根没进「本批要送的名单」→ 这才是真的超额度
        note = `【图片${i + 1}：超出本次送图额度（最多 ${visionLimit} 张），如需分析请单独提问】`;
      } else if (skipReason.get(id) === 'budget') {
        // 额度内、但请求体积已到顶 —— 与「图片坏了」是两回事，必须分开说
        note = `【图片${i + 1}：已达单次请求体积上限（约 ${budgetMB}MB），本次未发送；减少图片数量后可重试】`;
      } else {
        // 额度内、体积也没超，却没送出去 —— 这里再分两种「图读不出来」的原因。
        // 为什么必须分开（round88 审计，用户反馈「还是看不到图片」）：
        //   · missing    = **本机图库根本没有这一行**（跨设备未同步 / 从备份导入时漏带图库 / 原图已删）；
        //   · unreadable = 行在，但本机解码压缩失败（blob 损坏）。
        // 两者用户要做的事完全不同（去同步一次 vs 重新上传这张图），旧实现合并成一句
        // 「图片可能已被删除或无法解析」，既漏掉了最常见的原因（未同步），又让用户反复徒劳重试。
        note = skipReason.get(id) === 'missing'
          ? `【图片${i + 1}：本机图库里没有这张图（多因尚未同步到本设备，或原图已被删除）；`
            + '请在其他设备上同步一次，或重新上传该图】'
          : `【图片${i + 1}：图片存在但无法解析（数据可能已损坏），建议重新上传该图】`;
      }
      textMap.set(`sxy-img://${id}`, note);
    });
  } else if (ids.length) {
    // ocrFirst / auto：OCR 文字化（会话内缓存，反复对话不重复识别）
    // round43 N5：超出 OCR_TEXT_LIMIT 的图不进循环（标注「未识别」），防多图消息拖垮 AI 链路
    const ocrIds = ids.slice(0, OCR_TEXT_LIMIT);
    const skippedOcr = ids.slice(OCR_TEXT_LIMIT);
    const db = getDb();
    // round48：接收外部取消信号——用户点"取消"后不再继续逐张 OCR（此前完全不可中断）
    const ocrSignal = opts.signal;
    const ocrText = {};
    // 本机图库里**没有这一行**的图（与「图在但 OCR 没认出来」严格区分：前者要做的是同步/重传，
    // 后者才是识别问题。旧实现两者都写「未能识别文字」，把用户引向 OCR 设置，方向完全错了。
    const missingOcr = new Set();
    const canceledOcr = new Set();  // 信号已中止 → 压根没跑识别（与「识别失败」不同：重试即可）
    const ocrError = new Map();     // id → 识别失败的原因（人话，来自 explainOcrFailure）
    for (const id of ocrIds) {
      // 旧实现这里直接 break，剩余图就没有标注、会被归到「未能识别」；
      // 改成逐张标「已取消」——用户取消后重试即可，不需要去改任何配置。
      if (ocrSignal?.aborted) { canceledOcr.add(id); continue; }
      const row = await db.images.get(id);
      if (!row) missingOcr.add(id);
      // 缓存命中要求「图片行存在且未变更」：updatedAt 是图片被替换时必然推进的字段，
      // 拿它当版本签名，图片换了内容后旧识别结果自动作废（不需要在每个删除点挂钩子）。
      // row 缺失（图已删）时不复用缓存——否则会拿着已删图片的旧文字继续回答。
      const sig = row?.updatedAt ?? null;
      const cached = row ? getOcr(id, sig) : null;
      if (cached !== null) { ocrText[id] = cached; continue; }
      let text = '';
      if (row) {
        try {
          if (opts.ocrFn) {
            text = (await opts.ocrFn(id, row.blob)) || '';
          } else {
            // round82：统一到 utils/abort.js（原写法依赖可选调用 + 手写 any 判断，
            // 新旧浏览器语义不一致；兼容版让「每张 30s 上限」在旧 Safari 上也真的生效）
            const ocrAbort = anySignal([ocrSignal, timeoutSignal(30000)]);
            text = (await ocrImageText(row.blob, { signal: ocrAbort })) || '';
          }
        } catch (e) {
          text = '';
          // round88：不再静默留空。把真实原因留下来，下面的标注才能说清「该去改哪里」
          // （密钥失效 / 端点写错 / 语言包缺失 / 超时，四件事的做法完全不同）。
          ocrError.set(id, explainOcrFailure(e).text);
        }
      }
      // round88：失败与取消**绝不写缓存**。旧实现连失败也 setOcr —— 网络抖一下，
      // 这张图在整个会话里就永久「未能识别」，用户重试多少次都拿不到结果。
      // 「跑通了但没识别出文字」是稳定结果，照常缓存（省下重复识别的开销）。
      if (row && !ocrError.has(id)) setOcr(id, text, sig);
      ocrText[id] = text;
    }
    // 下一步指引：ocrFirst 从不发送原图，必须明确告诉用户去哪里改；
    // auto 已有视觉兜底，指引偏向「检查 OCR 配置 / 直接改先多模态」。
    const ocrNextStep = policy.mode === 'ocrFirst'
      ? '当前「图片分析策略」是「先 OCR」（该模式从不发送原图）；若想让 AI 直接看图，请到「设置 → 图片分析策略」改为「先多模态」。'
      : '可到「设置 → OCR」检查云端端点 / 密钥与识别语言，或把「图片分析策略」改为「先多模态」让 AI 直接看图。';
    ids.forEach((id) => {
      const ocr = ocrText[id];
      const failWhy = ocrError.get(id);
      if (ocr && ocr.trim()) {
        textMap.set(`sxy-img://${id}`, `【图片(${id}) 内文字（OCR）】\n${ocr.trim()}`);
        return;
      }
      if (missingOcr.has(id)) {
        // 行都不存在 → 与「OCR 没认出来」完全是两回事，分开说
        textMap.set(`sxy-img://${id}`, `【图片(${id})：本机图库里没有这张图（多因尚未同步到本设备，或原图已被删除），`
          + '无法识别；请在其他设备上同步一次，或重新上传该图】');
        return;
      }
      if (canceledOcr.has(id)) {
        textMap.set(`sxy-img://${id}`, `【图片(${id})：本次识别已取消（用户中止），未纳入分析；重新提问即可再试，不需要改任何设置】`);
        return;
      }
      if (failWhy) {
        textMap.set(`sxy-img://${id}`, `【图片(${id})：OCR 识别失败（${failWhy}），未纳入分析。${ocrNextStep}】`);
        return;
      }
      // 跑通了但一个字都没识别出来 —— 与「识别报错」是两回事，别把用户引去查 OCR 配置
      textMap.set(`sxy-img://${id}`, `【图片(${id})：OCR 没有识别出文字（图可能过暗 / 过糊，或图里本来就没有文字，`
        + `也可能是识别语言不匹配），未纳入分析。${ocrNextStep}】`);
    });
    // round43 N5：被总量上限挡掉的图单独标注（区别于「识别失败」），且不进 auto 视觉兜底——
    // 否则 OCR 护栏形同虚设（超限图全部转嫁到多模态发送）。
    for (const id of skippedOcr) {
      textMap.set(`sxy-img://${id}`, `【图片(${id})】未识别（超出本次 OCR 上限 ${OCR_TEXT_LIMIT} 张），如需分析请单独提问`);
    }
    // auto 兜底：OCR 失败的图挂 1 张给多模态（并把标注改回「已送图」；仅限真的进过 OCR 循环的图）
    if (policy.allowVisionFallback && vision.length < visionLimit) {
      const failed = ocrIds.filter((id) => {
        // 图都没了 / 已取消 → 送也送不出去，别再白读一次库（旧实现会把它们一起塞进尝试列表）
        if (missingOcr.has(id) || canceledOcr.has(id)) return false;
        return !ocrText[id] || !ocrText[id].trim();
      });
      const room = visionLimit - vision.length;
      const mapped = await imageIdsToVisionContentMapped(failed.slice(0, room));
      for (const x of mapped) vision.push(x.part);
      // 逐 id 标注：送成功的写「已发送」，被跳过的（图没了/压缩失败）保持原「未能识别」标注
      for (const { id } of mapped) {
        const why = ocrError.get(id);
        textMap.set(`sxy-img://${id}`, why
          ? `【图片(${id})：OCR 识别失败（${why}），已改为把原图作为附图发送给多模态模型】`
          : `【图片(${id})：OCR 未能识别，已作为附图发送给多模态模型】`);
      }
    }
  }

  // ---------- 资料库文件页 ----------
  if (docRefs.size) {
    const db = getDb();
    for (const [docId, pages] of docRefs) {
      const file = await db.docFiles?.get(docId);
      if (!file) { docTextMap.set(docId, '【资料引用失效：找不到该资料】'); continue; }
      const name = String(file.name || docId);
      const profile = await docContentProfile(docId);
      const text = String((await db.docTexts?.get(docId))?.text || '').trim();

      // ① 有可用文字层（且不像扫描件）→ 直接给文字，最省最准
      if (text && !profile.suspectedScan) {
        docTextMap.set(docId, `【资料《${name}》文字摘录（共 ${profile.pageCount || '?'} 页）】\n${text.slice(0, 2000)}`);
        continue;
      }
      // ② 无文字层 / 疑似扫描件 → 渲染页面图送多模态（ocrFirst 明确不送）
      const room = visionLimit - vision.length;
      const wantVision = policy.mode !== 'ocrFirst' && profile.canVision && room > 0;
      if (wantVision) {
        const v = await docVisionContent(docId, {
          maxPages: Math.min(policy.visionLimit, room),
          pages: pages.length ? pages : undefined,
          renderPdfPagesFn: opts.renderDocPagesFn, // 测试注入点
          ...resolveImageQuality(policy.imageQuality), // 资料页渲染同样按质量档位产出
        });
        if (v.length) {
          for (const item of v) vision.push(item);
          const shown = pages.length ? pages.slice(0, v.length).join(', ') : `1-${v.length}`;
          docTextMap.set(docId, `【资料《${name}》第 ${shown} 页：该文件没有可提取的文字层（扫描件/图表），`
            + '已作为附图发送，请直接看图分析（公式、图表数值、版式都在图里）】');
          continue;
        }
      }
      // ③ 兜底：明确说清原因与下一步，绝不让模型以为「资料是空的」
      const why = policy.mode === 'ocrFirst'
        ? '当前「图片分析策略」为「先 OCR」，未送图；如需分析图表请改为「先多模态」'
        : (!profile.canVision
          ? '原始文件不在本机（或无法渲染），无法送图'
          : `本次送图额度已用完（单次最多 ${visionLimit} 张），可单独提问该资料`);
      docTextMap.set(docId, `【资料《${name}》：无文字层（扫描件/图表），${why}】`);
    }
  }

  // ---------- 统一替换占位符 + 挂载视觉内容 ----------
  const replaced = messages.map((m) => {
    if (typeof m.content !== 'string') return m;
    let text = m.content;
    for (const [token, block] of textMap) text = text.split(token).join(block);
    if (docTextMap.size) {
      text = text.replace(docRefRe(), (whole, id) => docTextMap.get(id) ?? whole);
    }
    return { ...m, content: text };
  });

  const finalMsgs = vision.length ? attachVisionToLastUser(replaced, vision) : replaced;
  return { messages: finalMsgs, vision: vision.length };
}

/** 把视觉 content 挂到最后一条 user message（text 在前、图片在后）；无 user 则挂最后一条 */
function attachVisionToLastUser(messages, vision) {
  if (!vision.length) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { idx = i; break; }
  }
  if (idx === -1) idx = messages.length - 1;
  const m = messages[idx];
  const text = typeof m.content === 'string'
    ? m.content
    : ((Array.isArray(m.content) ? m.content : []).map((p) => (p?.type === 'text' ? p.text : '')).join('') || '');
  const next = messages.slice();
  next[idx] = { ...m, content: [{ type: 'text', text }, ...vision] };
  return next;
}
