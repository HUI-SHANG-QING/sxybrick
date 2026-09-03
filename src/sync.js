// 系统导出 / 导入（跨设备手动同步）
// 导出：把所有数据打包成一个 JSON 文件（表清单见 sync-manifest.js，自动覆盖全部模块）
// 导入：按策略合并（卡片=内容/SRS 双时间戳字段级；其他=updatedAt 或 id 幂等），
//       删除经「墓碑」跨设备传播，图片按 id 幂等写入
// P3-3 多设备同步增强：
//   · 自动快照：importBackup 前自动 saveSnapshot，支持历史回滚
//   · 冲突可视化：importBackup 返回 stats.conflicts，列出哪些卡片字段被覆盖
//   · 增量同步：buildIncrementalBackup(lastSyncAt) 只导出 updatedAt > lastSyncAt 的行
import { db, uid, currentDbMode } from './db.js';
import { base64ToBlob, blobToBase64, extractImageIds } from './images.js';
import { triggerHook } from './plugins/registry.js';
import { sheetCellGuard } from './utils/exporters.js';
import { encryptBackup, decryptBackup } from './utils/crypto.js';
import {
  BACKUP_VERSION, SYNC_TABLES, PRIVACY_SYNC_TABLES, EXCLUDED_FROM_SYNC,
  CARD_CONTENT_FIELDS, CARD_SRS_FIELDS,
  mergeRows, mergeTombstones, applyTombstones, kindOf, livenessTs, shouldExportRow,
  clearedBeforeKey, filterClearedRows, sanitizeStripRows,
} from './sync-manifest.js';

/** 按表读取待导出行（应用清单上的 exportFilter，排除派生/本机专属数据，如 kind='auto' 的图谱边）
 *  额外支持 entry.strip: string[] —— 导出前剔除敏感字段（如 wordSettings 的 LLM Key），
 *  不影响本机存储，仅让同步/备份包不含该字段（对端导入时保留自己的本地值）。 */
async function exportRows(t) {
  let rows = await db[t.table].toArray();
  if (typeof t.exportFilter === 'function') rows = rows.filter(r => shouldExportRow(t, r));
  // round18 R18-5：与合并侧（mergeRows）/ 中枢（hub merge）共用同一个净化函数，
  // 三处口径一致，避免「导出剔了、合并又放进来」的半程保护。
  if (Array.isArray(t.strip) && t.strip.length) rows = sanitizeStripRows(rows, t.strip);
  return rows;
}
import { dedupeIncomingCards } from './sync-dedup.js';
import { buildAuthHeaders } from './utils/hub-auth.js';
import { pad2 } from './utils/format.js';
// 快照标签里的时间跟随界面语言（此前硬编码 'zh-CN'，英文界面下仍是"2026/8/30 19:48"中文习惯）
import { fmtLocaleDateTime } from './utils/locale-date.js';

export { BACKUP_VERSION, EXCLUDED_FROM_SYNC };

const MAX_SNAPSHOTS = 12; // 快照保留上限：超过则自动删除最旧的，避免 IndexedDB 无限膨胀

// M3 演示模式：数据包带 scope 标记（real/test），各同步通道按 scope 隔离
//   文件 → 文件名后缀；Hub → /backup/{scope} 独立数据文件；Gist → 独立文件名 + 独立 gist 配置
export function backupScope() {
  return currentDbMode() === 'test' ? 'test' : 'real';
}

// 隐私数据 opt-in：默认 false，用户在设置面板显式开启后隐私表才入同步/导出
export function isPrivacySyncEnabled() {
  return localStorage.getItem('sxy_privacy_sync') === '1';
}
export function setPrivacySyncEnabled(v) {
  localStorage.setItem('sxy_privacy_sync', v ? '1' : '0');
}
// 根据用户设置返回有效同步表清单
// 导出：sync-status.js（状态面板）/ Sync.vue（记录全模块结果）需要按「有效表」遍历
export function getEffectiveSyncTables() {
  return isPrivacySyncEnabled() ? [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES] : SYNC_TABLES;
}

export async function countData() {
  const out = {};
  const tables = getEffectiveSyncTables();
  const rows = await Promise.all(tables.map(t => db[t.table].count()));
  tables.forEach((t, i) => { out[t.table] = rows[i]; });
  return out;
}

export async function buildBackup(subject) {
  let cards = await db.cards.toArray();
  if (subject) cards = cards.filter(c => c.subject === subject);
  const cardIds = new Set(cards.map(c => c.id));

  const parts = {};
  for (const t of getEffectiveSyncTables()) {
    if (t.table === 'cards') parts.cards = cards;
    else if (t.table === 'reviews') {
      let reviews = await db.reviews.toArray();
      if (subject) reviews = reviews.filter(r => cardIds.has(r.cardId));
      parts.reviews = reviews;
    } else if (t.table === 'images') {
      continue; // 图片单独打包：只带被引用图片，且需 base64 编码（不能直接放 Blob）
    } else {
      // 科目卡组分享：其他模块数据不带（发给同学的包里只含该科目内容）
      parts[t.table] = subject ? [] : await exportRows(t);
    }
  }
  // 科目分享包不携带墓碑（同学设备与你的删除历史无关）
  const tombstones = subject ? [] : await db.tombstones.toArray();

  // 收集被打包卡片引用的图片
  const ids = new Set();
  for (const c of cards) for (const id of extractImageIds(c.front + '\n' + c.back)) ids.add(id);
  const images = [];
  for (const id of ids) {
    const row = await db.images.get(id);
    if (row?.blob) images.push({ id, mime: row.mime || 'image/png', data: await blobToBase64(row.blob) });
  }

  // 打卡元数据：每日目标 goal（存 db.meta，随同步走；打卡天数/今日复习由 reviews 推导）
  const goalMeta = subject ? null : await db.meta.get('goal');
  const streakMeta = goalMeta ? { goal: goalMeta.value, updatedAt: goalMeta.updatedAt || 0 } : null;

  return { version: BACKUP_VERSION, app: 'sxybrick', scope: backupScope(), exportedAt: Date.now(), tombstones, images, streakMeta, ...parts };
}

