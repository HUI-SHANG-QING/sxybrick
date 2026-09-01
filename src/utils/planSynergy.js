/**
 * 每日规划数据协同聚合器（纯查询层）
 *
 * 跨模块聚合「今日真实学习数据」+「规划目标」，产出多维结构化数据，
 * 供 DailyPlanView 的雷达图 / 热力矩阵 / 风险图 / 完成对比面板直接渲染。
 *
 * 数据源（均为 IndexedDB 本地表，离线可用，随数据包同步）：
 *   - reviews     今日复习次数 / 按科目 / 按评分
 *   - pomoSessions 今日番茄分钟 / 会话数 / 按科目
 *   - cards       今日新建 / 今日到期 / 今日掌握 / 今日错题（wrongReasonAt）
 *   - exams       今日模考数 / 平均分 / 按科目
 *   - docFiles    今日新建资料 / 按类型
 *   - memos       今日备忘 / 按象限
 *   - dailyTasks  规划目标（targetCount/estimatedMinutes）+ 完成状态
 *
 * 设计原则：
 *   - 每张表 try/catch 隔离，单表失败不影响其他模块聚合
 *   - 纯查询，无写入，无副作用，可 Node 风格单测（mock db）
 *   - 返回结构扁平、可序列化（可随 backup 导出做趋势分析）
 */

import { db } from '../db.js';

/** 本地日期串 YYYY-MM-DD */
function localDateStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把日期串转为 [dayStart, dayEnd) 毫秒时间戳 */
function dayRange(dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00').getTime();
  return [dayStart, dayStart + 86400000];
}

const SAFE = (fn, fallback) => {
  try { return fn(); } catch { return fallback; }
};

/**
 * 主入口：聚合某天跨模块真实数据 + 规划完成度。
 * @param {string} [date] YYYY-MM-DD，默认今天
 * @param {Array} [planTasks] 已加载的当日 dailyTasks（避免重复查询）
 * @returns {Promise<object>} 结构见顶部注释
 */
export async function getDailySynergy(date = localDateStr(), planTasks = null) {
  const [dayStart, dayEnd] = dayRange(date);

  // 并行查询各表（每张表独立 try/catch）
  const [reviews, pomodoro, cards, exams, docs, memos, plan] = await Promise.all([
    aggregateReviews(dayStart, dayEnd),
    aggregatePomodoro(dayStart, dayEnd),
    aggregateCards(dayStart, dayEnd),
    aggregateExams(dayStart, dayEnd),
    aggregateDocs(dayStart, dayEnd),
    aggregateMemos(dayStart, dayEnd),
    planTasks ? Promise.resolve(planTasks) : loadPlanTasks(date),
  ]);

  // 多维完成率：规划目标 vs 实际
  const completion = buildCompletion(plan, reviews, pomodoro, cards, exams, docs, memos);

  // 风险任务：高优先级但未完成 / 大块时间未启动 / 已过期未打卡
  const risks = buildRisks(plan);

  // 总览
  const totals = {
    actions: reviews.count + cards.created + exams.count + docs.created + memos.created + cards.mastered,
    focusMinutes: pomodoro.minutes,
    reviews: reviews.count,
    newCards: cards.created,
    wrongToday: cards.wrongToday,
    exams: exams.count,
    examAvg: exams.avgScore,
  };

  return {
    date,
    reviews, pomodoro, cards, exams, docs, memos,
    plan, completion, risks, totals,
  };
}

// ──────────────── 各表聚合 ────────────────

async function aggregateReviews(dayStart, dayEnd) {
  const base = { count: 0, bySubject: {}, byGrade: { 0: 0, 1: 0, 2: 0 } };
  const rows = await SAFE(() => db.reviews.where('reviewedAt').between(dayStart, dayEnd, true, true).toArray(), []);
  base.count = rows.length;
  for (const r of rows) {
    const subj = r.subject || '未分类';
    base.bySubject[subj] = (base.bySubject[subj] || 0) + 1;
    const g = r.grade ?? r.rating ?? r.level;
    if (g === 0 || g === 1 || g === 2) base.byGrade[g]++;
  }
  return base;
}

