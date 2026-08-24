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
