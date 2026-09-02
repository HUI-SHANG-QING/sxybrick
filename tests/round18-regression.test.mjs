// tests/round18-regression.test.mjs —— round18 审计修复回归（node --test）
// 覆盖：
//   R18-1  单词卡扩展字段「repo 层 EXT_FIELDS vs sync 层 WORD_EXT_FIELDS」一致性闸
//          （R18-1 的 note/audio 经实证为**证伪**——二者写入必 bump updatedAt，LWW 语义
//          正确传播；本闸固化「差集只能是用户内容字段」的设计意图，防未来 AI 字段漏保护）
//   R18-3  planSnapshotRestore：旧快照缺表键 → skip（不 clear），新表不被抹空
//   R18-5  mergeRows strip 语义：strip 字段永不采纳 incoming（本地空不落值 / 本地有值保留）
//   R18-6  addPomoSession.partial + countPomoToday 排除 partial（今日番茄/成就不可刷）
//   R18-7  sync-status 面板动态覆盖全部 SYNC_TABLES + zh/en 模块名完整
//   R18-10 parseAnkiLines 坏行剔除 / 300 行截断计数
//   R18-8  静态闸：Export.vue doPrint 已接线 afterprint（防死函数复发）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─────────────────────────── R18-1 ───────────────────────────
test('R18-1：sync 层 WORD_EXT_FIELDS ⊆ repo 层 EXT_FIELDS（无死配置）', async () => {
  const { WORD_EXT_FIELDS } = await import('../src/sync-manifest.js');
  const { EXT_FIELDS } = await import('../src/word-repo.js');
  for (const f of WORD_EXT_FIELDS) {
    assert.ok(EXT_FIELDS.includes(f), `WORD_EXT_FIELDS 里的 ${f} 不在 repo 层 EXT_FIELDS —— 死配置`);
  }
});

test('R18-1：repo EXT_FIELDS 与 sync 保护集的差集只允许是「用户内容字段」', async () => {
  const { WORD_EXT_FIELDS } = await import('../src/sync-manifest.js');
  const { EXT_FIELDS } = await import('../src/word-repo.js');
  // 用户可编辑内容字段：不并集保护、刻意走 updatedAt 整行赢家（删除可跨设备传播），
  // 见 sync-manifest.js R17-9 注释。若未来新增 AI 生成字段（pos/defs/…）却漏进
  // WORD_EXT_FIELDS，此处直接 fail → 逼开发者补保护或显式声明为用户内容。
  const USER_CONTENT_FIELDS = new Set(['audio']);
  const diff = EXT_FIELDS.filter((f) => !WORD_EXT_FIELDS.includes(f));
  for (const f of diff) {
    assert.ok(USER_CONTENT_FIELDS.has(f),
      `${f} 在 repo 层 EXT_FIELDS 但不在 WORD_EXT_FIELDS 保护集，且未声明为用户内容字段 —— 需补并集保护`);
  }
});

// ─────────────────────────── R18-3 ───────────────────────────
test('R18-3：旧快照缺表键 → planSnapshotRestore 标记 skip，不整表抹空', async () => {
  const { planSnapshotRestore } = await import('../src/sync.js');
  const tables = [
    { table: 'cards', merge: 'card' },
    { table: 'images', merge: 'idOnly' },
    { table: 'wordCards', merge: 'card' },
    { table: 'wordReviews', merge: 'review' },
  ];
  // v24 时代生成的旧快照：没有单词表键、没有 tombstones
  const oldSnap = {
    rows: { cards: [{ id: 'c1' }], tombstones: [{ id: 't1', kind: 'card' }] },
  };
  const { restore, skip } = planSnapshotRestore(oldSnap, tables);
  assert.deepEqual(restore, ['cards'], '只有快照里真实存在的表才回滚');
  assert.ok(skip.includes('wordCards') && skip.includes('wordReviews'), '旧快照没有的表必须跳过');
  assert.ok(skip.includes('images'), 'images 恒不入快照，恒跳过');
});

test('R18-3：新快照全键 → 全部 restore（除 images）', async () => {
  const { planSnapshotRestore } = await import('../src/sync.js');
  const tables = [
    { table: 'cards', merge: 'card' },
    { table: 'images', merge: 'idOnly' },
    { table: 'wordCards', merge: 'card' },
  ];
  const snap = { rows: { cards: [1], wordCards: [2] } };
  const { restore, skip } = planSnapshotRestore(snap, tables);
  assert.deepEqual(restore.sort(), ['cards', 'wordCards']);
  assert.deepEqual(skip, ['images']);
});

