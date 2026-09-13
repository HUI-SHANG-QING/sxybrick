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
// settings.imageAnalysis.mode：
//   auto（默认）  = OCR 先行；OCR 不可用/全失败 → 视觉兜底（若允许）→ 纯文字+标注
//   ocrFirst     = 只 OCR，永不主动调视觉（省钱/离线）
//   visionFirst  = 含图内容直接发图给多模态（复用 AI 设置的接口/模型），OCR 仅视觉不可用时兜底

import { getDb } from '../db.js';
import { getWordSettings } from '../word-repo.js';
import { extractImageIds } from '../images.js';
// ocrImageText：真正导出的单图识别入口（云端优先→本地 Tesseract，docs-lib 内部分级），
// 接收 File/Blob，返回清洗后的纯文本字符串；识别不到/失败时抛异常。
import { ocrImageText } from '../docs-lib.js';
import { compressImageBlob } from '../utils/img-compress.js';

export const IMG_MODES = ['auto', 'ocrFirst', 'visionFirst'];
// 费用护栏：单次分析最多发给视觉模型的图片数
const VISION_LIMIT_FIRST = 3; // visionFirst 模式
const VISION_LIMIT_FALLBACK = 1; // auto/ocrFirst 的兜底

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
  return { mode, allowVisionFallback: mode === 'auto' };
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
      visionRefs: ids.slice(0, VISION_LIMIT_FIRST),
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
        const t = AbortSignal.timeout?.(30000);
        const s = signal && t && AbortSignal.any ? AbortSignal.any([signal, t]) : (t || signal);
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
      const text = r.front || r.back || r.content || '';
      const ids = typeof text === 'string' ? extractImageIds(text) : [];
      if (ids.length) {
        imgDocs += 1;
        n += 1;
        for (const id of ids) { imgRefs += 1; all.add(id); }
      }
    }
    if (n) bySource[source] = n;
  };

  scan('cards', (await db.cards.toArray()).filter((c) => c.front || c.back));
  scan('notes', await db.notes.toArray());
  scan('memos', await db.memos.toArray());
  if (db.docFiles) scan('docFiles', await db.docFiles.toArray());

  // 资料库的「视觉型文件」单独统计：pdf/图片文件不走 sxy-img:// 占位符，
  // 上面那轮 scan 一定漏掉它们——而扫描件/图表资料恰恰是最需要视觉分析的部分。
  // 动态 import doc-vision 避免与它形成静态环（doc-vision → utils/img-compress 单向）。
  let docVisual = 0;
  let docVisionPages = 0;
  try {
    const { docKindOf } = await import('./doc-vision.js');
    for (const f of db.docFiles ? await db.docFiles.toArray() : []) {
      const kind = docKindOf(f);
      if (kind === 'image') { docVisual += 1; docVisionPages += 1; }
      else if (kind === 'pdf') { docVisual += 1; docVisionPages += Math.max(1, Number(f.pageCount) || 1); }
    }
  } catch { /* 统计失败不影响主流程 */ }

  // 孤儿校验：占位符指向但 db.images 里没有的（不计入 imgUnique）
  let live = 0;
  for (const id of all) {
    const row = await db.images.get(id);
    if (row) live += 1;
  }

  const docs = (await db.cards.toArray()).filter((c) => c.front || c.back).length
    + (await db.notes.toArray()).length
    + (await db.memos.toArray()).length
    + (db.docFiles ? (await db.docFiles.toArray()).length : 0);

  return { imgRefs, imgUnique: live, imgDocs, docs, bySource, docVisual, docVisionPages };
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
  if (!ids?.length) return [];
  let db;
  try {
    db = getDb();
  } catch {
    return []; // 无 IndexedDB 环境（如 SSR/测试）→ 无视觉内容，调用方自动降级
  }
  const out = [];
  for (const id of ids) {
    const row = await db.images.get(id);
    if (!row) continue;
    const dataUrl = await compressImageBlob(row.blob);
    if (dataUrl) out.push({ type: 'image_url', image_url: { url: dataUrl } });
  }
  return out;
}

