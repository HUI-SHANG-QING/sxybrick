// tests/sync-audit.test.mjs —— Part 3 同步功能全面检查（数据导入导出 + 局域网同步）
// 目标：对「导出→导入往返」「增量同步」「快照回滚」「墓碑删除传播」「新表（syllabusMeanings /
//   wordCards.modeQuestions）」「敏感字段 strip」「局域网 hub 全链路」做端到端实证，
// 补上此前只做纯函数单测、未做整链路验证的盲区。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { db, setDbInstance, getDb, uid } from '../src/db.js';
import {
  buildBackup, buildIncrementalBackup, importBackup, previewImport,
  saveSnapshot, restoreSnapshot, listSnapshots, planSnapshotRestore,
  syncWithHub, getEffectiveSyncTables, backupScope,
} from '../src/sync.js';
import { SYNC_TABLES, BACKUP_VERSION } from '../src/sync-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUB_JS = join(__dirname, '..', 'sync-hub', 'hub.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => { try { await db.close(); } catch {} });

// 每个用例前清空「当前 real 实例」全部同步表 + 快照，隔离用例间残留。
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

// ───────────────────────── 一、全量导出→导入往返 ─────────────────────────

test('全量往返：buildBackup → 清库 → importBackup，32 张表数据不丢', async () => {
  await resetAll();
  const d = getDb();
  const T = Date.now();
  // 种入覆盖多表的数据（卡片 + 复习 + 备忘 + 单词 + 释义 + 设置）
  await d.cards.put(mkCard('c1', { updatedAt: T }));
  await d.cards.put(mkCard('c2', { updatedAt: T + 1 }));
  await d.reviews.put({ id: 'r1', cardId: 'c1', rating: 4, levelAfter: 1, reviewedAt: T + 10 });
  await d.memos.put({ id: 'm1', content: '备忘内容', updatedAt: T + 20, createdAt: T });
  await d.wordCards.put({ id: 'w1', word: 'abandon', meaning: '放弃', kind: 'word', subject: '英语', ease: 2.5, level: 0, intervalDays: 0, dueAt: 1000, reviewedAt: 0, createdAt: T, updatedAt: T, modeQuestions: { spell: { q: '拼写 abandon', a: 'abandon' } } });
  await d.syllabusMeanings.put({ id: 'abandon', word: 'abandon', meaning: 'v. 放弃；抛弃', updatedAt: T + 30, source: 'ai', syllabusVersion: 'kaoyan-2027' });
  await d.wordSettings.put({ id: 'me', tts: 'edge', dailyGoal: 20, llmApiKey: 'sk-secret-xyz', llmBase: 'https://api.x', updatedAt: T + 40 });

  const backup = await buildBackup();
  assert.equal(backup.app, 'sxybrick');
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.cards.length, 2);
  assert.equal(backup.reviews.length, 1);
  assert.equal(backup.memos.length, 1);
  assert.equal(backup.wordCards.length, 1);
  assert.equal(backup.syllabusMeanings.length, 1);
  // wordSettings 导出侧 strip：LLM Key 不得出现在备份包
  assert.equal(backup.wordSettings[0].llmApiKey, undefined, '导出必须剔除 llmApiKey');
  assert.equal(backup.wordSettings[0].llmBase, undefined, '导出必须剔除 llmBase');
  assert.equal(backup.wordSettings[0].tts, 'edge', '非敏感字段保留');

  // 清空全部数据
  for (const t of getEffectiveSyncTables()) await d[t.table].clear();
  await d.tombstones.clear();
  await d.images.clear();
  await d.meta.clear();

  const stats = await importBackup(backup, { skipSnapshot: true });
  assert.equal(stats.cards, 2, '导入应新增 2 张卡');
  assert.equal(stats.reviews, 1);
  assert.equal(stats.wordCards, 1, `wordCards 应新增 1，实际 ${stats.wordCards}`);
  assert.equal(stats.syllabusMeanings, 1, `syllabusMeanings 应新增 1，实际 ${stats.syllabusMeanings}`);

  // 落库验证
  assert.equal((await d.cards.count()), 2);
  assert.equal((await d.reviews.count()), 1);
  assert.equal((await d.memos.count()), 1);
  assert.equal((await d.wordCards.count()), 1);
  assert.equal((await d.syllabusMeanings.count()), 1);
  const w1 = await d.wordCards.get('w1');
  assert.deepEqual(w1.modeQuestions, { spell: { q: '拼写 abandon', a: 'abandon' } }, 'modeQuestions 必须随同步往返');
  const sm = await d.syllabusMeanings.get('abandon');
  assert.equal(sm.meaning, 'v. 放弃；抛弃');
  // 本地设置的敏感字段：导入对端包后，本地值应保留（本地无 key 时留空，不被回灌）
  const ws = await d.wordSettings.get('me');
  assert.equal(ws.tts, 'edge');
  assert.equal(ws.llmApiKey, undefined, '导入后本地 llmApiKey 应保持为空（不被对端回灌）');
});

