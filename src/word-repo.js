// src/word-repo.js
// 英语单词模块数据访问层（独立表，与记忆卡 repo.js 物理隔离）
//
// 设计要点：
//   - 复习调度**复用**记忆卡的底层算法：scheduleReview（SM-2/FSRS 自动切换）
//     + getSchedConfig 读取用户 FSRS 权重，保证单词与记忆卡同一套记忆曲线。
//   - 单词卡字段形状与 cards 兼容（ease/level/intervalDays/dueAt/fsrs/consolidation/
//     reviewedAt），因此 scheduleReview 可直接消费，无需重写调度逻辑。
//   - 熟词(familiar=1) 与范文(template) 不进默认复习队列：
//       · familiar 是用户主动标记「已掌握」，移出队列但保留检索/导出；
//       · template 是范文模板，无 SRS 语义，仅存储+收藏+导出。
//   - 删除走「回收站快照 + 墓碑」双写，与 deleteCard 一致，确保跨设备删除生效。
import { db, uid } from './db.js';
// 复用记忆卡调度器（SM-2/FSRS 自动切换）与权重配置：避免两套调度逻辑漂移
import { scheduleReview } from './srs.js';
import { getSchedConfig, refreshSchedConfig, formatDue, trashItem } from './repo.js';
import { retrievability } from './fsrs.js';

const now = () => Date.now();
// 剥离 Vue 响应式代理：Dexie put 前转纯对象，避免 reactive proxy 触发结构化克隆失败
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---------- 常量 ----------
export const WORD_KINDS = ['word', 'phrase', 'sentence', 'template'];
// 参与 SRS 复习的 kind（template 范文不参与）
export const SCHEDULABLE_KINDS = ['word', 'phrase', 'sentence'];

// ---------- 复习调度（复用底层算法） ----------
export async function reviewWord(cardId, rating, opts = {}) {
  const card = await db.wordCards.get(cardId);
  if (!card) throw new Error('单词卡不存在');
  if (card.kind === 'template') {
    // 范文不参与调度：仅记录一次浏览（reviewedAt bump），不重排 dueAt
    const t = now();
    await db.transaction('rw', db.wordCards, async () => {
      await db.wordCards.put({ ...plain(card), reviewedAt: t, updatedAt: t });
    });
    return { skipped: true, dueText: '—', reviewId: null };
  }
  const cfg = await getSchedConfig();
  const next = scheduleReview(card, rating, 1, false, {
    scheduler: cfg.scheduler,
    weights: cfg.weights,
    desiredRetention: opts.desiredRetention,
  });
  const nowTs = now();
  const predR = (card.fsrs && Number.isFinite(card.fsrs.s) && Number.isFinite(card.fsrs.last))
    ? Number(retrievability(card.fsrs.s, (nowTs - card.fsrs.last) / 86400000).toFixed(4))
    : null;
  const grade = rating >= 2 ? 'easy' : rating === 1 ? 'hard' : 'failed';
  const reviewId = uid();
  // 复习只更新 SRS 字段与 reviewedAt，不 bump updatedAt（与 repo.review 一致：
  // 否则跨设备同步时「复习动作」会覆盖另一台设备对文字/批注的编辑）
  await db.transaction('rw', db.wordCards, db.wordReviews, async () => {
    await db.wordCards.put({
      ...plain(card),
      ease: next.ease, level: next.level, intervalDays: next.intervalDays,
      dueAt: next.dueAt, consolidation: next.consolidation,
      fsrs: next.fsrs ?? card.fsrs, reviewedAt: nowTs,
    });
    await db.wordReviews.put({
      id: reviewId, cardId, reviewedAt: nowTs, rating,
      predR, levelAfter: next.level, grade,
    });
  });
  return { ...next, dueText: formatDue(next.dueAt), reviewId };
}

// 错题反思（落盘到复习记录，跨设备按 selfExplainAt 字段级合并）
export async function attachWordSelfExplanation(reviewId, text) {
  const r = await db.wordReviews.get(reviewId);
  if (!r) return null;
  const selfExplanation = String(text || '').trim().slice(0, 500);
  await db.wordReviews.put({ ...r, selfExplanation, selfExplainAt: Date.now() });
  return true;
}

