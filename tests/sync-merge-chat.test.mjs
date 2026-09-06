// tests/sync-merge-chat.test.mjs —— round23 P2-2
// ① aiChats 追加型消息跨设备合并不丢（整行 LWW 会让对端独有新消息整体丢失）；
// ② 全表 updatedAt 策略：同时间戳不同内容 → 确定性收敛（两设备选同一行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows, mergeChatPair } from '../src/sync-manifest.js';

const u = (i) => ({ role: 'user', content: 'u' + i });
const a = (i) => ({ role: 'assistant', content: 'a' + i });
const chat = (id, ts, msgs, extra = {}) => ({ id, title: 't', createdAt: ts - 1, updatedAt: ts, messages: msgs, ...extra });

test('P2-2 chat：对端独有新消息被并入，不再被整行 LWW 覆盖丢弃', () => {
  // 场景：B 更新（ts 更大）且带 [u1,a1,u2]；A 较旧但独有 mX —— 旧实现 B 整行赢 → mX 永久丢失
  const local = chat('c1', 200, [u(1), a(1), u(2)]);
  const incoming = chat('c1', 150, [u(1), a(1), a(9)]); // a9 = A 端独有
  const out = mergeRows([local], [incoming], 'chat')[0];
  const contents = out.messages.map((m) => m.content);
  assert.ok(contents.includes('a9'), '对端独有消息 a9 应保留');
  assert.ok(contents.includes('u2'), '本端独有消息 u2 应保留');
  assert.equal(new Set(contents).size, contents.length, '并集不应产生同 content 重复');
  assert.equal(out.updatedAt, 200, '标量时间取新');
});

test('P2-2 chat：同端重复消息不去重，仅过滤"对端完全相同一条"', () => {
  const local = chat('c1', 100, [u(1), u(1)]); // 用户问了两遍一模一样的问题（合法）
  const incoming = chat('c1', 120, [u(1), a(5)]);
  const out = mergeRows([local], [incoming], 'chat')[0];
  assert.equal(out.messages.filter((m) => m.content === 'u1').length, 2, '本端两条 u1 都要保留');
  assert.ok(out.messages.some((m) => m.content === 'a5'));
});

test('P2-2 chat：带 id 的消息按 id 去重，同内容不同 id 视为两条', () => {
  const local = chat('c1', 100, [{ id: 'm1', role: 'user', content: 'hi' }]);
  const incoming = chat('c1', 120, [{ id: 'm2', role: 'user', content: 'hi' }]); // 同内容但不同 id
  const out = mergeRows([local], [incoming], 'chat')[0];
  assert.equal(out.messages.length, 2, '不同 id 的同内容消息应视为两条');
});

test('P2-2 updatedAt：同时间戳不同内容 → 确定性收敛（字典序小者），两方向结果一致', () => {
  const mk = (content) => ({ id: 'r1', updatedAt: 100, createdAt: 99, content });
  const A = mk('AAA'), B = mk('BBB');
  const outAB = mergeRows([A], [B], 'updatedAt')[0];
  const outBA = mergeRows([B], [A], 'updatedAt')[0];
  assert.equal(outAB.content, outBA.content, '两个设备合并结果必须一致（收敛）');
  assert.equal(outAB.content, 'AAA', '应取序列化字典序小者（AAA < BBB）');
});

test('P2-2 updatedAt：时间更大者仍胜出（原 LWW 语义不破坏）', () => {
  const out = mergeRows(
    [{ id: 'r1', updatedAt: 100, content: 'old' }],
    [{ id: 'r1', updatedAt: 200, content: 'new' }],
    'updatedAt')[0];
  assert.equal(out.content, 'new');
});

test('P2-2 mergeChatPair：时间新一方的标量（title）胜出、messages 并集', () => {
  const out = mergeChatPair(
    { id: 'c', title: '旧题', updatedAt: 100, messages: [u(1)] },
    { id: 'c', title: '新题', updatedAt: 300, messages: [u(1), a(2)] },
  );
  assert.equal(out.title, '新题');
  assert.equal(out.messages.length, 2);
});
