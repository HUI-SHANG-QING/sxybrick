// tests/shareCode.test.mjs —— P2-26 卡组分享码
// 覆盖：encode → decode 往返（含中文/emoji/HTML）/ v1 压缩版 + v0 未压缩回退分支 /
//       错误分支（空 / 非法前缀 / 缺 cards 字段）/ 体积估算。
// 说明：Node 22 自带 CompressionStream/Blob/Response/btoa/atob，故能真实跑通 gzip 分支；
//       shareCode.js 不依赖 db，故无需 fake-indexeddb（仅按惯例引入 _env 垫片）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeShareCode, decodeShareCode, estimateSize } from '../src/utils/shareCode.js';

// 复刻 shareCode.js 内部 plainB64，用于构造合法的 v0（未压缩）分享码
function plainB64(text) {
  return btoa(encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode('0x' + p1)));
}

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  front: `正面${i + 1} 🎯`, back: `背面${i + 1} <b>x</b>`, subject: '考研',
  tags: ['a', 'b'], mnemonic: '助记', wrongReason: '错因', type: 'basic',
}));

test('往返：encode → decode 还原卡片（含中文/emoji/HTML）', async () => {
  const cards = mk(10);
  const code = await encodeShareCode(cards, { scope: 'all' });
  assert.ok(code.startsWith('SXY1:'), 'Node 22 应走 gzip 压缩版（SXY1:）');
  const r = await decodeShareCode(code);
  assert.equal(r.cards.length, 10);
  assert.equal(r.scope, 'all');
  assert.deepEqual(r.cards[0], {
    front: '正面1 🎯', back: '背面1 <b>x</b>', subject: '考研',
    tags: ['a', 'b'], mnemonic: '助记', wrongReason: '错因', type: 'basic',
  });
  // shareCode 不转义 HTML，原样保留
  assert.ok(r.cards[0].back.includes('<b>x</b>'));
});

test('v0 未压缩分支：手工构造 SXY0: 可被解码', async () => {
  const cards = mk(3);
  const payload = JSON.stringify({ v: 0, exportedAt: Date.now(), scope: 'byKind', cards });
  const code = 'SXY0:' + plainB64(payload);
  const r = await decodeShareCode(code);
  assert.equal(r.cards.length, 3);
  assert.equal(r.scope, 'byKind');
  assert.deepEqual(r.cards[2].front, '正面3 🎯');
});

test('v0 缺 cards 字段：抛出可读异常', async () => {
  const code = 'SXY0:' + plainB64(JSON.stringify({ v: 0 }));
  await assert.rejects(() => decodeShareCode(code), /缺少 cards 字段/);
});

test('错误分支：空 / 非法前缀', async () => {
  await assert.rejects(() => decodeShareCode(''), /分享码为空/);
  await assert.rejects(() => decodeShareCode('   '), /分享码为空/);
  await assert.rejects(() => decodeShareCode('XYZ:abc'), /无效的分享码/);
});

test('estimateSize：非空 ≥ 1，空为 1', () => {
  assert.ok(estimateSize(mk(50)) >= 1);
  assert.equal(estimateSize([]), 1);
});

test('往返幂等：多次编码互不干扰（独立 payload）', async () => {
  const a = await encodeShareCode(mk(2), { scope: 'a' });
  const b = await encodeShareCode(mk(2), { scope: 'b' });
  assert.notEqual(a, b);
  const ra = await decodeShareCode(a);
  const rb = await decodeShareCode(b);
  assert.equal(ra.scope, 'a');
  assert.equal(rb.scope, 'b');
  assert.equal(ra.cards.length, 2);
  assert.equal(rb.cards.length, 2);
});
