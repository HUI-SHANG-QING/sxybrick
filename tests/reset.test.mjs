// 「清空全部数据」功能测试（替代已移除的多用户体系测试）
// 覆盖：resetAllData 原子清空当前实例全部表；清空后实例仍可用。
// 注意：resetAllData 作用于当前 live-binding 实例，故每个用例先用 setDbInstance('test')
// 隔离到测试库，结束再 setDbInstance('real') 还原，避免污染后续用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { setDbInstance, getDb } from '../src/db.js';
import { resetAllData } from '../src/stores/reset.js';

test('resetAllData 清空当前实例全部表（cards/reviews/trash）', async () => {
  setDbInstance('test');
  const d = getDb();
  await d.cards.bulkPut([
    { id: 'r1', front: 'A 的卡片', subject: '数学' },
    { id: 'r2', front: 'B 的卡片', subject: '英语' },
  ]);
  await d.reviews.bulkPut([{ id: 'rv1', cardId: 'r1', grade: 2, reviewedAt: Date.now() }]);
  await d.trash.bulkPut([{ id: 't1', kind: 'card', deletedAt: Date.now(), data: { id: 'r9' } }]);

  assert.equal((await d.cards.toArray()).length, 2, '清空前应有 2 张卡');
  assert.equal((await d.reviews.toArray()).length, 1, '清空前应有 1 条复习');

  const r = await resetAllData();

  assert.equal((await d.cards.toArray()).length, 0, '卡片被清空');
  assert.equal((await d.reviews.toArray()).length, 0, '复习记录被清空');
  assert.equal((await d.trash.toArray()).length, 0, '回收站被清空');
  assert.ok(r.tables >= 1, '返回表数量');

  // 清空后实例仍可用：可重新写入
  await d.cards.put({ id: 'r-new', front: '新卡', subject: '数学' });
  assert.equal((await d.cards.toArray()).length, 1, '清空后实例仍可用');

  setDbInstance('real'); // 还原，避免影响后续用例
});

test('resetAllData 不影响其它实例（test 与 real 物理隔离）', async () => {
  setDbInstance('real');
  const real = getDb();
  await real.cards.put({ id: 'keep-real', front: '应保留', subject: '数学' });

  setDbInstance('test');
  const test = getDb();
  await test.cards.put({ id: 'only-test', front: '应清空', subject: '英语' });

  await resetAllData(); // 清空的是 test 实例

  assert.equal((await test.cards.toArray()).length, 0, 'test 实例被清空');
  setDbInstance('real');
  assert.equal((await real.cards.toArray()).length, 1, 'real 实例不受影响');

  setDbInstance('real'); // 已是 real，幂等
});