// ---------- 单词卡 CRUD ----------
export async function createWordCard(payload = {}) {
  const kind = WORD_KINDS.includes(payload.kind) ? payload.kind : 'word';
  const t = now();
  const card = {
    id: uid(),
    kind,
    word: String(payload.word || '').trim(),
    phonetic: String(payload.phonetic || '').trim(),
    meaning: String(payload.meaning || '').trim(),
    example: String(payload.example || '').trim(),
    exampleTrans: String(payload.exampleTrans || '').trim(),
    note: String(payload.note || '').trim(),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String).filter(Boolean) : [],
    source: String(payload.source || '').trim(),
    subject: String(payload.subject || '').trim(),
    familiar: 0,
    // SRS 初始状态：新卡立即到期（进入当日复习队列）
    ease: 2.5, level: 0, intervalDays: 0, dueAt: t,
    reviewedAt: 0, consolidation: null, fsrs: null,
    createdAt: t, updatedAt: t,
  };
  if (!card.word) throw new Error('单词/内容不能为空');
  await db.wordCards.put(card);
  return card;
}

export async function updateWordCard(id, patch = {}) {
  const cur = await db.wordCards.get(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of ['word', 'phonetic', 'meaning', 'example', 'exampleTrans', 'note', 'source', 'subject']) {
    if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
  }
  if (patch.kind !== undefined && WORD_KINDS.includes(patch.kind)) next.kind = patch.kind;
  if (patch.tags !== undefined && Array.isArray(patch.tags)) {
    next.tags = patch.tags.map(String).filter(Boolean);
  }
  if (!next.word) throw new Error('单词/内容不能为空');
  next.updatedAt = now();
  await db.wordCards.put(next);
  return next;
}

// 删除单词卡：回收站快照 + 墓碑（跨设备删除同步）+ 删卡 + 删复习记录 + 删词组关联
export async function deleteWordCard(id) {
  const old = await db.wordCards.get(id);
  if (!old) return false;
  const imgIds = []; // 单词模块无图片字段，占位以对齐 deleteCard 流程
  await db.transaction('rw', db.wordCards, db.trash, db.tombstones, db.wordReviews, db.wordGroupLinks, async () => {
    const reviews = await db.wordReviews.where('cardId').equals(id).toArray();
    const links = await db.wordGroupLinks.where('cardId').equals(id).toArray();
    await trashItem(id, 'wordCard', { ...plain(old), _reviews: reviews, _groupLinks: links });
    await db.tombstones.put({ id, kind: 'wordCard', deletedAt: now() });
    if (links.length) {
      await db.tombstones.bulkPut(links.map(l => ({ id: l.id, kind: 'wordGroupLink', deletedAt: now() })));
    }
    await db.wordCards.delete(id);
    await db.wordReviews.where('cardId').equals(id).delete();
    await db.wordGroupLinks.where('cardId').equals(id).delete();
  });
  return true;
}

// ---------- 熟词标记 / 批注 ----------
// 标记熟词：移出默认复习队列（dueAt 推到一年外），但不删除，可检索/导出
export async function markFamiliar(id, value = 1) {
  const cur = await db.wordCards.get(id);
  if (!cur) return null;
  const v = value ? 1 : 0;
  const patch = { familiar: v, updatedAt: now() };
  if (v === 1) patch.dueAt = now() + 365 * 86400000; // 熟词一年后到期（等于移出活跃队列）
  else patch.dueAt = now(); // 取消熟词：立即重新进入复习队列
  await db.wordCards.put({ ...cur, ...patch });
  return { ...cur, ...patch };
}

// 设置批注（note 字段，updatedAt 跟踪；跨设备按 updatedAt 合并）
export async function setWordNote(id, text) {
  const cur = await db.wordCards.get(id);
  if (!cur) return null;
  const note = String(text || '').slice(0, 2000);
  await db.wordCards.put({ ...cur, note, updatedAt: now() });
  return { ...cur, note, updatedAt: now() };
}

// ---------- 词组（多对多，仿卡组） ----------
export async function listWordGroups() {
  return db.wordGroups.orderBy('sortOrder').toArray();
}

