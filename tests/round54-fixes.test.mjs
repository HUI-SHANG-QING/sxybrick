// round54 回归：删卡 → 回收站还原，必须把卡片引用的图片一起带回来。
// 历史缺陷：deleteCard 会级联**物理删除**「不再被任何卡引用」的图（repo.js findOrphanImages + bulkDelete），
// 但回收站快照不含图片、restoreFromTrash 也不还原 db.images → 删卡再还原，图永久丢失（正文占位符悬空）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard, deleteCard, restoreFromTrash } from '../src/repo.js';

// ⚠ extractImageIds 只认 [0-9a-f-]，图片 id 必须是 UUID 形态
const IMG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('round54 P1：删卡 → 回收站还原，卡片图片必须一起回来', async () => {
  for (const t of ['cards', 'images', 'trash', 'tombstones', 'reviews',
    'cardGroupLinks', 'cardWordLinks', 'cardLinks', 'embeddings', 'notes']) {
    if (db[t]) await db[t].clear();
  }

  await db.images.put({ id: IMG, blob: new Blob(['fake-png']), mime: 'image/png', createdAt: Date.now() });
  const r = await createCard({ front: `看图 sxy-img://${IMG}`, back: '答案' });
  const id = r?.id || r;
  assert.ok(id, '建卡应返回 id');

  // 删卡：孤图会被级联物理删除（这是还原必须带上图片的前提）
  await deleteCard(id);
  assert.equal(await db.images.get(IMG), undefined, '前置条件：删卡后孤图应已被物理删除');

  const entry = await db.trash.get(id);
  assert.ok(entry?.data, '回收站应存在该卡快照');
  assert.ok(Array.isArray(entry.data._images) && entry.data._images.length === 1, '快照必须带上卡片引用的图片');

  await restoreFromTrash(entry);
  assert.ok(await db.cards.get(id), '卡片应已还原');
  assert.ok(await db.images.get(IMG), '图片必须一并还原（此前永久丢失）');
  assert.equal(await db.tombstones.get(IMG), undefined, '还原后必须清掉该图的墓碑，否则下轮同步会把图再删一次');
});
