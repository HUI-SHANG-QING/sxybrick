// src/annot-repo.js
// 卡片批注的数据访问层。
//
// 为什么单独成文件而不塞进 repo.js：主数据层已 2794 行，批注是一块**独立内聚**的
// 新能力（自己的表、自己的 CRUD），单独成文件的边界更清晰；
// 同时本模块只依赖 db.js（零业务依赖），不会被卷入 repo.js 的同步/级联大环。
//
// ⚠️ 删除语义（2026-10-01 审计修正，重要）：
//   初版用的是「行内软删除字段 deletedAt」——**该做法在本项目里没有先例，且有两处硬伤**：
//   ① `deletedAt` 在本项目是**墓碑表 tombstones 的字段名**，用作行内字段会造成
//      「同名不同义」，后来的维护者必然误读；
//   ② 同步策略 `updatedAt` 是**整行 LWW**：一端删除（T1）后被另一端编辑（T2 > T1）
//      覆盖 ⇒ **删除失效、批注复活**。
//   现改为与项目其余表**同口径**：删除 = 物理删行 + 写墓碑
//   （`kind: 'cardAnnot'`，已在 sync-manifest 登记，applyTombstones 会据此清除对端同 id 行）。
//   不写回收站（trash）是因为 `restoreFromTrash` 尚不认识该 kind，写入也恢复不了；
//   数据层保留 updateAnnot 供将来补编辑入口，删除暂以「二次确认」兜底。
//
// 其余硬性约束（逐条对应需求）：
//   · 批注与卡片内容**完全隔离** —— 只写 cardAnnots 表，绝不碰 cards 的正/背面字段；
//   · 一张卡可存多条，读取**按 createdAt 倒序**（最新在最上）；
//   · createdAt 由本层在创建时自动生成，UI 不可修改；编辑只改 content，**保留原 createdAt**；
//   · 读接口对失败宽容（返回空数组），保证批注加载失败**绝不阻塞背诵主流程**；
//     写接口对空内容抛错（由 UI 提示），但也只是一个可捕获的普通 Error。

import { db, uid } from './db.js';

/** 单条批注内容上限（字符）。超长静默截断——与卡片侧「在写入边界收口」的风格一致。 */
export const ANNOT_MAX_CHARS = 2000;

/** 内容归一化：去首尾空白 + 截断。返回空串表示「无有效内容」。 */
export function normalizeAnnotContent(s) {
  return String(s ?? '').trim().slice(0, ANNOT_MAX_CHARS);
}

/**
 * 时间戳展示格式：`YYYY-MM-DD HH:mm:ss`，**本地时区**（需求指定的固定格式）。
 * 放在本层而非组件内，是为了让格式能被单测直接覆盖（组件只负责调用）。
 */
export function formatAnnotTs(ms) {
  // ⚠️ 不要写成 `Number(ms) || 0`：NaN 会被 `||` 兜成 0，非法输入就悄悄显示成
  //    「1970-01-01 08:00:00」而不是空串（本项目反复踩过的 falsy 陷阱）。
  //    先过 Number.isFinite 判断合法性，再交给 Date。
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 列出某张卡的全部批注，按 createdAt **倒序**。
 * 查询失败或卡片无批注时一律返回 []（不抛错）。
 * @param {string} cardId
 * @returns {Promise<Array<object>>}
 */
export async function listAnnots(cardId) {
  const id = String(cardId || '');
  if (!id) return [];
  try {
    const rows = await db.cardAnnots.where('cardId').equals(id).toArray();
    return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}

/**
 * 新增一条批注。createdAt 在此自动生成，调用方无法指定（时间戳不可手动修改）。
 *
 * 另记两个**写入当时的复习上下文快照**：reviewCount（该卡累计复习次数）、level（当时巩固等级）。
 * 取不到时写 null —— 快照只用于回顾，**不允许它阻塞批注保存**。
 *
 * @param {string} cardId
 * @param {string} content
 * @returns {Promise<object>} 新建的行
 * @throws {Error} 卡片 id 缺失（ANN_NO_CARD）或内容为空（ANN_EMPTY）
 */
export async function addAnnot(cardId, content) {
  const id = String(cardId || '');
  const text = normalizeAnnotContent(content);
  if (!id) throw new Error('ANN_NO_CARD');
  if (!text) throw new Error('ANN_EMPTY');

  let reviewCount = null;
  let level = null;
  try {
    reviewCount = await db.reviews.where('cardId').equals(id).count();
  } catch { /* 快照失败不影响批注本体 */ }
  try {
    const card = await db.cards.get(id);
    const lv = Number(card?.level);
    level = Number.isFinite(lv) ? lv : null;
  } catch { /* 同上 */ }

  const now = Date.now();
  const row = {
    id: uid(),
    cardId: id,
    content: text,
    createdAt: now,
    updatedAt: now,
    reviewCount,
    level,
  };
  await db.cardAnnots.put(row);
  return row;
}

/**
 * 编辑批注内容。**保留原 createdAt**，只推进 updatedAt。
 * @returns {Promise<object|null>} 更新后的行；目标不存在时返回 null
 * @throws {Error} 内容为空（ANN_EMPTY）
 */
export async function updateAnnot(annotId, content) {
  const text = normalizeAnnotContent(content);
  if (!text) throw new Error('ANN_EMPTY');
  const row = await db.cardAnnots.get(annotId);
  if (!row) return null;
  const next = { ...row, content: text, updatedAt: Date.now() };
  await db.cardAnnots.put(next);
  return next;
}

/**
 * 删除一条批注：**物理删行 + 写墓碑**（与 deleteNote / sweepOrphanRows 同口径）。
 *
 * 为什么必须带墓碑：本端删行后若没有墓碑，对端同 id 的行（老包 / 未收到删除的设备）
 * 下次合并会按「新行」回灌，删除在跨设备场景静默失效。
 * 事务保证「删行 + 墓碑」原子：墓碑写失败则整体回滚，不会出现「行没了但墓碑也没写」。
 *
 * @returns {Promise<boolean>} 是否确实删除了（目标不存在返回 false）
 */
export async function deleteAnnot(annotId) {
  const id = String(annotId || '');
  if (!id) return false;
  const row = await db.cardAnnots.get(id);
  if (!row) return false;
  const ts = Date.now();
  await db.transaction('rw', db.cardAnnots, db.tombstones, async () => {
    await db.cardAnnots.delete(id);
    await db.tombstones.put({ id, kind: 'cardAnnot', deletedAt: ts });
  });
  return true;
}