export async function createWordGroup(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('词组名称不能为空');
  const t = now();
  const g = {
    id: uid(),
    name,
    description: String(payload.description || '').trim(),
    color: payload.color || '#4f7cff',
    status: payload.status === 'archived' ? 'archived' : 'active',
    sortOrder: Number(payload.sortOrder) || 0,
    createdAt: t, updatedAt: t,
  };
  await db.wordGroups.put(g);
  return g;
}

export async function updateWordGroup(id, patch = {}) {
  const cur = await db.wordGroups.get(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of ['name', 'description', 'color', 'status']) {
    if (patch[k] !== undefined) next[k] = k === 'name' ? String(patch[k]).trim() : patch[k];
  }
  if (patch.sortOrder !== undefined) next.sortOrder = Number(patch.sortOrder) || 0;
  if (!next.name) throw new Error('词组名称不能为空');
  next.updatedAt = now();
  await db.wordGroups.put(next);
  return next;
}

export async function deleteWordGroup(id) {
  const g = await db.wordGroups.get(id);
  if (!g) return false;
  await db.transaction('rw', db.wordGroups, db.wordGroupLinks, db.tombstones, async () => {
    const links = await db.wordGroupLinks.where('groupId').equals(id).toArray();
    await db.wordGroupLinks.where('groupId').equals(id).delete();
    await db.wordGroups.delete(id);
    await db.tombstones.put({ id, kind: 'wordGroup', deletedAt: now() });
    if (links.length) {
      await db.tombstones.bulkPut(links.map(l => ({ id: l.id, kind: 'wordGroupLink', deletedAt: now() })));
    }
  });
  return true;
}

// 某词组内的单词卡 id
export async function wordGroupCardIds(groupId) {
  const links = await db.wordGroupLinks.where('groupId').equals(groupId).toArray();
  return links.map(l => l.cardId);
}

// 某单词卡所属词组
export async function wordGroupsOfCard(cardId) {
  const links = await db.wordGroupLinks.where('cardId').equals(cardId).toArray();
  const groups = await db.wordGroups.bulkGet(links.map(l => l.groupId));
  return groups.filter(Boolean);
}

// 批量把单词卡移入/移出词组（幂等移入；移出写墓碑）
export async function setWordGroups(cardIds, addGroupIds = [], removeGroupIds = []) {
  const t0 = Date.now();
  let added = 0, removed = 0;
  await db.transaction('rw', db.wordCards, db.wordGroups, db.wordGroupLinks, db.tombstones, async () => {
    const cards = cardIds && cardIds.length ? await db.wordCards.bulkGet(cardIds) : [];
    const validIds = cards.filter(Boolean).map(c => c.id);
    const validAdd = new Set((await db.wordGroups.bulkGet(addGroupIds || [])).filter(Boolean).map(g => g.id));
    const validRemove = new Set((await db.wordGroups.bulkGet(removeGroupIds || [])).filter(Boolean).map(g => g.id));
    if (validAdd.size) {
      const existing = await db.wordGroupLinks.where('groupId').anyOf([...validAdd]).toArray();
      const existSet = new Set(existing.map(l => `${l.cardId}|${l.groupId}`));
      const toAdd = [];
      for (const cid of validIds) for (const gid of validAdd) {
        if (!existSet.has(`${cid}|${gid}`)) {
          toAdd.push({ id: uid(), cardId: cid, groupId: gid, addedAt: t0 });
          existSet.add(`${cid}|${gid}`);
        }
      }
      if (toAdd.length) { added = toAdd.length; await db.wordGroupLinks.bulkAdd(toAdd); }
    }
    if (validRemove.size) {
      const toDel = await db.wordGroupLinks.where('cardId').anyOf(validIds).toArray();
      const gone = toDel.filter(l => validRemove.has(l.groupId));
      if (gone.length) {
        removed = gone.length;
        await db.wordGroupLinks.bulkDelete(gone.map(l => l.id));
        await db.tombstones.bulkPut(gone.map(l => ({ id: l.id, kind: 'wordGroupLink', deletedAt: t0 })));
      }
    }
  });
  return { added, removed };
}

