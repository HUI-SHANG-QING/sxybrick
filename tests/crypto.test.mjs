// 隐私数据加密工具回归测试（node --test）
// 测试 src/utils/crypto.js：AES-GCM + PBKDF2（Web Crypto API，Node 18+ globalThis.crypto.subtle 可用）
// crypto.js 无任何 import（自包含），仅用 crypto.subtle / crypto.getRandomValues / btoa / atob /
// TextEncoder / TextDecoder，在 Node 24 下均为全局可用，不触碰 window/Dexie/localStorage。
// （getOrCreateDeviceKey 用 localStorage，不在本测试范围）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encrypt, decrypt,
  encryptObject, decryptObject,
  encryptBackup, decryptBackup,
  generateRecoveryCode,
  verifyPassword,
} from '../src/utils/crypto.js';

const TOL = 1e-9;

test('encrypt/decrypt 往返一致', async () => {
  const plain = '这是一段需要加密的隐私文本 secret 123 !@#';
  const pwd = 'my-password-2026';
  const enc = await encrypt(plain, pwd);

  // 输出是 JSON 字符串：{ v, salt, iv, ct }
  assert.equal(typeof enc, 'string');
  const obj = JSON.parse(enc);
  assert.equal(obj.v, 1);
  assert.ok(obj.salt);
  assert.ok(obj.iv);
  assert.ok(obj.ct);

  const dec = await decrypt(enc, pwd);
  assert.equal(dec, plain);
});

test('encrypt 每次密文不同（随机 salt/iv）', async () => {
  const pwd = 'same-pwd';
  const a = await encrypt('x', pwd);
  const b = await encrypt('x', pwd);
  assert.notEqual(a, b); // 随机 salt/iv → 密文不同
});

test('encryptObject/decryptObject 往返一致', async () => {
  const data = {
    id: 'p1', content: '隐私内容', tags: ['a', 'b'], n: 42,
    nested: { x: 1, arr: [1, 2, 3] }, flag: true,
  };
  const pwd = 'object-pwd';
  const enc = await encryptObject(data, pwd);
  assert.equal(typeof enc, 'string');
  const dec = await decryptObject(enc, pwd);
  assert.deepEqual(dec, data);
});

test('encryptBackup/decryptBackup 往返一致', async () => {
  // 模拟一个 .sxybrick 加密备份包（覆盖 sync-manifest 的三类字段）
  const backup = {
    version: 5,
    cards: [{ id: 'c1', front: '卡', consolidation: 2, wrongReason: 'CONCEPT_MIS' }],
    embeddings: [{ id: 'e1', cardId: 'c1', vec: [0.1, 0.2] }],
    tombstones: [{ id: 'c2', kind: 'card', deletedAt: 1 }],
  };
  const pwd = 'backup-pwd';
  const b64 = await encryptBackup(backup, pwd);

  assert.equal(typeof b64, 'string');
  assert.ok(b64.length > 0);
  // 二进制 buffer 前缀版本号：[version(1)][salt(16)][iv(12)][ct(...)] → base64
  // 解码后首字节应为版本号 1
  const bin = atob(b64);
  assert.equal(bin.charCodeAt(0), 1);

  const dec = await decryptBackup(b64, pwd);
  assert.deepEqual(dec, backup);
});

test('错误口令解密失败抛异常（decrypt / decryptBackup / decryptObject）', async () => {
  const enc = await encrypt('secret', 'right-pwd');
  await assert.rejects(decrypt(enc, 'wrong-pwd'));

  const encObj = await encryptObject({ a: 1 }, 'right');
  await assert.rejects(decryptObject(encObj, 'wrong'));

  const b64 = await encryptBackup({ a: 1 }, 'right');
  await assert.rejects(decryptBackup(b64, 'wrong'));
});

test('decrypt 对格式无效的输入抛异常', async () => {
  await assert.rejects(decrypt('not-json', 'pwd'));
  await assert.rejects(decrypt(JSON.stringify({ foo: 'bar' }), 'pwd')); // 缺 salt/iv/ct
});

test('generateRecoveryCode 格式：24 字节 hex → 12 段 4 字符、大写', () => {
  const code = generateRecoveryCode();
  // 24 字节 → 48 个十六进制字符 → match(/.{1,4}/g) 切成 12 段
  const parts = code.split('-');
  assert.equal(parts.length, 12, '24 字节 = 48 hex 字符 = 12 段');
  for (const p of parts) {
    assert.equal(p.length, 4, `每段 4 字符，得到 ${p}`);
    assert.match(p, /^[0-9A-F]{4}$/, `${p} 应为大写十六进制`);
  }
  // 总长 = 48 hex + 11 个分隔符
  assert.equal(code.length, 48 + 11);

  // 随机性：两次生成应不同
  const code2 = generateRecoveryCode();
  assert.notEqual(code, code2);
});

test('verifyPassword：正确口令 true、错误口令 false（不抛异常）', async () => {
  const enc = await encrypt('secret', 'right-pwd');
  assert.equal(await verifyPassword(enc, 'right-pwd'), true);
  assert.equal(await verifyPassword(enc, 'wrong-pwd'), false);
  // 格式无效也不抛，返回 false
  assert.equal(await verifyPassword('garbage', 'any'), false);
});
