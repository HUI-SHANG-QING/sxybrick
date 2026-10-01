// src/annot-repo.js
// 卡片批注的数据访问层。
//
// 为什么单独成文件而不塞进 repo.js：主数据层已 2794 行，批注是一块**独立内聚**的
// 新能力（自己的表、自己的 CRUD、自己的软删除语义），单独成文件的边界更清晰；
// 同时本模块只依赖 db.js（零业务依赖），不会被卷入 repo.js 的同步/级联大环。
//
// 硬性约束（逐条对应需求）：
//   · 批注与卡片内容**完全隔离** —— 只写 cardAnnots 表，绝不碰 cards 的正/背面字段；
//   · 一张卡可存多条，读取**按 createdAt 倒序**（最新在最上）；
//   · createdAt 由本层在创建时自动生成，UI 不可修改；编辑只改 content，**保留原 createdAt**；
//   · 删除为**软删除**（deletedAt），可撤销、可跨设备同步（行不消失，删除状态随行走）；
//   · 读接口对失败宽容（返回空数组/0），保证批注加载失败**绝不阻塞背诵主流程**；
//     写接口对空内容抛错（由 UI 提示），但也只是一个可捕获的普通 Error。

import { db, uid } from './db.js';

/** 单条批注内容上限（字符）。超长静默截断——与卡片侧「在写入边界收口」的风格一致。 */
export const ANNOT_MAX_CHARS = 2000;

/** 内容归一化：去首尾空白 + 截断。返回空串表示「无有效内容」。 */
export function normalizeAnnotContent(s) {
  return String(s ?? '').trim().slice(0, ANNOT_MAX_CHARS);
}

/** 行是否有效（存在且未被软删除）。 */
function isAlive(row) {
  return !!row && !row.deletedAt;
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
 * 列出某张卡的全部有效批注，按 createdAt **倒序**。
 * 查询失败或卡片无批注时一律返回 []（不抛错）。
 * @param {string} cardId
 * @returns {Promise<Array<object>>}
 */
export async function listAnnots(cardId) {
  const id = String(cardId || '');
  if (!id) return [];
  try {
    const rows = await db.cardAnnots.where('cardId').equals(id).toArray();
    return rows.filter(isAlive).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}

/**
 * 某张卡的有效批注条数（用于「批注 N」角标）。失败返回 0。
 * @param {string} cardId
 * @returns {Promise<number>}
 */
export async function countAnnots(cardId) {
  const id = String(cardId || '');
  if (!id) return 0;
  try {
    const rows = await db.cardAnnots.where('cardId').equals(id).toArray();
    return rows.filter(isAlive).length;
  } catch {
    return 0;
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
    deletedAt: null,
  };
  await db.cardAnnots.put(row);
  return row;
}

/**
 * 编辑批注内容。**保留原 createdAt**，只推进 updatedAt。
 * @returns {Promise<object|null>} 更新后的行；目标不存在或已删除时返回 null
 * @throws {Error} 内容为空（ANN_EMPTY）
 */
export async function updateAnnot(annotId, content) {
  const text = normalizeAnnotContent(content);
  if (!text) throw new Error('ANN_EMPTY');
  const row = await db.cardAnnots.get(annotId);
  if (!isAlive(row)) return null;
  const next = { ...row, content: text, updatedAt: Date.now() };
  await db.cardAnnots.put(next);
  return next;
}

/**
 * 软删除一条批注（可撤销）。行不消失，删除状态随 updatedAt 跨设备同步。
 * @returns {Promise<boolean>} 是否确实执行
 */
export async function softDeleteAnnot(annotId) {
  const row = await db.cardAnnots.get(annotId);
  if (!isAlive(row)) return false;
  const now = Date.now();
  await db.cardAnnots.put({ ...row, deletedAt: now, updatedAt: now });
  return true;
}

/**
 * 撤销软删除（恢复一条被删的批注）。
 * @returns {Promise<boolean>} 是否确实执行
 */
export async function restoreAnnot(annotId) {
  const row = await db.cardAnnots.get(annotId);
  if (!row || !row.deletedAt) return false;
  await db.cardAnnots.put({ ...row, deletedAt: null, updatedAt: Date.now() });
  return true;
}
