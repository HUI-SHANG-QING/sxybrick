// tests/review-wrongreason.test.mjs —— P0 回归：
// review() 仅在确有错因内容时推进 wrongReasonAt，避免「记住了」(空错因)
// 以新时间戳覆盖另一台设备上的真实错因（跨设备错因丢失）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard, review } from '../src/repo.js';
import { after } from 'node:test';

after(async () => { try { await db.close(); } catch {} });

test('记住了（空错因）不应 bump wrongReasonAt', async () => {
  const c = await createCard({
    front: '什么是可提取性 R？', back: 'R=(1+t/9S)^-1', subject: '线性代数', tags: ['FSRS'],
  });
  // rating=2「记住了」且未提供任何错因
  await review(c.id, 2);
  const after = await db.cards.get(c.id);
  assert.equal(after.wrongReason, '', '无错因时 wrongReason 应为空');
  assert.equal(after.wrongReasonAt, 0, '空错因不应推进 wrongReasonAt，否则会以新时间戳覆盖他机真实错因');
});

test('没记住且有错因时推进 wrongReasonAt', async () => {
  const c = await createCard({
    front: 'FSRS 的稳定度 S 是什么？', back: '记忆强度的度量', subject: '线性代数',
  });
  await review(c.id, 0, 1, false, { wrongReason: '混淆了 S 与难度 D' });
  const after = await db.cards.get(c.id);
  assert.equal(after.wrongReason, '混淆了 S 与难度 D');
  assert.ok(after.wrongReasonAt > 0, '有错因时应推进 wrongReasonAt');
});

test('真实错因不会被「记住了」空复习覆盖', async () => {
  const c = await createCard({ front: '题目', back: '答案', subject: '线性代数' });
  // 第一次「没记住」且给出错因 → 写入真实错因 + 时间戳
  await review(c.id, 0, 1, false, { wrongReason: '第一次错因：混淆 S 与 D' });
  const r1 = await db.cards.get(c.id);
  assert.equal(r1.wrongReason, '第一次错因：混淆 S 与 D');
  assert.ok(r1.wrongReasonAt > 0);
  // 之后「记住了」但未提供新错因 → 旧错因应保留，不被清空
  await review(c.id, 2);
  const r2 = await db.cards.get(c.id);
  assert.equal(r2.wrongReason, '第一次错因：混淆 S 与 D', '真实错因不应被空复习清空');
  assert.ok(r2.wrongReasonAt >= r1.wrongReasonAt, '保留错因的时间戳不应早于原始记录');
});
