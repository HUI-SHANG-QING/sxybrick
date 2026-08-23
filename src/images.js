// 图片存取与 URL 解析：图片以 Blob 存 IndexedDB，正文里用 sxy-img://<id> 占位
import { db } from './db.js';

const cache = new Map(); // id -> objectURL

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
    if (row?.blob) cache.set(need[i], URL.createObjectURL(row.blob));
  }
}

export async function putImage(id, blob, mime) {
  await db.images.put({ id, blob, mime, createdAt: Date.now() });
  if (cache.has(id)) URL.revokeObjectURL(cache.get(id));
  cache.set(id, URL.createObjectURL(blob));
}

export function base64ToBlob(b64, mime = 'image/png') {
  const bin = atob(b64);
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