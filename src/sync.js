// 系统导出 / 导入（跨设备手动同步）
// 导出：把所有数据打包成一个 JSON 文件（表清单见 sync-manifest.js，自动覆盖全部模块）
// 导入：按策略合并（卡片=内容/SRS 双时间戳字段级；其他=updatedAt 或 id 幂等），
//       删除经「墓碑」跨设备传播，图片按 id 幂等写入
// P3-3 多设备同步增强：
//   · 自动快照：importBackup 前自动 saveSnapshot，支持历史回滚
//   · 冲突可视化：importBackup 返回 stats.conflicts，列出哪些卡片字段被覆盖
//   · 增量同步：buildIncrementalBackup(lastSyncAt) 只导出 updatedAt > lastSyncAt 的行
import { db, uid } from './db.js';
import { base64ToBlob, blobToBase64, extractImageIds } from './images.js';
import { triggerHook } from './plugins/registry.js';
import {
  BACKUP_VERSION, SYNC_TABLES, PRIVACY_SYNC_TABLES, EXCLUDED_FROM_SYNC,
  CARD_CONTENT_FIELDS, CARD_SRS_FIELDS,
  mergeRows, mergeTombstones, applyTombstones, kindOf, livenessTs,
} from './sync-manifest.js';
import { dedupeIncomingCards } from './sync-dedup.js';
import { buildAuthHeaders } from './utils/hub-auth.js';
import { pad2 } from './utils/format.js';

export { BACKUP_VERSION, EXCLUDED_FROM_SYNC };

const MAX_SNAPSHOTS = 12; // 快照保留上限：超过则自动删除最旧的，避免 IndexedDB 无限膨胀

// 隐私数据 opt-in：默认 false，用户在设置面板显式开启后隐私表才入同步/导出
export function isPrivacySyncEnabled() {
  return localStorage.getItem('sxy_privacy_sync') === '1';
}
export function setPrivacySyncEnabled(v) {
  localStorage.setItem('sxy_privacy_sync', v ? '1' : '0');
}
// 根据用户设置返回有效同步表清单
function getEffectiveSyncTables() {
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
      parts[t.table] = subject ? [] : await db[t.table].toArray();
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

  return { version: BACKUP_VERSION, app: 'sxybrick', exportedAt: Date.now(), tombstones, images, streakMeta, ...parts };
}

