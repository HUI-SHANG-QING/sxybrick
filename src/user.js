// 多用户（档案）管理：用户目录 + 切换 + 跨库迁移
// 设计（与 db.js 的 live-binding 实例配合）：
//  - 用户目录（id/name/createdAt/lastUsedAt）存 localStorage（单机本地优先，无需独立账户库）。
//  - 当前用户 id 存 localStorage(CURRENT_USER_KEY)，启动时由 appMode.init 读它并 open 对应库。
//  - 切换/新建用户 = setDbInstance('real', id) + 写入 CURRENT_USER_KEY + 整页 reload
//    （与演示模式一致：保证所有 Pinia store 重新查询当前库）。
//  - 迁移 = 同时在源库与目标库各 open 一个 Dexie 实例，读源写目标，不切全局 db。

import { ref } from 'vue';
import { getUserDb, CURRENT_USER_KEY, currentUserId, setDbInstance } from './db.js';

const USERS_KEY = 'sxy_users'; // localStorage: JSON 数组，与 CURRENT_USER_KEY 分开便于只读枚举

/** 用户目录（响应式，供 UI 直接绑定）。 */
export const users = ref(loadUsers());
export const activeUserId = ref(currentUserId());

function loadUsers() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(USERS_KEY) : null;
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function persistUsers() {
  if (typeof localStorage !== 'undefined') localStorage.setItem(USERS_KEY, JSON.stringify(users.value));
}

/** 当前用户对象（默认档案兜底）。 */
export function activeUser() {
  const id = activeUserId.value;
  return users.value.find(u => u.id === id) || { id: 'default', name: '默认档案', builtin: true };
}

/** 新建档案（不自动切换，调用方决定）。返回新用户对象。 */
export function createUser(name) {
  const id = `u_${(Date.now().toString(36) + Math.random().toString(36).slice(2, 8))}`;
  const u = { id, name: (name || '新档案').trim().slice(0, 24), createdAt: Date.now(), lastUsedAt: Date.now() };
  const exists = users.value.some(x => x.id === id);
  if (!exists) users.value = [...users.value, u];
  persistUsers();
  // 预创建库（应用 schema，保证首次进入即就绪）
  getUserDb(id);
  return u;
}

/** 切换档案：写 localStorage + 切换 db live binding + 整页 reload。 */
export function switchUser(id) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(CURRENT_USER_KEY, id || 'default');
  activeUserId.value = id || 'default';
  const u = users.value.find(x => x.id === id);
  if (u) { u.lastUsedAt = Date.now(); persistUsers(); }
  setDbInstance('real', id || 'default');
  if (typeof location !== 'undefined') location.reload();
}

/** 删除档案（仅新建的非默认用户）：删除其独立库 + 从目录移除。 */
export async function deleteUser(id) {
  if (!id || id === 'default') throw new Error('默认档案不可删除');
  const d = getUserDb(id);
  await d.delete(); // 物理删库，零残留（对比单库 ownerId 方案需逐表清）
  users.value = users.value.filter(x => x.id !== id);
  persistUsers();
  if (activeUserId.value === id) switchUser('default');
}

/**
 * 跨档案迁移：把源档案中「指定范围的卡片」连同其关联数据复制到目标档案。
 * 卡片 id 为全局 UUID，跨库 bulkPut 无主键冲突。
 * @param {string} fromId 源用户 id（'default' 表示默认档案）
 * @param {string} toId   目标用户 id
 * @param {{ subjects?:string[], groupId?:string, all?:boolean }} scope 迁移范围
 * @param {(p:number)=>void} onProgress 进度回调（0~1）
 * @returns {Promise<{cards:number, edges:number, mindmaps:number, notes:number, memos:number, groups:number}>}
 */
export async function migrateData(fromId, toId, scope = {}, onProgress = () => {}) {
  if (fromId === toId) throw new Error('源与目标不能是同一档案');
  const src = getUserDb(fromId);
  const dst = getUserDb(toId);

  // 1) 选卡片
  let cards = await src.cards.toArray();
  if (scope.subjects?.length) cards = cards.filter(c => scope.subjects.includes(c.subject));
  if (scope.groupId) {
    const links = await src.cardGroupLinks.where('groupId').equals(scope.groupId).toArray();
    const ids = new Set(links.map(l => l.cardId));
    cards = cards.filter(c => ids.has(c.id));
  }
  const cardIds = new Set(cards.map(c => c.id));
  onProgress(0.2);

  // 2) 关联数据（仅迁移与选中卡片相关的，避免把整库的边/复习都搬过去）
  const [reviews, edges, mindmaps, notes, memos, groups, groupLinks] = await Promise.all([
    src.reviews.filter(r => cardIds.has(r.cardId)).toArray(),
    src.graphEdges.filter(e => cardIds.has(e.fromCardId) && cardIds.has(e.toCardId)).toArray(),
    src.mindmaps.toArray(),                 // 导图是独立知识树，量少，整库迁移
    src.notes.toArray(),                    // 笔记独立，整库迁移
    src.memos.toArray(),                    // 备忘独立，整库迁移
    src.cardGroups.toArray(),              // 卡组元数据整库迁移
    src.cardGroupLinks.filter(l => cardIds.has(l.cardId)).toArray(),
  ]);
  onProgress(0.5);

  // 3) 写入目标库（bulkPut：已存在则覆盖，幂等可重跑）
  await dst.transaction('rw',
    [dst.cards, dst.reviews, dst.graphEdges, dst.mindmaps, dst.notes, dst.memos, dst.cardGroups, dst.cardGroupLinks],
    async () => {
      await dst.cards.bulkPut(cards);
      await dst.reviews.bulkPut(reviews);
      await dst.graphEdges.bulkPut(edges);
      await dst.mindmaps.bulkPut(mindmaps);
      await dst.notes.bulkPut(notes);
      await dst.memos.bulkPut(memos);
      await dst.cardGroups.bulkPut(groups);
      await dst.cardGroupLinks.bulkPut(groupLinks);
    });
  onProgress(1);

  return {
    cards: cards.length,
    edges: edges.length,
    mindmaps: mindmaps.length,
    notes: notes.length,
    memos: memos.length,
    groups: groups.length,
  };
}

/** 取源档案可选的迁移范围（科目列表 / 卡组列表）。 */
export async function migrationScope(fromId) {
  const src = getUserDb(fromId);
  const [cards, groups] = await Promise.all([src.cards.toArray(), src.cardGroups.toArray()]);
  const subjects = [...new Set(cards.map(c => c.subject || '未分类'))].filter(Boolean).sort();
  return { subjects, groups };
}