// P3-3 增量同步：只导出 updatedAt > lastSyncAt 的行（卡片按 max(updatedAt, reviewedAt, wrongReasonAt) 判定）
//   用途：hub 同步场景下，减少每次同步的包体积（从「全量 N 万行」降到「本次变更的几十行」）
//   注意：墓碑始终全量带（删除传播不可遗漏），图片仍按被引用打包
//   返回结构与 buildBackup 一致，但多一个 incremental: true + since 字段，hub 端可据此识别
// M5：opts.table 指定单模块同步（只推送该表增量；hub 返回的全量包仍会整体合并 = 全模块拉取）
export async function buildIncrementalBackup(lastSyncAt = 0, opts = {}) {
  const since = Number(lastSyncAt) || 0;
  const onlyTable = opts.table || null;
  // 卡片：内容 / SRS / 错因 任一时间戳新于 since 都视为本次变更
  const allCards = await db.cards.toArray();
  const cards = allCards.filter(c => {
    const ts = Math.max(c.updatedAt ?? 0, c.reviewedAt ?? 0, c.wrongReasonAt ?? 0, c.createdAt ?? 0);
    // round17 R17-14：首包（since=0）放行全 0 时间戳的遗留行（早期备份/Anki 批导入
    // 缺时间戳）——`0 > 0` 恒假会让它们永久漏传，水位单调递增后再无补传路径
    return ts > since || (since === 0 && ts === 0);
  });
  const cardIds = new Set(cards.map(c => c.id));

  const parts = {};
  for (const t of getEffectiveSyncTables()) {
    if (t.table === 'images') continue; // 图片单独打包
    if (onlyTable && t.table !== onlyTable) { parts[t.table] = []; continue; }
    if (t.table === 'cards') { parts.cards = cards; continue; }
    // idOnly（不可变记录：番茄/成就/嵌入/userOps）与 updatedAt 策略统一用
    // sync-manifest 的 livenessTs 判定（2026-08-29 修复）：
    //   此前按固定顺序取「第一个存在的值」（createdAt ?? startedAt ?? unlockedAt ?? t ?? 0），
    //   reviews（只有 reviewedAt）与 embeddings（只有 updatedAt）的字段都不在链上
    //   → 判定值恒为 0 → `0 > since` 恒假 → 这两张表永不上传。
    //   livenessTs 取全部已知时间字段的最大值，任一表只要带其中一个字段即可正确判定。
    const rows = await exportRows(t);
    // round17 R17-14：同卡片过滤——首包放行全 0 时间戳行（防遗留行永久漏传）
    parts[t.table] = rows.filter(r => livenessTs(r) > since || (since === 0 && livenessTs(r) === 0));
  }
  // 增量包仍带全量墓碑（删除传播不可遗漏）
  const tombstones = await db.tombstones.toArray();

  // 增量包的图片：只带本次变更卡片引用的图片
  const ids = new Set();
  for (const c of cards) for (const id of extractImageIds(c.front + '\n' + c.back)) ids.add(id);
  const images = [];
  for (const id of ids) {
    const row = await db.images.get(id);
    if (row?.blob) images.push({ id, mime: row.mime || 'image/png', data: await blobToBase64(row.blob) });
  }

  const goalMeta = await db.meta.get('goal');
  const streakMeta = goalMeta ? { goal: goalMeta.value, updatedAt: goalMeta.updatedAt || 0 } : null;

  return {
    version: BACKUP_VERSION, app: 'sxybrick', scope: backupScope(), exportedAt: Date.now(),
    incremental: true, since, tombstones, images, streakMeta, ...parts,
  };
}

// ---------- P3-3 自动快照 / 历史回滚 ----------
// saveSnapshot：把当前 db 全量快照存入 db.snapshots，支持事后回滚
//   kind: 'backup-before-import' | 'auto-before-sync' | 'manual'
//   label: 用户可读的快照名（如「导入 sxybrick-备份-20260827.json 前」）
//   自动清理：超过 MAX_SNAPSHOTS 时删除最旧的
export async function saveSnapshot(label, kind = 'manual') {
  const tables = getEffectiveSyncTables();
  const rows = {};
  let sizeBytes = 0;
  for (const t of tables) {
    if (t.table === 'images') continue; // 图片单独存 Blob，不入快照（恢复时按引用重建）
    const arr = await db[t.table].toArray();
    rows[t.table] = arr;
    sizeBytes += JSON.stringify(arr).length;
  }
  rows.tombstones = await db.tombstones.toArray();
  rows.goal = (await db.meta.get('goal'))?.value ?? null;
  const snap = { id: uid(), label: String(label || '').slice(0, 80), kind, createdAt: Date.now(), rows, sizeBytes };
  await db.snapshots.put(snap);
  // 超出上限：按 createdAt 删最旧的
  const all = await db.snapshots.orderBy('createdAt').toArray();
  if (all.length > MAX_SNAPSHOTS) {
    const toDelete = all.slice(0, all.length - MAX_SNAPSHOTS);
    await Promise.all(toDelete.map(s => db.snapshots.delete(s.id)));
  }
  return snap;
}

export async function listSnapshots() {
  return await db.snapshots.orderBy('createdAt').reverse().toArray();
}

/**
 * 规划一次快照回滚：区分「快照里有、会被覆盖的表」与「快照里没有、必须跳过不动的表」。
 *
 * round18 R18-3（P2）：旧快照（生成时点早于某张表的引入）在 `snap.rows` 里没有该表的键，
 * 若按 `snap.rows?.[t] || []` 兜底，就会走「clear + 空 bulkPut」= 把这张表整表抹掉。
 * v25 之前生成的快照回滚一次 → 单词模块 7 张表全灭，且这类表往往是当时最活跃的新模块。
 * 语义修正：**快照里没有的表 = 当时还不存在，回滚不该倒退它的历史**，一律跳过原样保留。
 *
 * 纯函数（无 db 依赖），便于单测与 UI 预览。
 * @param {object} snap 快照对象
 * @param {Array} tables getEffectiveSyncTables() 的结果
 * @returns {{ restore: string[], skip: string[] }} 表名数组（images 恒跳过：快照不存图片）
 */
export function planSnapshotRestore(snap, tables) {
  const rows = snap?.rows || {};
  const restore = [];
  const skip = [];
  for (const t of tables || []) {
    if (t.table === 'images') { skip.push(t.table); continue; }
    if (Object.prototype.hasOwnProperty.call(rows, t.table)) restore.push(t.table);
    else skip.push(t.table);
  }
  return { restore, skip };
}

