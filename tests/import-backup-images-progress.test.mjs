// tests/import-backup-images-progress.test.mjs —— round11 N1 方案 A 回归
//   ① 图片 base64→Blob 拆到事务外：好图落库 + 坏图跳过不阻断主数据
//   ② onProgress 6 阶段触发顺序：snapshot → dedupe → tombstones → tables → cascade → images
//   ③ onProgress 缺省/非函数/抛错时静默跳过，不阻断导入主链
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db, setDbInstance, getDb } from '../src/db.js';
import { importBackup, getEffectiveSyncTables } from '../src/sync.js';

after(async () => { try { await db.close(); } catch {} });

// 隔离用例：清空全部同步表 + 快照 + meta + images
async function resetAll() {
  setDbInstance('real');
  const d = getDb();
  for (const t of getEffectiveSyncTables()) {
    try { await d[t.table].clear(); } catch { /* 表不存在则跳过 */ }
  }
  await d.tombstones.clear();
  await d.snapshots.clear();
  await d.meta.clear();
  await d.images.clear();
}

function mkCard(id, extra = {}) {
  return {
    id, front: `Q-${id}`, back: `A-${id}`, subject: '计组', type: 'basic', tags: [],
    ease: 2.5, level: 0, intervalDays: 0, dueAt: 1000, reviewedAt: 0,
    createdAt: 1000, updatedAt: 1000, ...extra,
  };
}

// 1x1 透明 PNG 的标准 base64（96 字符，4 倍数）
const GOOD_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
// 含非法 base64 字符 '@'——atob 必抛 InvalidCharacterError（atob 对非 4 倍数会容错，
// 但遇到非合法字符集立刻抛错，故不能用截断字符串当坏样本）
const BAD_B64_INVALID = '@@@@@@@@@@';

// ───────────────── 一、图片解码拆出事务外 ─────────────────

test('N1 方案 A：图片解码在事务外执行，好图落库 + 坏图不阻断主数据 + stats.skippedImages', async () => {
  await resetAll();
  const d = getDb();
  const backup = {
    app: 'sxybrick',
    version: 7,
    cards: [mkCard('card1')],
    images: [
      { id: 'good-img', data: GOOD_PNG_B64, mime: 'image/png' },
      { id: 'bad-img', data: BAD_B64_INVALID, mime: 'image/png' },
    ],
  };
  // 修复前：坏图 atob 抛错发生在 31 表大事务内 → 整事务 AbortError → 卡片也回滚
  // 修复后：图片拆到事务外，坏图仅 console.warn + stats.skippedImages，主数据安然落库
  const stats = await importBackup(backup, { skipSnapshot: true });

  assert.equal(stats.cards, 1, '主数据卡片应落库（坏图不应回滚）');
  assert.equal(stats.images, 1, '好图应落库');
  assert.equal(stats.skippedImages, 1, '坏图应记入 skippedImages');

  const goodRow = await d.images.get('good-img');
  assert.ok(goodRow?.blob instanceof Blob, '好图 blob 应存在');
  // 1x1 PNG 解码后 70 字节（8 字节签名 + IHDR + IDAT + IEND chunks）
  assert.equal(goodRow.blob.size, 70, '好图 blob 字节数应等于解码后大小');
  assert.equal(goodRow.mime, 'image/png', 'mime 应保留');

  const badRow = await d.images.get('bad-img');
  assert.equal(badRow, undefined, '坏图不应落库');

  const card = await d.cards.get('card1');
  assert.ok(card, '卡片应落库');
  assert.equal(card.front, 'Q-card1');
});

// ───────────────── 二、6 阶段 onProgress 触发顺序 ─────────────────

test('N1 方案 A：onProgress 按 6 阶段顺序触发，每个阶段有起止进度', async () => {
  await resetAll();
  const phases = [];
  const progresses = [];
  const infos = [];
  const backup = {
    app: 'sxybrick',
    version: 7,
    cards: [mkCard('card1')],
    images: [{ id: 'good-img', data: GOOD_PNG_B64, mime: 'image/png' }],
  };
  await importBackup(backup, {
    skipSnapshot: true,
    onProgress: (phase, progress, info) => {
      phases.push(phase);
      progresses.push(progress);
      infos.push(info);
    },
  });

  // 6 阶段都必须出现
  const seenAt = new Map();
  phases.forEach((p, i) => { if (!seenAt.has(p)) seenAt.set(p, i); });
  const order = [...seenAt.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p);
  assert.deepEqual(
    order,
    ['snapshot', 'dedupe', 'tombstones', 'tables', 'cascade', 'images'],
    '6 阶段必须按 importBackup 执行顺序触发：snapshot → dedupe → tombstones → tables → cascade → images',
  );

  // 每个阶段最终 progress 应 >= 0.5（保证 fireProgress 末尾进度都到位）
  const lastProgress = new Map();
  phases.forEach((p, i) => lastProgress.set(p, progresses[i])); // 后写覆盖前写
  for (const [p, prog] of lastProgress) {
    assert.ok(prog >= 0.5, `阶段 ${p} 最终进度应 >= 0.5，实际 ${prog}`);
  }

  // TABLES 阶段必须传 total（fireProgress 0 时带 info.total）
  const tablesInfo = infos.find((x, i) => phases[i] === 'tables' && progresses[i] === 0);
  assert.ok(tablesInfo && typeof tablesInfo.total === 'number' && tablesInfo.total > 0, 'TABLES 阶段应传 total');

  // IMAGES 阶段必须出现 0.5（bulkGet 完成、解码前）
  const imagesHalf = progresses.some((p, i) => phases[i] === 'images' && p === 0.5);
  assert.ok(imagesHalf, 'IMAGES 阶段应触发 0.5 进度（bulkGet 完成）');
});

// ───────────────── 三、回调缺省/非函数/抛错的兜底 ─────────────────

test('N1 方案 A：onProgress 缺省 / 非函数 / 抛错均静默跳过，不阻断导入', async () => {
  // Case A：opts.onProgress 缺省（旧调用方零侵入）
  await resetAll();
  const backupA = { app: 'sxybrick', version: 7, cards: [mkCard('a1')] };
  const statsA = await importBackup(backupA, { skipSnapshot: true });
  assert.equal(statsA.cards, 1, '缺省 onProgress 不应阻断导入');

  // Case B：opts.onProgress 非函数（用户误传）——fireProgress 内部 typeof 守卫应静默
  await resetAll();
  const backupB = { app: 'sxybrick', version: 7, cards: [mkCard('b1')] };
  const statsB = await importBackup(backupB, { skipSnapshot: true, onProgress: 'oops-not-a-fn' });
  assert.equal(statsB.cards, 1, '非函数 onProgress 不应阻断导入');

  // Case C：opts.onProgress 抛错——fireProgress 内 try/catch 应兜底，主链继续
  await resetAll();
  const backupC = { app: 'sxybrick', version: 7, cards: [mkCard('c1')] };
  const statsC = await importBackup(backupC, {
    skipSnapshot: true,
    onProgress: () => { throw new Error('用户回调里随便抛'); },
  });
  assert.equal(statsC.cards, 1, 'onProgress 抛错不应阻断导入');
});
