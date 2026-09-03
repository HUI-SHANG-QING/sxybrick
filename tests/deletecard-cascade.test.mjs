// tests/deletecard-cascade.test.mjs —— M5 残余修复回归（2026-08-29 审计）
// deleteCard 级联补全验证：
//   1) notes.linkedCardIds 中剔除被删卡引用（无悬空引用）
//   2) 孤儿图片物理删 + 写 kind='image' 墓碑（对端不再永久残留）
//   3) 仍被其它卡引用的图片：不删、不写墓碑
//   4) 既有级联不回归：reviews / embeddings / graphEdges 干净 + 卡片墓碑存在
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../src/db.js';
import { createCard, deleteCard, review } from '../src/repo.js';

after(async () => { try { await db.close(); } catch {} });

const IMG_ID = () => uid(); // 图片 id 用 uuid（sxy-img:// 协议要求）
const imgRef = (id) => `看图：sxy-img://${id}`;

async function mkCard(front, back = 'b') {
  return createCard({ front, back, subject: '计组', source: 'test' });
}

test('deleteCard 级联：notes.linkedCardIds 剔除 + 孤儿图片墓碑 + 全表干净', async () => {
  const imgOrphan = IMG_ID();
  const imgShared = IMG_ID();
  const cardA = await mkCard(`A ${imgRef(imgOrphan)} ${imgRef(imgShared)}`);
  const cardB = await mkCard(`B ${imgRef(imgShared)}`); // B 仍引用 imgShared
  // 图片落库
  await db.images.put({ id: imgOrphan, blob: 'png', mime: 'image/png', createdAt: Date.now() });
  await db.images.put({ id: imgShared, blob: 'png', mime: 'image/png', createdAt: Date.now() });
  // 关联数据：笔记引用 A、向量指向 A、图谱边连 A、A 有复习
  await db.notes.put({ id: uid(), title: '笔记', content: '[[x]]', category: 'idea', tags: [], linkedCardIds: [cardA.id, cardB.id], createdAt: Date.now(), updatedAt: Date.now() });
  await db.embeddings.put({ id: uid(), sourceId: cardA.id, sourceType: 'card', subject: '计组', updatedAt: Date.now() });
  const eId = uid();
  await db.graphEdges.put({ id: eId, fromCardId: cardA.id, toCardId: cardB.id, type: 'link', updatedAt: Date.now() });
  await review(cardA.id, 0, 1);

  await deleteCard(cardA.id);

  // 卡片本体 + 复习 + 向量 + 图谱边 全清
  assert.equal(await db.cards.get(cardA.id), undefined);
  assert.equal((await db.reviews.where('cardId').equals(cardA.id).count()), 0);
  assert.equal((await db.embeddings.where('sourceId').equals(cardA.id).count()), 0);
  assert.equal((await db.graphEdges.get(eId)), undefined);
  // 笔记引用被剔除
  const note = (await db.notes.toArray())[0];
  assert.ok(!note.linkedCardIds.includes(cardA.id), '被删卡 id 应从笔记 linkedCardIds 剔除');
  assert.ok(note.linkedCardIds.includes(cardB.id), '未删卡 id 保留');
  // 孤儿图片物理删 + 写墓碑；共享图片保留且无墓碑
  assert.equal(await db.images.get(imgOrphan), undefined, '孤儿图片应物理删除');
  assert.ok(await db.images.get(imgShared), '仍被 B 引用的图片必须保留');
  const tombs = await db.tombstones.toArray();
  assert.ok(tombs.some((t) => t.kind === 'card' && t.id === cardA.id), '卡片墓碑存在');
  assert.ok(tombs.some((t) => t.kind === 'image' && t.id === imgOrphan), '孤儿图片应写 kind=image 墓碑（对端同步清理）');
  assert.ok(!tombs.some((t) => t.kind === 'image' && t.id === imgShared), '共享图片不得写墓碑');
  // B 卡片仍在
  assert.ok(await db.cards.get(cardB.id));
});

test('deleteCard 无图片/无笔记时不产生多余墓碑', async () => {
  await db.tombstones.clear(); // 隔离前一测试遗留的 image 墓碑（共享同一 DB 实例）
  const c = await mkCard('无图卡');
  await deleteCard(c.id);
  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'image');
  assert.equal(tombs.length, 0, '无孤儿图片时不应产生 image 墓碑');
});