async function aggregatePomodoro(dayStart, dayEnd) {
  const base = { minutes: 0, sessions: 0, bySubject: {} };
  const rows = await SAFE(() => db.pomoSessions.where('startedAt').between(dayStart, dayEnd, true, true).toArray(), []);
  base.sessions = rows.length;
  // round17 R17-1：字段是 duration（分钟，见 repo.js addPomoSession）——此前误读
  // durationMs 并 ÷60000，该字段不存在 → 协同雷达「专注分钟」恒 0。与 analytics.js:144 对齐。
  base.minutes = Math.round(rows.reduce((s, x) => s + (x?.duration || 0), 0));
  for (const r of rows) {
    const subj = r.subject || '未分类';
    base.bySubject[subj] = (base.bySubject[subj] || 0) + Math.round(r?.duration || 0);
  }
  return base;
}

async function aggregateCards(dayStart, dayEnd) {
  const base = { created: 0, dueToday: 0, mastered: 0, wrongToday: 0, bySubject: {} };
  // 今日新建（createdAt）
  const created = await SAFE(() => db.cards.where('createdAt').between(dayStart, dayEnd, true, true).toArray(), []);
  base.created = created.length;
  for (const c of created) {
    const subj = c.subject || '未分类';
    base.bySubject[subj] = (base.bySubject[subj] || 0) + 1;
  }
  // 今日到期（dueAt 落在今日）
  base.dueToday = await SAFE(() => db.cards.where('dueAt').between(dayStart, dayEnd, true, true).count(), 0);
  // 今日掌握（consolidation 进入新阶段）—— 简化：今日 reviewedAt 且 level 显著上升
  // 今日错题（wrongReasonAt 落在今日）
  base.wrongToday = await SAFE(() => {
    if (!db.cards.schema) return 0;
    // wrongReasonAt 不是索引字段，全表扫描今日命中数（量小可接受）
    return db.cards.toArray().then(arr => arr.filter(c => {
      const t = c.wrongReasonAt;
      return t != null && t >= dayStart && t < dayEnd;
    }).length);
  }, 0);
  return base;
}

async function aggregateExams(dayStart, dayEnd) {
  const base = { count: 0, avgScore: 0, bySubject: {} };
  const rows = await SAFE(() => db.exams.where('createdAt').between(dayStart, dayEnd, true, true).toArray(), []);
  base.count = rows.length;
  if (rows.length) {
    const sum = rows.reduce((s, x) => s + (Number(x.score) || 0), 0);
    const sumTotal = rows.reduce((s, x) => s + (Number(x.total) || 0), 0);
    base.avgScore = sumTotal ? Math.round((sum / sumTotal) * 100) : Math.round(sum / rows.length);
    for (const e of rows) {
      const subj = e.subject || '未分类';
      if (!base.bySubject[subj]) base.bySubject[subj] = { count: 0, score: 0, total: 0 };
      base.bySubject[subj].count++;
      base.bySubject[subj].score += Number(e.score) || 0;
      base.bySubject[subj].total += Number(e.total) || 0;
    }
  }
  return base;
}

async function aggregateDocs(dayStart, dayEnd) {
  const base = { created: 0, byType: {} };
  const rows = await SAFE(() => db.docFiles.where('createdAt').between(dayStart, dayEnd, true, true).toArray(), []);
  base.created = rows.length;
  for (const d of rows) {
    const t = d.type || d.kind || '未分类';
    base.byType[t] = (base.byType[t] || 0) + 1;
  }
  return base;
}

async function aggregateMemos(dayStart, dayEnd) {
  const base = { created: 0, byQuadrant: { Q1: 0, Q2: 0, Q3: 0, Q4: 0 } };
  const rows = await SAFE(() => db.memos.where('at').between(dayStart, dayEnd, true, true).toArray(), []);
  base.created = rows.length;
  for (const m of rows) {
    const q = m.quadrant || 'Q4';
    if (base.byQuadrant[q] != null) base.byQuadrant[q]++;
  }
  return base;
}

async function loadPlanTasks(date) {
  const plan = await SAFE(() => db.dailyPlans.where('date').equals(date).first(), null);
  if (!plan) return [];
  return SAFE(() => db.dailyTasks.where('planId').equals(plan.id).toArray(), []);
}

// ──────────────── 多维完成率（雷达图） ────────────────

/**
 * 按任务类型聚合规划目标 vs 实际完成，产出雷达图所需的多维数组。
 * 维度：复习 / 专注 / 资料 / 做题 / 笔记 / 新建卡
 */
