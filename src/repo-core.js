// src/repo-core.js
// repo.js 的纯函数层：校验/过滤/排序/聚合/统计逻辑与 IndexedDB 读写分离，
// 可在 Node 单测中直接覆盖（repo.js 因依赖 Dexie 无法在 Node 下 import）。
// 编排层（repo.js）只做 IO，行为与本模块此前内联实现完全一致。

import { formatDate } from './utils/format.js';
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
  // 审计：标签比较时 trim 规范化——存储的标签可能未经 trim（旧备份导入/AI 生成/早期版本），
  // 导致 "短期不重要" 与 "短期不重要 " 不匹配，用户选了科目+标签但检索出其他内容。
  // 与 validateCard 写入口径一致（写入时 trim+slice(0,20)）。
  const norm = tags.map(t => String(t).trim());
  if (logic === 'AND') return cards.filter(c => norm.every(t => (c.tags || []).some(ct => String(ct).trim() === t)));
  if (logic === 'OR') return cards.filter(c => norm.some(t => (c.tags || []).some(ct => String(ct).trim() === t)));
  return cards.filter(c => !norm.some(t => (c.tags || []).some(ct => String(ct).trim() === t))); // NOT
}

// ---------- 列表筛选（卡片/搜索词/科目/标签 的统一口径） ----------
// round29：此前「搜索词 + 科目 + 标签」这套筛选在 repo.listCards 里内联实现，
// Cards.vue 的错题集分支又各写一份（且后者长期漏用 → 该模式下混合检索完全失效）。
// 收敛成单一纯函数：任何数据源（全量卡 / 薄弱卡 / 其它派生集合）都走同一口径，
// 避免「同一个筛选条件在不同列表里结果不一致」，也让这段逻辑可被单测覆盖。
export function applyCardFilters(cards, { q = '', subject = '', tags = [], logic = 'AND' } = {}) {
  let out = cards || [];
  const subj = String(subject || '').trim();
  if (subj) out = out.filter(c => String(c.subject || '').trim() === subj);
  const kw = String(q || '').trim().toLowerCase();
  if (kw) {
    out = out.filter(c =>
      String(c.front || '').toLowerCase().includes(kw) ||
      String(c.back || '').toLowerCase().includes(kw) ||
      (c.tags || []).some(t => String(t).toLowerCase().includes(kw)) ||
      String(c.subject || '').toLowerCase().includes(kw) ||
      String(c.source || '').toLowerCase().includes(kw) ||
      String(c.mnemonic || '').toLowerCase().includes(kw));
  }
  if (tags && tags.length) out = tagFilter(out, tags, logic);
  return out;
}

// ---------- 卡片等级标签 ----------
// 审计 B2（掌握度三口径分裂）：此前「已掌握」有三套互不兼容的判定——gradeCard 用
// level>=4、wordStats 用 level>=4 || intervalDays>=21、computeStats 用 90 天自评均分。
// 其中 computeStats 是「整体掌握度百分比」，语义本就和逐卡等级不同，保持独立；
// 但逐卡「这张卡是否已掌握」必须收敛到单一事实源，否则卡片列表/单词统计/成就/周报
// 对同一张卡给出不同结论。于是抽 isMastered 单点，gradeCard 与 wordStats 统一调用。
// 口径：intervalDays>=21 或 level>=4 —— 即「实际调度拉长到 ≥21 天」或「等级达已掌握档」。
//   FSRS 路径 level 封顶 4（S≥15 天近似 21 天）；SM-2 路径原本只看 level 无上限，
//   用 intervalDays>=21 兜底后两套调度器在「≥21 天间隔即掌握」上对齐。
export function isMastered(row) {
  return (row?.level ?? 0) >= 4 || (row?.intervalDays || 0) >= 21;
}

