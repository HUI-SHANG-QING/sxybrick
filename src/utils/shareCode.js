// src/utils/shareCode.js
// 卡组分享码（P3·#1）：把筛选后的卡片数据编码成短字符串，对方粘贴即可导入。
// 纯前端实现：gzip 压缩 + base64，零外部服务、零文件传输、跨设备可用。
// 兼容性：浏览器不支持 CompressionStream 时自动回退到纯 base64（前缀区分版本）。
//
// 码格式：
//   SXY1:<base64-gzipped-json>   v1：压缩版（首选）
//   SXY0:<base64-json>           v0：未压缩版（兼容老浏览器）
//   payload JSON: { v, exportedAt, scope, cards: [{front,back,subject,tags,mnemonic,wrongReason,type}] }

const PREFIX_V1 = 'SXY1:';
const PREFIX_V0 = 'SXY0:';

function hasCompressionStream() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

// uint8array → base64（兼容中文，逐字节拼接）
function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gzipEncode(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToB64(new Uint8Array(buf));
}
async function gzipDecode(b64) {
  const bytes = b64ToBytes(b64);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

function plainB64(text) {
  // UTF-8 安全的 base64：先 encodeURIComponent 处理中文
  return btoa(encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode('0x' + p1)));
}
function plainB64Decode(b64) {
  const bin = atob(b64);
  return decodeURIComponent(bin.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

/**
 * 把卡片数组编码成分享码。
 * @param {Array} cards 卡片数组（仅取可分享字段，过滤内部状态）
 * @param {object} meta { scope } 范围描述（可选）
 * @returns {Promise<string>} 分享码字符串
 */
export async function encodeShareCode(cards, meta = {}) {
  const payload = {
    v: 1,
    exportedAt: Date.now(),
    scope: String(meta.scope || ''),
    cards: (cards || []).map(c => ({
      front: String(c.front || ''),
      back: String(c.back || ''),
      subject: String(c.subject || ''),
      tags: Array.isArray(c.tags) ? c.tags : [],
      mnemonic: String(c.mnemonic || ''),
      wrongReason: String(c.wrongReason || ''),
      type: String(c.type || 'basic'),
    })),
  };
  const json = JSON.stringify(payload);
  if (hasCompressionStream()) {
    try {
      const b64 = await gzipEncode(json);
      return PREFIX_V1 + b64;
    } catch { /* 失败则回退 v0 */ }
  }
  return PREFIX_V0 + plainB64(json);
}

/**
 * 解码分享码，返回卡片数组。
 * @param {string} code 分享码字符串
 * @returns {Promise<{cards, scope, exportedAt}>}
 * @throws 格式错误时抛出可读异常
 */
export async function decodeShareCode(code) {
  const s = String(code || '').trim();
  if (!s) throw new Error('分享码为空');
  if (s.startsWith(PREFIX_V1)) {
    const b64 = s.slice(PREFIX_V1.length);
    const json = await gzipDecode(b64);
    const obj = JSON.parse(json);
    if (!Array.isArray(obj.cards)) throw new Error('分享码格式异常：缺少 cards 字段');
    return { cards: obj.cards, scope: obj.scope || '', exportedAt: obj.exportedAt || 0 };
  }
  if (s.startsWith(PREFIX_V0)) {
    const b64 = s.slice(PREFIX_V0.length);
    const json = plainB64Decode(b64);
    const obj = JSON.parse(json);
    if (!Array.isArray(obj.cards)) throw new Error('分享码格式异常：缺少 cards 字段');
    return { cards: obj.cards, scope: obj.scope || '', exportedAt: obj.exportedAt || 0 };
  }
  throw new Error('无效的分享码：应以 SXY1: 或 SXY0: 开头');
}

/**
 * 估算分享码体积（KB），用于在 UI 提示用户。
 */
export function estimateSize(cards) {
  // 经验值：单卡平均 220B JSON，gzip 后约 1/4，base64 后 ×1.33
  const n = cards?.length || 0;
  const rawJson = n * 220;
  const gzipped = rawJson * 0.25;
  const b64 = gzipped * 1.33;
  return Math.max(1, Math.round(b64 / 1024));
}
