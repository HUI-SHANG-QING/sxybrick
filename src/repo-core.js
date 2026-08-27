// src/repo-core.js
// repo.js 的纯函数层：校验/过滤/排序/聚合/统计逻辑与 IndexedDB 读写分离，
// 可在 Node 单测中直接覆盖（repo.js 因依赖 Dexie 无法在 Node 下 import）。
// 编排层（repo.js）只做 IO，行为与本模块此前内联实现完全一致。

export const DEFAULT_SUBJECTS = ['计算机网络', '操作系统', '数据结构', '计算机组成原理', '高等数学', '线性代数', '概率论'];
const MAX_CHARS = 8000;

const DAY = 86400000;

// ---------- 卡片校验与规范化 ----------
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
  // 变式卡溯源：记录原卡 ID，便于"同知识点不同情境"复习混排与追溯
  const sourceCardId = body.sourceCardId ? String(body.sourceCardId).slice(0, 60) : '';
  // 渐进式复杂度（P3-E）：基础 / 应用 / 挑战 三级，便于脚手架式复习编排
  const difficulty = ['basic', 'applied', 'challenge'].includes(body.difficulty) ? body.difficulty : 'basic';
  if (!front) return { error: '正面内容不能为空' };
  if (type !== 'cloze' && !back) return { error: '背面内容不能为空' };
  if ([...front].length > MAX_CHARS) return { error: `正面内容不能超过 ${MAX_CHARS} 字` };
  if ([...back].length > MAX_CHARS) return { error: `背面内容不能超过 ${MAX_CHARS} 字` };
  return { value: { front, back, subject, tags, source, type, marked, mnemonic, wrongReason, sourceCardId, difficulty } };
}

// ---------- 多标签 AND/OR/NOT 过滤 ----------
export function tagFilter(cards, tags, logic) {
  if (!tags.length) return cards;
  if (logic === 'AND') return cards.filter(c => tags.every(t => (c.tags || []).includes(t)));
  if (logic === 'OR') return cards.filter(c => tags.some(t => (c.tags || []).includes(t)));
  return cards.filter(c => !tags.some(t => (c.tags || []).includes(t))); // NOT
}

// ---------- 卡片等级标签 ----------
export function gradeCard(card) {
  const level = card.level || 0;
  if (card.marked) return { label: '错题', cls: 'g-weak' };
  if (level >= 4) return { label: '已掌握', cls: 'g-master' };
  if (level >= 2) return { label: '巩固中', cls: 'g-good' };
  if (level >= 1) return { label: '学习中', cls: 'g-learning' };
  return { label: '未开始', cls: 'g-new' };
}

// ---------- 错因 ----------
export const WRONG_REASON_MAP = {
  CONCEPT_MIS: '概念混淆',
  MEMORY_WEAK: '记忆不牢',
  REVIEW_ERROR: '审题偏差',
  MEMORY_VAGUE: '记忆模糊',
  CALC_ERROR: '计算失误',
  CARELESS: '粗心',
  OTHER: '其他',
};
// 向后兼容：旧数据可能存的是中文字符串，用此函数转为 code
export function wrongReasonToCode(reason) {
  if (!reason) return '';
  if (WRONG_REASON_MAP[reason]) return reason;
  for (const [code, label] of Object.entries(WRONG_REASON_MAP)) {
    if (reason === label || reason.includes(label)) return code;
  }
  return 'OTHER';
}
// UI 用的数组：[{code, label}]，自定义项由 UI 追加
export const WRONG_REASONS = Object.entries(WRONG_REASON_MAP).map(([code, label]) => ({ code, label }));

