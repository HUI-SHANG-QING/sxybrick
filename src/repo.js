// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid } from './db.js';
import { computeNext, applyFeedback } from './srs.js';
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
  const type = ['basic', 'cloze', 'choice', 'writing'].includes(body.type) ? body.type : 'basic';
  const marked = !!body.marked;
  const mnemonic = String(body.mnemonic ?? '').trim().slice(0, 200);
  const wrongReason = String(body.wrongReason ?? '').trim().slice(0, 20);
  if (!front) return { error: '正面内容不能为空' };
  if (type !== 'cloze' && !back) return { error: '背面内容不能为空' };
  if ([...front].length > MAX_CHARS) return { error: `正面内容不能超过 ${MAX_CHARS} 字` };
  if ([...back].length > MAX_CHARS) return { error: `背面内容不能超过 ${MAX_CHARS} 字` };
  return { value: { front, back, subject, tags, source, type, marked, mnemonic, wrongReason } };
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

export function gradeCard(card) {
  const level = card.level || 0;
  if (card.marked) return { label: '错题', cls: 'g-weak' };
  if (level >= 4) return { label: '已掌握', cls: 'g-master' };
  if (level >= 2) return { label: '巩固中', cls: 'g-good' };
  if (level >= 1) return { label: '学习中', cls: 'g-learning' };
  return { label: '未开始', cls: 'g-new' };
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
    type: r.value.type,
    marked: r.value.marked,
    mnemonic: r.value.mnemonic,
    wrongReason: r.value.wrongReason,
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
    type: r.value.type,
    marked: r.value.marked,
    mnemonic: r.value.mnemonic,
    wrongReason: r.value.wrongReason,
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
  await db.tombstones.put({ id, kind: 'card', deletedAt: now() });
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

// 手动标记 / 取消标记错题
export async function setMarked(id, marked) {
  const card = await db.cards.get(id);
  if (!card) throw new Error('卡片不存在');
  await db.cards.put({ ...card, marked: !!marked, updatedAt: now() });
  return card;
}

// ---------- 错因 ----------
// 统一错因选项（新建卡片 + 背诵页共用）；「自定义」由 UI 层追加
export const WRONG_REASONS = ['概念混淆', '记忆不牢', '审题偏差', '记忆模糊', '计算失误', '粗心', '其他'];

// ---------- 复习 ----------
// filter: { subjects:[], tags:[], logic:'AND'|'OR'|'NOT', wrongReasons:[], includeDueOnly:true }
// 自由组合背诵：按科目/标签/错因并集·交集·差集筛选到期队列（默认全量到期，遵循复习曲线）
export async function reviewQueue(limit = 100, interleave = false, filter = {}) {
  let cards = (await allCards());
  const f = filter || {};
  if (f.subjects?.length) cards = cards.filter(c => f.subjects.includes(c.subject || '未分类'));
  if (f.tags?.length) {
    const ts = f.tags, logic = f.logic || 'OR';
    if (logic === 'AND') cards = cards.filter(c => ts.every(t => (c.tags || []).includes(t)));
    else if (logic === 'NOT') cards = cards.filter(c => !ts.some(t => (c.tags || []).includes(t)));
    else cards = cards.filter(c => ts.some(t => (c.tags || []).includes(t)));
  }
  if (f.wrongReasons?.length) cards = cards.filter(c => f.wrongReasons.includes(c.wrongReason || ''));
  // 默认只背到期卡（遵循复习曲线）；includeDueOnly=false 时可背全部（重复复习场景）
  if (f.includeDueOnly !== false) cards = cards.filter(c => c.dueAt <= now());
  cards.sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : 1));
  // 交错混科：把到期卡片按科目轮流取出，避免同一科目连串出现
  if (interleave && cards.length > 1) {
    const groups = new Map();
    for (const c of cards) {
      const k = c.subject || '未分类';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const result = [];
    let added = true;
    while (added) {
      added = false;
      for (const arr of groups.values()) {
        if (arr.length) { result.push(arr.shift()); added = true; }
      }
    }
    cards = result;
  }
  return cards.slice(0, limit);
}

