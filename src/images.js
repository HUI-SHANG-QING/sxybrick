// 图片存取与 URL 解析：图片以 Blob 存 IndexedDB，正文里用 sxy-img://<id> 占位
import { db } from './db.js';

// LRU-cap 缓存：长会话 + 大量图片会持续累积 Blob 引用导致内存泄漏，
// 超过上限时按插入顺序淘汰最旧条目并回收其 objectURL（避免浏览器内存压力 / 不可逆占用）。
const cache = new Map(); // id -> objectURL
const MAX_CACHE = 300;

function cacheSet(id, url) {
  // 命中更新：先删旧键再 set，保证插入顺序反映最近使用
  if (cache.has(id)) {
    const old = cache.get(id);
    if (old && old !== url) URL.revokeObjectURL(old);
    cache.delete(id);
  }
  // 插入前先淘汰最旧（Map 保持插入顺序，keys().next() 即最旧）
  while (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    const o = cache.get(oldest);
    if (o) URL.revokeObjectURL(o);
    cache.delete(oldest);
  }
  cache.set(id, url);
}

export function imgUrl(id) {
  return cache.get(id) || '';
}

export function extractImageIds(md) {
  const ids = [];
  const re = /sxy-img:\/\/([0-9a-fA-F-]+)/g;
  let m;
  while ((m = re.exec(md || ''))) ids.push(m[1]);
  return ids;
}

export async function ensureImages(ids) {
  const need = [...new Set(ids)].filter(id => !cache.has(id));
  if (!need.length) return;
  const rows = await db.images.bulkGet(need);
  for (let i = 0; i < need.length; i++) {
    const row = rows[i];
    if (row?.blob) cacheSet(need[i], URL.createObjectURL(row.blob));
  }
}

export async function putImage(id, blob, mime) {
  await db.images.put({ id, blob, mime, createdAt: Date.now() });
  cacheSet(id, URL.createObjectURL(blob));
}

export function base64ToBlob(b64, mime = 'image/png') {
  // round18：容错解码——容忍 data URL 前缀（"data:image/png;base64,xxx"）、
  // 换行/空白（部分工具导出的 base64 带换行）。此前 atob 直接抛 "Invalid character"，
  // 且该异常发生在 importBackup 事务内 → 整个 31 表导入大事务被中止，
  // 用户侧表现为同步模块报 AbortError（"The transaction was aborted..."）。
  let s = String(b64 || '').trim();
  const comma = s.indexOf(',');
  if (s.startsWith('data:') && comma > 0) s = s.slice(comma + 1);
  s = s.replace(/\s+/g, '');
  const bin = atob(s);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}