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
import { readFileSync } from 'node:fs';
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

// round75 审计新增（契约⑤）：把 round57 的「共享快照」契约从**只盯 5 个已迁移函数**
// 升级为**结构性闸门** —— analytics.js 里任何裸 `db.cards/reviews.toArray()` 都必须落在
// 「已委托给 Web Worker」的函数里（那些在 worker 线程跑，不阻塞主线程）；
// 其余主线程函数必须改用 dashboardSnapshot()。
//
// 为什么加：审计扫全仓时发现 getDueForecast / getNetWorth / getSourceOverview 三个主线程函数
// 一直绕开快照（旧 P1「analytics 全表 toArray」只修了最热的 5 个，剩下的没人管），
// 而 round57 的测试只覆盖已迁移的那 5 个 → 漏网者可以长期存在。本闸门按「违规形态」定义，
// 白名单**从 analytics.worker.js 的实际导入派生**（不是手写清单），新增委托时自动生效。
test('round57 性能契约⑤：analytics 的裸全表读只允许出现在 Worker 委托函数里', () => {
  const analyticsSrc = readFileSync(new URL('../src/agent/analytics.js', import.meta.url), 'utf8');
  const workerSrc = readFileSync(new URL('../src/agent/analytics.worker.js', import.meta.url), 'utf8');

  // 白名单 = worker 从 analytics.js 导入的函数名（真正在 worker 线程执行的）
  const imported = /import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/analytics\.js['"]/.exec(workerSrc);
  assert.ok(imported, '必须能从 analytics.worker.js 解析出导入块（解析失败说明结构变了，闸门需同步）');
  const workerFns = new Set(imported[1].split(',').map((s) => s.trim()).filter(Boolean));
  assert.ok(workerFns.size >= 4, `白名单异常偏小（${workerFns.size}）：${[...workerFns].join(',')}`);

  // 白名单还须包含 Worker 委托函数的**私有实现**（`_getConfusablePairs` 这类）：
  // worker 线程里 offload 返回 _FALLBACK → 公共 wrapper 原地调用私有实现，仍在 worker 线程执行。
  const allowed = new Set([...workerFns, ...[...workerFns].map((n) => '_' + n)]);

  // 逐个裸全表读定位其所属函数。
  // ⚠️ 必须先剥掉注释：本文件里就有解释性注释写着 `db.cards.toArray()`，
  // 不剥注释会把注释当违规（实测误报过一次）。
  const codeOnly = analyticsSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:'"`])\/\/[^\n]*/, '$1'));

  const offenders = [];
  let fn = '(module)';
  codeOnly.forEach((line, i) => {
    const m = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (m) fn = m[1];
    if (/db\.(cards|reviews)\.toArray\(\)/.test(line) && !allowed.has(fn)) {
      offenders.push(`${fn}（第 ${i + 1} 行）`);
    }
  });
  assert.deepEqual(
    offenders, [],
    '这些主线程函数绕开了 dashboardSnapshot()：' + offenders.join('、')
      + '。改用 `const { cards } = await dashboardSnapshot();`，或把函数委托给 Worker。',
  );
});

// round75 审计新增（契约⑥）：repo.js 里**所有**写 db.cards / db.reviews 的函数，
// 必须显式调 invalidateDashboardCache()，或落入「key 天然覆盖」白名单。
//
// 白名单 = 改变「卡数」的写路径（新建/删除/回收站还原）：快照 key 含 count，
// 行数一变 key 必变 → 天然失效。**其余（改字段类）必须显式失效**，因为
// 「同一毫秒内第二次编辑」不会改变最大 updatedAt → key 不变 → 命中陈旧快照。
// 本轮审计实证：updateCard / setMarked 属于此类却未显式失效（已补）。
test('round57 性能契约⑥：repo 的 cards/reviews 写路径必须显式失效快照（或属 key 已覆盖的增删类）', () => {
  // key 含 count → 行数变化即天然换 key，无需显式失效
  const KEY_COVERED = new Set(['createCard', 'deleteCard', 'restoreFromTrash']);
  const src = readFileSync(new URL('../src/repo.js', import.meta.url), 'utf8');
  const WRITE = /db\.(cards|reviews)\.(put|bulkPut|delete|add|update|clear)\(/;

  // 按「顶格声明的函数」切段：嵌套函数（缩进声明）不得重置归属。
  // 反例（实测）：deleteNote 内部有嵌套函数，若用「最后见到的函数名」归属，
  // 函数末尾的失效调用会被算到嵌套函数头上，deleteNote 被误报。
  const TOP_FN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const lines = src.split(/\r?\n/);
  const segs = [];
  lines.forEach((line, i) => {
    const m = TOP_FN.exec(line);
    if (m) segs.push({ name: m[1], start: i, lines: [] });
    if (segs.length) segs[segs.length - 1].lines.push(line);
  });

  const offenders = [];
  for (const seg of segs) {
    const body = seg.lines.join('\n');
    if (!WRITE.test(body)) continue;
    if (KEY_COVERED.has(seg.name)) continue;
    if (/invalidateDashboardCache\(\)/.test(body)) continue;
    offenders.push(seg.name);
  }

  assert.deepEqual(
    offenders, [],
    '这些函数改了卡片/复习却没显式失效快照：' + offenders.join('、')
      + '。加 `invalidateDashboardCache();`，或（若会改变行数）登记进 KEY_COVERED 白名单。',
  );
});
