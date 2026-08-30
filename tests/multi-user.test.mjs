import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { setDbInstance, getUserDb } from '../src/db.js';

test('多用户：不同档案的库物理隔离、互不可见', async () => {
  const a = getUserDb('u_iso_a');
  const b = getUserDb('u_iso_b');
  await a.cards.put({ id: 'c-a', front: 'A 的卡片', subject: '数学' });
  await b.cards.put({ id: 'c-b', front: 'B 的卡片', subject: '英语' });
  const aCards = await a.cards.toArray();
  const bCards = await b.cards.toArray();
  assert.deepEqual(aCards.map((c) => c.id), ['c-a']);
  assert.deepEqual(bCards.map((c) => c.id), ['c-b']);
  assert.equal(a.name, 'sxybrick_u_iso_a');
  assert.equal(b.name, 'sxybrick_u_iso_b');
});

test('setDbInstance 切换到用户库后 live binding 指向正确实例', async () => {
  const d = setDbInstance('real', 'u_iso_c');
  assert.equal(d.name, 'sxybrick_u_iso_c');
  const def = setDbInstance('real');
  assert.equal(def.name, 'sxybrick');
});

test('迁移：部分卡片连同关联边复制到目标库（源库不改）', async () => {
  const { migrateData } = await import('../src/user.js');
  const src = getUserDb('u_src');
  const dst = getUserDb('u_dst');
  await src.cards.bulkPut([
    { id: 'k1', front: '重要卡1', subject: '数学' },
    { id: 'k2', front: '重要卡2', subject: '数学' },
    { id: 'k3', front: '搁置卡', subject: '英语' },
  ]);
  await src.graphEdges.bulkPut([
    { id: 'e1', fromCardId: 'k1', toCardId: 'k2', label: '前置' },
    { id: 'e2', fromCardId: 'k1', toCardId: 'k3', label: '无关' },
  ]);
  const r = await migrateData('u_src', 'u_dst', { subjects: ['数学'] });
  assert.equal(r.cards, 2, '只迁移数学的 2 张');
  assert.equal(r.edges, 1, '只迁移两端都在范围内的边 e1');
  const dstCards = await dst.cards.toArray();
  assert.deepEqual(dstCards.map((c) => c.id).sort(), ['k1', 'k2']);
  const dstEdges = await dst.graphEdges.toArray();
  assert.deepEqual(dstEdges.map((e) => e.id), ['e1']);
  assert.equal((await src.cards.toArray()).length, 3, '源库不被改动（复制非移动）');
});

test('迁移幂等：重复执行不丢数据、不报错', async () => {
  const { migrateData } = await import('../src/user.js');
  const r = await migrateData('u_src', 'u_dst', { subjects: ['数学'] });
  assert.equal(r.cards, 2);
  const dst = getUserDb('u_dst');
  assert.equal((await dst.cards.toArray()).length, 2);
});

test('迁移范围按全量：迁移全部卡片', async () => {
  const { migrateData } = await import('../src/user.js');
  const src = getUserDb('u_src_all');
  const dst = getUserDb('u_dst_all');
  await src.cards.bulkPut([
    { id: 'x1', front: 'A', subject: '数学' },
    { id: 'x2', front: 'B', subject: '英语' },
  ]);
  const r = await migrateData('u_src_all', 'u_dst_all', { all: true });
  assert.equal(r.cards, 2);
  assert.equal((await dst.cards.toArray()).length, 2);
});
