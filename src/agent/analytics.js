// src/agent/analytics.js
// 跨模块统一数据访问层：任何模块（费曼/AI问答/Agent/文档/图谱/计划）都能通过它
// 拿到「卡片维度」与「全局维度」的真实数据，实现跨模块协同与针对性智能复习。
// 全部只读，纯前端查询 IndexedDB，零服务器。

import { db } from '../db.js';
import { getStats, weakCards } from '../repo.js';

const DAY = 86400000;
const now = () => Date.now();

// ---------- 卡片维度：单卡复习画像 ----------
export async function getCardAnalytics(cardId) {
  const card = await db.cards.get(cardId);
  if (!card) return null;
  const reviews = await db.reviews.where('cardId').equals(cardId).toArray();
  const total = reviews.length;
  const wrong = reviews.filter(r => r.rating === 0).length;
  const fuzzy = reviews.filter(r => r.rating === 1).length;
  const remembered = reviews.filter(r => r.rating === 2).length;
  const lastReviewedAt = reviews.reduce((m, r) => Math.max(m, r.reviewedAt), 0) || null;
  const firstReviewedAt = reviews.reduce((m, r) => Math.min(m, r.reviewedAt), Infinity);
  const daysActive = Math.max(1, Math.floor((now() - (firstReviewedAt === Infinity ? (card.createdAt || now()) : firstReviewedAt)) / DAY));
  const freqPerDay = +(total / daysActive).toFixed(2);
  const last7 = reviews.filter(r => r.reviewedAt >= now() - 7 * DAY).length;
  const correctRate = total ? Math.round((remembered / total) * 100) : null;
  return {
    id: card.id,
    subject: card.subject,
    front: String(card.front).slice(0, 60),
    tags: card.tags || [],
    marked: !!card.marked,
    wrongReason: card.wrongReason || '',
    level: card.level,
    total, wrong, fuzzy, remembered, last7,
    correctRate,
    lastReviewedAt,
    freqPerDay,
    isHighFreq: total >= 5,
    isWrongFreq: wrong >= 3,
    dueAt: card.dueAt,
  };
}

// ---------- 历史维度：最近 N 天答错的题 ----------
export async function getRecentMistakes(days = 1) {
  const since = now() - days * DAY;
  const reviews = await db.reviews.toArray();
  const wrongIds = new Set();
  for (const r of reviews) {
    if (r.rating === 0 && r.reviewedAt >= since) wrongIds.add(r.cardId);
  }
  const cards = await db.cards.toArray();
  const cardMap = new Map(cards.map(c => [c.id, c]));
  const out = [];
  for (const id of wrongIds) {
    const c = cardMap.get(id);
    if (!c) continue;
    const a = await getCardAnalytics(id);
    out.push({ id, subject: c.subject, front: String(c.front).slice(0, 60), wrongCount: a?.wrong || 0, total: a?.total || 0 });
  }
  return out.sort((a, b) => b.wrongCount - a.wrongCount);
}

// ---------- 全局维度：跨模块概览 ----------
export async function getCrossModuleInsight() {
  const stats = await getStats();
  const weak = await weakCards(20, 1);
  const recentMistakes = await getRecentMistakes(1);
  const [plans, docs, graphEdges, memos, aiChats, pomoSessions] = await Promise.all([
    db.plans.toArray(), db.docs.toArray(), db.graphEdges.toArray(),
    db.memos.toArray(), db.aiChats.toArray(), db.pomoSessions.toArray(),
  ]);
  const feynmanCount = aiChats.filter(c => c.type === 'feynman').length;
  const agentCount = aiChats.filter(c => c.type === 'agent').length;
  const chatCount = aiChats.filter(c => !c.type || c.type === 'chat').length;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const pomoToday = pomoSessions.filter(s => s.startedAt >= dayStart.getTime()).length;
  const pomoMinutes = pomoSessions.reduce((s, x) => s + (x.duration || 0), 0);
  const activePlans = plans.filter(p => p.status === 'active').length;
  return {
    cards: stats.totalCards,
    reviews: stats.totalReviews,
    dueToday: stats.dueToday,
    avgMastery: stats.avgMastery,
    ability: stats.ability,
    weakCount: weak.length,
    recentMistakeCount: recentMistakes.length,
    recentMistakes: recentMistakes.slice(0, 10),
    plans: { total: plans.length, active: activePlans },
    docs: { total: docs.length },
    graphEdges: { total: graphEdges.length },
    memos: { total: memos.length },
    ai: { feynman: feynmanCount, agent: agentCount, chat: chatCount },
    pomodoro: { today: pomoToday, totalSessions: pomoSessions.length, totalMinutes: pomoMinutes },
  };
}