// ─────────────────────────── R18-5 ───────────────────────────
test('R18-5：mergeRows 新行分支 strip 字段不入库（本地空不落 incoming 凭证）', async () => {
  const { mergeRows } = await import('../src/sync-manifest.js');
  // 设备 B 本地没有任何 wordSettings 行（从未配置 Key），incoming 是旧包/中枢残留的明文 Key
  const out = mergeRows([], [{ id: 'me', updatedAt: 100, llmApiKey: 'sk-legacy', llmBase: 'https://x' }], 'updatedAt', { strip: ['llmApiKey', 'llmBase'] });
  assert.equal(out.length, 1);
  assert.ok(out[0].llmApiKey === undefined, '新行直接入表时 strip 字段必须被剔除');
  assert.ok(out[0].llmBase === undefined);
  assert.equal(out[0].id, 'me', '行本身保留');
});

test('R18-5：mergeRows updatedAt 分支——本地空 → strip 字段留空；本地有值 → 保留本地', async () => {
  const { mergeRows } = await import('../src/sync-manifest.js');
  const strip = ['llmApiKey', 'llmBase'];
  // 本地有 key：incoming 更新但导出侧已剔除 → 合并后保留本地 key
  const a = mergeRows(
    [{ id: 'me', updatedAt: 1, llmApiKey: 'sk-local' }],
    [{ id: 'me', updatedAt: 200, llmApiKey: undefined, llmBase: undefined }],
    'updatedAt', { strip },
  );
  assert.equal(a[0].llmApiKey, 'sk-local', '本地有值必须保留，不被剔除的 incoming 清掉');
  // 本地空：incoming 带残留 key → 合并后必须仍为空（此前会落 incoming 值 → 凭证灌进本机）
  const b = mergeRows(
    [{ id: 'me', updatedAt: 1 }],
    [{ id: 'me', updatedAt: 200, llmApiKey: 'sk-leak' }],
    'updatedAt', { strip },
  );
  assert.ok(b[0].llmApiKey === undefined, '本地无值 → strip 字段绝不采纳 incoming');
  assert.equal(b[0].updatedAt, 200, '行内容仍按 updatedAt 合并');
});

test('R18-5：无 strip 配置的表行为不变（updatedAt 整行合并）', async () => {
  const { mergeRows } = await import('../src/sync-manifest.js');
  const out = mergeRows([{ id: 'a', updatedAt: 1, v: 1 }], [{ id: 'a', updatedAt: 2, v: 2 }], 'updatedAt');
  assert.equal(out[0].v, 2);
});

// ─────────────────────────── R18-6 ───────────────────────────
test('R18-6：addPomoSession 持久化 partial 标记', async () => {
  const { db } = await import('../src/db.js');
  const { addPomoSession } = await import('../src/repo.js');
  const full = await addPomoSession({ duration: 25, startedAt: Date.now() });
  assert.equal(full.partial, 0, '完整番茄 partial=0');
  const part = await addPomoSession({ duration: 3, startedAt: Date.now(), partial: 1 });
  assert.equal(part.partial, 1, '部分专注 partial=1');
  assert.equal(part.duration, 3, '部分专注按实际分钟记录');
  await db.pomoSessions.clear();
});

test('R18-6：countPomoToday 排除 partial——开 2 分钟关页回来不再白拿番茄', async () => {
  const { db } = await import('../src/db.js');
  const { countPomoToday, addPomoSession } = await import('../src/repo.js');
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const now = Date.now();
  await db.pomoSessions.clear();
  await addPomoSession({ duration: 25, startedAt: now });              // 完整
  await addPomoSession({ duration: 3, startedAt: now, partial: 1 });   // 中断 2 分钟场景
  const n = await countPomoToday();
  assert.equal(n, 1, '今日番茄只数完整番茄');
  // 旧数据（无 partial 字段）仍按完整番茄计，向后兼容
  await db.pomoSessions.put({ id: 'legacy', startedAt: now, duration: 25 });
  assert.equal(await countPomoToday(), 2, '旧行无 partial → 计入');
  await db.pomoSessions.clear();
});