// ───────────────────────── 二、增量同步 ─────────────────────────

test('增量：buildIncrementalBackup 只带 since 之后的变更，墓碑始终全量', async () => {
  await resetAll();
  const d = getDb();
  const T = 100000;
  // 两张卡：一张旧（T）、一张新（T+1000）
  await d.cards.put(mkCard('old', { updatedAt: T, reviewedAt: T }));
  await d.cards.put(mkCard('new', { updatedAt: T + 1000 }));
  // 一条旧复习 + 一条新复习
  await d.reviews.put({ id: 'r-old', cardId: 'old', rating: 1, reviewedAt: T });
  await d.reviews.put({ id: 'r-new', cardId: 'new', rating: 2, reviewedAt: T + 1000 });
  // 墓碑（删除传播不可遗漏，必须全量带）
  await d.tombstones.put({ id: 'gone', kind: 'card', deletedAt: T + 500 });

  const inc = await buildIncrementalBackup(T + 500);
  assert.equal(inc.incremental, true);
  // 只有 new 卡（updatedAt/reviewedAt = T+1000 > T+500）与 r-new 复习被带出
  assert.deepEqual(inc.cards.map(c => c.id), ['new'], '增量只带 new 卡');
  assert.deepEqual(inc.reviews.map(r => r.id), ['r-new'], '增量只带 r-new 复习');
  // 墓碑全量
  assert.equal(inc.tombstones.length, 1, '墓碑必须全量带');
  assert.equal(inc.tombstones[0].id, 'gone');

  // since=0 首包：全 0 时间戳的遗留行也放行（防永久漏传）
  await d.cards.put(mkCard('legacy', { updatedAt: 0, reviewedAt: 0, createdAt: 0 }));
  const first = await buildIncrementalBackup(0);
  assert.ok(first.cards.some(c => c.id === 'legacy'), '首包须放行全 0 时间戳遗留行');
});

// ───────────────────────── 三、快照保存 / 回滚 ─────────────────────────

test('快照：saveSnapshot → 改动 → restoreSnapshot 精确还原；新表随快照往返', async () => {
  await resetAll();
  const d = getDb();
  const T = Date.now();
  await d.cards.put(mkCard('c1', { front: '原始正面', updatedAt: T }));
  await d.syllabusMeanings.put({ id: 'word1', word: 'word1', meaning: '原释义', updatedAt: T });

  const snap = await saveSnapshot('审计快照', 'manual');
  assert.ok(snap.id);
  assert.ok(snap.rows.cards.length === 1);
  assert.ok(snap.rows.syllabusMeanings.length === 1, '新表 syllabusMeanings 必须入快照');

  // 改动：改卡 + 删释义 + 新增释义
  await d.cards.put(mkCard('c1', { front: '改过的正面', updatedAt: T + 1000 }));
  await d.syllabusMeanings.put({ id: 'word1', word: 'word1', meaning: '改过释义', updatedAt: T + 1000 });
  await d.syllabusMeanings.put({ id: 'word2', word: 'word2', meaning: '新增', updatedAt: T + 2000 });

  const r = await restoreSnapshot(snap.id);
  assert.ok(r.restored.includes('cards'));
  assert.ok(r.restored.includes('syllabusMeanings'));

  const c = await d.cards.get('c1');
  assert.equal(c.front, '原始正面', '卡片应还原');
  const sm1 = await d.syllabusMeanings.get('word1');
  assert.equal(sm1.meaning, '原释义', '释义应还原');
  assert.equal(await d.syllabusMeanings.get('word2'), undefined, '快照后新增的行应被清掉');
});

