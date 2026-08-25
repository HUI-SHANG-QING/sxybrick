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