// ─────────────────────────── R18-7 ───────────────────────────
test('R18-7：sync-status 面板动态覆盖全部 SYNC_TABLES（word 7 表不再被漏）', async () => {
  // 隐私同步开启态下，面板要覆盖「全部有效表」= SYNC_TABLES ∪ PRIVACY_SYNC_TABLES。
  // 先置 flag 再导入：sync-status.js 模块级的 MODULE_ORDER = buildModuleOrder() 在导入时求值，
  // 必须让它看到「隐私开启」，否则默认实例天然不含 privacyRecords（非 bug，是条件表）。
  localStorage.setItem('sxy_privacy_sync', '1');
  const { buildModuleOrder, MODULE_ORDER, MODULE_LABELS, moduleLabelKey } = await import('../src/sync-status.js');
  const { SYNC_TABLES, PRIVACY_SYNC_TABLES } = await import('../src/sync-manifest.js');
  const all = [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES].map((t) => t.table);
  // buildModuleOrder 的全集保证：喂多少表就覆盖多少表（含隐私表，不含的不会凭空出现）
  const order = buildModuleOrder([...SYNC_TABLES, ...PRIVACY_SYNC_TABLES]);
  for (const name of all) {
    assert.ok(order.includes(name), `面板次序缺表 ${name}`);
    assert.ok(MODULE_LABELS[name], `MODULE_LABELS 缺 ${name} 兜底名`);
    assert.ok(moduleLabelKey(name).startsWith('syncStatus.module.'), `labelKey 格式错误 ${name}`);
  }
  // MODULE_ORDER（默认构造）也不得丢任何表（在隐私开启的前提下，全表必须出现）
  for (const name of all) assert.ok(MODULE_ORDER.includes(name), `MODULE_ORDER 缺表 ${name}`);
  // 隐私关闭态：面板只含非隐私表（条件表不入列，符合 opt-in 语义）
  const offOrder = buildModuleOrder(SYNC_TABLES);
  assert.ok(!offOrder.includes('privacyRecords'), '隐私关闭时 privacyRecords 不应出现');
  assert.ok(offOrder.includes('wordCards'), '隐私关闭时 word 表照常入面板');
});

test('R18-7：每张同步表在 zh/en 字典都有模块名（新增表必须补 i18n 键）', async () => {
  const { SYNC_TABLES, PRIVACY_SYNC_TABLES } = await import('../src/sync-manifest.js');
  const { zh, en } = await import('../src/i18n/views/sync.js');
  for (const t of [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES]) {
    const key = `syncStatus.module.${t.table}`;
    const z = key.split('.').reduce((o, k) => (o ? o[k] : undefined), zh);
    const e = key.split('.').reduce((o, k) => (o ? o[k] : undefined), en);
    assert.equal(typeof z, 'string', `zh 缺 ${key}`);
    assert.equal(typeof e, 'string', `en 缺 ${key}`);
    assert.ok(z.length > 0 && e.length > 0, `${key} 不应为空串`);
  }
});

// ─────────────────────────── R18-10 ───────────────────────────
test('R18-10：parseAnkiLines 剔除空背面坏行（不再整循环中断）', async () => {
  const { parseAnkiLines } = await import('../src/sync.js');
  const r = parseAnkiLines('q1\tback1\n只有正面没有分隔符\nq2|back2\n# 注释行\n');
  assert.equal(r.pairs.length, 2, '只保留正反完整的行');
  assert.equal(r.skippedEmptyBack, 1, '无背面行被计数剔除');
  assert.equal(r.truncated, 0);
  assert.deepEqual(r.pairs.map((p) => p.front), ['q1', 'q2']);
});

test('R18-10：parseAnkiLines 超 300 行截断并计数', async () => {
  const { parseAnkiLines } = await import('../src/sync.js');
  const lines = Array.from({ length: 305 }, (_, i) => `f${i}\tb${i}`).join('\n');
  const r = parseAnkiLines(lines);
  assert.equal(r.pairs.length, 300, '最多导入 300 张');
  assert.equal(r.truncated, 5, '截断行数如实返回');
});

// ─────────────────────────── R18-8（静态闸） ───────────────────────────
test('R18-8：Export.vue doPrint 已接线 afterprint（防死函数复发）', () => {
  const src = readFileSync(join(ROOT, 'src/views/Export.vue'), 'utf8');
  const doPrintBlock = src.slice(src.indexOf('function doPrint'), src.indexOf('async function doCsv'));
  assert.ok(doPrintBlock.includes("addEventListener('afterprint'"), 'doPrint 必须绑定 afterprint 推进打印水位');
  assert.ok(doPrintBlock.includes('window.print()'), 'doPrint 仍执行打印');
});

// ─────────────────────────── R18-11（静态闸） ───────────────────────────
test('R18-11：sync-hub/hub.js 无字面 NUL 字节（工具链可正常 grep/diff）', () => {
  const buf = readFileSync(join(ROOT, 'sync-hub/hub.js'));
  assert.ok(!buf.includes(0), 'hub.js 不得再含字面 NUL 字节');
});
