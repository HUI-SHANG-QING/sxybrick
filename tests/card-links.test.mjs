// tests/card-links.test.mjs —— v34 通用卡 ↔ 通用卡关联（cardLinks）测试
// 背景：卡片编辑里的「关联」此前只支持英语词卡（v31 cardWordLinks），纯记忆卡之间
// 无法互相关联。v34 新增 cardLinks，本测试锁定其不变量：
//   1) 建/解关联 + 双向查询（有向存储、展示双向）
//   2) 自环拒绝、重复 link 幂等（含反向重复）
//   3) 删卡级联：双向关联行删除 + 写墓碑（防对端悬空复活）
//   4) 回收站：删→恢复后关联还原，且墓碑被清（否则下一轮同步又被删掉）
//   5) 同步去重：cardLinks.id 复合键随 fromCardId/toCardId 重映射一起重算
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  createCard, deleteCard, restoreFromTrash, listCards,
  linkCards, unlinkCards, cardsOfCard, allCardLinks,
} from '../src/repo.js';
import { remapCardRefs } from '../src/sync-dedup.js';

after(async () => { try { await db.close(); } catch {} });

async function newCard(front, subject = '线性代数') {
  return createCard({ front, back: '答案', subject, ease: 2.5, intervalDays: 10, dueAt: Date.now() + 3600e3, level: 1 });
}

test('建/解关联：双向可见，解除后两侧都空', async () => {
  const a = await newCard('# 特征值\n几何重数与代数重数');
  const b = await newCard('# 相似矩阵\n等价 vs 相似');
  const row = await linkCards(a.id, b.id);
  assert.ok(row && row.id === `${a.id}:${b.id}`);
  assert.equal(row.fromCardId, a.id);
  assert.equal(row.toCardId, b.id);

  const ofA = await cardsOfCard(a.id);
  const ofB = await cardsOfCard(b.id);
  assert.deepEqual(ofA.map(c => c.id), [b.id], 'A 侧可见 B');
  assert.deepEqual(ofB.map(c => c.id), [a.id], 'B 侧可见 A（双向展示）');

  assert.equal(await unlinkCards(a.id, b.id), true);
  assert.equal((await cardsOfCard(a.id)).length, 0);
  assert.equal((await cardsOfCard(b.id)).length, 0);
  await deleteCard(a.id); await deleteCard(b.id);
});

test('自环拒绝 + 重复关联幂等（含反向）', async () => {
  const a = await newCard('A 卡');
  const b = await newCard('B 卡');
  assert.equal(await linkCards(a.id, a.id), null, '禁止自环');
  const r1 = await linkCards(a.id, b.id);
  const r2 = await linkCards(a.id, b.id);
  const r3 = await linkCards(b.id, a.id); // 反向重复 → 复用既有行
  assert.equal(r2.id, r1.id);
  assert.equal(r3.id, r1.id);
  assert.equal((await allCardLinks()).filter(l => l.id === r1.id).length, 1, '同一对只有一行');
  await unlinkCards(a.id, b.id);
  await deleteCard(a.id); await deleteCard(b.id);
});

test('删卡级联：双向关联清空并写 cardLink 墓碑', async () => {
  const a = await newCard('被删的卡');
  const b = await newCard('保留的卡');
  const c = await newCard('另一个关联卡');
  const l1 = await linkCards(a.id, b.id); // a 作为 from
  const l2 = await linkCards(c.id, a.id); // a 作为 to
  await deleteCard(a.id);

  const left = await db.cardLinks.bulkGet([l1.id, l2.id]);
  assert.ok(left.every(x => x === undefined), '两个方向的关联行都已删除');
  const tombs = await db.tombstones.bulkGet([l1.id, l2.id]);
  assert.ok(tombs.every(t => t && t.kind === 'cardLink'), '两个方向都写了墓碑（防对端悬空复活）');
  assert.equal((await cardsOfCard(b.id)).length, 0);
  await deleteCard(b.id); await deleteCard(c.id);
});

test('回收站恢复：关联还原且墓碑被清（不会下一轮被自己删掉）', async () => {
  const a = await newCard('待删待恢复');
  const b = await newCard('关联方');
  const link = await linkCards(a.id, b.id);
  await deleteCard(a.id);
  assert.equal((await db.cardLinks.get(link.id)), undefined);

  const snap = await db.trash.get(a.id);
  assert.ok(snap, '删卡后应进回收站');
  assert.equal(await restoreFromTrash(snap), true);
  const back = await db.cardLinks.get(link.id);
  assert.ok(back, '关联行随回收站恢复还原');
  assert.equal(await db.tombstones.get(link.id), undefined, '恢复时清掉墓碑');
  assert.deepEqual((await cardsOfCard(a.id)).map(c => c.id), [b.id]);
  await deleteCard(b.id);
});

test('同步去重：cardLinks 复合 id 随字段重映射重算', async () => {  const backup = {
    cardLinks: [{ id: 'oldA:keepB', fromCardId: 'oldA', toCardId: 'keepB', addedAt: 1 }],
  };
  const out = remapCardRefs(backup, new Map([['oldA', 'keepA']]));
  assert.equal(out.cardLinks[0].fromCardId, 'keepA');
  assert.equal(out.cardLinks[0].id, 'keepA:keepB', 'id 必须跟着重算（否则 unlink/去重落空）');
});

test('候选数据源契约：listCards 返回 {items} 数组（关联选择器依赖）', async () => {
  // 回归：CardModal 关联选择器把 listCards() 的结果直接当数组用 → 实际返回
  // { items, total, dueCount }，slice 抛错被 catch 吞掉后候选恒为空（静默失败）。
  const c = await newCard('# 候选卡\n标题');
  const r = await listCards({ mode: 'all' });
  assert.ok(Array.isArray(r?.items), 'listCards().items 必须是数组');
  assert.ok(r.items.some(x => x.id === c.id), '新建卡应出现在候选里');
  await deleteCard(c.id);
});