export async function review(cardId, rating, intensity = 1, guessed = false, opts = {}) {
  const card = await db.cards.get(cardId);
  if (!card) throw new Error('卡片不存在');
  const difficulty = Number(opts.difficulty ?? card.difficulty ?? 1);
  const wrongReason = opts.wrongReason || card.wrongReason || '';
  // 自适应节奏（C4）：按该卡近 10 次复习的错误率微调间隔（仅开启时计算）
  let adaptive = null;
  if (opts.adaptive) {
    const recent = await db.reviews.where('cardId').equals(cardId).reverse().sortBy('reviewedAt');
    const last10 = recent.slice(0, 10);
    const fail = last10.filter(r => r.rating === 0).length;
    adaptive = { reviews: last10.length, failRate: last10.length ? fail / last10.length : 0 };
  }
  const next = computeNext(card, rating, intensity, guessed, { difficulty, wrongReason, adaptive });
  // 复习只更新 SRS 字段与 reviewedAt，不 bump updatedAt：
  // 否则跨设备同步时「复习动作」会覆盖另一台设备对卡片文字的编辑（数据丢失）
  await db.cards.put({ ...card, ease: next.ease, level: next.level, intervalDays: next.intervalDays, dueAt: next.dueAt, difficulty, wrongReason, reviewedAt: now() });
  await db.reviews.put({ id: uid(), cardId, reviewedAt: now(), rating, levelAfter: next.level, guessed: !!guessed, difficulty, wrongReason });
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

// 学习行为回写 SRS：语音评测得分 / 费曼练习加成（不改 updatedAt，仅 ease/dueAt）
export async function applyCardFeedback(cardId, signal = {}) {
  const card = await db.cards.get(cardId);
  if (!card) return null;
  const f = applyFeedback(card, signal);
  await db.cards.put({ ...card, ease: f.ease, dueAt: f.dueAt });
  return f;
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

// ---------- 单卡复习历史 ----------
export async function getCardHistory(id) {
  const card = await db.cards.get(id);
  const reviews = await db.reviews.where('cardId').equals(id).reverse().sortBy('reviewedAt');
  const label = ['没记住', '还模糊', '记住了'];
  return {
    card: card || null,
    history: reviews.map(r => ({
      reviewedAt: r.reviewedAt, rating: r.rating,
      ratingText: label[r.rating] ?? '已复习', levelAfter: r.levelAfter,
    })),
  };
}

// ---------- 错题集 / 薄弱卡片 ----------
export async function weakCards(limit = 100, minFail = 2) {
  const cards = await allCards();
  const reviews = await db.reviews.toArray();
  const fail = new Map();
  for (const r of reviews) if (r.rating === 0) fail.set(r.cardId, (fail.get(r.cardId) || 0) + 1);
  return cards
    .filter(c => (fail.get(c.id) || 0) >= minFail || c.marked)
    .map(c => ({ ...c, failCount: fail.get(c.id) || 0 }))
    .sort((a, b) => (b.failCount - a.failCount) || (b.updatedAt - a.updatedAt))
    .slice(0, limit);
}

// ---------- 复习提醒建议 ----------
export async function getReviewSuggestion() {
  const cards = await allCards();
  const reviews = await db.reviews.toArray();
  const nowTs = now();
  const due = cards.filter(c => c.dueAt <= nowTs);

  // 今天待背按科目分组
  const bySubject = new Map();
  for (const c of due) { const k = c.subject || '未分类'; bySubject.set(k, (bySubject.get(k) || 0) + 1); }

  // 每张卡最近一次复习时间（无记录用创建时间）
  const lastReview = new Map();
  for (const r of reviews) {
    const cur = lastReview.get(r.cardId);
    if (cur === undefined || r.reviewedAt > cur) lastReview.set(r.cardId, r.reviewedAt);
  }
  // 每科最久未复习（取该科内最久未复习的那张卡）
  const subjOldest = new Map();
  for (const c of cards) {
    const k = c.subject || '未分类';
    const t = lastReview.get(c.id) ?? c.createdAt ?? nowTs;
    const cur = subjOldest.get(k);
    if (cur === undefined || t < cur) subjOldest.set(k, t);
  }
  const staleSubjects = [...subjOldest.entries()]
    .map(([name, ts]) => ({ name, days: Math.max(0, Math.floor((nowTs - ts) / 86400000)) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 5);

  return {
    dueCount: due.length,
    dueBySubject: [...bySubject.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    markedCount: cards.filter(c => c.marked).length,
    staleSubjects,
  };
}

// ---------- 统计 ----------
export async function getStats() {
  const cards = await allCards();
  const reviews = await db.reviews.toArray();
  const totalCards = cards.length;
  const totalReviews = reviews.length;

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  // 今日复习 = 去重卡片数（同一张卡今天复习多次只算 1 张）
  const todaySet = new Set();
  for (const r of reviews) if (r.reviewedAt >= dayStart.getTime()) todaySet.add(r.cardId);
  const todayReviews = todaySet.size;
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

  // 各科卡片数 + 自评分布
  const subjectCards = {};
  for (const c of cards) { const k = c.subject || '未分类'; subjectCards[k] = (subjectCards[k] || 0) + 1; }
  const ratingDist = { 0: 0, 1: 0, 2: 0 };
  for (const r of reviews) if (ratingDist[r.rating] !== undefined) ratingDist[r.rating]++;

  // 24 小时复习时间分布
  const hourly = new Array(24).fill(0);
  for (const r of reviews) hourly[new Date(r.reviewedAt).getHours()]++;

  // 近 30 天遗忘率（没记住占比 %）
  const forgotTrend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const s = d.getTime(), e = s + 86400000;
    const dayRs = reviews.filter(r => r.reviewedAt >= s && r.reviewedAt < e);
    const forgot = dayRs.filter(r => r.rating === 0).length;
    forgotTrend.push({ date: `${d.getMonth() + 1}-${d.getDate()}`, rate: dayRs.length ? Math.round(forgot / dayRs.length * 100) : 0 });
  }

  // 能力四维（掌握度/正确率/稳定度/覆盖率）
  const total = totalReviews || 1;
  const correct = Math.round((reviews.filter(r => r.rating === 2).length / total) * 100);
  const stable = Math.round((1 - reviews.filter(r => r.rating === 0).length / total) * 100);
  const reviewedCount = new Set(reviews.map(r => r.cardId)).size;
  const coverage = totalCards ? Math.round((reviewedCount / totalCards) * 100) : 0;
  const ability = { mastery: avgMastery, correct, stable, coverage };

  // 标签 Top 10
  const tagMap = new Map();
  for (const c of cards) for (const t of (c.tags || [])) tagMap.set(t, (tagMap.get(t) || 0) + 1);
  const tagCounts = [...tagMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  return { totalCards, totalReviews, todayReviews, dueToday, avgMastery, heatmap: heat, mastery, trend, subjectCards, ratingDist, hourly, forgotTrend, ability, tagCounts };
}

// ---------- 备忘录（四象限：重要/紧急） ----------
export async function listMemos() {
  return db.memos.orderBy('at').reverse().toArray();
}
export async function addMemo(payload) {
  const text = String(payload?.text || '').trim();
  if (!text) return null;
  const m = { id: uid(), text, important: !!payload.important, urgent: !!payload.urgent, at: Date.now(), createdAt: Date.now() };
  await db.memos.put(m);
  return m;
}
export async function deleteMemo(id) {
  await db.memos.delete(id);
  await db.tombstones.put({ id, kind: 'memo', deletedAt: now() }); // 墓碑：跨设备同步删除
}

// ---------- 学习计划（可持久化、随数据包同步） ----------
export async function listPlans() {
  return db.plans.orderBy('updatedAt').reverse().toArray();
}
export async function createPlan(payload) {
  const title = String(payload?.title || '').trim() || '未命名计划';
  const content = String(payload?.content || '').trim();
  const t = now();
  const p = {
    id: uid(), title, content,
    status: ['active', 'done', 'archived'].includes(payload?.status) ? payload.status : 'active',
    createdAt: t, updatedAt: t,
  };
  await db.plans.put(p);
  return p;
}
export async function updatePlan(id, patch) {
  const old = await db.plans.get(id);
  if (!old) throw new Error('计划不存在');
  const p = { ...old, ...(patch || {}), updatedAt: now() };
  await db.plans.put(p);
  return p;
}
export async function deletePlan(id) {
  await db.plans.delete(id);
  await db.tombstones.put({ id, kind: 'plan', deletedAt: now() }); // 墓碑：跨设备同步删除
}

// ---------- 知识图谱关系（可持久化、随数据包同步） ----------
export async function listGraphEdges() {
  return db.graphEdges.toArray();
}
export async function createGraphEdge(payload) {
  const from = String(payload?.from || '').trim();
  const to = String(payload?.to || '').trim();
  if (!from || !to) throw new Error('关系的两端不能为空');
  const label = String(payload?.label || '相关').trim();
  const subject = String(payload?.subject || '').trim();
  // 去重：同 from/to/label 的边已存在则不重复创建（避免「保存关联」多点几次就产生重复边）
  const exists = await db.graphEdges.filter(e => e.from === from && e.to === to && (e.label || '相关') === label).first();
  if (exists) return null;
  const t = now();
  const e = {
    id: uid(), from, to,
    label,
    subject,
    createdAt: t, updatedAt: t,
  };
  await db.graphEdges.put(e);
  return e;
}
export async function deleteGraphEdge(id) {
  await db.graphEdges.delete(id);
  await db.tombstones.put({ id, kind: 'graphEdge', deletedAt: now() }); // 墓碑：跨设备同步删除
}

// ---------- AI 文档（可持久化、随数据包同步） ----------
export async function listDocs() {
  return db.docs.orderBy('updatedAt').reverse().toArray();
}
export async function getDoc(id) {
  return (await db.docs.get(id)) || null;
}
export async function createDoc(payload) {
  const title = String(payload?.title || '').trim() || '未命名文档';
  const content = String(payload?.content || '').trim();
  const t = now();
  const d = {
    id: uid(), title, content,
    type: ['summary', 'note', 'plan', 'other'].includes(payload?.type) ? payload.type : 'note',
    tags: (Array.isArray(payload?.tags) ? payload.tags : []).map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 16),
    source: String(payload?.source || '').trim().slice(0, 60),
    createdAt: t, updatedAt: t,
  };
  await db.docs.put(d);
  return d;
}
export async function updateDoc(id, patch) {
  const old = await db.docs.get(id);
  if (!old) throw new Error('文档不存在');
  const d = { ...old, ...(patch || {}), updatedAt: now() };
  await db.docs.put(d);
  return d;
}
export async function deleteDoc(id) {
  await db.docs.delete(id);
  await db.tombstones.put({ id, kind: 'doc', deletedAt: now() }); // 墓碑：跨设备同步删除
}

// ---------- 番茄专注记录（可持久化、随数据包同步） ----------
export async function addPomoSession(payload) {
  const t = now();
  const s = {
    id: uid(),
    startedAt: payload?.startedAt || t,
    duration: Number(payload?.duration) || 0, // 分钟
    tag: String(payload?.tag || '').trim().slice(0, 30),
    createdAt: t,
  };
  await db.pomoSessions.put(s);
  return s;
}
export async function listPomoSessions(limit = 200) {
  return db.pomoSessions.orderBy('startedAt').reverse().limit(limit).toArray();
}
export async function countPomoToday() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  return db.pomoSessions.where('startedAt').aboveOrEqual(dayStart.getTime()).count();
}

// ---------- 思维导图（可持久化、随数据包同步；借鉴 Progress AI 的本地化实现） ----------
// 树结构：{ id, label, children: [...] }，根节点在 root 字段
export async function listMindmaps() {
  return db.mindmaps.orderBy('updatedAt').reverse().toArray();
}
export async function getMindmap(id) {
  return (await db.mindmaps.get(id)) || null;
}
export async function createMindmap(payload) {
  const title = String(payload?.title || '').trim() || '未命名导图';
  const root = payload?.root && payload.root.label
    ? payload.root
    : { id: uid(), label: String(payload?.rootLabel || '中心主题').trim() || '中心主题', children: [] };
  const t = now();
  const m = { id: uid(), title, root, createdAt: t, updatedAt: t };
  await db.mindmaps.put(m);
  return m;
}
export async function updateMindmap(id, patch) {
  const old = await db.mindmaps.get(id);
  if (!old) throw new Error('导图不存在');
  const m = { ...old, ...(patch || {}), updatedAt: now() };
  await db.mindmaps.put(m);
  return m;
}
export async function deleteMindmap(id) {
  await db.mindmaps.delete(id);
  await db.tombstones.put({ id, kind: 'mindmap', deletedAt: now() }); // 墓碑：跨设备同步删除
}

// ---------- 每周学习报告（可持久化、随数据包同步；借鉴 Progress AI 的本地化实现） ----------
export async function listWeeklyReports() {
  return db.weeklyReports.orderBy('weekStart').reverse().toArray();
}
export async function getWeeklyReport(id) {
  return (await db.weeklyReports.get(id)) || null;
}
export async function getWeeklyReportByWeek(weekStart) {
  return db.weeklyReports.where('weekStart').equals(weekStart).first() || null;
}
export async function saveWeeklyReport(payload) {
  const weekStart = Number(payload?.weekStart) || 0;
  const t = now();
  const old = weekStart ? await getWeeklyReportByWeek(weekStart) : null;
  const row = {
    id: old?.id || uid(),
    weekStart,
    title: String(payload?.title || '学习周报').trim(),
    data: payload?.data || {},
    summary: String(payload?.summary || '').trim(),
    createdAt: old?.createdAt || t,
    updatedAt: t,
  };
  await db.weeklyReports.put(row);
  return row;
}
export async function deleteWeeklyReport(id) {
  await db.weeklyReports.delete(id);
  await db.tombstones.put({ id, kind: 'weeklyReport', deletedAt: now() }); // 墓碑：跨设备同步删除
}

// ---------- 成就（可持久化、随数据包同步；id 为确定性 ack-<key>，各设备幂等） ----------
export async function listAchievements() {
  return db.achievements.orderBy('unlockedAt').reverse().toArray();
}
export async function unlockAchievement(key) {
  const id = 'ach-' + key;
  if (await db.achievements.get(id)) return null; // 已解锁（解锁不可逆）
  const row = { id, key, unlockedAt: now() };
  await db.achievements.put(row);
  return row;
}

// ---------- 组卷模考（成绩存档，随数据包同步；借鉴 Progress AI 的本地化实现） ----------
export async function listExams() {
  return db.exams.orderBy('createdAt').reverse().toArray();
}
export async function getExam(id) {
  return (await db.exams.get(id)) || null;
}
export async function saveExam(payload) {
  const t = now();
  const e = {
    id: uid(),
    title: String(payload?.title || '模拟考试').trim().slice(0, 40),
    subject: String(payload?.subject || '').trim(),
    questions: Array.isArray(payload?.questions) ? payload.questions : [],
    score: Number(payload?.score) || 0,
    total: Number(payload?.total) || 0,
    createdAt: t, updatedAt: t,
  };
  await db.exams.put(e);
  return e;
}
export async function deleteExam(id) {
  await db.exams.delete(id);
  await db.tombstones.put({ id, kind: 'exam', deletedAt: now() }); // 墓碑：跨设备同步删除
}
export async function updateExam(id, patch) {
  const old = await db.exams.get(id);
  if (!old) throw new Error('成绩不存在');
  const e = { ...old, ...(patch || {}), updatedAt: now() };
  await db.exams.put(e);
  return e;
}