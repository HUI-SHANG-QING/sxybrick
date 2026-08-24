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
        confusable: (wrongCount.get(a.id) || 0) + (wrongCount.get(b.id) || 0),
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