// ---------- 模块概览（供 context.js 注入一段精简文本） ----------
export async function getModuleSummary() {
  const insight = await getCrossModuleInsight();
  const L = [];
  L.push(`- 跨模块概况：计划 ${insight.plans.active}/${insight.plans.total}（进行中/总数）、AI文档 ${insight.docs.total} 篇、知识图谱边 ${insight.graphEdges.total} 条、备忘 ${insight.memos.total} 条`);
  L.push(`- 学习行为：费曼练习 ${insight.ai.feynman} 次、Agent 工作台会话 ${insight.ai.agent} 次、普通问答 ${insight.ai.chat} 次、番茄专注 ${insight.pomodoro.totalSessions} 次（累计 ${insight.pomodoro.totalMinutes} 分钟，今日 ${insight.pomodoro.today} 次）`);
  if (insight.recentMistakeCount) {
    const top = insight.recentMistakes.slice(0, 8).map(m => `[${m.subject}] ${m.front}（错${m.wrongCount}次）`).join('；');
    L.push(`- 最近 24h 答错：${top}`);
  }
  return L.join('\n');
}

// ---------- 学习画像：跨模块统一打分（0~100） ----------
export async function getLearningProfile() {
  const stats = await getStats();
  const reviews = await db.reviews.toArray();
  const mastery = stats.avgMastery || 0;
  const correct = stats.ability?.correct || 0;
  const stable = stats.ability?.stable || 0;
  const coverage = stats.ability?.coverage || 0;

  // 活跃度：近 7 天有复习的天数占比
  const since7 = now() - 7 * DAY;
  const actDays = new Set();
  for (const r of reviews) if (r.reviewedAt >= since7) actDays.add(new Date(r.reviewedAt).toDateString());
  const activity = Math.round((actDays.size / 7) * 100);

  // 纠正力：曾答错的卡片中，之后有答对记录的比例
  const wrongCardIds = new Set();
  for (const r of reviews) if (r.rating === 0) wrongCardIds.add(r.cardId);
  let corrected = 0;
  for (const id of wrongCardIds) {
    if (reviews.some(r => r.cardId === id && r.rating === 2)) corrected++;
  }
  const correction = wrongCardIds.size ? Math.round((corrected / wrongCardIds.size) * 100) : 0;

  const score = Math.round(mastery * 0.25 + correct * 0.2 + stable * 0.15 + coverage * 0.15 + activity * 0.15 + correction * 0.1);
  return {
    score,
    level: score >= 85 ? '优秀' : score >= 70 ? '良好' : score >= 55 ? '中等' : '待提升',
    dimensions: { mastery, correct, stable, coverage, activity, correction },
    summary: `掌握度${mastery}% · 正确率${correct}% · 稳定度${stable}% · 覆盖率${coverage}% · 活跃度${activity}% · 纠正力${correction}%`,
  };
}

// ---------- 易混卡片自动配对（同科目、双方都有答错记录） ----------
export async function getConfusablePairs(limit = 10) {
  const cards = await db.cards.toArray();
  const reviews = await db.reviews.toArray();
  const wrongCount = new Map();
  for (const r of reviews) if (r.rating === 0) wrongCount.set(r.cardId, (wrongCount.get(r.cardId) || 0) + 1);

  // 易混对决的错选记录（D1：对决数据回流，自动扩容/加权易混对）
  const dwRow = await db.meta.get('duelWrongs');
  const duelWrongKeys = new Set(Array.isArray(dwRow?.value) ? dwRow.value : []);

  const candidates = cards.filter(c => (wrongCount.get(c.id) || 0) >= 1);
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (!a.subject || a.subject !== b.subject) continue;
      const shareTag = (a.tags || []).some(t => (b.tags || []).includes(t));
      if (!shareTag) continue; // 同科目且至少一个共同标签才视为易混
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        a: { id: a.id, subject: a.subject, front: String(a.front).slice(0, 40), tags: a.tags || [] },
        b: { id: b.id, subject: b.subject, front: String(b.front).slice(0, 40), tags: b.tags || [] },
        confusable: (wrongCount.get(a.id) || 0) + (wrongCount.get(b.id) || 0) + (duelWrongKeys.has(key) ? 5 : 0),
      });
    }
  }
  pairs.sort((x, y) => y.confusable - x.confusable);
  return pairs.slice(0, limit);
}