// 回滚到指定快照：用快照里的 rows 覆盖当前 db 各表（保留 images 不动，避免图片丢失）
//   注意：回滚是「破坏性」操作，会覆盖快照所含表的全部数据；调用方应先二次确认
export async function restoreSnapshot(id) {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('快照不存在或已被删除');
  const tables = getEffectiveSyncTables();
  const { restore, skip } = planSnapshotRestore(snap, tables);
  // P0 修正：整段回滚包裹在 Dexie 事务中，clear + bulkPut 中途中断时整体回滚，
  // 避免「部分表已清空、部分未写」的不可逆全库半残。
  const _seen = new Set();
  const txTables = [];
  for (const tb of [db.tombstones, db.meta, ...tables.map(t => db[t.table])]) {
    if (!_seen.has(tb.name)) { _seen.add(tb.name); txTables.push(tb); }
  }
  await db.transaction('rw', ...txTables, async () => {
    for (const t of tables) {
      // R18-3：只回滚快照里实际存在的表键；缺失键 = 旧快照，跳过以免整表抹空
      if (!restore.includes(t.table)) continue;
      const rows = snap.rows[t.table] || [];
      await db[t.table].clear();
      if (rows.length) await db[t.table].bulkPut(rows);
    }
    // 墓碑也回滚（快照内墓碑缺失时同理：旧快照没有墓碑键 → 跳过，不清空当前墓碑）
    if (Object.prototype.hasOwnProperty.call(snap.rows || {}, 'tombstones')) {
      await db.tombstones.clear();
      if (snap.rows.tombstones?.length) await db.tombstones.bulkPut(snap.rows.tombstones);
    }
    // 打卡目标回滚
    if (snap.rows?.goal != null) {
      await db.meta.put({ key: 'goal', value: snap.rows.goal, updatedAt: snap.createdAt });
    }
  });
  return { restoredAt: snap.createdAt, label: snap.label, restored: restore, skipped: skip };
}

export async function deleteSnapshot(id) {
  await db.snapshots.delete(id);
}

