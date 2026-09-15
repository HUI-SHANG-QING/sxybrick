// round57 回归：备份导入的**存储配额路径**（QuotaExceededError）必须降级而非抛出。
//
// 背景（实证）：图片 base64→Blob 的写库刻意拆在主事务之外（round11 N1 / round18 根因：
// 大 base64 阻塞事务、单张坏图不再回滚整 31 表导入）。注释里的理由只覆盖了「单张坏图」，
// 没覆盖「整批写不进去」。实测：db.images.bulkPut 抛 QuotaExceededError 时异常一路冒出
// importBackup → 调用方 Sync.vue confirmImport 走 error 分支 → 只弹原始 QuotaExceededError，
// 既不 loadCounts() 也不 saveReport()，用户以为"什么都没导入"，实际卡片/复习已落库、图片全缺。
//
// 修后契约：图片写库失败 → 不抛出；主数据保持已入库；缺图数量进 stats.imageWriteFailed。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { importBackup, BACKUP_VERSION } from '../src/sync.js';

// ⚠ extractImageIds 只认 [0-9a-f-]，图片 id 必须是 UUID 形态
const IMG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// 1x1 透明 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// 版本号取导出常量，避免随 BACKUP_VERSION 演进失效
function mkBackup(overrides = {}) {
  return {
    app: 'sxybrick',
    version: BACKUP_VERSION,
    scope: 'real',
    exportedAt: Date.now(),
    tombstones: [],
    images: [{ id: IMG, data: PNG_B64, mime: 'image/png' }],
    streakMeta: null, examMeta: null, schedMeta: null,
    cards: [{ id: 'c1', front: `看图 sxy-img://${IMG}`, back: 'b', subject: 'x', createdAt: 1, updatedAt: 1, reviewedAt: 0 }],
    reviews: [],
    ...overrides,
  };
}

async function reset() {
  for (const t of ['cards', 'reviews', 'images', 'meta', 'tombstones', 'snapshots', 'trash', 'cardGroupLinks', 'cardWordLinks', 'cardLinks', 'embeddings', 'notes']) {
    if (db[t]) await db[t].clear();
  }
}

function quotaError() {
  const e = new Error('The quota has been exceeded.');
  e.name = 'QuotaExceededError';
  return e;
}

test('round57 P2：图片写库撞配额 → 不抛出，主数据入库 + imageWriteFailed 计数', async () => {
  await reset();
  const orig = db.images.bulkPut;
  db.images.bulkPut = async () => { throw quotaError(); };
  let stats = null;
  let threw = null;
  try {
    stats = await importBackup(mkBackup(), { skipSnapshot: true });
  } catch (e) {
    threw = e;
  } finally {
    db.images.bulkPut = orig;
  }

  assert.equal(threw, null, '不得抛出——抛出会让调用方误判"整包导入失败"（实际主数据已落库）');
  assert.ok(stats, '应正常返回统计');
  assert.equal(await db.cards.count(), 1, '主数据（卡片）必须已入库');
  assert.equal(await db.images.count(), 0, '图片确实没写进去');
  assert.equal(stats.imageWriteFailed, 1, '缺图数量必须显式汇报，否则用户只看到"导入成功却全是破图"');
  assert.equal(stats.images, 0, '写入失败时 stats.images 不得虚报成功数');
});

test('round57 P2：单张坏图（解码失败）走 skippedImages，不得污染 imageWriteFailed', async () => {
  await reset();
  const stats = await importBackup(mkBackup({ images: [{ id: IMG, data: '!!!not-base64!!!', mime: 'image/png' }] }), { skipSnapshot: true });

  assert.equal(stats.skippedImages, 1, '坏图应计入 skippedImages（语义：可重新导入补齐）');
  assert.equal(stats.imageWriteFailed, undefined, '坏图不是"写库失败"，两个计数必须语义分离');
  assert.equal(await db.cards.count(), 1, '主数据照常入库');
});

test('round57 P2：主事务内的配额失败仍必须整体回滚（quotaExceeded 文案的前提）', async () => {
  await reset();
  const orig = db.cards.bulkPut;
  db.cards.bulkPut = async () => { throw quotaError(); };
  let threw = null;
  try {
    await importBackup(mkBackup(), { skipSnapshot: true });
  } catch (e) {
    threw = e;
  } finally {
    db.cards.bulkPut = orig;
  }

  assert.equal(threw?.name, 'QuotaExceededError', '主事务内失败应抛出，交由调用方提示');
  assert.equal(await db.cards.count(), 0, '事务必须整体回滚——"未写入任何数据"是给用户的承诺，不能是假的');
  assert.equal(await db.images.count(), 0, '图片段在事务之后，主事务失败时不应执行');
});

test('round57 P3：损坏包（字段存在但非数组）必须给出可读错误，而不是裸 TypeError', async () => {
  await reset();
  let threw = null;
  try {
    await importBackup(mkBackup({ cards: {} }), { skipSnapshot: true });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '损坏包必须拒收');
  assert.notEqual(threw.name, 'TypeError', '不得再把 `(...).filter is not a function` 抛给用户');
  assert.match(threw.message, /结构损坏/, '错误信息必须说明是文件结构问题');
  assert.match(threw.message, /cards/, '要点名是哪个字段坏了，用户才知道该改哪里');
  assert.equal(await db.cards.count(), 0, '拒收时不得写入任何数据');
});

test('round57 P3：字段缺失（老版本包）仍须容忍，不能被结构校验误伤', async () => {
  await reset();
  const b = mkBackup();
  delete b.reviews;   // 老包可能没有该表
  delete b.tombstones;
  const stats = await importBackup(b, { skipSnapshot: true });
  assert.equal(await db.cards.count(), 1, '缺失字段必须走 `|| []` 兜底（向后兼容），只拦"存在但类型错"');
  assert.equal(stats.cards, 1);
});