// ---------- 费曼→错题→卡片 闭环：找出高频错题（可据此生成巩固/变式卡） ----------
export async function getGapCards(limit = 15) {
  const weak = await weakCards(limit, 1);
  return weak.map(c => ({
    id: c.id, subject: c.subject, front: String(c.front).slice(0, 60), back: String(c.back).slice(0, 80),
    failCount: c.failCount, tags: c.tags || [],
  }));
}

// ---------- D1 遗忘预警：3 天内到期且历史表现不稳的卡（趁没忘先救） ----------
export async function getForgetRisk(limit = 5) {
  const cards = await db.cards.toArray();
  const reviews = await db.reviews.toArray();
  const nowTs = now();
  const fail = new Map(); const total = new Map();
  for (const r of reviews) {
    total.set(r.cardId, (total.get(r.cardId) || 0) + 1);
    if (r.rating === 0) fail.set(r.cardId, (fail.get(r.cardId) || 0) + 1);
  }
  const out = [];
  for (const c of cards) {
    const t = total.get(c.id) || 0;
    if (t < 2) continue; // 样本太少不预测
    const failRate = (fail.get(c.id) || 0) / t;
    const dueIn = (c.dueAt ?? 0) - nowTs;
    if (dueIn < 0 || dueIn > 3 * DAY) continue; // 只预警"3 天内将到期"
    // 风险 = 临近程度 60% + 历史错误率 40%；>=0.35 才预警
    const risk = (1 - dueIn / (3 * DAY)) * 0.6 + Math.min(1, failRate * 2.5) * 0.4;
    if (risk < 0.35) continue;
    out.push({
      id: c.id, subject: c.subject || '未分类',
      front: String(c.front).slice(0, 50),
      risk: Math.round(risk * 100),
      failRate: Math.round(failRate * 100),
      reviews: t,
      dueAt: c.dueAt,
    });
  }
  return out.sort((a, b) => b.risk - a.risk).slice(0, limit);
}

// ---------- D1 单科诊断：每科的掌握度/到期/错题/易混画像 + 规则化建议 ----------
export async function getSubjectDiagnosis() {
  const [stats, pairs] = await Promise.all([getStats(), getConfusablePairs(300)]);
  const cards = await db.cards.toArray();
  const nowTs = now();
  const masteryMap = new Map((stats.mastery || []).map(m => [m.subject, m.mastery]));
  const subjects = [...new Set(cards.map(c => c.subject || '未分类'))];
  const diag = [];
  for (const subject of subjects) {
    const subjCards = cards.filter(c => (c.subject || '未分类') === subject);
    const due = subjCards.filter(c => c.dueAt <= nowTs).length;
    const marked = subjCards.filter(c => c.marked).length;
    const pairN = pairs.filter(p => p.a.subject === subject || p.b.subject === subject).length;
    const m = masteryMap.get(subject) || 0;
    const advices = [];
    if (m < 50) advices.push('掌握度偏低，先回看基础概念、放慢加卡速度');
    if (marked >= 3) advices.push(`${marked} 张手动错题，优先清理错题本`);
    if (pairN >= 3) advices.push(`有 ${pairN} 组易混点，多做「易混对决」`);
    if (due >= 10) advices.push(`今日待背 ${due} 张，先集中清到期卡`);
    if (!advices.length) advices.push('状态良好，保持节奏即可');
    diag.push({ subject, cards: subjCards.length, due, marked, mastery: m, pairN, advice: advices.join('；') });
  }
  return diag.sort((a, b) => b.cards - a.cards);
}

// ---------- 知识图谱驱动复习编排 ----------
// 把持久化的图谱边（from/to 是知识点 label）映射到具体卡片，
// 按 prereq（前置/依赖）关系做拓扑回溯：到期卡 → 其前置知识点对应卡 → 一并加入队列且排在前面
// 按 contrast（对比/易混）关系做配对：把同知识点的易混卡挨着复习

function classifyEdge(label) {
  const s = String(label || '').trim();
  if (/(前置|依赖|先修|prerequisite|prereq|基础)/i.test(s)) return 'prereq';
  if (/(对比|易混|对照|versus|vs|区分)/i.test(s)) return 'contrast';
  if (/(属于|包含|分类|is_a|subset)/i.test(s)) return 'parent';
  if (/(相关|关联|related)/i.test(s)) return 'related';
  return 'related';
}

