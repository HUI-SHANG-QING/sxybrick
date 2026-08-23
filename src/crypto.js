// 数据包加密：AES-GCM（256）+ PBKDF2 密钥派生，用浏览器 Web Crypto
// 导出时若用户填了密码，则整个数据包加密为 { app:'sxybrick-enc', salt, iv, data }
const te = new TextEncoder();
const td = new TextDecoder();

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptBackup(backup, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(backup)));
  return { app: 'sxybrick-enc', version: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(enc) };
}

export async function decryptBackup(pkg, password) {
  const salt = fromB64(pkg.salt);
  const iv = fromB64(pkg.iv);
  const key = await deriveKey(password, salt);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromB64(pkg.data));
  return JSON.parse(td.decode(dec));
}