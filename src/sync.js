// 系统导出 / 导入（跨设备手动同步）
// 导出：把所有数据（卡片 + 复习记录 + 删除墓碑 + 图片）打包成一个 JSON 文件
// 导入：按「最后修改时间谁新听谁」合并，删除用墓碑传播，图片按 id 幂等写入
import { db } from './db.js';
import { base64ToBlob, blobToBase64, extractImageIds } from './images.js';

export const BACKUP_VERSION = 1;

export async function countData() {
  const [cards, reviews, images] = await Promise.all([
    db.cards.count(), db.reviews.count(), db.images.count(),
  ]);
  return { cards, reviews, images };
}

export async function buildBackup(subject) {
  let cards = await db.cards.toArray();
  if (subject) cards = cards.filter(c => c.subject === subject);
  const cardIds = new Set(cards.map(c => c.id));
  let reviews = await db.reviews.toArray();
  if (subject) reviews = reviews.filter(r => cardIds.has(r.cardId));
  const tombstones = await db.tombstones.toArray();

  // 收集被打包卡片引用的图片
  const ids = new Set();
  for (const c of cards) for (const id of extractImageIds(c.front + '\n' + c.back)) ids.add(id);
  const images = [];
  for (const id of ids) {
    const row = await db.images.get(id);
    if (row?.blob) images.push({ id, mime: row.mime || 'image/png', data: await blobToBase64(row.blob) });
  }

  return { version: BACKUP_VERSION, app: 'sxybrick', exportedAt: Date.now(), cards, reviews, tombstones, images };
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

// 按科目导出一个卡组（分享给同学）
export async function downloadSubjectBackup(subject) {
  if (!subject) throw new Error('请先选择要分享的科目');
  const backup = await buildBackup(subject);
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

export async function importBackup(backup) {
  if (!backup || backup.app !== 'sxybrick') throw new Error('不是有效的 SxyBrick 数据包');
  const stats = { cards: 0, reviews: 0, images: 0, overridden: 0, deleted: 0 };

  // 1) 卡片：按 updatedAt 最后写入胜出
  const localCards = new Map((await db.cards.toArray()).map(c => [c.id, c]));
  for (const c of backup.cards || []) {
    const local = localCards.get(c.id);
    if (!local) { await db.cards.put(c); localCards.set(c.id, c); stats.cards++; }
    else if ((c.updatedAt ?? 0) > (local.updatedAt ?? 0)) { await db.cards.put(c); localCards.set(c.id, c); stats.overridden++; }
  }

  // 2) 删除墓碑：晚删除的生效
  const localTombs = new Map((await db.tombstones.toArray()).map(t => [t.id, t]));
  for (const t of backup.tombstones || []) {
    const lt = localTombs.get(t.id);
    if (lt && (lt.deletedAt ?? 0) >= (t.deletedAt ?? 0)) continue;
    const card = await db.cards.get(t.id);
    if (card && (card.updatedAt ?? 0) <= (t.deletedAt ?? 0)) {
      await db.cards.delete(t.id);
      await db.reviews.where('cardId').equals(t.id).delete();
      localCards.delete(t.id);
      stats.deleted++;
    }
    await db.tombstones.put(t);
    localTombs.set(t.id, t);
  }

  // 3) 清理已「复活」卡片的过期墓碑（最新编辑晚于删除时间）
  for (const c of localCards.values()) {
    const tb = localTombs.get(c.id);
    if (tb && (c.updatedAt ?? 0) > (tb.deletedAt ?? 0)) await db.tombstones.delete(c.id);
  }

  // 4) 复习记录：按 id 幂等合并
  for (const r of backup.reviews || []) {
    if (!(await db.reviews.get(r.id))) { await db.reviews.put(r); stats.reviews++; }
  }

  // 5) 图片：按 id 幂等写入
  for (const img of backup.images || []) {
    if (!(await db.images.get(img.id)) && img.data) {
      await db.images.put({ id: img.id, blob: base64ToBlob(img.data, img.mime), mime: img.mime || 'image/png', createdAt: Date.now() });
      stats.images++;
    }
  }

  return stats;
}