function buildCompletion(plan, reviews, pomodoro, cards, exams, docs, memos) {
  // 按类型聚合规划目标
  const planByType = { review: 0, pomodoro: 0, doc: 0, exam: 0, note: 0, write: 0 };
  const planMinByType = { review: 0, pomodoro: 0, doc: 0, exam: 0, note: 0, write: 0 };
  for (const t of plan) {
    if (t.type === 'review') planByType.review += t.targetCount || 0;
    if (t.type === 'pomodoro') planMinByType.pomodoro += t.estimatedMinutes || 0;
    if (t.type === 'doc') planByType.doc += t.targetCount || 0;
    if (t.type === 'exam') planByType.exam += t.targetCount || 0;
    if (t.type === 'note') planByType.note += t.targetCount || 0;
    if (t.type === 'write') planByType.write += t.targetCount || 0;
  }

  const dims = [
    { dim: '复习', icon: '📖', plan: planByType.review, actual: reviews.count, unit: '次' },
    { dim: '专注', icon: '🍅', plan: planMinByType.pomodoro, actual: pomodoro.minutes, unit: '分钟' },
    { dim: '资料', icon: '📚', plan: planByType.doc, actual: docs.created, unit: '份' },
    { dim: '做题', icon: '📝', plan: planByType.exam, actual: exams.count, unit: '套' },
    { dim: '笔记', icon: '📓', plan: planByType.note, actual: memos.created, unit: '条' },
    { dim: '新建卡', icon: '🃏', plan: 0, actual: cards.created, unit: '张' },
  ];
  for (const d of dims) {
    d.rate = d.plan > 0 ? Math.min(100, Math.round((d.actual / d.plan) * 100)) : (d.actual > 0 ? 100 : 0);
  }
  return dims;
}

// ──────────────── 风险任务识别 ────────────────

/**
 * 识别今日规划中的「风险任务」，按严重度排序：
 *   - high:   Q1/Q2 任务且未完成，且当前时间已过 12:00
 *   - medium: estimatedMinutes > 60 且状态仍 pending
 *   - low:    Q3 任务且未完成
 * @param {Array} planTasks
 */
function buildRisks(planTasks) {
  const now = Date.now();
  const pastNoon = new Date().getHours() >= 12;
  const out = [];
  for (const t of planTasks) {
    if (!t || t.status === 'done') continue;
    const isPending = t.status === 'pending';
    if ((t.quadrant === 'Q1' || t.quadrant === 'Q2') && isPending && pastNoon) {
      out.push({ task: t, severity: 'high', reason: '重要任务午后仍未启动' });
    } else if ((t.estimatedMinutes || 0) > 60 && isPending) {
      out.push({ task: t, severity: 'medium', reason: '大块时间任务未启动' });
    } else if (t.quadrant === 'Q3' && isPending) {
      out.push({ task: t, severity: 'low', reason: '紧急任务拖延中' });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ──────────────── 历史热力矩阵（GitHub 风格） ────────────────

/**
 * 拉取最近 N 天每日任务完成率，渲染 GitHub 风格热力矩阵。
 * @param {number} [days=84] 默认 12 周（84 天），与 GitHub 一致
 * @returns {Promise<Array<{date, total, done, rate}>>} 按日期升序
 */
export async function getCompletionHeatmap(days = 84) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const startStr = localDateStr(start);
  const allPlans = await SAFE(() => db.dailyPlans.where('date').aboveOrEqual(startStr).toArray(), []);

  // 按日期聚合任务
  const byDate = {};
  for (const p of allPlans) byDate[p.date] = byDate[p.date] || { date: p.date, planId: p.id, total: 0, done: 0 };

  // 一次性拉所有相关任务（按 planId 索引）
  const planIds = Object.values(byDate).map(d => d.planId).filter(Boolean);
  if (planIds.length) {
    const tasks = await SAFE(() => db.dailyTasks.where('planId').anyOf(planIds).toArray(), []);
    for (const t of tasks) {
      const d = byDate[t.date];
      if (!d) continue;
      d.total++;
      if (t.status === 'done') d.done++;
    }
  }

  // 补齐空日期（无规划的天也算 0%）+ 计算 rate
  const out = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const ds = localDateStr(cursor);
    const d = byDate[ds] || { date: ds, total: 0, done: 0 };
    d.rate = d.total ? Math.round((d.done / d.total) * 100) : 0;
    out.push(d);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// ──────────────── 历史趋势（折线图） ────────────────

/**
 * 最近 N 天完成率趋势（折线图）。
 * @param {number} [days=30]
 */
export async function getCompletionTrend(days = 30) {
  const heat = await getCompletionHeatmap(days);
  return heat.map(d => ({ date: d.date, rate: d.rate, total: d.total, done: d.done }));
}