// canvas 压缩 / dataURL 转换已下沉到 utils/img-compress.js——
// doc-vision.js（资料库文件 → 多模态）同样需要，若两边各自 import 对方就成静态环（dep:check 拦）。
// 这里 re-export 保持既有引用面（image-analysis.compressImageBlob）不变。
export { compressImageBlob, blobToDataUrlRaw } from '../utils/img-compress.js';

// ---- LLM 消息富集（AI 链路的唯一接线点） ----------------------------------

// 会话内 OCR 缓存：同一图片不重复识别（反复对话时 context 带同一批图占位符，命中即复用）
const ocrCache = new Map();

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
export async function enrichForLlm(messages, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) return { messages, vision: 0 };

  // 收集所有 string content 里的图片占位（去重）
  const allIds = new Set();
  for (const m of messages) {
    if (typeof m?.content === 'string') {
      for (const id of extractImageIds(m.content)) allIds.add(id);
    }
  }
  if (!allIds.size) return { messages, vision: 0 };

  const settings = opts.settings || (await getWordSettings());
  const policy = resolveImagePolicy(settings);
  const ids = [...allIds];

  // ① visionFirst：直接发图（护栏截断 3 张），不 OCR
  if (policy.mode === 'visionFirst') {
    const picked = ids.slice(0, VISION_LIMIT_FIRST);
    const vision = await imageIdsToVisionContent(picked);
    if (!vision.length) return { messages, vision: 0 };
    // 关键：送图的图要在正文里留「已作为附图发送」的标注，超出单次上限的图要显式说明未发送。
    // 否则模型只看到一串 sxy-img://xxx 占位符，会误以为「只有标题、看不到内容」——
    // 这正是用户反馈的「白搞」场景（护栏截断后尤其明显）。
    const sent = new Set(picked.slice(0, vision.length)); // 转换失败的按未发送处理
    const marked = messages.map((m) => {
      if (typeof m.content !== 'string') return m;
      let text = m.content;
      let n = 0;
      for (const id of ids) {
        n += 1;
        const block = sent.has(id)
          ? `【图片${n}：已作为附图发送，请直接看图分析】`
          : `【图片${n}：未随本次发送（单次最多 ${VISION_LIMIT_FIRST} 张），如需分析请单独提问】`;
        text = text.split(`sxy-img://${id}`).join(block);
      }
      return { ...m, content: text };
    });
    return { messages: attachVisionToLastUser(marked, vision), vision: vision.length };
  }

  // ② ocrFirst / auto：OCR 文字化（带缓存）。ocrFn 为识别注入点（默认 ocrImageText）。
  const db = getDb();
  const ocrText = {};
  for (const id of ids) {
    if (ocrCache.has(id)) { ocrText[id] = ocrCache.get(id); continue; }
    let text = '';
    const row = await db.images.get(id);
    if (row) {
      try {
        if (opts.ocrFn) {
          text = (await opts.ocrFn(id, row.blob)) || '';
        } else {
          const t = AbortSignal.timeout?.(30000);
          text = (await ocrImageText(row.blob, { signal: t })) || '';
        }
      } catch { text = ''; }
    }
    ocrCache.set(id, text);
    ocrText[id] = text;
  }

  // 占位符 → OCR 文字块（完整占位符才替换；被切片切断的不命中→安全降级）
  const replaced = messages.map((m) => {
    if (typeof m.content !== 'string') return m;
    let s = m.content;
    for (const id of ids) {
      const ocr = ocrText[id];
      const block = ocr && ocr.trim()
        ? `【图片(${id}) 内文字（OCR）】\n${ocr.trim()}`
        : `【图片(${id})】未能识别文字，未纳入分析`;
      s = s.split(`sxy-img://${id}`).join(block);
    }
    return { ...m, content: s };
  });

  // ③ auto 兜底：允许视觉且存在 OCR 失败的图 → 挂 1 张给多模态
  let finalMsgs = replaced;
  let vision = 0;
  if (policy.allowVisionFallback) {
    const failedIds = ids.filter((id) => !ocrText[id] || !ocrText[id].trim());
    if (failedIds.length) {
      const v = await imageIdsToVisionContent(failedIds.slice(0, VISION_LIMIT_FALLBACK));
      if (v.length) {
        finalMsgs = attachVisionToLastUser(replaced, v);
        vision = v.length;
      }
    }
  }
  return { messages: finalMsgs, vision };
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
