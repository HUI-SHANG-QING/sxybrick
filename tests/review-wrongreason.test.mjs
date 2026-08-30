// tests/review-wrongreason.test.mjs —— 错因的生命周期
// 两条互相制衡的规则，缺一都会出问题：
//   1) review() 不得用「空错因 + 新时间戳」覆盖他机的真实错因（P0，跨设备错因丢失）
//   2) 错因不得「终身携带」：答对且未上报新错因时必须清空，
//      否则一次「概念混淆」会让这张卡此后每次答对都被 ×0.6，永远升不到正常梯度
//      （2026-08-30 修复；规则 2 的清空必须 bump 时间戳，否则跨设备会被对端顶回来）
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

test('错因不终身携带：答对后清空（但本次仍按错因缩短间隔）', async () => {
  const c = await createCard({ front: '题目', back: '答案', subject: '线性代数' });
  // 第一次「没记住」且给出错因 → 写入真实错因 + 时间戳
  await review(c.id, 0, 1, false, { wrongReason: '混淆 S 与 D' });
  const r1 = await db.cards.get(c.id);
  assert.equal(r1.wrongReason, '混淆 S 与 D');
  assert.ok(r1.wrongReasonAt > 0);

  // 之后「记住了」且未提供新错因 → 本次仍按错因缩短间隔（惩罚生效一次），
  // 但卡片上的错因必须被清空，否则这张卡此后每次答对都被 ×0.6，永远升不上去。
  await review(c.id, 2);
  const r2 = await db.cards.get(c.id);
  assert.equal(r2.wrongReason, '', '答对后必须清空错因（不然后续复习被永久惩罚）');
  assert.ok(r2.wrongReasonAt > r1.wrongReasonAt,
    '清空必须 bump 时间戳：否则 mergeCardPair 在时间戳相等时优先保留有内容的一方，对端旧错因会把清空顶回来');

  // 再答对一次：这次不该再有任何错因惩罚（间隔按正常梯度走）
  const before = await db.cards.get(c.id);
  await review(c.id, 2);
  const r3 = await db.cards.get(c.id);
  assert.equal(r3.wrongReason, '');
  assert.ok(r3.wrongReasonAt >= before.wrongReasonAt, '无错因时不再反复 bump（避免用新时间戳覆盖他机真实错因）');
});

test('答模糊（rating=1）保留错因：没真正答对，不该清空', async () => {
  const c = await createCard({ front: '题2', back: '答2', subject: '线性代数' });
  await review(c.id, 0, 1, false, { wrongReason: '概念混淆' });
  const r1 = await db.cards.get(c.id);
  assert.equal(r1.wrongReason, '概念混淆');

  await review(c.id, 1); // 还模糊
  const r2 = await db.cards.get(c.id);
  assert.equal(r2.wrongReason, '概念混淆', '答模糊不算掌握，错因应保留');
});

test('上报新错因覆盖旧错因', async () => {
  const c = await createCard({ front: '题3', back: '答3', subject: '线性代数' });
  await review(c.id, 0, 1, false, { wrongReason: '概念混淆' });
  await review(c.id, 0, 1, false, { wrongReason: '审题偏差' });
  const r = await db.cards.get(c.id);
  assert.equal(r.wrongReason, '审题偏差', '新错因应覆盖旧错因');
});