export async function downloadBackup() {
  const backup = await buildBackup();
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  // M3：演示模式导出文件名带 -test 后缀，避免与真实备份混淆/误导入
  const scopeTag = backupScope() === 'test' ? '-test' : '';
  a.download = `sxybrick-备份${scopeTag}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // round17 R17-37：click 后不能同步 revoke——部分浏览器（Firefox 等）下载未真正开始
  // 时 URL 已失效 → 偶发下载失败/空文件。延迟 1s 释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- M14 加密备份（.sxybrick）----------
// 判定：privacyRecords「落盘静态加密」与既有跨设备隐私同步(opt-in)语义冲突——
// 设备密钥加密后，对端设备无同一密钥无法解密，opt-in 隐私同步将名存实亡；
// 改为共享口令派生密钥则需要新增「设置隐私口令」UX 流程，超出本次修复边界。
// 故采用审计列出的最小可接受方案：离设备流转的备份文件走 AES-GCM + PBKDF2 加密，
// 明文不再落到磁盘文件里（crypto.js 由此从死代码变为真实被调用）。
// 备份内容范围沿用 buildBackup 的当前语义（需在包含隐私记录时先开启隐私同步）。

/** 生成加密备份（AES-GCM + PBKDF2，返回 base64 容器） */
export async function buildEncryptedBackup(password) {
  if (!password) throw new Error('请先设置加密口令');
  const backup = await buildBackup();
  const enc = await encryptBackup(backup, password);
  return { payload: enc, cardCount: (backup.cards || []).length, bytes: enc.length };
}

/** 下载加密备份文件（.sxybrick，非明文 JSON） */
export async function downloadEncryptedBackup(password) {
  const { payload } = await buildEncryptedBackup(password);
  const blob = new Blob([payload], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const scopeTag = backupScope() === 'test' ? '-test' : '';
  a.href = url;
  a.download = `sxybrick-加密备份${scopeTag}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.sxybrick`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // round17 R17-37：click 后不能同步 revoke（Firefox 等偶发下载失败/空文件），延迟 1s
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 解密并导入 .sxybrick 加密备份（口令错误/文件损坏 → 明确报错） */
export async function importEncryptedBackup(b64, password) {
  if (!password) throw new Error('请输入加密口令');
  let data;
  try {
    data = await decryptBackup(String(b64 || '').trim(), password);
  } catch {
    throw new Error('解密失败：口令错误或备份文件已损坏');
  }
  if (!data || data.app !== 'sxybrick') throw new Error('不是有效的 SxyBrick 加密备份包');
  return importBackup(data);
}

// 按科目导出一个卡组（分享给同学），可附带作者/版本/说明（E2 卡组署名）
export async function downloadSubjectBackup(subject, meta = {}) {
  if (!subject) throw new Error('请先选择要分享的科目');
  const backup = await buildBackup(subject);
  if (meta.author || meta.description) {
    backup.deckMeta = {
      author: String(meta.author || '').trim().slice(0, 30),
      description: String(meta.description || '').trim().slice(0, 200),
    };
  }
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  // M3：演示模式分享包同样带 -test 标记
  const scopeTag = backupScope() === 'test' ? '-test' : '';
  a.download = `sxybrick-卡组${scopeTag}-${subject}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // round17 R17-37：click 后不能同步 revoke——部分浏览器（Firefox 等）下载未真正开始
  // 时 URL 已失效 → 偶发下载失败/空文件。延迟 1s 释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 导出 CSV（制表符分隔，Anki/Excel 可直接导入）
// S1 公式注入防御：单元格前置 sheetCellGuard（= + - @ 开头 → 加单引号中和），
// 防止 WPS/Excel 直接打开 .tsv 时把用户可控内容当公式执行
export async function downloadCsv() {
  const cards = await db.cards.toArray();
  const rows = [['正面', '背面', '科目', '标签', '来源']];
  for (const c of cards) rows.push([c.front, c.back, c.subject || '', (c.tags || []).join(' '), c.source || '']);
  const tsv = rows.map(r => r.map(cell => sheetCellGuard(String(cell ?? '').replace(/\t/g, ' ').replace(/"/g, '""'))).join('\t')).join('\n');
  const blob = new Blob(['\ufeff' + tsv], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `sxybrick-导出-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.tsv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // round17 R17-37：click 后不能同步 revoke——部分浏览器（Firefox 等）下载未真正开始
  // 时 URL 已失效 → 偶发下载失败/空文件。延迟 1s 释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Anki 互通导出（E2 + P3-1 增强）：制表符分隔纯文本，Anki 桌面版「导入 → 文本文件」直接可用
// 说明：标准 .apkg 为二进制压缩包，需专用解析库；此处提供 Anki 原生支持的纯文本通道，实现零依赖互操作
// P3-1 增强：支持筛选卡片 + 第 3 列标签 + #tags column 配置，Anki 导入时自动带标签
// @param cards 可选，传入筛选后的卡片数组；无参时全量导出（向后兼容）
export async function downloadAnkiText(cards) {
  const arr = Array.isArray(cards) ? cards : await db.cards.toArray();
  const lines = ['#separator:tab', '#html:false', '#tags column:3'];
  for (const c of arr) {
    // S1 公式注入防御：与 CSV/TSV 同口径前置单引号中和（WPS 直接打开 .txt 表格化时同理）
    const front = sheetCellGuard(String(c.front || '').replace(/[\r\n\t]+/g, ' ').trim());
    const back = sheetCellGuard(String(c.back || '').replace(/[\r\n\t]+/g, ' ').trim());
    // Anki 标签用空格分隔，需清洗标签内空格
    const tags = (c.tags || []).map(t => String(t).replace(/\s+/g, '_')).join(' ');
    if (front) lines.push(`${front}\t${back}\t${tags}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `sxybrick-anki-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // round17 R17-37：click 后不能同步 revoke——部分浏览器（Firefox 等）下载未真正开始
  // 时 URL 已失效 → 偶发下载失败/空文件。延迟 1s 释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// round18 R18-10（P3）：Anki 导入上限具名常量 + 行数截断可见。
// 300 行是防呆上限（单次导入一次建 300 张卡已是重操作），截断时调用方应提示用户。
const ANKI_MAX_ROWS = 300;

/**
 * 解析 Anki 文本导入（E2）：Anki 导出的 txt / 分隔行文本 → 卡片行数组。
 *
 * round18 R18-10：返回结构化结果而非裸数组，导入前就剔除会崩的坏行：
 *   - 无分隔符行 back 为空 → createCard 会 throw「背面内容不能为空」（repo-core.js:29）
 *     且整循环中断、已入库的前 N 张不回滚（二次导入重复建卡）。这里直接跳过并计数，
 *     不再让坏行打断整批。
 *   - 超 ANKI_MAX_ROWS 的行截断并如实计数，避免「文件 3000 行、只导了 300 张」无任何告知。
 * @returns {{ pairs: Array<{front,back}>, truncated: number, skippedEmptyBack: number, total: number }}
 */
export function parseAnkiLines(text) {
  const all = String(text || '').split(/\r?\n/)
    .map(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return null;
      let front = l, back = '';
      const m = l.match(/^(.+?)\s*(?:\t|\||→|->)\s*(.+)$/);
      if (m && m[2]) { front = m[1].trim(); back = m[2].trim(); }
      return { front, back };
    })
    .filter(Boolean);
  const skippedEmptyBack = all.filter((p) => !p.back).length;
  const valid = all.filter((p) => !!p.back);
  const truncated = valid.length > ANKI_MAX_ROWS ? valid.length - ANKI_MAX_ROWS : 0;
  return { pairs: valid.slice(0, ANKI_MAX_ROWS), truncated, skippedEmptyBack, total: all.length };
}

// 局域网一键同步：把本地数据包 PUT 给电脑端中枢（hub），hub 合并后返回全量数据，再本地导入
// 增量优化：用 buildIncrementalBackup 仅上传「上次同步后变更」的行，千卡场景包体从全量降到几十行；
// 首次（无 lastSyncAt）退化为全量。中枢侧按同一 sync-manifest 合并，增量包结构兼容全量合并。
// M3：增量水位按 scope 分开（real/test 各自维护，互不干扰）
const hubLastSyncKey = () => backupScope() === 'test' ? 'sxy_hub_last_sync_test' : 'sxy_hub_last_sync';
const HUB_LAST_SYNC_KEY = 'sxy_hub_last_sync'; // 保留旧键兼容（real 域）

// ---------- 同步水位（P0 修复：单模块同步不得推进全局水位） ----------
// 水位 = 「上次成功上传到中枢的时刻」，增量包只上传 livenessTs(row) > since 的行。
//
// 历史缺陷：水位只有一个全局值。单模块同步（opts.table）时其它表被写成空数组上传，
// 中枢毫无变化，但水位仍被推到 startedAt —— 于是那些表里「时间戳早于 startedAt 的未推送变更」
// 从此 `> since` 恒为假，**永久静默丢失**。
// 修法：拆成「全局水位 + 每表独立水位」。单模块同步只推进该表水位；全量同步推进全局 + 所有表。
export function tableSyncKeyOf(globalKey, table) {
  return `${globalKey}__t_${table}`;
}

/**
 * 取本次同步的 since（纯函数：storage 依赖注入，便于 Node 单测）。
 * @param {{getItem:(k:string)=>string|null}} storage
 * @param {{globalKey:string, table?:string|null}} opts
 */
export function resolveSince(storage, { globalKey, table }) {
  const key = table ? tableSyncKeyOf(globalKey, table) : globalKey;
  try { return Number(storage?.getItem?.(key) || 0) || 0; } catch { return 0; }
}

/**
 * 推进水位（纯函数：storage 依赖注入）。
 * - table 有值：只推进该表水位（其它表的待推送变更不受影响）
 * - 全量：推进全局水位，并把所有表水位一并拉齐到同一值
 *   （否则「先单模块、后全量」会因各表水位参差而产生漏传/重复）
 * @param {{setItem:(k:string,v:string)=>void}} storage
 */
export function advanceWatermark(storage, { globalKey, table, value, allTables = [] }) {
  const v = String(value);
  const put = (k) => { try { storage?.setItem?.(k, v); } catch { /* 配额/隐私模式忽略 */ } };
  if (table) { put(tableSyncKeyOf(globalKey, table)); return; }
  put(globalKey);
  for (const t of allTables) put(tableSyncKeyOf(globalKey, t));
}

// M5：opts.table 指定单模块同步（只推送该表；hub 返回全量包仍整体合并 = 全模块拉取更新）
export async function syncWithHub(hubUrl, token, opts = {}) {
  const hub = String(hubUrl || '').replace(/\/+$/, '');
  if (!hub) throw new Error('请先填写电脑端同步中枢地址');
  // M3：hub 端点按 scope 路由（/backup/real | /backup/test），中枢侧独立数据文件
  const hubPath = `/backup/${backupScope()}`;
  const onlyTable = opts.table || null;
  const globalKey = hubLastSyncKey();
  // 单模块同步只认该表自己的水位；全量同步认全局水位
  const lastRaw = resolveSince(localStorage, { globalKey, table: onlyTable });
  // 水位基准必须在「建快照之前」取时刻（2026-08-29 修复）：
  //   若用同步完成时刻推进，则快照(T0)→完成(T2) 之间用户的编辑/复习其时间戳 ≤ T2，
  //   会被下次 `> since` 过滤掉，且 since 只增不减 → 这部分变更永久静默丢失。
  //   取快照前的时刻会让边界数据重传一次（合并幂等，安全），但绝不漏传。
  const startedAt = Date.now();
  const backup = await buildIncrementalBackup(lastRaw, { table: onlyTable });
  const body = JSON.stringify(backup);
  // 鉴权 v2：优先 HMAC 挑战-响应（同步密码不上网）；老版 Hub 或不支持 WebCrypto 时退回明文 token
  const authHeaders = await buildAuthHeaders({ hub, token, method: 'PUT', path: hubPath, body })
    || { 'x-sync-token': String(token || '') };
  const res = await fetch(`${hub}${hubPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body,
  });
  if (res.status === 401) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error || '同步密码错误，请检查 App「同步」页填写的密码');
  }
  if (res.status === 409) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error || '数据域不匹配：请先退出演示模式再同步真实数据');
  }
  if (!res.ok) throw new Error(`同步失败（${res.status}），请确认电脑端中枢已启动（演示模式需要新版中枢）`);
  const merged = await res.json();
  if (!merged || merged.app !== 'sxybrick') throw new Error('中枢返回的数据无效');
  const stats = await importBackup(merged);
  // 仅在成功（中枢返回合法数据）后推进 lastSyncAt，避免「上传失败却推进」导致后续漏传。
  // 推进值取快照时刻（startedAt / exportedAt 的较早者），而非此处调用时的 Date.now()，
  // 否则会把「快照建立 → 数据导入完成」这段时间内产生的本地变更永久跳过。
  try {
    // -1：增量判定是严格 `> since`，同一毫秒内落库的变更若不减 1 会永久漏传；
    //     减 1 只是让边界那批数据重传一次，合并是幂等的，安全。
    const watermark = Math.max(0, Math.min(startedAt, backup.exportedAt || startedAt) - 1);
    advanceWatermark(localStorage, {
      globalKey, table: onlyTable, value: watermark,
      allTables: getEffectiveSyncTables().map(t => t.table),
    });
  } catch {}
  // 插件钩子：同步完成后分发（fire-and-forget，插件异常不阻断）
  triggerHook('onSyncCompleted', stats).catch(() => {});
  return stats;
}

/**
 * 数据域校验：演示模式（test）与真实数据（real）的包不得互导。
 * 中枢通道靠 409 拦、Gist 通道在 Sync.vue 里校验，唯独最常用的「文件导入」通道没校验
 * —— M3 的数据域隔离在这条通道上形同虚设。
 * 历史数据包没有 scope 字段，为不误伤一律放行。
 */
export function assertBackupScope(backup) {
  const scope = backup?.scope;
  if (!scope) return;
  const cur = backupScope();
  if (scope === cur) return;
  const name = (s) => (s === 'test' ? '演示模式' : '真实数据');
  throw new Error(`数据域不匹配：当前是「${name(cur)}」，却要导入「${name(scope)}」的数据包。请先在设置里切换到${name(scope)}再导入。`);
}

// 各表合并 + 墓碑应用（与中枢 hub.js 的 merge 使用同一套 sync-manifest 纯函数，保证两端一致）
// P3-3 增强：合并前自动 saveSnapshot（kind=backup-before-import），合并后返回 stats.conflicts
//   conflicts: [{ id, front(摘要), winner: 'incoming'|'local'|'mixed', fields: ['front','ease',...], reason }]
//   让用户在 Sync.vue 直观看到「哪张卡的哪个字段被谁覆盖了」
export async function importBackup(backup, opts = {}) {
  if (!backup || backup.app !== 'sxybrick') throw new Error('不是有效的 SxyBrick 数据包');
  assertBackupScope(backup);
  const stats = { cards: 0, reviews: 0, overridden: 0, deleted: 0, duplicated: 0, conflicts: [], snapshotId: null };
  const effTables = getEffectiveSyncTables();
  for (const t of effTables) if (t.table !== 'cards' && t.table !== 'reviews') stats[t.table] = 0;

  // P3-3 0) 合并前自动保存快照（便于事后回滚）；失败不阻断导入
  //   opts.skipSnapshot —— round18 R18-2：推送前的 pull-merge 由代码自动触发，
  //   每次推送都存一份全量快照既浪费配额也让快照列表被噪声淹没（用户并没有主动导入）。
  if (!opts.skipSnapshot) {
    try {
      const label = `导入前自动快照 · ${fmtLocaleDateTime(Date.now())}`;
      const snap = await saveSnapshot(label, 'backup-before-import');
      stats.snapshotId = snap.id;
    } catch (e) { console.warn('[sync] 自动快照失败（不阻断导入）:', e?.message || e); }
  }

  // 0b) 卡片去重预判 + 关联引用重定向（round12 数据协同修复）
  // 先算出【跳过 id → 保留 id】映射。被「异 id 同内容」去重跳过的卡，其关联数据
  // （reviews 的 cardId / graphEdges 的 fromCardId,toCardId / cardGroupLinks 的 cardId
  //  / embeddings 的 sourceId 等）仍会随数据包进入合并，变成指向不存在卡片的孤儿行。
  // 故在逐表合并前，把全部入站表内凡引用了「跳过 id」的字段统一重定向到保留 id，
  // 让关联数据落到保留下来的那张卡上，避免复习/图谱/卡组/向量索引被污染。
  // 见 src/sync-dedup.js 头部说明。
  // ⚠️ 字段名枚举易漏（N-6：embeddings.sourceId 曾漏掉）——任何新卡片引用字段
  // 都必须同步加进 CARD_REF_FIELDS，否则被去重跳过的卡在对应表里留下孤儿行。
  let cardDedupe = { kept: (backup.cards || []).filter(x => x && x.id), duplicated: 0, idRemap: new Map() };
  if (cardDedupe.kept.length) {
    const baseCards = await db.cards.toArray();
    const baseCardsMap = new Map(baseCards.map(x => [x.id, x]));
    cardDedupe = dedupeIncomingCards(cardDedupe.kept, baseCardsMap, baseCards);
    if (cardDedupe.idRemap.size) {
      // round17 R17-8：补 sourceCardId（变式卡链）——去重跳过卡后，保留卡的
      // sourceCardId 仍指向已不存在的被跳卡 id，变式链路/血缘统计永久断裂
      const CARD_REF_FIELDS = ['cardId', 'fromCardId', 'toCardId', 'sourceId', 'sourceCardId'];
      // round15 P2：数组/嵌套引用字段也要重定向——notes.linkedCardIds、plans.linkedCardIds
      // （字符串数组）、analysisSessions.cardIds（JSON 串数组）、exams.questions（[{cardId}]）。
      // 此前只重定向标量字段，去重跳过的卡在这些表里留下孤儿引用。
      const ARRAY_REF_FIELDS = ['linkedCardIds'];
      const JSON_REF_FIELDS = ['cardIds'];
      const NESTED_REF_FIELDS = ['questions'];
      const remap = (v) => (cardDedupe.idRemap.has(v) ? cardDedupe.idRemap.get(v) : v);
      for (const key of Object.keys(backup)) {
        if (!Array.isArray(backup[key])) continue;
        backup[key] = backup[key].map(r => {
          let row = r;
          // round17 R17-8：cards 表自身只重定向 sourceCardId 单字段——绝不能对
          // cards 行做整行级 cardId 重定向（那会把保留卡的自身 id 改掉）
          if (key === 'cards') {
            if (r.sourceCardId != null && cardDedupe.idRemap.has(r.sourceCardId)) {
              row = { ...row, sourceCardId: cardDedupe.idRemap.get(r.sourceCardId) };
            }
            return row;
          }
          for (const f of CARD_REF_FIELDS) {
            if (r[f] != null && cardDedupe.idRemap.has(r[f])) {
              row = { ...row, [f]: cardDedupe.idRemap.get(r[f]) };
            }
          }
          for (const f of ARRAY_REF_FIELDS) {
            if (Array.isArray(r[f])) row = { ...row, [f]: r[f].map(x => remap(x)) };
          }
          for (const f of JSON_REF_FIELDS) {
            if (typeof r[f] === 'string') {
              try {
                const arr = JSON.parse(r[f]);
                if (Array.isArray(arr)) row = { ...row, [f]: JSON.stringify(arr.map(x => remap(x))) };
              } catch { /* 非 JSON 字符串：原样保留 */ }
            }
          }
          for (const f of NESTED_REF_FIELDS) {
            if (Array.isArray(r[f])) {
              row = { ...row, [f]: r[f].map(q => (q && typeof q === 'object' && q.cardId != null && cardDedupe.idRemap.has(q.cardId)) ? { ...q, cardId: remap(q.cardId) } : q) };
            }
          }
          return row;
        });
      }
    }
  }

  // 1) 墓碑：按 deletedAt 谁新听谁合并（kind 缺失的旧数据按 card 处理）
  // P0 修正：整段合并包裹在 Dexie 事务中，任一子步骤失败整体回滚，
  // 杜绝「部分表写入、部分未写」导致的数据不一致（尤其大批量导入中途中断）。
  // 事务表集合 = 墓碑 + 图片 + meta + 全部有效同步表（按 name 去重）。
  const _seen = new Set();
  const txTables = [];
  for (const tb of [db.tombstones, db.images, db.meta, ...effTables.map(t => db[t.table])]) {
    if (!_seen.has(tb.name)) { _seen.add(tb.name); txTables.push(tb); }
  }
  await db.transaction('rw', ...txTables, async () => {
  const tombstones = mergeTombstones(await db.tombstones.toArray(), backup.tombstones || []);
  if (tombstones.length) await db.tombstones.bulkPut(tombstones);

  // 2) 各数据表按清单策略合并（图片单独处理：base64→Blob 且存在即跳过，避免覆盖本地 Blob）
  for (const t of effTables) {
    if (t.table === 'images') continue;
    let incoming = (backup[t.table] || []).filter(x => x && x.id);
    if (!incoming.length) continue;
    // F10（round15 P2）：隐私/埋点表「已清空水位」——用户点过「清空埋点/清空隐私」后，
    // 把水位之前的入站行过滤掉，防止 hub/对端把历史行灌回（此前 wipe 只 clear 本地
    // 不写水位，下轮同步数据全部复活，「撤销监控」失效）。仅浏览器端有 localStorage。
    if (typeof localStorage !== 'undefined') {
      const clearedBefore = Number(localStorage.getItem(clearedBeforeKey(t.table)) || 0);
      if (clearedBefore) incoming = filterClearedRows(incoming, clearedBefore);
      if (!incoming.length) continue;
    }
    const base = await db[t.table].toArray();
    const baseMap = new Map(base.map(x => [x.id, x]));
    // E1 去重合并：内容雷同的异 id 卡视为重复跳过；但【同 id 卡必须放行】，
    // 交给下方 mergeRows 做字段级合并（SRS 按 reviewedAt 取新），否则纯复习（SRS 字段变）的卡
    // 会被内容去重静默丢弃 → 跨设备复习进度永不同步（P0 修复，逻辑见 src/sync-dedup.js）。
    if (t.table === 'cards') {
      // 复用 0b 步提前算好的去重结果（已跳过异 id 同内容卡并生成 idRemap），避免重复计算
      incoming = cardDedupe.kept;
      stats.duplicated += cardDedupe.duplicated;
    }
    if (!incoming.length) continue;
    const merged = mergeRows(base, incoming, t.merge, { strip: t.strip, extFields: t.extFields });
    let added = 0, updated = 0;
    const toWrite = [];
    const incomingMap = new Map(incoming.map(x => [x.id, x])); // O(n) 查表，替代循环内 find 的 O(n²)
    for (const row of merged) {
      const old = baseMap.get(row.id);
      if (!old) { added++; toWrite.push(row); }
      else {
        if (JSON.stringify(old) !== JSON.stringify(row)) { updated++; toWrite.push(row); }
        // P3-3 卡片冲突可视化：对 cards 表逐字段比对，记录哪些字段被谁覆盖
        if (t.table === 'cards') {
          const inc = incomingMap.get(row.id);
          const conflict = collectCardConflict(old, inc, row);
          if (conflict) stats.conflicts.push(conflict);
        }
      }
    }
    // 批量导入：一次 bulkPut 替代 N 次逐行 put（千卡导入从 N 次事务降为 1 次）
    if (toWrite.length) await db[t.table].bulkPut(toWrite);
    if (t.table === 'cards') { stats.cards = added; stats.overridden = updated; }
    else if (t.table === 'reviews') { stats.reviews = added; }
    else stats[t.table] = added + updated;
  }

  // 2b) 图片：base64 解码为 Blob 后按 id 幂等写入（bulkGet 已存在 id + 一次 bulkPut，替代逐张 get/put）
  stats.images = 0;
  const incomingImgs = (backup.images || []).filter(img => img && img.id && img.data);
  if (incomingImgs.length) {
    const existing = await db.images.bulkGet(incomingImgs.map(i => i.id));
    const toAdd = [];
    incomingImgs.forEach((img, i) => {
      if (existing[i]) return;
      toAdd.push({ id: img.id, blob: base64ToBlob(img.data, img.mime), mime: img.mime || 'image/png', createdAt: Date.now() });
    });
    if (toAdd.length) { await db.images.bulkPut(toAdd); stats.images = toAdd.length; }
  }

  // 3) 卡片墓碑：删除卡片 + 级联删复习记录 + 清理孤儿图片
  //    round17 R17-13：必须先于下方「各表 applyTombstones」执行——若后执行，
  //    reviews 表的复活判定会先把 review 墓碑清成 stale（如 selfExplainAt > deletedAt），
  //    随后本块级联又把复习行物理删掉 → 墓碑已丢，对端残留行下次以新行回灌（idOnly 幂等），
  //    孤儿 review 永久回归，卡墓碑因 kind 不匹配无法拦截。
  const cardsNow = await db.cards.toArray();
  const { removed, stale } = applyTombstones(cardsNow, tombstones, 'card');
  if (stale.length) await db.tombstones.bulkDelete(stale);
  if (removed.length) {
    const removedSet = new Set(removed);
    const goneImgIds = new Set();
    for (const c of cardsNow) {
      if (!removedSet.has(c.id)) continue;
      for (const i of extractImageIds((c.front || '') + '\n' + (c.back || ''))) goneImgIds.add(i);
    }
    await db.cards.bulkDelete(removed);
    await db.reviews.where('cardId').anyOf(removed).delete(); // 一次范围删除替代逐卡 delete
    // round15 P1：级联远端孤儿——卡片删除在源端已删 embeddings（sourceId 索引 + sourceType='card'）
    // 并写 graphEdge 墓碑；但对端若在墓碑同步之前就存在这些行（旧包/增量竞态），此处兜底清理，
    // 避免「删卡后对端 RAG 检索到幽灵向量、图谱挂着悬空边」。
    await db.embeddings.where('sourceId').anyOf(removed).and(e => e.sourceType === 'card').delete();
    await db.graphEdges.filter(e => removedSet.has(e.fromCardId) || removedSet.has(e.toCardId)).delete();
    stats.deleted = removed.length;
    if (goneImgIds.size) {
      const rest = await db.cards.toArray();
      const used = new Set();
      for (const c of rest) for (const i of extractImageIds((c.front || '') + '\n' + (c.back || ''))) used.add(i);
      const orphan = [...goneImgIds].filter(id => !used.has(id));
      if (orphan.length) await db.images.bulkDelete(orphan);
    }
  } else {
    // 无删除也执行一遍复活清理（兜底旧墓碑）
    const tombRows = await db.tombstones.toArray();
    const cardTomb = new Map(); // O(1) 查表，替代逐卡 find 的 O(n·m)
    for (const t of tombRows) if (kindOf(t) === 'card') cardTomb.set(t.id, t);
    const toClear = [];
    for (const c of cardsNow) {
      const tb = cardTomb.get(c.id);
      // 与 applyTombstones 同口径：必须看全部活跃时间戳，
      // 只看 updatedAt 会漏掉「复习（reviewedAt）后于删除」的复活场景
      if (tb && livenessTs(c) > (tb.deletedAt ?? 0)) toClear.push(c.id);
    }
    if (toClear.length) await db.tombstones.bulkDelete(toClear);
  }

  // 4) 其余各表墓碑：删除已在其他设备删除的记录；已「复活」（编辑晚于删除）的记录清除墓碑
  //    （此时卡级联已删完被删卡的复习行，review 墓碑不会再被误判复活而提前清掉）
  for (const t of effTables) {
    if (t.kind === 'card') continue; // 卡片已在上方处理
    const rows = await db[t.table].toArray();
    const { removed, stale } = applyTombstones(rows, tombstones, t.kind);
    if (stale.length) await db.tombstones.bulkDelete(stale);
    if (removed.length) await db[t.table].bulkDelete(removed);
  }

  // 5) 打卡元数据（每日目标 goal）：updatedAt 谁新听谁
  if (backup.streakMeta && typeof backup.streakMeta.goal === 'number') {
    const local = await db.meta.get('goal');
    if (!local || (backup.streakMeta.updatedAt || 0) >= (local.updatedAt || 0)) {
      await db.meta.put({ key: 'goal', value: backup.streakMeta.goal, updatedAt: backup.streakMeta.updatedAt || Date.now() });
    }
  }
  }); // end db.transaction（P0：整段导入原子化）

  return stats;
}

// P2-23 导入去重预览：提交前 dry-run 分类（只读，不写库、不建快照、不应用墓碑）。
// 复用与 importBackup 一致的去重/墓碑口径，返回每个同步表的 新增/覆盖/跳过/重复 计数与样例，
// 以及墓碑将删除的本地记录数，供 Sync.vue 先预览再确认导入。
const TABLE_LABEL = {
  cards: '卡片', reviews: '复习记录', images: '图片', memos: '备忘', plans: '计划',
  graphEdges: '图谱关系', docs: '文档', pomoSessions: '专注记录', mindmaps: '导图',
  weeklyReports: '周报', achievements: '成就', exams: '模考', embeddings: '嵌入向量',
  notes: '笔记', docFiles: '资料文件', dailyPlans: '每日计划', dailyTasks: '每日任务',
  aiChats: 'AI对话', aiMemories: 'AI记忆', meta: '元数据', userOps: '用户操作', privacyRecords: '隐私记录',
};
function previewSample(t, row) {
  if (t.table === 'cards') return (row.front || '(空卡)').slice(0, 48);
  if (t.table === 'notes') return (row.title || '').slice(0, 48);
  if (t.table === 'docs' || t.table === 'docFiles') return (row.name || row.title || '').slice(0, 48);
  if (['mindmaps', 'weeklyReports', 'plans', 'dailyPlans'].includes(t.table)) return (row.title || '').slice(0, 48);
  return String(row.id || '').slice(0, 24);
}
export async function previewImport(backup) {
  if (!backup || backup.app !== 'sxybrick') return { valid: false, error: '不是有效的 SxyBrick 数据包', tables: [] };
  // 与 importBackup 同口径：预览阶段就拦住跨数据域导入，别让用户走完 3 秒预览才发现
  try { assertBackupScope(backup); }
  catch (e) { return { valid: false, error: e.message, tables: [] }; }
  const effTables = getEffectiveSyncTables();
  const tombstones = backup.tombstones || [];
  const tables = [];
  let totalAdded = 0, totalOverwritten = 0, totalSkipped = 0, totalDuplicated = 0, totalDeleted = 0;
  // P2-26：分享包署名（deckMeta）透传给预览，导入者在确认前即可看到卡组作者/说明
  const dm = backup.deckMeta;
  const deckMeta = dm && (dm.author || dm.description)
    ? { author: String(dm.author || '').trim().slice(0, 30), description: String(dm.description || '').trim().slice(0, 200) }
    : null;

  for (const t of effTables) {
    if (t.table === 'images') {
      const incoming = (backup.images || []).filter(img => img && img.id && img.data);
      if (!incoming.length) continue;
      const existing = await db.images.bulkGet(incoming.map(i => i.id));
      let added = 0, skipped = 0;
      incoming.forEach((img, i) => { if (existing[i]) skipped++; else added++; });
      if (added || skipped) {
        tables.push({ table: 'images', kind: 'image', label: TABLE_LABEL.images, total: incoming.length, added, overwritten: 0, skipped, duplicated: 0, deleted: 0, samples: [] });
        totalAdded += added; totalSkipped += skipped;
      }
      continue;
    }
    let incoming = (backup[t.table] || []).filter(x => x && x.id);
    if (!incoming.length) continue;
    const base = await db[t.table].toArray();
    const baseMap = new Map(base.map(x => [x.id, x]));
    let duplicated = 0;
    if (t.table === 'cards') {
      const d = dedupeIncomingCards(incoming, baseMap, base);
      duplicated = d.duplicated;
      incoming = d.kept;
    }
    let added = 0, overwritten = 0, skipped = 0;
    const samples = [];
    for (const row of incoming) {
      const old = baseMap.get(row.id);
      if (!old) { added++; if (samples.length < 5) samples.push({ title: previewSample(t, row), status: 'new' }); }
      else if (JSON.stringify(old) !== JSON.stringify(row)) { overwritten++; if (samples.length < 5) samples.push({ title: previewSample(t, row), status: 'overwrite' }); }
      else { skipped++; }
    }
    let deleted = 0;
    if (tombstones.length) { const { removed } = applyTombstones(base, tombstones, t.kind); deleted = removed.length; }
    if (added || overwritten || skipped || duplicated || deleted) {
      tables.push({ table: t.table, kind: t.kind, label: TABLE_LABEL[t.table] || t.table, total: incoming.length, added, overwritten, skipped, duplicated, deleted, samples });
      totalAdded += added; totalOverwritten += overwritten; totalSkipped += skipped; totalDuplicated += duplicated; totalDeleted += deleted;
    }
  }
  return { valid: true, deckMeta, tables, totalAdded, totalOverwritten, totalSkipped, totalDuplicated, totalDeleted };
}

// P3-3 卡片冲突收集器：比对本地 / incoming / 合并后三者，找出哪些字段被覆盖、谁赢
//   返回 null 表示无字段级冲突（仅时间戳推进等无内容差异）
//   winner: 'incoming'=导入方赢 / 'local'=本地赢 / 'mixed'=字段级混合（内容来自一边、SRS 来自另一边）
function collectCardConflict(local, incoming, merged) {
  if (!local || !incoming || !merged) return null;
  const fields = [];
  let contentWinner = null, srsWinner = null;
  // 内容字段：判定来自 incoming 还是 local
  for (const f of CARD_CONTENT_FIELDS) {
    const lv = local[f], iv = incoming[f], mv = merged[f];
    if (JSON.stringify(lv) === JSON.stringify(iv)) continue; // 两端一致，无冲突
    if (JSON.stringify(mv) === JSON.stringify(iv)) { contentWinner = 'incoming'; fields.push(f); }
    else if (JSON.stringify(mv) === JSON.stringify(lv)) { contentWinner = 'local'; fields.push(f); }
  }
  // SRS 字段
  for (const f of CARD_SRS_FIELDS) {
    const lv = local[f], iv = incoming[f], mv = merged[f];
    if (JSON.stringify(lv) === JSON.stringify(iv)) continue;
    if (JSON.stringify(mv) === JSON.stringify(iv)) { srsWinner = 'incoming'; fields.push(f); }
    else if (JSON.stringify(mv) === JSON.stringify(lv)) { srsWinner = 'local'; fields.push(f); }
  }
  // 错因
  if (JSON.stringify(local.wrongReason) !== JSON.stringify(incoming.wrongReason)) {
    if (JSON.stringify(merged.wrongReason) === JSON.stringify(incoming.wrongReason)) { srsWinner = srsWinner || 'incoming'; fields.push('wrongReason'); }
    else if (JSON.stringify(merged.wrongReason) === JSON.stringify(local.wrongReason)) { srsWinner = srsWinner || 'local'; fields.push('wrongReason'); }
  }
  if (!fields.length) return null;
  // 判定整体 winner
  let winner = 'mixed';
  if (contentWinner && srsWinner) winner = contentWinner === srsWinner ? contentWinner : 'mixed';
  else if (contentWinner) winner = contentWinner;
  else if (srsWinner) winner = srsWinner;
  const frontPreview = String(local.front || incoming.front || '').slice(0, 40);
  return { id: merged.id, front: frontPreview, winner, fields, reason: explainConflict(contentWinner, srsWinner) };
}

function explainConflict(content, srs) {
  if (content && srs) {
    if (content === srs) return `内容与复习状态均来自${content === 'incoming' ? '导入方' : '本地'}`;
    return `内容来自${content === 'incoming' ? '导入方' : '本地'}，复习状态来自${srs === 'incoming' ? '导入方' : '本地'}`;
  }
  if (content) return `内容字段来自${content === 'incoming' ? '导入方' : '本地'}`;
  if (srs) return `复习状态来自${srs === 'incoming' ? '导入方' : '本地'}`;
  return '字段被覆盖';
}