// ---------- 到期时间展示 ----------
export function formatDue(ts, nowTs = Date.now()) {
  const diff = ts - nowTs;
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))} 分钟后`;
  if (diff < 24 * 3600 * 1000) return `${Math.round(diff / 3600000)} 小时后`;
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 复习候选过滤（reviewQueue 的筛选 + 排序核心） ----------
// filter: { subjects:[], tags:[], logic:'AND'|'OR'|'NOT', wrongReasons:[], includeDueOnly:true }
export function filterReviewCandidates(cards, filter = {}, nowTs = Date.now()) {
  const f = filter || {};
  let out = [...cards];
  if (f.subjects?.length) out = out.filter(c => f.subjects.includes(c.subject || '未分类'));
  if (f.tags?.length) {
    const ts = f.tags, logic = f.logic || 'OR';
    if (logic === 'AND') out = out.filter(c => ts.every(t => (c.tags || []).includes(t)));
    else if (logic === 'NOT') out = out.filter(c => !ts.some(t => (c.tags || []).includes(t)));
    else out = out.filter(c => ts.some(t => (c.tags || []).includes(t)));
  }
  if (f.wrongReasons?.length) out = out.filter(c => f.wrongReasons.includes(c.wrongReason || ''));
  // 默认只背到期卡（遵循复习曲线）；includeDueOnly=false 时可背全部（重复复习场景）
  if (f.includeDueOnly !== false) out = out.filter(c => c.dueAt <= nowTs);
  out.sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : 1));
  return out;
}

// ---------- 薄弱卡片排名（weakCards 核心） ----------
export function rankWeakCards(cards, reviews, { limit = 100, minFail = 2 } = {}) {
  const fail = new Map();
  for (const r of reviews) if (r.rating === 0) fail.set(r.cardId, (fail.get(r.cardId) || 0) + 1);
  return cards
    .filter(c => (fail.get(c.id) || 0) >= minFail || c.marked)
    .map(c => ({ ...c, failCount: fail.get(c.id) || 0 }))
    .sort((a, b) => (b.failCount - a.failCount) || (b.updatedAt - a.updatedAt))
    .slice(0, limit);
}

// ---------- 僵尸卡判定（zombieCardIds 核心） ----------
export function selectZombieIds(cards, reviewedIds, nowTs = Date.now(), staleDays = 90) {
  const threshold = nowTs - staleDays * DAY;
  const reviewed = reviewedIds instanceof Set ? reviewedIds : new Set(reviewedIds || []);
  return cards
    .filter(c => (c.createdAt || 0) <= threshold && !reviewed.has(c.id))
    .map(c => c.id);
}

// ---------- 复习提醒建议（getReviewSuggestion 核心） ----------
export function buildReviewSuggestion(cards, reviews, nowTs = Date.now()) {
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
    .map(([name, ts]) => ({ name, days: Math.max(0, Math.floor((nowTs - ts) / DAY)) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 5);

  return {
    dueCount: due.length,
    dueBySubject: [...bySubject.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    markedCount: cards.filter(c => c.marked).length,
    staleSubjects,
  };
}

// ---------- 全局统计（getStats 核心） ----------
export function computeStats(cards, reviews, nowTs = Date.now()) {
  const totalCards = cards.length;
  const totalReviews = reviews.length;

  const dayStart = new Date(nowTs); dayStart.setHours(0, 0, 0, 0);
  // 今日复习 = 去重卡片数（同一张卡今天复习多次只算 1 张）
  const todaySet = new Set();
  for (const r of reviews) if (r.reviewedAt >= dayStart.getTime()) todaySet.add(r.cardId);
  const todayReviews = todaySet.size;
  const dueToday = cards.filter(c => c.dueAt <= nowTs).length;

  // 热力图：近 365 天
  const since = nowTs - 365 * DAY;
  const heat = {};
  for (const r of reviews) {
    if (r.reviewedAt < since) continue;
    const d = new Date(r.reviewedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    heat[key] = (heat[key] || 0) + 1;
  }

  // 各科掌握度：近 90 天自评均分 / 2 * 100
  const cardMap = new Map(cards.map(c => [c.id, c]));
  const since90 = nowTs - 90 * DAY;
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
    const d = new Date(nowTs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const start = d.getTime(), end = start + DAY;
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
    const d = new Date(nowTs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const s = d.getTime(), e = s + DAY;
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

// ---------- userOps 分组聚合（queryUserOps 核心） ----------
export function groupUserOps(arr, groupBy) {
  const fmt = (ts) => {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  if (groupBy === 'day') {
    const m = new Map();
    for (const o of arr) { const k = fmt(o.t); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, c]) => ({ date: d, count: c }));
  }
  if (groupBy === 'hour') {
    const m = new Map();
    for (let i = 0; i < 24; i++) m.set(i, 0);
    for (const o of arr) { const k = new Date(o.t).getHours(); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort(([a], [b]) => a - b).map(([h, c]) => ({ hour: h, count: c }));
  }
  if (groupBy === 'dayHour') {
    // 7*24 heatmap matrix key = YYYY-MM-DD-HH
    const m = new Map();
    for (const o of arr) {
      const k = `${fmt(o.t)}-${String(new Date(o.t).getHours()).padStart(2, '0')}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m; // Map<String, count>
  }
  if (groupBy === 'module' || groupBy === 'type' || groupBy === 'category') {
    const m = new Map();
    for (const o of arr) { const k = String(o[groupBy] || '（空）'); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ key: k, count: c }));
  }
  return arr;
}