// P3-3 增量同步：只导出 updatedAt > lastSyncAt 的行（卡片按 max(updatedAt, reviewedAt, wrongReasonAt) 判定）
//   用途：hub 同步场景下，减少每次同步的包体积（从「全量 N 万行」降到「本次变更的几十行」）
//   注意：墓碑始终全量带（删除传播不可遗漏），图片仍按被引用打包
//   返回结构与 buildBackup 一致，但多一个 incremental: true + since 字段，hub 端可据此识别
export async function buildIncrementalBackup(lastSyncAt = 0) {
  const since = Number(lastSyncAt) || 0;
  // 卡片：内容 / SRS / 错因 任一时间戳新于 since 都视为本次变更
  const allCards = await db.cards.toArray();
  const cards = allCards.filter(c => {
    const ts = Math.max(c.updatedAt ?? 0, c.reviewedAt ?? 0, c.wrongReasonAt ?? 0, c.createdAt ?? 0);
    return ts > since;
  });
  const cardIds = new Set(cards.map(c => c.id));

  const parts = {};
  for (const t of getEffectiveSyncTables()) {
    if (t.table === 'cards') { parts.cards = cards; continue; }
    if (t.table === 'images') continue; // 图片单独打包
    // idOnly（不可变记录：番茄/成就/嵌入/userOps）与 updatedAt 策略统一用
    // sync-manifest 的 livenessTs 判定（2026-08-29 修复）：
    //   此前按固定顺序取「第一个存在的值」（createdAt ?? startedAt ?? unlockedAt ?? t ?? 0），
    //   reviews（只有 reviewedAt）与 embeddings（只有 updatedAt）的字段都不在链上
    //   → 判定值恒为 0 → `0 > since` 恒假 → 这两张表永不上传。
    //   livenessTs 取全部已知时间字段的最大值，任一表只要带其中一个字段即可正确判定。
    const rows = await db[t.table].toArray();
    parts[t.table] = rows.filter(r => livenessTs(r) > since);
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
    version: BACKUP_VERSION, app: 'sxybrick', exportedAt: Date.now(),
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

// 回滚到指定快照：用快照里的 rows 覆盖当前 db 各表（保留 images 不动，避免图片丢失）
//   注意：回滚是「破坏性」操作，会覆盖当前所有非图片表数据；调用方应先二次确认
export async function restoreSnapshot(id) {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('快照不存在或已被删除');
  const tables = getEffectiveSyncTables();
  // P0 修正：整段回滚包裹在 Dexie 事务中，clear + bulkPut 中途中断时整体回滚，
  // 避免「部分表已清空、部分未写」的不可逆全库半残。
  const _seen = new Set();
  const txTables = [];
  for (const tb of [db.tombstones, db.meta, ...tables.map(t => db[t.table])]) {
    if (!_seen.has(tb.name)) { _seen.add(tb.name); txTables.push(tb); }
  }
  await db.transaction('rw', ...txTables, async () => {
    for (const t of tables) {
      if (t.table === 'images') continue;
      const rows = (snap.rows?.[t.table] || []);
      await db[t.table].clear();
      if (rows.length) await db[t.table].bulkPut(rows);
    }
    // 墓碑也回滚
    await db.tombstones.clear();
    if (snap.rows?.tombstones?.length) await db.tombstones.bulkPut(snap.rows.tombstones);
    // 打卡目标回滚
    if (snap.rows?.goal != null) {
      await db.meta.put({ key: 'goal', value: snap.rows.goal, updatedAt: snap.createdAt });
    }
  });
  return { restoredAt: snap.createdAt, label: snap.label };
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
  a.download = `sxybrick-备份-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  a.download = `sxybrick-卡组-${subject}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 导出 CSV（制表符分隔，Anki/Excel 可直接导入）
export async function downloadCsv() {
  const cards = await db.cards.toArray();
  const rows = [['正面', '背面', '科目', '标签', '来源']];
  for (const c of cards) rows.push([c.front, c.back, c.subject || '', (c.tags || []).join(' '), c.source || '']);
  const tsv = rows.map(r => r.map(cell => String(cell ?? '').replace(/\t/g, ' ').replace(/"/g, '""')).join('\t')).join('\n');
  const blob = new Blob(['\ufeff' + tsv], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `sxybrick-导出-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.tsv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Anki 互通导出（E2 + P3-1 增强）：制表符分隔纯文本，Anki 桌面版「导入 → 文本文件」直接可用
// 说明：标准 .apkg 为二进制压缩包，需专用解析库；此处提供 Anki 原生支持的纯文本通道，实现零依赖互操作
// P3-1 增强：支持筛选卡片 + 第 3 列标签 + #tags column 配置，Anki 导入时自动带标签
// @param cards 可选，传入筛选后的卡片数组；无参时全量导出（向后兼容）
export async function downloadAnkiText(cards) {
  const arr = Array.isArray(cards) ? cards : await db.cards.toArray();
  const lines = ['#separator:tab', '#html:false', '#tags column:3'];
  for (const c of arr) {
    const front = String(c.front || '').replace(/[\r\n\t]+/g, ' ').trim();
    const back = String(c.back || '').replace(/[\r\n\t]+/g, ' ').trim();
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
  URL.revokeObjectURL(url);
}

// Anki 文本解析导入（E2）：Anki 导出的 txt / 分隔行文本 → 卡片
export function parseAnkiLines(text) {
  return String(text || '').split(/\r?\n/)
    .map(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return null;
      let front = l, back = '';
      const m = l.match(/^(.+?)\s*(?:\t|\||→|->)\s*(.+)$/);
      if (m && m[2]) { front = m[1].trim(); back = m[2].trim(); }
      return { front, back };
    })
    .filter(Boolean)
    .slice(0, 300);
}

// 局域网一键同步：把本地数据包 PUT 给电脑端中枢（hub），hub 合并后返回全量数据，再本地导入
// 增量优化：用 buildIncrementalBackup 仅上传「上次同步后变更」的行，千卡场景包体从全量降到几十行；
// 首次（无 lastSyncAt）退化为全量。中枢侧按同一 sync-manifest 合并，增量包结构兼容全量合并。
const HUB_LAST_SYNC_KEY = 'sxy_hub_last_sync';
export async function syncWithHub(hubUrl, token) {
  const hub = String(hubUrl || '').replace(/\/+$/, '');
  if (!hub) throw new Error('请先填写电脑端同步中枢地址');
  const lastRaw = Number(localStorage.getItem(HUB_LAST_SYNC_KEY) || 0) || 0;
  // 水位基准必须在「建快照之前」取时刻（2026-08-29 修复）：
  //   若用同步完成时刻推进，则快照(T0)→完成(T2) 之间用户的编辑/复习其时间戳 ≤ T2，
  //   会被下次 `> since` 过滤掉，且 since 只增不减 → 这部分变更永久静默丢失。
  //   取快照前的时刻会让边界数据重传一次（合并幂等，安全），但绝不漏传。
  const startedAt = Date.now();
  const backup = await buildIncrementalBackup(lastRaw);
  const body = JSON.stringify(backup);
  // 鉴权 v2：优先 HMAC 挑战-响应（同步密码不上网）；老版 Hub 或不支持 WebCrypto 时退回明文 token
  const authHeaders = await buildAuthHeaders({ hub, token, method: 'PUT', path: '/backup', body })
    || { 'x-sync-token': String(token || '') };
  const res = await fetch(`${hub}/backup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body,
  });
  if (res.status === 401) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error || '同步密码错误，请检查 App「同步」页填写的密码');
  }
  if (!res.ok) throw new Error(`同步失败（${res.status}），请确认电脑端中枢已启动`);
  const merged = await res.json();
  if (!merged || merged.app !== 'sxybrick') throw new Error('中枢返回的数据无效');
  const stats = await importBackup(merged);
  // 仅在成功（中枢返回合法数据）后推进 lastSyncAt，避免「上传失败却推进」导致后续漏传。
  // 推进值取快照时刻（startedAt / exportedAt 的较早者），而非此处调用时的 Date.now()，
  // 否则会把「快照建立 → 数据导入完成」这段时间内产生的本地变更永久跳过。
  try {
    const watermark = Math.min(startedAt, backup.exportedAt || startedAt);
    localStorage.setItem(HUB_LAST_SYNC_KEY, String(watermark));
  } catch {}
  // 插件钩子：同步完成后分发（fire-and-forget，插件异常不阻断）
  triggerHook('onSyncCompleted', stats).catch(() => {});
  return stats;
}

// 各表合并 + 墓碑应用（与中枢 hub.js 的 merge 使用同一套 sync-manifest 纯函数，保证两端一致）
// P3-3 增强：合并前自动 saveSnapshot（kind=backup-before-import），合并后返回 stats.conflicts
//   conflicts: [{ id, front(摘要), winner: 'incoming'|'local'|'mixed', fields: ['front','ease',...], reason }]
//   让用户在 Sync.vue 直观看到「哪张卡的哪个字段被谁覆盖了」
export async function importBackup(backup) {
  if (!backup || backup.app !== 'sxybrick') throw new Error('不是有效的 SxyBrick 数据包');
  const stats = { cards: 0, reviews: 0, overridden: 0, deleted: 0, duplicated: 0, conflicts: [], snapshotId: null };
  const effTables = getEffectiveSyncTables();
  for (const t of effTables) if (t.table !== 'cards' && t.table !== 'reviews') stats[t.table] = 0;

  // P3-3 0) 合并前自动保存快照（便于事后回滚）；失败不阻断导入
  try {
    const label = `导入前自动快照 · ${new Date().toLocaleString('zh-CN')}`;
    const snap = await saveSnapshot(label, 'backup-before-import');
    stats.snapshotId = snap.id;
  } catch (e) { console.warn('[sync] 自动快照失败（不阻断导入）:', e?.message || e); }

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
    const base = await db[t.table].toArray();
    const baseMap = new Map(base.map(x => [x.id, x]));
    // E1 去重合并：内容雷同的异 id 卡视为重复跳过；但【同 id 卡必须放行】，
    // 交给下方 mergeRows 做字段级合并（SRS 按 reviewedAt 取新），否则纯复习（SRS 字段变）的卡
    // 会被内容去重静默丢弃 → 跨设备复习进度永不同步（P0 修复，逻辑见 src/sync-dedup.js）。
    if (t.table === 'cards') {
      const { kept, duplicated: dup } = dedupeIncomingCards(incoming, baseMap, base);
      stats.duplicated += dup;
      incoming = kept;
    }
    if (!incoming.length) continue;
    const merged = mergeRows(base, incoming, t.merge);
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

  // 3) 应用墓碑：删除已在其他设备删除的记录；已「复活」（编辑晚于删除）的记录清除墓碑
  for (const t of effTables) {
    if (t.kind === 'card') continue; // 卡片单独处理（需级联清复习/图片）
    const rows = await db[t.table].toArray();
    const { removed, stale } = applyTombstones(rows, tombstones, t.kind);
    if (stale.length) await db.tombstones.bulkDelete(stale);
    if (removed.length) await db[t.table].bulkDelete(removed);
  }

  // 4) 卡片墓碑：删除卡片 + 级联删复习记录 + 清理孤儿图片
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
  const effTables = getEffectiveSyncTables();
  const tombstones = backup.tombstones || [];
  const tables = [];
  let totalAdded = 0, totalOverwritten = 0, totalSkipped = 0, totalDuplicated = 0, totalDeleted = 0;

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
  return { valid: true, tables, totalAdded, totalOverwritten, totalSkipped, totalDuplicated, totalDeleted };
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