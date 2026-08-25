// 系统导出 / 导入（跨设备手动同步）
// 导出：把所有数据打包成一个 JSON 文件（表清单见 sync-manifest.js，自动覆盖全部模块）
// 导入：按策略合并（卡片=内容/SRS 双时间戳字段级；其他=updatedAt 或 id 幂等），
//       删除经「墓碑」跨设备传播，图片按 id 幂等写入
import { db } from './db.js';
import { base64ToBlob, blobToBase64, extractImageIds } from './images.js';
import {
  BACKUP_VERSION, SYNC_TABLES,
  mergeRows, mergeTombstones, applyTombstones, kindOf,
} from './sync-manifest.js';

export { BACKUP_VERSION };

export async function countData() {
  const out = {};
  const rows = await Promise.all(SYNC_TABLES.map(t => db[t.table].count()));
  SYNC_TABLES.forEach((t, i) => { out[t.table] = rows[i]; });
  return out;
}

export async function buildBackup(subject) {
  let cards = await db.cards.toArray();
  if (subject) cards = cards.filter(c => c.subject === subject);
  const cardIds = new Set(cards.map(c => c.id));

  const parts = {};
  for (const t of SYNC_TABLES) {
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

export async function downloadBackup() {
  const backup = await buildBackup();
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `sxybrick-备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
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
  const p = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `sxybrick-卡组-${subject}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
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
  const p = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `sxybrick-导出-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.tsv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Anki 互通导出（E2）：制表符分隔纯文本，Anki 桌面版「导入 → 文本文件」直接可用
// 说明：标准 .apkg 为二进制压缩包，需专用解析库；此处提供 Anki 原生支持的纯文本通道，实现零依赖互操作
export async function downloadAnkiText() {
  const cards = await db.cards.toArray();
  const lines = ['#separator:tab', '#html:false'];
  for (const c of cards) {
    const front = String(c.front || '').replace(/[\r\n\t]+/g, ' ').trim();
    const back = String(c.back || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (front) lines.push(`${front}\t${back}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `sxybrick-anki-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.txt`;
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
export async function syncWithHub(hubUrl, token) {
  const hub = String(hubUrl || '').replace(/\/+$/, '');
  if (!hub) throw new Error('请先填写电脑端同步中枢地址');
  const backup = await buildBackup();
  const res = await fetch(`${hub}/backup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': String(token || '') },
    body: JSON.stringify(backup),
  });
  if (!res.ok) throw new Error(`同步失败（${res.status}），请确认电脑端中枢已启动`);
  const merged = await res.json();
  if (!merged || merged.app !== 'sxybrick') throw new Error('中枢返回的数据无效');
  return importBackup(merged);
}

// 各表合并 + 墓碑应用（与中枢 hub.js 的 merge 使用同一套 sync-manifest 纯函数，保证两端一致）
export async function importBackup(backup) {
  if (!backup || backup.app !== 'sxybrick') throw new Error('不是有效的 SxyBrick 数据包');
  const stats = { cards: 0, reviews: 0, overridden: 0, deleted: 0, duplicated: 0 };
  for (const t of SYNC_TABLES) if (t.table !== 'cards' && t.table !== 'reviews') stats[t.table] = 0;

  // 1) 墓碑：按 deletedAt 谁新听谁合并（kind 缺失的旧数据按 card 处理）
  const tombstones = mergeTombstones(await db.tombstones.toArray(), backup.tombstones || []);
  for (const t of tombstones) await db.tombstones.put(t);

  // 2) 各数据表按清单策略合并（图片单独处理：base64→Blob 且存在即跳过，避免覆盖本地 Blob）
  for (const t of SYNC_TABLES) {
    if (t.table === 'images') continue;
    let incoming = (backup[t.table] || []).filter(x => x && x.id);
    if (!incoming.length) continue;
    const base = await db[t.table].toArray();
    const baseMap = new Map(base.map(x => [x.id, x]));
    // E1 去重合并：与本地 front+back+subject 完全相同的内容重复卡跳过不导入（避免跨设备重复入库）
    if (t.table === 'cards') {
      const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const localKeys = new Set(base.map(c => `${norm(c.front)}||${norm(c.back)}||${c.subject || ''}`));
      const kept = [];
      for (const c of incoming) {
        const k = `${norm(c.front)}||${norm(c.back)}||${c.subject || ''}`;
        if (localKeys.has(k)) { stats.duplicated++; continue; }
        kept.push(c);
        localKeys.add(k);
      }
      incoming = kept;
    }
    if (!incoming.length) continue;
    const merged = mergeRows(base, incoming, t.merge);
    let added = 0, updated = 0;
    for (const row of merged) {
      const old = baseMap.get(row.id);
      if (!old) { added++; } else {
        const a = JSON.stringify(old), b = JSON.stringify(row);
        if (a !== b) updated++;
      }
      await db[t.table].put(row);
    }
    if (t.table === 'cards') { stats.cards = added; stats.overridden = updated; }
    else if (t.table === 'reviews') { stats.reviews = added; }
    else stats[t.table] = added + updated;
  }

  // 2b) 图片：base64 解码为 Blob 后按 id 幂等写入
  stats.images = 0;
  for (const img of backup.images || []) {
    if (!img || !img.id || !img.data) continue;
    if (await db.images.get(img.id)) continue;
    await db.images.put({ id: img.id, blob: base64ToBlob(img.data, img.mime), mime: img.mime || 'image/png', createdAt: Date.now() });
    stats.images++;
  }

  // 3) 应用墓碑：删除已在其他设备删除的记录；已「复活」（编辑晚于删除）的记录清除墓碑
  for (const t of SYNC_TABLES) {
    if (t.kind === 'card') continue; // 卡片单独处理（需级联清复习/图片）
    const rows = await db[t.table].toArray();
    const { removed, stale } = applyTombstones(rows, tombstones, t.kind);
    for (const id of stale) await db.tombstones.delete(id);
    for (const id of removed) await db[t.table].delete(id);
  }

  // 4) 卡片墓碑：删除卡片 + 级联删复习记录 + 清理孤儿图片
  const cardsNow = await db.cards.toArray();
  const { removed, stale } = applyTombstones(cardsNow, tombstones, 'card');
  for (const id of stale) await db.tombstones.delete(id);
  if (removed.length) {
    const goneImgIds = new Set();
    for (const c of cardsNow) {
      if (!removed.includes(c.id)) continue;
      for (const i of extractImageIds((c.front || '') + '\n' + (c.back || ''))) goneImgIds.add(i);
      await db.cards.delete(c.id);
      await db.reviews.where('cardId').equals(c.id).delete();
      stats.deleted++;
    }
    if (goneImgIds.size) {
      const rest = await db.cards.toArray();
      const used = new Set();
      for (const c of rest) for (const i of extractImageIds((c.front || '') + '\n' + (c.back || ''))) used.add(i);
      for (const id of goneImgIds) if (!used.has(id)) await db.images.delete(id);
    }
  } else {
    // 无删除也执行一遍复活清理（兜底旧墓碑）
    const tombRows = await db.tombstones.toArray();
    for (const c of cardsNow) {
      const tb = tombRows.find(t => (kindOf(t)) === 'card' && t.id === c.id);
      if (tb && (c.updatedAt ?? 0) > (tb.deletedAt ?? 0)) await db.tombstones.delete(c.id);
    }
  }

  // 5) 打卡元数据（每日目标 goal）：updatedAt 谁新听谁
  if (backup.streakMeta && typeof backup.streakMeta.goal === 'number') {
    const local = await db.meta.get('goal');
    if (!local || (backup.streakMeta.updatedAt || 0) >= (local.updatedAt || 0)) {
      await db.meta.put({ key: 'goal', value: backup.streakMeta.goal, updatedAt: backup.streakMeta.updatedAt || Date.now() });
    }
  }

  return stats;
}