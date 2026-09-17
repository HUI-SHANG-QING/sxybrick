// tests/failcount-snapshot-reuse.test.mjs —— round106：答错次数复用首页快照的性能改动，不得引入陈旧值
//
// 背景：/cards 首屏会同时要「统计快照」与「答错次数」，旧实现各自全表扫一遍 reviews
// （实测 3000 卡/6 万复习：快照 151ms + failCount 76ms）。改为 failCount 冷启时复用快照的行，
// **但对账守卫必须有效**：快照自身的缓存键不含「最新行的 id」，同毫秒换行时可能拿到陈旧行。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { dashboardSnapshot, failCountMap, invalidateFailCountCache, review } from '../src/repo.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const mkCard = (i) => ({
  id: 'c' + i, front: 'F' + i, back: 'B', subject: 's', tags: [],
  createdAt: 1, updatedAt: 1 + i, dueAt: 1, level: 1, intervalDays: 1,
});
const mkReview = (id, cardId, rating, reviewedAt) => ({ id, cardId, rating, type: 'srs', reviewedAt });

beforeEach(async () => {
  for (const t of ['cards', 'reviews']) { try { await db[t].clear(); } catch { /* ignore */ } }
  invalidateFailCountCache();
});

test('复用快照后结果与直接全表统计一致', async () => {
  await db.cards.bulkPut([mkCard(1), mkCard(2), mkCard(3)]);
  await db.reviews.bulkPut([
    mkReview('r1', 'c1', 0, 1000), mkReview('r2', 'c1', 0, 2000), mkReview('r3', 'c1', 2, 3000),
    mkReview('r4', 'c2', 0, 4000), mkReview('r5', 'c3', 2, 5000),
    mkReview('r6', 'c3', 0, 6000),
  ]);
  invalidateFailCountCache();
  const a = await failCountMap();
  // 先热快照再取（走复用路径）
  await dashboardSnapshot();
  invalidateFailCountCache();
  const b = await failCountMap();
  assert.equal(a.get('c1'), 2);
  assert.equal(a.get('c2'), 1);
  assert.equal(b.get('c1'), 2, '复用快照后必须与原结果一致');
  assert.equal(b.get('c2'), 1);
  assert.equal(b.get('c3'), 1);
});

test('quick 行不计入答错次数（沿用 realReviews 口径）', async () => {
  await db.cards.bulkPut([mkCard(1)]);
  await db.reviews.bulkPut([
    mkReview('r1', 'c1', 0, 1000),
    { id: 'r2', cardId: 'c1', rating: 0, type: 'quick', reviewedAt: 2000 },
  ]);
  invalidateFailCountCache();
  await dashboardSnapshot();
  invalidateFailCountCache();
  assert.equal((await failCountMap()).get('c1'), 1, '快检答错不该把卡标红');
});

test('同毫秒换行（行数/最新时间戳都不变、id 变了）→ 对账守卫必须拦截陈旧快照', async () => {
  await db.cards.bulkPut([mkCard(1)]);
  await db.reviews.bulkPut([mkReview('r1', 'c1', 2, 5000)]); // 最新一条：记得，不计错
  await dashboardSnapshot(); // 先把快照热起来（内容是 r1）
  assert.equal((await failCountMap()).get('c1'), undefined, '前置：此时没有答错记录');

  // 直接改库：把最新那条换成同时间戳的另一条（答错）。
  // 行数不变、最新 reviewedAt 不变 → **快照自己的 key 不变，会命中陈旧快照**；
  // failCount 的 key 含该行 id 故会 miss —— 此时必须靠对账守卫发现快照过期，而不是拿陈旧行算。
  await db.reviews.delete('r1');
  await db.reviews.put(mkReview('r2', 'c1', 0, 5000));

  const m = await failCountMap();
  assert.equal(m.get('c1'), 1, '必须看到新增的那次答错（不得复用陈旧快照）');
});

test('正常写路径（review()）后立刻更新', async () => {
  await db.cards.bulkPut([mkCard(1)]);
  await dashboardSnapshot();
  await review('c1', 0); // review() 内部会失效两个缓存
  assert.equal((await failCountMap()).get('c1'), 1, '复习答错后应立刻可见');
});
