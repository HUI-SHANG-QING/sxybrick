// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid } from './db.js';
import { computeNext } from './srs.js';
import { extractImageIds } from './images.js';

export const DEFAULT_SUBJECTS = ['计算机网络', '操作系统', '数据结构', '计算机组成原理', '高等数学', '线性代数', '概率论'];
const MAX_CHARS = 8000;

const now = () => Date.now();

export function validateCard(body) {
  const front = String(body.front ?? '').trim();
  const back = String(body.back ?? '').trim();
  const subject = String(body.subject ?? '').trim().slice(0, 30);
  const tags = (Array.isArray(body.tags) ? body.tags : [])
    .map(t => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 16);
  const source = String(body.source ?? '').trim().slice(0, 60);
  if (!front) return { error: '正面内容不能为空' };
  if (!back) return { error: '背面内容不能为空' };
  if ([...front].length > MAX_CHARS) return { error: `正面内容不能超过 ${MAX_CHARS} 字` };
  if ([...back].length > MAX_CHARS) return { error: `背面内容不能超过 ${MAX_CHARS} 字` };
  return { value: { front, back, subject, tags, source } };
}

async function allCards() {
  return db.cards.toArray();
}

// ---------- 科目 / 标签 ----------
export async function getSubjects() {
  const cards = await allCards();
  const map = new Map();
  for (const c of cards) if (c.subject) map.set(c.subject, (map.get(c.subject) || 0) + 1);
  const names = [...new Set([...DEFAULT_SUBJECTS, ...map.keys()])];
  return names.map(name => ({ name, count: map.get(name) || 0 }));
}

export async function getTags(subject = '') {
  const cards = await allCards();
  const map = new Map();
  for (const c of cards) {
    if (subject && c.subject !== subject) continue;
    for (const t of (c.tags || [])) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// 多标签 AND/OR/NOT 过滤
function tagFilter(cards, tags, logic) {
  if (!tags.length) return cards;
  if (logic === 'AND') return cards.filter(c => tags.every(t => (c.tags || []).includes(t)));
  if (logic === 'OR') return cards.filter(c => tags.some(t => (c.tags || []).includes(t)));
  return cards.filter(c => !tags.some(t => (c.tags || []).includes(t))); // NOT
}

// ---------- 卡片列表 ----------
export async function listCards({ q = '', subject = '', tags = [], logic = 'AND', mode = 'all', sortBy = 'updated' } = {}) {
  let cards = await allCards();
  if (subject) cards = cards.filter(c => c.subject === subject);
  if (q) cards = cards.filter(c => c.front.includes(q) || c.back.includes(q));
  cards = tagFilter(cards, tags, logic);
  if (mode === 'due') cards = cards.filter(c => c.dueAt <= now());
  if (sortBy === 'created') cards.sort((a, b) => (b.createdAt - a.createdAt) || (b.id > a.id ? 1 : -1));
  else if (sortBy === 'due') cards.sort((a, b) => (a.dueAt - b.dueAt) || (a.id < b.id ? -1 : 1));
  else if (sortBy === 'subject') cards.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || '')) || (b.updatedAt - a.updatedAt));
  else cards.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.id > a.id ? 1 : -1));
  const dueCount = (await allCards()).filter(c => c.dueAt <= now()).length;
  return { items: cards, total: cards.length, dueCount };
}

export async function getCard(id) {
  return (await db.cards.get(id)) || null;
}

export async function createCard(payload) {
  const r = validateCard(payload);
  if (r.error) throw new Error(r.error);
  const t = now();
  const card = {
    id: uid(), front: r.value.front, back: r.value.back, subject: r.value.subject, source: r.value.source,
    tags: r.value.tags, frontChars: [...r.value.front].length, backChars: [...r.value.back].length,
    ease: 2.5, level: 0, intervalDays: 0, dueAt: t, createdAt: t, updatedAt: t,
  };
  await db.cards.put(card);
  return card;
}

export async function updateCard(id, payload) {
  const old = await db.cards.get(id);
  if (!old) throw new Error('卡片不存在');
  const r = validateCard(payload);
  if (r.error) throw new Error(r.error);
  const card = {
    ...old, front: r.value.front, back: r.value.back, subject: r.value.subject, tags: r.value.tags,
    source: r.value.source,
    frontChars: [...r.value.front].length, backChars: [...r.value.back].length, updatedAt: now(),
  };
  await db.cards.put(card);
  return card;
}

export async function deleteCard(id) {
  const old = await db.cards.get(id);
  if (!old) return;
  const imgIds = [...extractImageIds((old.front || '') + '\n' + (old.back || ''))];
  await db.cards.delete(id);
  await db.tombstones.put({ id, deletedAt: now() });
  await db.reviews.where('cardId').equals(id).delete();
  await cleanupOrphanImages(imgIds);
}

