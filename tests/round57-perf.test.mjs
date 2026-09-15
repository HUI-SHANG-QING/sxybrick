// round57 性能回归：主线程全表扫的「共享快照」契约
//
// 背景（实证）：repo.js 早有 round33 C-2 建立的 dashboardSnapshot()（按 count+时间戳自失效、
// 并发调用只物化一次），但 agent/analytics.js 的多个首屏函数各自再 `db.reviews.toArray()` 绕过它。
// 实测 3000 卡/6 万复习：单次 reviews 全表扫 436ms，getRecentMistakes+getForgetRisk+getLearningProfile
// 串行 1591ms 全阻塞主线程 → 收口后 186ms（8.6×）。
//
// 本测试守两条契约：
//   ① 消费方不得再自扫全表（快照命中后应为 0 次全表扫）；
//   ② 消费方不得**原地修改**共享数组（sort/push/splice 会污染其他消费者，且缓存键不含内容，不会自愈）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { dashboardSnapshot, invalidateDashboardCache } from '../src/repo.js';
import {
  getRecentMistakes, getForgetRisk, getLearningProfile, getCalibration, getAssetHealth,
  shutdownAnalyticsWorker,
} from '../src/agent/analytics.js';

const DAY = 86400000;
const nowTs = Date.now();

async function seed() {
  for (const t of ['cards', 'reviews', 'images', 'meta', 'tombstones']) { try { await db[t].clear(); } catch {} }
  const cards = [];
  for (let i = 0; i < 400; i++) {
    cards.push({
      id: 'c' + i, front: '正面' + i, back: '背面', subject: 's' + (i % 5),
      createdAt: nowTs - 120 * DAY, updatedAt: nowTs - (i % 120) * DAY,
      dueAt: nowTs - (i % 20) * DAY, tags: i % 3 ? ['t'] : [],
    });
  }
  await db.cards.bulkPut(cards);
  const reviews = [];
  for (let i = 0; i < 2000; i++) {
    reviews.push({
      id: 'r' + i, cardId: 'c' + (i % 400), reviewedAt: nowTs - (i % 120) * DAY - (i % 60) * 60000,
      rating: i % 5 === 0 ? 0 : 2, type: i % 17 === 0 ? 'quick' : 'srs',
    });
  }
  await db.reviews.bulkPut(reviews);
}

/** 统计全表扫次数：包住 db.<table>.toArray */
function countFullScans() {
  const orig = { reviews: db.reviews.toArray, cards: db.cards.toArray };
  const n = { reviews: 0, cards: 0 };
  db.reviews.toArray = function (...a) { n.reviews++; return orig.reviews.apply(this, a); };
  db.cards.toArray = function (...a) { n.cards++; return orig.cards.apply(this, a); };
  return { n, restore() { db.reviews.toArray = orig.reviews; db.cards.toArray = orig.cards; } };
}

test('round57 性能契约①：首屏分析函数共用快照，不得各自再全表扫', async () => {
  await seed();
  // 预热：让 dashboardSnapshot 物化一次（缓存键=count+最新时间戳）
  await dashboardSnapshot();

  const c = countFullScans();
  try {
    await getRecentMistakes(7);
    await getForgetRisk(5);
    await getLearningProfile();
    await getCalibration();
    await getAssetHealth();
  } finally {
    c.restore();
  }

  assert.equal(c.n.reviews, 0, '快照已命中时，5 个首屏函数都不应再读 reviews 全表（原先 5 次）');
  assert.equal(c.n.cards, 0, 'cards 同样不得再全表扫（原先多个函数各扫一遍）');
  await shutdownAnalyticsWorker();
});

test('round57 性能契约②：消费方不得原地修改共享快照数组', async () => {
  await seed();
  const snapA = await dashboardSnapshot();
  const sigRev = snapA.reviews.map(r => r.id).join(',');
  const sigCard = snapA.cards.map(c => c.id).join(',');
  const lenRev = snapA.reviews.length;
  const lenCard = snapA.cards.length;

  await getRecentMistakes(7);
  await getForgetRisk(5);
  await getLearningProfile();
  await getCalibration();
  await getAssetHealth();

  const snapB = await dashboardSnapshot();
  assert.equal(snapB.reviews.length, lenRev, '共享 reviews 长度不得被消费方改变');
  assert.equal(snapB.cards.length, lenCard, '共享 cards 长度不得被消费方改变');
  assert.equal(snapB.reviews.map(r => r.id).join(','), sigRev, '共享 reviews 顺序不得被原地 sort 打乱');
  assert.equal(snapB.cards.map(c => c.id).join(','), sigCard, '共享 cards 顺序不得被原地 sort 打乱');
  await shutdownAnalyticsWorker();
});

test('round57 性能契约③：收口后结果语义不变（真实复习口径 / 孤儿图仍能识别）', async () => {
  await seed();
  // 放两张图：一张被卡片引用、一张是孤儿
  const used = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
  const orphan = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
  await db.images.bulkPut([
    { id: used, blob: new Blob(['x']), mime: 'image/png', createdAt: nowTs },
    { id: orphan, blob: new Blob(['y']), mime: 'image/png', createdAt: nowTs },
  ]);
  const c0 = await db.cards.get('c0');
  // 真实写入语义：repo 改卡必定 bump updatedAt → 快照 key 随之变化并重建
  await db.cards.put({ ...c0, front: `看图 sxy-img://${used}`, updatedAt: Date.now() });

  const h = await getAssetHealth();
  assert.equal(h.orphanImageCount, 1, '孤儿图应被识别（且只统计未被引用那张）');
  assert.deepEqual(h.orphanImages.map(i => i.id), [orphan], '孤儿图 id 必须准确');

  const mistakes = await getRecentMistakes(400);
  assert.ok(Array.isArray(mistakes), '错题聚合应正常返回');
  assert.ok(mistakes.length > 0, '存在答错记录时必须聚合出错题');
  await shutdownAnalyticsWorker();
});

// round57 性能契约④：快照 key **不完备**，故写路径的显式失效不可省。
// 反例（本次审计实测）：原地改写某张卡的字段而不 bump updatedAt，且该卡不是 updatedAt 最大者
// → count 与「最新时间戳」双双不变 → 命中陈旧快照。缓存键不看内容，陈旧不会自愈。
// 这条测试同时守住两件事：① 记录该局限（别依赖 key）；② 显式失效必须真的能清缓存。
test('round57 性能契约④：key 不完备 → 写路径必须显式失效，且失效必须真的生效', async () => {
  await seed();
  const before = (await dashboardSnapshot()).cards.find(c => c.id === 'c1');
  assert.ok(before, '前置：c1 应存在');

  // 原地改写但不 bump updatedAt，且 c1 不是 updatedAt 最大者（c0 是）→ key 不变
  await db.cards.put({ ...before, front: '原地改写的正面' });
  const staleHit = (await dashboardSnapshot()).cards.find(c => c.id === 'c1');
  assert.equal(staleHit.front, before.front, '证明 key 不完备：此处仍返回陈旧快照（正是不许依赖 key 的原因）');

  // 显式失效后必须重建
  invalidateDashboardCache();
  const fresh = (await dashboardSnapshot()).cards.find(c => c.id === 'c1');
  assert.equal(fresh.front, '原地改写的正面', 'invalidated 后必须读到新值——写路径漏调它会静默陈旧');
  await shutdownAnalyticsWorker();
});
