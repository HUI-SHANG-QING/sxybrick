// src/utils/hub-auth.js
// 局域网 Hub 鉴权客户端（与 sync-hub/auth-core.js 同协议）
//
// v2 协议：HMAC-SHA256 挑战-响应 —— 同步密码只作 HMAC 密钥，永不上网，
// 因此局域网内抓包也拿不到口令。规范串与服务端逐字一致，见 auth-core.js。

const enc = new TextEncoder();

/** sha256 hex（用于请求体摘要） */
async function sha256Hex(text) {
  // 非安全上下文（HTTP 内网页）下 crypto.subtle 可能不可用，此时退回到 null 由调用方处理
  if (!globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(text ?? '')));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 与服务端 buildSignPayload 一致的规范串。
 * 顺序/分隔符必须和服务端完全相同，否则签名校验必然失败。
 */
export function buildSignPayload({ challenge, method, path, body }) {
  return [`v2`, challenge, String(method || '').toUpperCase(), String(path || '/'), body].join('\n');
}

/** HMAC-SHA256(secret, payload) → hex */
async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(String(secret || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 取一次性挑战。失败返回 null（调用方据此退回旧式明文 token）。
 * @param {string} hub 形如 http://192.168.1.5:18080（尾部斜杠会被清理）
 */
export async function fetchChallenge(hub, { timeoutMs = 8000 } = {}) {
  const base = String(hub || '').replace(/\/+$/, '');
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/auth/challenge`, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.challenge ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成 v2 鉴权头。
 * @param {{hub:string, token:string, method:string, path:string, body?:string}} p
 * @returns {Promise<Record<string,string>|null>} 无法使用 HMAC 时返回 null
 */
export async function buildAuthHeaders({ hub, token, method, path, body = '' }) {
  if (!token) return null;
  if (!globalThis.crypto?.subtle) return null; // 非安全上下文不支持 HMAC
  const ch = await fetchChallenge(hub);
  if (!ch) return null;
  const bodyHash = await sha256Hex(body);
  if (bodyHash == null) return null;
  const payload = buildSignPayload({ challenge: ch.challenge, method, path, body: bodyHash });
  const sig = await hmacHex(token, payload);
  return { 'x-sync-challenge': ch.challenge, 'x-sync-sig': sig };
}