// 删除卡片后，清理不再被任何卡片引用的图片
async function cleanupOrphanImages(ids) {
  if (!ids.length) return;
  const cards = await allCards();
  const used = new Set();
  for (const c of cards) for (const i of extractImageIds((c.front || '') + '\n' + (c.back || ''))) used.add(i);
  for (const id of new Set(ids)) if (!used.has(id)) await db.images.delete(id);
}

// ---------- 复习 ----------
export async function reviewQueue(limit = 100) {
  const cards = (await allCards())
    .filter(c => c.dueAt <= now())
    .sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : 1));
  return cards.slice(0, limit);
}

export async function review(cardId, rating, intensity = 1) {
  const card = await db.cards.get(cardId);
  if (!card) throw new Error('卡片不存在');
  const next = computeNext(card, rating, intensity);
  await db.cards.put({ ...card, ease: next.ease, level: next.level, intervalDays: next.intervalDays, dueAt: next.dueAt, updatedAt: now() });
  await db.reviews.put({ id: uid(), cardId, reviewedAt: now(), rating, levelAfter: next.level });
  return { ...next, dueText: formatDue(next.dueAt) };
}

export function formatDue(ts) {
  const diff = ts - now();
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))} 分钟后`;
  if (diff < 24 * 3600 * 1000) return `${Math.round(diff / 3600000)} 小时后`;
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 已背记录 ----------
export async function reviewHistory(limit = 200) {
  const reviews = await db.reviews.orderBy('reviewedAt').reverse().limit(limit).toArray();
  const cardMap = new Map((await allCards()).map(c => [c.id, c]));
  const label = ['没记住', '还模糊', '记住了'];
  return reviews.map(r => {
    const card = cardMap.get(r.cardId);
    return {
      id: r.id, cardId: r.cardId, reviewedAt: r.reviewedAt, rating: r.rating,
      ratingText: label[r.rating] ?? '已复习',
      front: card?.front || '(卡片已删除)', back: card?.back || '',
      subject: card?.subject || '', tags: card?.tags || [],
    };
  });
}

// ---------- 错题集 / 薄弱卡片 ----------
export async function weakCards(limit = 100, minFail = 2) {
  const cards = await allCards();
  const reviews = await db.reviews.toArray();
  const fail = new Map();
  for (const r of reviews) if (r.rating === 0) fail.set(r.cardId, (fail.get(r.cardId) || 0) + 1);
  return cards
    .filter(c => (fail.get(c.id) || 0) >= minFail)
    .map(c => ({ ...c, failCount: fail.get(c.id) }))
    .sort((a, b) => (b.failCount - a.failCount) || (b.updatedAt - a.updatedAt))
    .slice(0, limit);
}

// ---------- 统计 ----------
export async function getStats() {
  const cards = await allCards();
  const reviews = await db.reviews.toArray();
  const totalCards = cards.length;
  const totalReviews = reviews.length;

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const todayReviews = reviews.filter(r => r.reviewedAt >= dayStart.getTime()).length;
  const dueToday = cards.filter(c => c.dueAt <= now()).length;

  // 热力图：近 365 天
  const since = now() - 365 * 86400000;
  const heat = {};
  for (const r of reviews) {
    if (r.reviewedAt < since) continue;
    const d = new Date(r.reviewedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    heat[key] = (heat[key] || 0) + 1;
  }

  // 各科掌握度：近 90 天自评均分 / 2 * 100
  const cardMap = new Map(cards.map(c => [c.id, c]));
  const since90 = now() - 90 * 86400000;
  const agg = {};
  for (const c of cards) { const k = c.subject || '未分类'; if (!agg[k]) agg[k] = { sum: 0, n: 0 }; }
  for (const r of reviews) {
    if (r.reviewedAt < since90) continue;
    const c = cardMap.get(r.cardId);
    const key = c?.subject || '未分类';
    if (!agg[key]) agg[key] = { sum: 0, n: 0 };
    agg[key].sum += r.rating; agg[key].n += 1;
  }
  const mastery = Object.entries(agg).map(([subject, v]) => ({
    subject, mastery: v.n ? Math.round((v.sum / (2 * v.n)) * 100) : 0, reviews: v.n,
  }));
  const avgMastery = mastery.length ? Math.round(mastery.reduce((s, m) => s + m.mastery, 0) / mastery.length) : 0;

  // 近 14 天趋势
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const start = d.getTime(), end = start + 86400000;
    const n = reviews.filter(r => r.reviewedAt >= start && r.reviewedAt < end).length;
    trend.push({ date: `${d.getMonth() + 1}-${d.getDate()}`, count: n });
  }

  return { totalCards, totalReviews, todayReviews, dueToday, avgMastery, heatmap: heat, mastery, trend };
}