export function gradeCard(card) {
  const level = card.level || 0;
  if (card.marked) return { label: '错题', cls: 'g-weak' };
  if (isMastered(card)) return { label: '已掌握', cls: 'g-master' };
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
  // ⚠️ 逾期必须先判：此前 `diff < 3600000` 对负数恒真，
  //   于是「逾期 3 天 / 逾期 2 小时 / 逾期 1 分钟」统统显示成「1 分钟后」——
  //   用户完全看不出哪些卡已经拖了很久。
  if (diff <= 0) {
    const over = -diff;
    if (over < 3600000) return '已逾期 · 不到 1 小时';
    if (over < 24 * 3600000) return `已逾期 ${Math.round(over / 3600000)} 小时`;
    return `已逾期 ${Math.round(over / 86400000)} 天`;
  }
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
  if (f.wrongReasons?.length) out = out.filter(c => { const wr = c.wrongReason || ''; return f.wrongReasons.includes(wr) || f.wrongReasons.some(r => WRONG_REASON_MAP[r] === wr); });
  // 默认只背到期卡（遵循复习曲线）；includeDueOnly=false 时可背全部（重复复习场景）
  // 幽灵卡防护：历史 fsrs 缺陷（2026-08 修复前）可能把 dueAt 写成 NaN，经备份 JSON
  // 往返又可能变 null——`NaN <= now` 恒假 → 该卡永远不出现在队列（有卡却背不到、无法
  // 自愈重排）。这里把「确定损坏的 dueAt（NaN/null）」视为 0（到期一次 → 复习后由调度器
  // 重写为有限值自愈）；undefined 维持旧语义（不视为到期），避免无 dueAt 的老数据洪泛。
  const dueOf = (c) => {
    const d = c.dueAt;
    if (d === undefined) return Infinity;
    return (d === null || Number.isNaN(d)) ? 0 : d;
  };
  if (f.includeDueOnly !== false) out = out.filter(c => dueOf(c) <= nowTs);
  out.sort((a, b) => dueOf(a) - dueOf(b) || (a.id < b.id ? -1 : 1));
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
    // ⚠️ createdAt 缺失（0/undefined）不能当成「1970 年创建」：
    //   否则一张刚建的新卡立刻被判成僵尸卡（(0) <= threshold 恒真）。
    //   缺时间戳时用 updatedAt 兜底，两者都缺则跳过该卡（没数据就不下结论）。
    .filter((c) => {
      if (reviewed.has(c.id)) return false;
      const created = Number(c.createdAt) || Number(c.updatedAt) || 0;
      if (!created) return false;
      return created <= threshold;
    })
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

/**
 * 审计 B3：「今日」窗口的单一事实源。
 * 此前三处各自算当天，且写法不一——computeStats 用 `setHours(0,0,0,0)` 后**只判下界**
 * （reviewedAt >= dayStart，无上界），getDailyReality 用 `date+'T00:00:00'` 再 +86400000，
 * wordReviewedToday 又是一种。窗口口径不统一，跨模块的「今日复习」无法互相对齐。
 * 统一为左闭右开 [start, end)。
 */
export function dayWindowOf(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  return { start, end: start + 86400000 };
}

/**
 * 审计 B3：今日复习两种口径的单一实现，调用方只决定取哪个口径。
 *   · cards = 去重**卡片数**（同一张卡今天复习多次只算 1 张）
 *   · times = **复习次数**（一条复习记录算 1 次）
 * 历史上 `todayReviews`(卡片数) 与 `reviewsToday`(次数) 名字几乎一样却语义不同，
 * 极易误用；此处把两种口径都显式产出，命名自解释。
 */
export function countReviewsInWindow(reviews, win) {
  const set = new Set();
  let times = 0;
  for (const r of reviews || []) {
    const t = Number(r?.reviewedAt) || 0;
    if (t >= win.start && t < win.end) { set.add(r.cardId); times++; }
  }
  return { cards: set.size, times };
}

export function computeStats(cards, reviews, nowTs = Date.now()) {
  // 审计 P2：过滤 quickCheck 行——快速检测不计入 SRS 统计（today/mastery/trend/ratingDist 等）
  const real = (reviews || []).filter(r => r.type !== 'quick');
  const totalCards = cards.length;
  const totalReviews = real.length;

  // 今日复习 = 去重卡片数（同一张卡今天复习多次只算 1 张）—— 口径见 countReviewsInWindow
  const todayReviews = countReviewsInWindow(real, dayWindowOf(nowTs)).cards;
  const dueToday = cards.filter(c => c.dueAt <= nowTs).length;

  // 热力图：近 365 天
  const since = nowTs - 365 * DAY;
  const heat = {};
  for (const r of real) {
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
  for (const r of real) {
    if (r.reviewedAt < since90) continue;
    const c = cardMap.get(r.cardId);
    const key = c?.subject || '未分类';
    if (!agg[key]) agg[key] = { sum: 0, n: 0 };
    agg[key].sum += r.rating; agg[key].n += 1;
  }
  const mastery = Object.entries(agg).map(([subject, v]) => ({
    subject, mastery: v.n ? Math.round((v.sum / (2 * v.n)) * 100) : 0, reviews: v.n,
    // 「近 90 天没复习过」≠「掌握度 0 分」。此前两者都被写成 mastery:0，
    // 下游（全局平均 / 自适应保持率）把"无数据"当成"完全没掌握"处理。
    noData: v.n === 0,
  }));
  // 全局平均掌握度：只统计有复习数据的科目，且按复习次数加权。
  //   此前对所有科目（含 0 次复习的）求算术平均 —— 实测「3 科只复习 1 科且全对」
  //   平均掌握度被算成 33%，等价于把「没学过」判成「学了但全不会」。
  //   按次数加权后等价于「近 90 天全局自评均分」，口径与 ability.correct 一致。
  let mWeighted = 0;
  let mWeight = 0;
  for (const m of mastery) {
    const n = agg[m.subject]?.n || 0;
    mWeighted += m.mastery * n;
    mWeight += n;
  }
  const avgMastery = mWeight ? Math.round(mWeighted / mWeight) : 0;

  // 近 14 天趋势（单趟扫描分桶，避免原「每天 filter 一次」的 O(14·N)）
  const trendBucket = new Map(); // 当天 0 点时间戳 → 计数
  for (const r of real) {
    if (r.reviewedAt < nowTs - 14 * DAY) continue;
    const d = new Date(r.reviewedAt);
    const ds = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    trendBucket.set(ds, (trendBucket.get(ds) || 0) + 1);
  }
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(nowTs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const start = d.getTime();
    trend.push({ date: `${d.getMonth() + 1}-${d.getDate()}`, count: trendBucket.get(start) || 0 });
  }

  // 各科卡片数 + 自评分布
  const subjectCards = {};
  for (const c of cards) { const k = c.subject || '未分类'; subjectCards[k] = (subjectCards[k] || 0) + 1; }
  const ratingDist = { 0: 0, 1: 0, 2: 0 };
  for (const r of real) if (ratingDist[r.rating] !== undefined) ratingDist[r.rating]++;

  // 24 小时复习时间分布
  const hourly = new Array(24).fill(0);
  for (const r of real) hourly[new Date(r.reviewedAt).getHours()]++;

  // 近 30 天遗忘率（单趟扫描分桶，避免原「每天 filter 一次」的 O(30·N)）
  const forgotBucket = new Map(); // 当天 0 点时间戳 → { total, forgot }
  for (const r of real) {
    if (r.reviewedAt < nowTs - 30 * DAY) continue;
    const d = new Date(r.reviewedAt);
    const ds = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const b = forgotBucket.get(ds) || { total: 0, forgot: 0 };
    b.total += 1;
    if (r.rating === 0) b.forgot += 1;
    forgotBucket.set(ds, b);
  }
  const forgotTrend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(nowTs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const start = d.getTime();
    const b = forgotBucket.get(start) || { total: 0, forgot: 0 };
    forgotTrend.push({ date: `${d.getMonth() + 1}-${d.getDate()}`, rate: b.total ? Math.round(b.forgot / b.total * 100) : 0 });
  }

  // 能力四维（掌握度/正确率/稳定度/覆盖率）
  //
  // ⚠️ 零复习时不能沿用 `total = totalReviews || 1`：那样 stable = 1 - 0/1 = 100%，
  // 新用户会看到「稳定度 100% / 正确率 0% / 掌握度 0%」这种自相矛盾的面板。
  // 与上面 mastery 分支同一口径：无数据记 0，另给 noData 标记供 UI 显示「暂无数据」。
  const hasReviews = totalReviews > 0;
  const total = totalReviews || 1;
  const correct = hasReviews ? Math.round((real.filter(r => r.rating === 2).length / total) * 100) : 0;
  const stable = hasReviews ? Math.round((1 - real.filter(r => r.rating === 0).length / total) * 100) : 0;
  const reviewedCount = new Set(real.map(r => r.cardId)).size;
  const coverage = totalCards ? Math.round((reviewedCount / totalCards) * 100) : 0;
  const ability = { mastery: avgMastery, correct, stable, coverage, noData: !hasReviews };

  // 标签 Top 10
  const tagMap = new Map();
  for (const c of cards) for (const t of (c.tags || [])) tagMap.set(t, (tagMap.get(t) || 0) + 1);
  const tagCounts = [...tagMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  return { totalCards, totalReviews, todayReviews, dueToday, avgMastery, heatmap: heat, mastery, trend, subjectCards, ratingDist, hourly, forgotTrend, ability, tagCounts };
}

// ---------- userOps 分组聚合（queryUserOps 核心） ----------
export function groupUserOps(arr, groupBy) {
  const fmt = (ts) => formatDate(ts);
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