test('快照 R18-3：旧快照缺失新表键 → 跳过不抹空该表', async () => {
  await resetAll();
  const d = getDb();
  const T = Date.now();
  await d.syllabusMeanings.put({ id: 'wordX', word: 'wordX', meaning: '重要释义', updatedAt: T });

  // 构造一个「旧快照」：rows 里没有 syllabusMeanings 键（生成时点早于 v30 表引入）
  const oldSnap = {
    id: 'oldsnap', label: 'v25 老快照', kind: 'manual', createdAt: T - 10000,
    rows: { cards: [{ id: 'c1', front: '旧卡', back: '旧答', updatedAt: T - 5000 }], tombstones: [] },
  };
  const { restore, skip } = planSnapshotRestore(oldSnap, getEffectiveSyncTables());
  assert.ok(skip.includes('syllabusMeanings'), '旧快照缺 syllabusMeanings → 应跳过');
  assert.ok(!restore.includes('syllabusMeanings'), '缺键表不得进 restore 清单');

  // 直接调 restoreSnapshot（它内部走 planSnapshotRestore）——旧快照不含新表键，不得抹空新表
  await d.snapshots.put(oldSnap);
  await restoreSnapshot('oldsnap');
  const sm = await d.syllabusMeanings.get('wordX');
  assert.ok(sm, '旧快照回滚后新表 syllabusMeanings 必须原样保留');
  assert.equal(sm.meaning, '重要释义');
});

test('快照上限：超过 MAX_SNAPSHOTS 自动删最旧', async () => {
  await resetAll();
  // 存 13 个快照（上限 12）
  const ids = [];
  for (let i = 0; i < 13; i++) {
    const s = await saveSnapshot(`snap-${i}`, 'manual');
    ids.push(s.id);
  }
  const all = await listSnapshots();
  assert.ok(all.length <= 12, `快照数应 ≤12，实际 ${all.length}`);
  // 最旧的 snap-0 应被淘汰
  assert.ok(!all.some(s => s.label === 'snap-0'), '最旧快照应被自动清理');
});

// ───────────────────────── 四、墓碑删除传播 ─────────────────────────

test('墓碑：A 删卡 → 导出 → B 导入 → 卡片与级联复习/图谱边被删', async () => {
  await resetAll();
  const d = getDb();
  const T = Date.now();
  // B 端已有卡 + 复习 + 图谱边
  await d.cards.put(mkCard('victim', { updatedAt: T - 500, reviewedAt: T - 500 }));
  await d.reviews.put({ id: 'rv1', cardId: 'victim', rating: 1, reviewedAt: T - 500 });
  await d.graphEdges.put({ id: 'edge1', fromCardId: 'victim', toCardId: 'other', label: '关联', kind: 'manual', updatedAt: T - 500 });

  // A 端删除该卡 → 生成墓碑
  const backup = {
    app: 'sxybrick', version: BACKUP_VERSION, scope: 'real', exportedAt: T,
    tombstones: [{ id: 'victim', kind: 'card', deletedAt: T }],
    cards: [], reviews: [], images: [], streakMeta: null,
  };
  const stats = await importBackup(backup, { skipSnapshot: true });
  assert.equal(stats.deleted, 1, '应删除 1 张卡');

  // 卡片、其复习、指向它的图谱边、其嵌入都应级联删除
  assert.equal(await d.cards.get('victim'), undefined, '卡片应删除');
  assert.equal(await d.reviews.get('rv1'), undefined, '级联复习应删除');
  assert.equal(await d.graphEdges.get('edge1'), undefined, '级联图谱边应删除');
});

// ───────────────────────── 五、预览 / 数据域 ─────────────────────────

