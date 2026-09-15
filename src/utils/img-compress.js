// src/utils/img-compress.js
// 图片压缩工具（无业务依赖，供 image-analysis / doc-vision 共用）。
//
// 抽出原因：image-analysis（卡片图片富集）与 doc-vision（资料库文件 → 多模态）
// 都需要「Blob → 长边 ≤1568px JPEG dataURL」，若互相 import 会形成静态环
// （dep:check 会拦）；下沉到 utils 层两边单向引用即可。
//
// 环境差异：
//   · 浏览器：用 canvas 缩放 + JPEG 压缩（q0.8），长边限制到 1568px（多模态模型的
//     常见最佳输入尺寸，再大只会增加 token 费用而不提升识别质量）；
//   · Node（测试/SSR）：无 document → 直接读字节转 base64，保证逻辑可测、不抛错。

const MAX_EDGE = 1568;

/**
 * 图片质量档位（用户可选）。
 *
 * 为什么需要：单次请求的图片总体积才是真正先到顶的约束（见 image-analysis 的
 * VISION_BYTES_BUDGET）。**降低单张体积比放大预算更有效** —— 质量调低一档，
 * 同样的字节预算能装下 3–4 倍张数，而且不增加崩溃/超时风险。
 *
 * 实测参考（1568px ≈ 200–600KB 视内容复杂度而定）：
 *   high     ≈ 200–600KB/张   → 24MB 约装 40–120 张（识别质量优先，默认）
 *   standard ≈ 80–200KB/张    → 24MB 约装 120–300 张
 *   low      ≈ 30–80KB/张     → 24MB 约装 300–800 张（截图类通常仍可读）
 */
export const IMAGE_QUALITY_PRESETS = Object.freeze({
  high: Object.freeze({ maxEdge: 1568, quality: 0.8 }),
  standard: Object.freeze({ maxEdge: 1024, quality: 0.75 }),
  low: Object.freeze({ maxEdge: 768, quality: 0.6 }),
});
export const IMAGE_QUALITY_KEYS = Object.freeze(Object.keys(IMAGE_QUALITY_PRESETS));
export const IMAGE_QUALITY_DEFAULT = 'high';

/**
 * 档位 key → { maxEdge, quality }；非法 / 缺省回退默认档（脏设置兜底）。
 * @param {*} key
 * @returns {{ maxEdge: number, quality: number }}
 */
export function resolveImageQuality(key) {
  return IMAGE_QUALITY_PRESETS[IMAGE_QUALITY_KEYS.includes(key) ? key : IMAGE_QUALITY_DEFAULT];
}

/**
 * 压缩图片 Blob 为 dataURL。
 * @param {Blob} blob
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<string>} dataURL（失败时退化为原图 dataURL；仍失败则返回 ''）
 */
export async function compressImageBlob(blob, opts = {}) {
  const maxEdge = Number(opts.maxEdge) || MAX_EDGE;
  const quality = Number(opts.quality) || 0.8;
  try {
    if (typeof document === 'undefined') return blobToDataUrlRaw(blob);
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const out = canvas.toDataURL('image/jpeg', quality);
      canvas.width = 0; canvas.height = 0;
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return blobToDataUrlRaw(blob);
  }
}

/** 原样转 dataURL（浏览器用 FileReader，Node 用 Buffer） */
export async function blobToDataUrlRaw(blob) {
  const mime = blob?.type || 'application/octet-stream';
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const b64 = (typeof btoa !== 'undefined') ? btoa(bin) : Buffer.from(bytes).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return '';
  }
}