// ---------- 列表 / 筛选 / 统计 ----------
/**
 * 列出单词卡（支持筛选）
 * @param {object} filter { kind?, familiar?, groupId?, q?, reviewedOnly?, schedulableOnly? }
 *   - kind：'word'|'phrase'|'sentence'|'template' 单选
 *   - familiar：1/0 熟词筛选
 *   - groupId：仅某词组内
 *   - q：关键字（word/meaning/phonetic/note 模糊）
 *   - reviewedOnly：true=只显示已背（reviewedAt>0）；false=只显示未背；不传=全部
 *   - schedulableOnly：true=排除 template（不参与 SRS）
 */
export async function listWordCards(filter = {}) {
  let rows = await db.wordCards.toArray();
  const q = String(filter.q || '').trim().toLowerCase();
  if (filter.kind) rows = rows.filter(r => r.kind === filter.kind);
  if (filter.familiar !== undefined && filter.familiar !== null) {
    rows = rows.filter(r => (r.familiar ? 1 : 0) === (Number(filter.familiar) ? 1 : 0));
  }
  if (filter.schedulableOnly) rows = rows.filter(r => SCHEDULABLE_KINDS.includes(r.kind));
  if (filter.reviewedOnly === true) rows = rows.filter(r => r.reviewedAt > 0);
  if (filter.reviewedOnly === false) rows = rows.filter(r => !r.reviewedAt);
  if (filter.groupId) {
    const ids = new Set(await wordGroupCardIds(filter.groupId));
    rows = rows.filter(r => ids.has(r.id));
  }
  if (q) {
    rows = rows.filter(r =>
      (r.word || '').toLowerCase().includes(q) ||
      (r.meaning || '').toLowerCase().includes(q) ||
      (r.phonetic || '').toLowerCase().includes(q) ||
      (r.note || '').toLowerCase().includes(q) ||
      (r.example || '').toLowerCase().includes(q));
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows;
}

// 复习队列：参与 SRS 且未标记为熟词且已到期（含从未复习的新卡）
export async function dueWordCards(opts = {}) {
  let rows = await db.wordCards.toArray();
  const t = now();
  rows = rows.filter(r =>
    SCHEDULABLE_KINDS.includes(r.kind) &&
    !r.familiar &&
    (r.dueAt || 0) <= t);
  if (opts.kind) rows = rows.filter(r => r.kind === opts.kind);
  if (opts.groupId) {
    const ids = new Set(await wordGroupCardIds(opts.groupId));
    rows = rows.filter(r => ids.has(r.id));
  }
  // 新卡（从未复习）优先，其次按到期时间升序
  rows.sort((a, b) => {
    const an = a.reviewedAt ? 0 : 1, bn = b.reviewedAt ? 0 : 1;
    if (an !== bn) return bn - an;
    return (a.dueAt || 0) - (b.dueAt || 0);
  });
  return rows;
}

// 统计：待复习 / 已掌握 / 今日新学 / 熟词 / 总数 / 范文数
export async function wordStats() {
  const rows = await db.wordCards.toArray();
  const t = now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  let due = 0, mastered = 0, newToday = 0, familiar = 0, templates = 0;
  for (const r of rows) {
    if (r.kind === 'template') { templates++; continue; }
    if (r.familiar) { familiar++; continue; }
    if ((r.createdAt || 0) >= dayStart) newToday++;
    if ((r.dueAt || 0) <= t) due++;
    if (r.level >= 4 || (r.intervalDays || 0) >= 21) mastered++;
  }
  return {
    total: rows.length,
    due, mastered, newToday, familiar, templates,
    schedulable: rows.length - templates,
  };
}

// 复习历史（已背查看）：按时间倒序
export async function wordReviewHistory(limit = 200) {
  const rows = await db.wordReviews.orderBy('reviewedAt').reverse().limit(limit).toArray();
  const cards = await db.wordCards.bulkGet(rows.map(r => r.cardId));
  const byId = new Map(cards.filter(Boolean).map(c => [c.id, c]));
  return rows.map(r => ({ ...r, card: byId.get(r.cardId) || null }));
}
