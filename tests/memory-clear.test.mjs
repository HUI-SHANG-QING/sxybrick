// tests/memory-clear.test.mjs —— round110：记忆批量清空（含墓碑不变量）
//
// 为什么必须验证墓碑：同步语义是 merge:'updatedAt' —— **absence ≠ deletion**。
// 清空若不逐条写墓碑，对端/中枢会在下次同步把清掉的记忆原样推回来（用户会看到"清不掉"）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { clearMemories, addMemory, listMemories } from '../src/agent/memory.js';
import { clearMemories as clearViaAi } from '../src/ai.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });
beforeEach(async () => { await db.aiMemories.clear(); await db.tombstones.clear(); });

test('清空全部：返回条数、表清空、且**每条都写了墓碑**（否则同步会复活）', async () => {
  await addMemory({ content: '核心事实 A', category: 'core' });
  await addMemory({ content: '偏好 B', category: 'preference' });
  await addMemory({ content: '事实 C', category: 'fact' });
  const before = await db.aiMemories.toArray();
  assert.equal(before.length, 3);

  const removed = await clearMemories();
  assert.equal(removed, 3);
  assert.equal(await db.aiMemories.count(), 0, '记忆表应清空');

  const tombs = await db.tombstones.toArray();
  const ids = tombs.filter((t) => t.kind === 'memory').map((t) => t.id).sort();
  assert.deepEqual(ids, before.map((m) => m.id).sort(), '每条被删的记忆都必须有 kind=memory 的墓碑');
});

test('按类别清空：只清该类，其它类原样保留', async () => {
  await addMemory({ content: '核心事实', category: 'core' });
  await addMemory({ content: '事实 1', category: 'fact' });
  await addMemory({ content: '事实 2', category: 'fact' });

  const removed = await clearMemories({ category: 'fact' });
  assert.equal(removed, 2);
  const left = await listMemories();
  assert.equal(left.length, 1);
  assert.equal(left[0].category, 'core', '清空 fact 不得波及 core');
});

test('非法类别当作「全部」处理（防御式：不静默删错范围）', async () => {
  await addMemory({ content: '唯一的记忆', category: 'fact' });
  const removed = await clearMemories({ category: 'not-a-category' });
  assert.equal(removed, 1, '非法类别不应被当成合法筛选（否则会静默什么都不删）');
});

test('空表时返回 0 且不抛（界面点了「清空」不该报错）', async () => {
  assert.equal(await clearMemories(), 0);
  assert.equal(await clearMemories({ category: 'core' }), 0);
});

test('ai.js 包装：传类别则只清该类，不传则清全部', async () => {
  await addMemory({ content: 'A', category: 'core' });
  await addMemory({ content: 'B', category: 'preference' });
  assert.equal(await clearViaAi('core'), 1);
  assert.equal((await listMemories()).length, 1, '只应剩下 preference');
  assert.equal(await clearViaAi(), 1, '不传参 = 清全部');
  assert.equal(await db.aiMemories.count(), 0);
});
