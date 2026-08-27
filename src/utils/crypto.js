// 隐私数据加密工具（Web Crypto API: AES-GCM + PBKDF2）
// 三种加密方案：
//   1) password+recovery: 用户口令 + 一次性恢复码（恢复码可代替口令解密）
//   2) password-only: 纯口令（口令忘=数据永久丢失）
//   3) device-key: 设备生成的密钥（不要求口令，但密钥绑定本设备）
//
// 用途：privacyRecords 本地加密存储 + 离设备加密备份(.sxybrick)
// PIPL 合规：敏感个人信息不明文流转

const ENC_VERSION = 1;
const PBKDF2_ITER = 100000; // OWASP 推荐 ≥ 100k
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 256; // AES-256

// 文件格式：[version(1)] [salt(16)] [iv(12)] [ciphertext(...)]
// 或 JSON：{ v, salt, iv, ct }（base64）

// ---- base64 工具 ----
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---- PBKDF2 派生密钥 ----
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LEN },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---- 生成一次性恢复码（32 位随机串，用户需自行保存） ----
export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  // 分段显示，便于抄写：xxxx-xxxx-xxxx-xxxx-xxxx-xxxx
  return hex.match(/.{1,4}/g).join('-').toUpperCase();
}

// ---- 生成设备密钥（存 IndexedDB/localStorage，不要求用户输口令） ----
export async function getOrCreateDeviceKey() {
  const STORAGE_KEY = '_sxybrick_device_key';
  let stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(STORAGE_KEY, hex);
  return hex;
}

// ---- 加密（返回 JSON 字符串：{v, salt, iv, ct}） ----
export async function encrypt(plaintext, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  );
  return JSON.stringify({
    v: ENC_VERSION,
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ct: bufToB64(ct),
  });
}

// ---- 解密（传入加密 JSON 字符串 + 口令，返回明文） ----
export async function decrypt(encryptedJson, password) {
  const obj = typeof encryptedJson === 'string' ? JSON.parse(encryptedJson) : encryptedJson;
  if (!obj || !obj.salt || !obj.iv || !obj.ct) throw new Error('加密数据格式无效');
  const salt = new Uint8Array(b64ToBuf(obj.salt));
  const iv = new Uint8Array(b64ToBuf(obj.iv));
  const ct = b64ToBuf(obj.ct);
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}

// ---- 加密对象（JSON 序列化后加密） ----
export async function encryptObject(obj, password) {
  return encrypt(JSON.stringify(obj), password);
}

// ---- 解密对象（解密后 JSON.parse） ----
export async function decryptObject(encryptedJson, password) {
  const pt = await decrypt(encryptedJson, password);
  return JSON.parse(pt);
}

// ---- 加密整个数据包（用于 .sxybrick 加密备份文件） ----
// 返回 base64 字符串，可直接写入文件
export async function encryptBackup(dataObj, password) {
  const json = JSON.stringify(dataObj);
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(json),
  );
  // 合并为一个二进制 buffer 前缀版本号
  const versionByte = new Uint8Array([ENC_VERSION]);
  const combined = new Uint8Array(versionByte.length + salt.length + iv.length + ct.byteLength);
  combined.set(versionByte, 0);
  combined.set(salt, versionByte.length);
  combined.set(iv, versionByte.length + salt.length);
  combined.set(new Uint8Array(ct), versionByte.length + salt.length + iv.length);
  return bufToB64(combined.buffer);
}

// ---- 解密备份文件 ----
export async function decryptBackup(b64Data, password) {
  const buf = b64ToBuf(b64Data);
  const bytes = new Uint8Array(buf);
  const version = bytes[0];
  if (version !== ENC_VERSION) throw new Error(`不支持的加密版本: ${version}`);
  const salt = bytes.slice(1, 1 + SALT_LEN);
  const iv = bytes.slice(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN);
  const ct = bytes.slice(1 + SALT_LEN + IV_LEN);
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct,
  );
  const json = new TextDecoder().decode(pt);
  return JSON.parse(json);
}

// ---- 验证口令是否能解密（不返回明文，仅 true/false） ----
export async function verifyPassword(encryptedJson, password) {
  try {
    await decrypt(encryptedJson, password);
    return true;
  } catch {
    return false;
  }
}
