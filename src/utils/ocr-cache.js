// src/utils/ocr-cache.js
// OCR 结果会话内缓存（LRU 上限 + 版本签名校验），零依赖。
//
// 为什么单独成模块：图片 OCR 很贵（云端按次计费 / 本地 Tesseract 几秒一张），
// 同一张图在反复对话里会被重复喂进来，必须缓存；但缓存本身有两个坑——
//   ① 无界增长：PWA 一天不关标签页，识别几百上千张图就一直堆在内存里（Map 永不淘汰）；
//   ② 结果过期：图片被替换（或 OCR 引擎/语言设置变了）后，缓存里还是旧文字，
//      AI 会拿着「上一版图片的内容」回答，用户看到的却是新图 → 查不出原因的怪现象。
// 对策：
//   · LRU：Map 保持插入顺序，命中先删后插更新使用序，超上限淘汰最旧；
//   · sig：值的「版本签名」（调用方传图片行的 updatedAt）——读缓存时签名不一致即视为失效，
//     这样无需在 repo/sync/视图的每个删除点挂钩子也能保证正确性。
//
// 放在 utils 层（只依赖 Map，不 import db/业务）是为了让 images.js 与 services 层都能安全引用，
// 不会与 image-analysis.js 形成静态环（dep:check 会拦）。

const MAX_OCR_CACHE = 200;

/** id → { text, sig }，Map 迭代顺序即插入顺序（LRU 依据） */
const cache = new Map();

/**
 * 读缓存。签名不一致（图片已被替换）→ 视为未命中并顺手清掉该条。
 * @param {string} id 图片 id
 * @param {number|string} [sig] 版本签名（一般传图片行的 updatedAt）
 * @returns {string|null} 命中返回 OCR 文本（可能是空串），未命中返回 null
 */
export function getOcr(id, sig) {
  if (!cache.has(id)) return null;
  const hit = cache.get(id);
  if (sig != null && hit?.sig != null && String(hit.sig) !== String(sig)) {
    cache.delete(id); // 图片换过了，旧识别结果作废
    return null;
  }
  // LRU：命中后重新插入，反映「最近使用」
  cache.delete(id);
  cache.set(id, hit);
  return typeof hit?.text === 'string' ? hit.text : '';
}

/**
 * 写缓存（超上限淘汰最旧）。
 * @param {string} id
 * @param {string} text OCR 结果（空串也缓存——「这张图没有文字」同样是结论，避免反复重试）
 * @param {number|string} [sig] 版本签名
 */
export function setOcr(id, text, sig) {
  if (!id) return;
  if (cache.has(id)) cache.delete(id);
  while (cache.size >= MAX_OCR_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
  cache.set(id, { text: typeof text === 'string' ? text : '', sig: sig ?? null });
}

/** 主动失效若干图片（图片被删除/替换时可调用；不做也不影响正确性——sig 会兜住） */
export function forgetOcr(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  let n = 0;
  for (const id of list) if (id && cache.delete(id)) n += 1;
  return n;
}

/** 清空（测试隔离 / 用户手动清缓存用） */
export function clearOcrCache() {
  cache.clear();
}

/** 当前条目数（供测试与调试面板展示） */
export function ocrCacheSize() {
  return cache.size;
}

/** 上限常量（供测试断言，避免测试里写死数字） */
export const OCR_CACHE_LIMIT = MAX_OCR_CACHE;