test('previewImport：只读不写库，正确分类新增/覆盖/重复', async () => {
  await resetAll();
  const d = getDb();
  const T = Date.now();
  await d.cards.put(mkCard('c1', { front: '已有', updatedAt: T }));

  const backup = {
    app: 'sxybrick', version: BACKUP_VERSION, scope: 'real',
    cards: [
      mkCard('c1', { front: '已有改', updatedAt: T + 100 }), // 覆盖
      mkCard('c2', { front: '全新', updatedAt: T + 100 }),   // 新增
      mkCard('c3', { front: '已有', back: 'A-c1', updatedAt: T + 100 }), // 内容雷同异 id → 重复
    ],
    reviews: [], images: [], tombstones: [], streakMeta: null,
  };
  const pv = await previewImport(backup);
  assert.equal(pv.valid, true);
  const cardT = pv.tables.find(t => t.table === 'cards');
  assert.equal(cardT.added, 1);
  assert.equal(cardT.overwritten, 1);
  assert.equal(cardT.duplicated, 1);
  // 预览是 dry-run，不得真正写库
  assert.equal(await d.cards.count(), 1, '预览后库中卡片数不变');
  assert.equal(await d.cards.get('c2'), undefined);
});

// ───────────────────────── 六、局域网 hub 全链路 ─────────────────────────

async function withHub(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sxy-hub-audit-'));
  const tokenFile = join(dir, 'token.txt');
  const dataFile = join(dir, 'data.json');
  const token = randomBytes(16).toString('hex');
  writeFileSync(tokenFile, token);
  const port = 49000 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [HUB_JS, String(port)], {
    env: { ...process.env, PORT: String(port), HUB_HOST: '127.0.0.1', HUB_TOKEN_FILE: tokenFile, HUB_DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {}
      await sleep(100);
    }
    return await fn({ base: `http://127.0.0.1:${port}`, token, dir, dataFile });
  } finally {
    child.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('局域网：syncWithHub 全链路（增量上传 → 中枢合并 → 拉取合并 → 水位推进）', async () => {
  await resetAll();
  // 清空 sync 水位，保证首轮全量
  localStorage.removeItem('sxy_hub_last_sync');
  localStorage.removeItem('sxy_hub_last_sync__t_cards');
  const d = getDb();
  const T = Date.now();
  await d.cards.put(mkCard('hub-c1', { updatedAt: T }));
  await d.memos.put({ id: 'hub-m1', content: '同步备忘', updatedAt: T, createdAt: T });

  await withHub(async ({ base, token }) => {
    await syncWithHub(base, token); // 首轮：本地 → 中枢（本地已有该卡，合并后 added=0 属正常）
    // 水位已推进
    const wm = Number(localStorage.getItem('sxy_hub_last_sync'));
    assert.ok(wm > 0, '全局水位应推进');

    // 第二台「设备」：清库模拟另一台，从同一中枢拉取
    for (const t of getEffectiveSyncTables()) await d[t.table].clear();
    await d.tombstones.clear();
    await syncWithHub(base, token);
    assert.equal((await d.cards.get('hub-c1'))?.front, 'Q-hub-c1', '第二设备应从中枢拉到卡片');
    assert.equal((await d.memos.get('hub-m1'))?.content, '同步备忘', '第二设备应从中枢拉到备忘');
  });
});

test('局域网：增量同步后新变更仍可传播（水位不吞数据）', async () => {
  await resetAll();
  localStorage.removeItem('sxy_hub_last_sync');
  const d = getDb();
  const T = Date.now();
  await d.cards.put(mkCard('inc-c1', { updatedAt: T }));

  await withHub(async ({ base, token }) => {
    await syncWithHub(base, token); // 首轮全量
    // 首轮同步后再加一张新卡 + 改一张卡
    await d.cards.put(mkCard('inc-c2', { updatedAt: T + 5000 }));
    await d.cards.put(mkCard('inc-c1', { front: 'inc-c1-改', updatedAt: T + 5000 }));
    await syncWithHub(base, token); // 第二轮增量

    // 清库模拟第三设备拉取
    for (const t of getEffectiveSyncTables()) await d[t.table].clear();
    await d.tombstones.clear();
    await syncWithHub(base, token);
    const c1 = await d.cards.get('inc-c1');
    const c2 = await d.cards.get('inc-c2');
    assert.equal(c1?.front, 'inc-c1-改', '增量修改必须传播到中枢');
    assert.ok(c2, '增量新增必须传播到中枢');
  });
});
