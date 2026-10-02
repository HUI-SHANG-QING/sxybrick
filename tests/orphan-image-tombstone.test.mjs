// tests/orphan-image-tombstone.test.mjs —— 删同步表图片必须写墓碑（round123 审计修复）
//
// 背景：卡片页的「孤儿图片」面板此前在**视图层**直接 `db.images.delete(id)`，**不写墓碑**。
//   `images` 是同步表且按 idOnly 幂等 ⇒ 本机删掉的图会在下一次同步被对端/hub 原样灌回来，
//   用户点「清理孤儿图」后换设备或下次同步图又出现 —— 清理**静默失效**。
//   项目其余删图路径都是「先写 kind='image' 墓碑 → 再物理删」：
//     · repo.deleteCard（repo.js:698-704，注释「round26 D3：先写墓碑、后物理删」）
//     · repo.deleteNote（同样的两行）
//   所以 Cards.vue 是唯一漏网点。
// 修复：收口到 repo.deleteOrphanImages（单事务：墓碑 + 物理删），视图层不再直接碰 db.images。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db } from '../src/db.js';
import { deleteOrphanImages, cleanupOrphanImages } from '../src/repo.js';

beforeEach(async () => {
  await db.images.clear();
  await db.tombstones.clear();
});

test('删除孤儿图片必须同时写 kind=image 墓碑（否则跨设备会复活）', async () => {
  await db.images.bulkPut([{ id: 'img-a', createdAt: 1 }, { id: 'img-b', createdAt: 2 }]);

  const n = await deleteOrphanImages(['img-a', 'img-b']);
  assert.equal(n, 2, '应删除 2 张');

  assert.equal(await db.images.get('img-a'), undefined, '图片行应被物理删除');
  assert.equal(await db.images.get('img-b'), undefined);
  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'image');
  assert.deepEqual(
    tombs.map((t) => t.id).sort(), ['img-a', 'img-b'],
    '每张被删的图都必须有 kind="image" 墓碑 —— 缺墓碑时同步会按 idOnly 幂等把它灌回来',
  );
});

test('墓碑 deletedAt 必须是本次删除时刻（0/旧值会被对端判为 stale 而不删）', async () => {
  await db.images.put({ id: 'img-c', createdAt: 1000 });
  const before = Date.now();
  await deleteOrphanImages(['img-c']);
  const t = (await db.tombstones.toArray()).find((x) => x.id === 'img-c');
  assert.ok(t, '应写墓碑');
  assert.ok(t.deletedAt >= before, `墓碑 deletedAt（${t.deletedAt}）必须是本次删除时刻`);
});

test('入参去重与空值过滤：不抛错、不产生多余墓碑', async () => {
  assert.equal(await deleteOrphanImages([]), 0);
  assert.equal(await deleteOrphanImages(null), 0);
  assert.equal(await deleteOrphanImages(['', null, undefined]), 0);
  await db.images.put({ id: 'img-d', createdAt: 1 });
  assert.equal(await deleteOrphanImages(['img-d', 'img-d']), 1, '重复 id 只算一次');
  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'image');
  assert.equal(tombs.length, 1, '去重后只应有 1 条墓碑');
});

test('结构闸门：视图层不得再直接写/删 db.images（必须收口到 repo）', () => {
  const src = readFileSync(new URL('../src/views/Cards.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src, /db\.images\s*\.\s*(delete|bulkDelete|put|add|update|clear)\(/,
    'Cards.vue 不得直接写/删 db.images —— 删同步表图片必须走 repo.deleteOrphanImages（那里会写墓碑）。',
  );
});

test('结构闸门：Health.vue 也不得直接删 db.images（同一缺口的另一个入口）', () => {
  // 健康页有「清理孤儿图片」按钮 + 「一键修复」，两条路径此前都直接 db.images.delete。
  const src = readFileSync(new URL('../src/views/Health.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src, /db\.images\s*\.\s*(delete|bulkDelete|put|add|update|clear)\(/,
    'Health.vue（清理孤儿图片 / 一键修复）不得直接删 db.images —— 必须走 repo.deleteOrphanImages。',
  );
});

test('cleanupOrphanImages：自包含墓碑（旧契约要求调用方先写，极易被漏）', async () => {
  await db.cards.clear();
  await db.images.clear();
  await db.tombstones.clear();
  // ⚠️ 图片 id 必须是**合法 UUID**：extractImageIds 的正则只匹配 [0-9a-fA-F-]，
  //    用 'img-keep-1234' 这类字符串会匹配不到 → 判成孤儿 → 测试得出错误结论（round119 踩过）。
  const KEEP = 'a1b2c3d4-1111-2222-3333-444444444444';
  const DROP = 'b2c3d4e5-1111-2222-3333-444444444444';
  await db.cards.put({ id: 'oc-1', front: `看图 ![](sxy-img://${KEEP})`, back: '', subject: 's', updatedAt: 1, createdAt: 1 });
  await db.images.bulkPut([{ id: KEEP, createdAt: 1 }, { id: DROP, createdAt: 1 }]);

  const removed = await cleanupOrphanImages([KEEP, DROP]);
  assert.deepEqual(removed, [DROP], '只应删掉无人引用的那张（被卡引用的必须保留）');

  assert.equal(await db.images.get(DROP), undefined, '孤儿图应被物理删除');
  assert.notEqual(await db.images.get(KEEP), undefined, '被卡引用的图绝不能删');
  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'image');
  assert.deepEqual(
    tombs.map((t) => t.id), [DROP],
    'cleanupOrphanImages 必须自包含地写 kind="image" 墓碑（此前契约把这一步推给调用方，无人调用=无人写）',
  );
});