function mapLabelsToCards(cards) {
  const byLabel = new Map();
  for (const c of cards) {
    const f = String(c.front || '').replace(/[*_#>`~|-]/g, '').trim();
    const b = String(c.back || '').replace(/[*_#>`~|-]/g, '').trim();
    byLabel.set(f.toLowerCase(), c);
    if (!byLabel.has(b.toLowerCase())) byLabel.set(b.toLowerCase(), c);
  }
  return byLabel;
}

function findCardForLabel(label, byLabel, cards) {
  if (!label) return null;
  const key = String(label).toLowerCase();
  if (byLabel.has(key)) return byLabel.get(key);
  const lc = String(label).toLowerCase();
  for (const c of cards) {
    if (String(c.front || '').toLowerCase().includes(lc)) return c;
  }
  return null;
}

/**
 * 图谱驱动复习编排
 * @param {object} opts { limit, includeDueOnly }
 * @returns {Promise<{path, prereqsAdded, contrastPairs, unmapped, edgesUsed}>}
 */
export async function getGraphDrivenReviewPlan(opts = {}) {
  const limit = Number(opts?.limit) || 50;
  const includeDueOnly = opts?.includeDueOnly !== false;
  const [cards, edges, reviews] = await Promise.all([
    db.cards.toArray(), db.graphEdges.toArray(), db.reviews.toArray(),
  ]);
  if (!edges.length) {
    const nowTs = now();
    let pool = cards;
    if (includeDueOnly) pool = pool.filter(c => c.dueAt <= nowTs);
    pool.sort((a, b) => (a.dueAt - b.dueAt) || (a.id < b.id ? -1 : 1));
    return { path: pool.slice(0, limit), prereqsAdded: [], contrastPairs: [], unmapped: [], edgesUsed: 0, fallback: true };
  }

  const byLabel = mapLabelsToCards(cards);
  const nowTs = now();
  const failCount = new Map();
  for (const r of reviews) if (r.rating === 0) failCount.set(r.cardId, (failCount.get(r.cardId) || 0) + 1);

  let seeds = cards.filter(c => c.dueAt <= nowTs);
  const weak = cards.filter(c => c.marked || (failCount.get(c.id) || 0) >= 2);
  const seedSet = new Map();
  for (const c of seeds) seedSet.set(c.id, c);
  for (const c of weak) if (!seedSet.has(c.id)) seedSet.set(c.id, c);
  seeds = [...seedSet.values()];

  const idx = new Map();
  const ensure = (l) => { if (!idx.has(l)) idx.set(l, { prereqs: [], contrasts: [], related: [] }); return idx.get(l); };
  let edgesUsed = 0;
  for (const e of edges) {
    const t = classifyEdge(e.label);
    if (t === 'prereq') { ensure(e.from).prereqs.push(e.to); edgesUsed++; }
    else if (t === 'contrast') { ensure(e.from).contrasts.push(e.to); ensure(e.to).contrasts.push(e.from); edgesUsed++; }
    else { ensure(e.from).related.push(e.to); }
  }

  const unmapped = new Set();
  const added = new Map();
  const inPath = new Set();
  const path = [];

  function pushCard(c, reason) {
    if (!c || inPath.has(c.id)) return;
    inPath.add(c.id);
    path.push({ ...c, graphReason: reason });
  }

  for (const seed of seeds) {
    const seedLabels = [String(seed.front || '').replace(/[*_#>`~|-]/g, '').trim().toLowerCase()];
    const prereqLabels = [];
    const visit = (lbl, depth) => {
      if (depth > 3) return;
      const node = idx.get(lbl);
      if (!node) return;
      for (const p of node.prereqs) {
        if (!prereqLabels.includes(p)) prereqLabels.push(p);
        visit(p, depth + 1);
      }
    };
    for (const sl of seedLabels) visit(sl, 0);

    for (const pl of prereqLabels) {
      const pc = findCardForLabel(pl, byLabel, cards);
      if (pc) {
        if (!added.has(pc.id) && !inPath.has(pc.id)) added.set(pc.id, pc);
        pushCard(pc, '前置知识');
      } else if (!unmapped.has(pl)) unmapped.add(pl);
    }
    pushCard(seed, '到期/薄弱');
  }

  const contrastPairs = [];
  const baseLen = path.length;
  for (let i = 0; i < baseLen; i++) {
    const item = path[i];
    const lbl = String(item.front || '').replace(/[*_#>`~|-]/g, '').trim().toLowerCase();
    const node = idx.get(lbl);
    if (!node || !node.contrasts.length) continue;
    for (const cl of node.contrasts) {
      const cc = findCardForLabel(cl, byLabel, cards);
      if (cc && !inPath.has(cc.id)) {
        pushCard(cc, '易混配对');
        contrastPairs.push({ a: item.id, b: cc.id, label: lbl });
      }
    }
  }

  return {
    path: path.slice(0, limit),
    prereqsAdded: [...added.values()].slice(0, 20),
    contrastPairs,
    unmapped: [...unmapped].slice(0, 20),
    edgesUsed,
    fallback: false,
  };
}

// ---------- 学习计划自动编排（数据驱动，零 LLM 也能用）----------
// 拉取跨模块数据（薄弱/到期/遗忘风险/易混对/单科诊断/图驱动路径），
// 按 days 切成 3 阶段（抢救→巩固→收尾），每阶段含目标/任务/优先级/里程碑
// 输出 markdown content + 结构化 meta，可由 create_plan 直接持久化
export async function generateAutoPlan(days = 7) {
  const D = Math.max(1, Math.min(30, Number(days) | 0));
  const [stats, diag, risks, weak, graph] = await Promise.all([
    getStats(),
    getSubjectDiagnosis(),
    getForgetRisk(10),
    weakCards(20, 1),
    getGraphDrivenReviewPlan({ limit: 30, includeDueOnly: true }),
  ]);

  const s1 = Math.max(1, Math.round(D * 0.3));
  const s2 = Math.max(1, Math.round(D * 0.4));
  const s3 = Math.max(1, D - s1 - s2);

  const subjRank = [...diag].sort((a, b) => {
    const sa = (100 - a.mastery) + a.due * 0.5 + a.pairN * 3 + a.marked;
    const sb = (100 - b.mastery) + b.due * 0.5 + b.pairN * 3 + b.marked;
    return sb - sa;
  });
  const topSubjects = subjRank.slice(0, 4);
  const focusSubject = topSubjects[0]?.subject || '';

  const dailyDue = Math.max(5, Math.ceil(stats.dueToday / Math.max(1, D)));

  const riskList = risks.slice(0, 8).map(r => `- [${r.subject}] ${r.front}（风险 ${r.risk}%，错率 ${r.failRate}%）`);
  const weakList = weak.slice(0, 8).map(c => `- [${c.subject || '未分类'}] ${String(c.front).slice(0, 50)}（错 ${c.failCount} 次）`);

  const graphHint = graph.fallback
    ? '（暂无知识图谱，建议去「知识图谱」页生成并保存关联，启用图驱动复习）'
    : `已用 ${graph.edgesUsed} 条图谱边编排：额外加入 ${graph.prereqsAdded.length} 张前置卡、${graph.contrastPairs.length} 组易混配对`;

  const phases = [
    {
      name: '阶段一 · 抢救期',
      days: s1,
      goal: `主攻最薄弱科目「${focusSubject || '综合'}」与 ${risks.length} 张遗忘风险卡`,
      tasks: [
        `每天清 ${dailyDue} 张到期卡（优先 ${topSubjects.slice(0, 2).map(s => s.subject).join('、')}）`,
        `重做 ${Math.min(risks.length, 5)} 张遗忘风险卡（${risks.slice(0, 3).map(r => r.front.slice(0, 16)).join('、')}…）`,
        '错题本标记卡逐张过一遍（清零目标）',
      ],
      milestone: `抢救期结束：薄弱科目掌握度 +10，遗忘风险卡清空过半`,
    },
    {
      name: '阶段二 · 巩固期',
      days: s2,
      goal: `扩展到 ${topSubjects.length} 个重点科目，强化易混辨析与变式练习`,
      tasks: [
        `每天 ${dailyDue} 张到期卡 + 3 张变式卡（用「情境变式」生成）`,
        '开启「易混对决」模式，每天 1 组（5 对）',
        '若已建图谱：开启「图驱动复习」走前置→依赖路径',
      ],
      milestone: `巩固期结束：易混对正确率 ≥ 80%，覆盖全部重点科目`,
    },
    {
      name: '阶段三 · 收尾期',
      days: s3,
      goal: '全量到期卡 + 一次模考自测',
      tasks: [
        '清空所有到期卡（含跨期累积）',
        '在「模考」页做一次全科自测（出题 10 道）',
        '错题立即补卡（用「智能卡组」从错题原文重新拆卡）',
      ],
      milestone: `收尾期结束：模考正确率 ≥ 80%，所有到期卡清零`,
    },
  ];

  const lines = [];
  lines.push(`# 自动编排的 ${D} 天复习计划`);
  lines.push('');
  lines.push(`> 生成时间：${new Date().toLocaleString()} · 数据驱动（基于 ${stats.totalCards} 张卡 / ${stats.totalReviews} 次复习）`);
  lines.push('');
  lines.push(`## 总览`);
  lines.push(`- 周期：${D} 天，分 3 阶段（抢救 ${s1}d → 巩固 ${s2}d → 收尾 ${s3}d）`);
  lines.push(`- 重点科目：${topSubjects.map(s => `${s.subject}（掌握 ${s.mastery}%·到期 ${s.due}）`).join('、') || '（暂无数据）'}`);
  lines.push(`- 每日负载：约 ${dailyDue} 张到期卡`);
  lines.push(`- 图驱动：${graphHint}`);
  lines.push('');
  if (riskList.length) { lines.push(`## 遗忘风险卡（${risks.length}）`); lines.push(...riskList); lines.push(''); }
  if (weakList.length) { lines.push(`## 高频错题（${weak.length}）`); lines.push(...weakList); lines.push(''); }
  for (const p of phases) {
    lines.push(`## ${p.name}（${p.days} 天）`);
    lines.push(`**目标**：${p.goal}`);
    lines.push('**每日任务**：');
    for (const t of p.tasks) lines.push(`- ${t}`);
    lines.push(`**里程碑**：${p.milestone}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('> 提示：本计划由系统按你的真实数据自动生成；可点「编辑」微调，或让「复习计划编排师」Agent 用 AI 再细化。');

  return {
    title: `${D} 天复习计划 · ${focusSubject || '综合'} · ${new Date().toLocaleDateString()}`,
    content: lines.join('\n'),
    meta: {
      days: D,
      phases: phases.map(p => ({ name: p.name, days: p.days, goal: p.goal, milestone: p.milestone })),
      focusSubject,
      topSubjects: topSubjects.map(s => ({ subject: s.subject, mastery: s.mastery, due: s.due, pairN: s.pairN })),
      dailyDue,
      riskCount: risks.length,
      weakCount: weak.length,
      graphUsed: !graph.fallback,
      graphEdgesUsed: graph.edgesUsed,
    },
  };
}

// ---------- E1 资产健康度：重复卡 / 僵尸卡 / 孤儿图片 / 无标签卡 ----------
export async function getAssetHealth() {
  const [cards, reviews, images] = await Promise.all([
    db.cards.toArray(), db.reviews.toArray(), db.images.toArray(),
  ]);
  const nowTs = now();
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

  // 重复卡：front+back+subject 完全相同（忽略大小写与首尾空格）
  const byKey = new Map();
  for (const c of cards) {
    const k = `${norm(c.front)}||${norm(c.back)}||${c.subject || ''}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const duplicates = [...byKey.values()].filter(g => g.length > 1)
    .map(g => ({ key: g[0].front.slice(0, 30), front: g[0].front, back: g[0].back, subject: g[0].subject || '', cards: g, n: g.length }));

  // 僵尸卡：创建超过 90 天、从未复习、且已到期迟迟未处理
  const reviewedIds = new Set(reviews.map(r => r.cardId));
  const zombies = cards
    .filter(c => !reviewedIds.has(c.id) && nowTs - (c.createdAt || nowTs) > 90 * DAY && (c.dueAt || 0) <= nowTs)
    .map(c => ({ id: c.id, front: String(c.front).slice(0, 50), subject: c.subject || '', createdAt: c.createdAt, dueAt: c.dueAt }));

  // 孤儿图片：不被任何卡片引用
  const used = new Set();
  const re = /sxy-img:\/\/([0-9a-fA-F-]+)/g;
  for (const c of cards) {
    const text = `${c.front || ''}\n${c.back || ''}`;
    let m;
    while ((m = re.exec(text))) used.add(m[1]);
  }
  const orphanImages = images.filter(i => !used.has(i.id)).map(i => ({ id: i.id, createdAt: i.createdAt }));

  const untaggedCount = cards.filter(c => !(c.tags || []).length).length;

  return {
    totalCards: cards.length,
    duplicates,
    zombieCount: zombies.length,
    zombies,
    orphanImageCount: orphanImages.length,
    orphanImages,
    untaggedCount,
  };
}
