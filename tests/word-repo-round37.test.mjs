// tests/word-repo-round37.test.mjs —— round37 审计两项修复的回归测试
//   P1-1：dueWordCards 的「缺失 dueAt 一次性修复」必须用差量写（bulkUpdate），
//         绝不能用整行快照 bulkPut 覆盖——否则窗口期内并发复习写入的 SRS 字段被回滚。
//   P3-4：词组 status 字段缺失的旧数据（老版本建的组）不应被误判为「已归档」而整组停车。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDbInstance, getDb } from '../src/db.js';

const { dueWordCards, getParkedWordCardIds } = await import('../src/word-repo.js');

test('P1-1 dueWordCards：补 dueAt 用差量写，不覆盖窗口期内并发复习的 SRS 字段', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.wordCards.clear();
  await db.meta.clear();

  const id = 'r37-w1';
  await db.wordCards.put({
    id, kind: 'word', word: 'abandon', meaning: '放弃', subject: '考研',
    familiar: 0, ease: 2.5, level: 1, intervalDays: 5, reviewedAt: 0,
    dueAt: undefined, // 老版本遗留：无 dueAt → 不在索引里，永远不进复习队列
    createdAt: 1, updatedAt: 1,
  });

  // 模拟并发窗口：修复流程已读到旧快照，此时用户在复习页提交了新的 SRS
  const p = dueWordCards();
  await new Promise((r) => setTimeout(r, 0));
  await db.wordCards.update(id, { ease: 1.6, level: 6, intervalDays: 40, reviewedAt: 999, dueAt: 0 });
  await p;

  const row = await db.wordCards.get(id);
  assert.equal(row.dueAt, 0, '缺失的 dueAt 应补为 0（视为已到期）');
  // 关键断言：旧实现（整行 bulkPut）会把快照里的 5/1 写回，这里必须是并发提交后的新值
  assert.equal(row.intervalDays, 40, '并发复习写入的 intervalDays 不能被旧快照回滚');
  assert.equal(row.level, 6, '并发复习写入的 level 不能被旧快照回滚');
  assert.equal(row.ease, 1.6, '并发复习写入的 ease 不能被旧快照回滚');
  assert.equal(row.reviewedAt, 999, '并发复习写入的 reviewedAt 不能被旧快照回滚');
});

test('P1-1 dueWordCards：修复只跑一次（meta 哨兵），二次调用不重复全表扫描写入', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.wordCards.clear();
  await db.meta.clear();
  await db.wordCards.put({
    id: 'r37-w2', kind: 'word', word: 'anchor', meaning: '锚', familiar: 0,
    dueAt: undefined, createdAt: 1, updatedAt: 1,
  });
  await dueWordCards();
  const sentinel = await db.meta.get('missingDueAtRepaired');
  assert.equal(sentinel?.value, true, '一次性修复后应写入 meta 哨兵');
  const row = await db.wordCards.get('r37-w2');
  assert.equal(row.dueAt, 0);
  await dueWordCards(); // 二次调用不应抛错
  assert.equal((await db.wordCards.get('r37-w2')).dueAt, 0);
});

test('P3-4 getParkedWordCardIds：status 缺失的旧组视为在用，不误停车', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.wordCards.clear();
  await db.wordGroups.clear();
  await db.wordGroupLinks.clear();

  await db.wordCards.put({ id: 'r37-w3', kind: 'word', word: 'x', meaning: 'y', familiar: 0, dueAt: 0, createdAt: 1, updatedAt: 1 });
  // 老版本建的组：没有 status 字段（undefined）
  await db.wordGroups.put({ id: 'r37-g1', name: '旧词组', createdAt: 1, updatedAt: 1 });
  await db.wordGroupLinks.put({ id: 'r37-l1', groupId: 'r37-g1', cardId: 'r37-w3', addedAt: 1 });

  const parked = await getParkedWordCardIds();
  assert.equal(parked.has('r37-w3'), false, 'status 缺失应视为在用（仅显式 archived 才算停车）');
});

test('P3-4 getParkedWordCardIds：显式 archived 的组仍正常停车（修复不破坏原语义）', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.wordCards.clear();
  await db.wordGroups.clear();
  await db.wordGroupLinks.clear();

  await db.wordCards.put({ id: 'r37-w4', kind: 'word', word: 'z', meaning: 'w', familiar: 0, dueAt: 0, createdAt: 1, updatedAt: 1 });
  await db.wordGroups.put({ id: 'r37-g2', name: '已归档', status: 'archived', createdAt: 1, updatedAt: 1 });
  await db.wordGroupLinks.put({ id: 'r37-l2', groupId: 'r37-g2', cardId: 'r37-w4', addedAt: 1 });

  const parked = await getParkedWordCardIds();
  assert.equal(parked.has('r37-w4'), true, 'archived 组内的卡应被判为停车');
});
