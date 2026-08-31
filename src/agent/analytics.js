// src/agent/analytics.js
// 跨模块统一数据访问层：任何模块（费曼/AI问答/Agent/文档/图谱/计划）都能通过它
// 拿到「卡片维度」与「全局维度」的真实数据，实现跨模块协同与针对性智能复习。
// 全部只读，纯前端查询 IndexedDB，零服务器。

import { db } from '../db.js';
import { getStats, weakCards } from '../repo.js';
import { trainWeights } from '../fsrs.js';

const DAY = 86400000;
const now = () => Date.now();

// ---------- P0-3: 重计算移入 Web Worker，避免 O(n²)/全表扫描阻塞主线程 ----------
// 主线程创建 worker；worker 内 _analyticsWorker 为 null → offload 直接返回 _FALLBACK → 走 inline，无循环递归
const isMainThread = typeof window !== 'undefined';
let _analyticsWorker = null;
const _pending = new Map();
let _seq = 0;
const _FALLBACK = Symbol('fallback');
if (isMainThread) {
  try {
    _analyticsWorker = new Worker(new URL('./analytics.worker.js', import.meta.url), { type: 'module' });
    _analyticsWorker.onmessage = (ev) => {
      const { id, result, error } = ev.data || {};
      const p = _pending.get(id);
      if (!p) return;
      _pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    _analyticsWorker.onerror = () => {
      _analyticsWorker = null; // worker 加载/运行失败：清空，后续调用回退主线程
      for (const [, p] of _pending) p.reject(new Error('worker unavailable'));
      _pending.clear();
    };
  } catch { _analyticsWorker = null; }
}
// 通用 offload：worker 优先，失败/无 worker 返回 _FALLBACK 让调用方走 inline
function offload(fn, args) {
  if (!_analyticsWorker) return Promise.resolve(_FALLBACK);
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    _analyticsWorker.postMessage({ id, fn, args });
  }).catch(() => _FALLBACK);
}

/**
 * 关闭分析 worker（仅供测试收尾调用）。
 *
 * ⚠️ 为什么需要：worker 线程是活跃 handle，会让 `node --test` 的子进程**无法自然退出**，
 * 被 SIGTERM 杀掉后 node --test 把整个文件判成失败（exitCode 143）——即使里面每条
 * 用例都 pass。项目为此在 package.json 用了 `--test-force-exit` 兜底，但实证该参数
 * 会在测试真正跑完前就 `process.exit(0)`，**吞掉真实的断言失败**（graphAuto 有一条
 * 用例在 force-exit 下不报 not ok）。正确解法是让进程能干净退出，而不是强制杀。
 * 浏览器里无需调用（页面卸载即回收 Worker）。
 */
export async function shutdownAnalyticsWorker() {
  const w = _analyticsWorker;
  _analyticsWorker = null;
  if (w) {
    // terminate() 是异步的：不 await 的话 worker 线程可能还没真正退出，
    // node --test 的子进程就已经被判定为「不退出」了。
    try { await w.terminate(); } catch { /* 已终止 */ }
  }
  for (const [, p] of _pending) p.reject(new Error('worker shutdown'));
  _pending.clear();
}

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
  // N+1 修复：一次全表扫描在内存聚合每卡错误/总数，替代逐卡 getCardAnalytics（N 次 get + N 次索引查询）
  const reviews = await db.reviews.toArray();
  const wrongIds = new Set();
  const wrongCount = new Map();
  const totalCount = new Map();
  for (const r of reviews) {
    const id = r.cardId;
    totalCount.set(id, (totalCount.get(id) || 0) + 1);
    if (r.rating === 0) {
      wrongCount.set(id, (wrongCount.get(id) || 0) + 1);
      if (r.reviewedAt >= since) wrongIds.add(id);
    }
  }
  const ids = [...wrongIds];
  if (!ids.length) return [];
  const cards = await db.cards.bulkGet(ids); // 只取错题卡，替代全卡 toArray
  const out = [];
  cards.forEach((c, i) => {
    if (!c) return;
    out.push({ id: ids[i], subject: c.subject, front: String(c.front).slice(0, 60), wrongCount: wrongCount.get(ids[i]) || 0, total: totalCount.get(ids[i]) || 0 });
  });
  return out.sort((a, b) => b.wrongCount - a.wrongCount);
}

// ---------- 全局维度：跨模块概览 ----------
async function _getCrossModuleInsight() {
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
// P0-3：6 表全表扫描移入 worker，失败回退 inline
export async function getCrossModuleInsight() {
  const r = await offload('getCrossModuleInsight', []);
  if (r !== _FALLBACK) return r;
  return _getCrossModuleInsight();
}

// ---------- P1-1 FSRS ML 训练数据准备 + 训练调度（offload 到 worker） ----------
// 训练数据：全部复习记录 + 卡片当前 fsrs 状态，按时间升序
export async function prepareFsrsTrainingData() {
  const [reviews, cards] = await Promise.all([db.reviews.toArray(), db.cards.toArray()]);
  const cardsById = new Map(cards.map(c => [c.id, c]));
  reviews.sort((a, b) => (a.reviewedAt || 0) - (b.reviewedAt || 0));
  return { reviews, cardsById };
}
// 训练用户 FSRS 权重（自动 offload 到 worker；样本不足/无 worker 回退默认）
export async function trainFsrsModel() {
  const r = await offload('trainFsrs', []);
  if (r !== _FALLBACK) return r;
  const { reviews, cardsById } = await prepareFsrsTrainingData();
  return trainWeights(reviews, cardsById);
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
  //
  // ⚠️ 2026-08-30 修复（两处）：
  //   ① 零错题用户被判 0 分：原实现 `wrongCardIds.size ? … : 0`，
  //      从未答错过 = 最好的学习结果，却在这一维拿 0 分 —— 满分用户总分上限被压到 90，
  //      从"优秀"(≥85) 掉档。零错题应判 100 分。
  //   ② 复杂度 O(N×M)：`reviews.some()` 嵌在遍历错卡集合的循环里，
  //      10 万条复习 × 5000 张错卡 = 5 亿次比较，且完全在主线程（该函数未被 offload）。
  //   顺带修正语义：注释写的是「**之后**有答对记录」，原实现只判断"存在答对记录"，
  //      不比较时间先后 —— 先答对后答错的卡也会被算成"已纠正"。
  const lastWrongAt = new Map();  // cardId → 最近一次 rating=0 的时刻
  const lastGoodAt = new Map();   // cardId → 最近一次 rating=2 的时刻
  for (const r of reviews) {
    const t = r.reviewedAt || 0;
    if (r.rating === 0) {
      if (t > (lastWrongAt.get(r.cardId) ?? -Infinity)) lastWrongAt.set(r.cardId, t);
    } else if (r.rating === 2) {
      if (t > (lastGoodAt.get(r.cardId) ?? -Infinity)) lastGoodAt.set(r.cardId, t);
    }
  }
  let corrected = 0;
  for (const [id, wrongAt] of lastWrongAt) {
    if ((lastGoodAt.get(id) ?? -Infinity) > wrongAt) corrected++; // 答错**之后**又答对了
  }
  const correction = lastWrongAt.size ? Math.round((corrected / lastWrongAt.size) * 100) : 100;

  const score = Math.round(mastery * 0.25 + correct * 0.2 + stable * 0.15 + coverage * 0.15 + activity * 0.15 + correction * 0.1);
  // ⚠️ 2026-08-31：等级与 summary 不再在这里拼中文。
  //   领域层产出 localized 散文的后果：切到英文界面后「学习画像」卡片仍显示
  //   「优秀 / 掌握度80% · 正确率90% …」，而问题不在任何 .vue 里，
  //   i18n 闸门（只扫视图）永远扫不到 —— 与 repo.bestWorstPartners 是同一类跨层缺陷。
  //   这里只回 levelCode，文案交给视图用 t() 组装。
  const levelCode = score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 55 ? 'fair' : 'needsWork';
  const dimensions = { mastery, correct, stable, coverage, activity, correction };
  return {
    score,
    levelCode,
    dimensions,
  };
}

// ---------- 易混卡片自动配对（同科目、双方都有答错记录） ----------
async function _getConfusablePairs(limit = 10) {
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
// P0-3：O(n²) 全对配对移入 worker，避免千卡级阻塞主线程
export async function getConfusablePairs(limit = 10) {
  const r = await offload('getConfusablePairs', [limit]);
  if (r !== _FALLBACK) return r;
  return _getConfusablePairs(limit);
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
    // ⚠️ 2026-08-30 修复：原实现 `if (dueIn < 0 …) continue` 把**逾期卡整类跳过** ——
    //   而逾期卡恰恰是风险最高、最该被预警的一批（已经过了最佳复习窗口还没背）。
    //   修正：逾期 → 临近度直接拉满；只排除「3 天后才到期」的远期卡。
    if (dueIn > 3 * DAY) continue;
    const proximity = dueIn >= 0 ? (1 - dueIn / (3 * DAY)) : 1;
    const overdueDays = dueIn < 0 ? Math.floor(-dueIn / DAY) : 0;
    // 风险 = 临近程度 60% + 历史错误率 40%；>=0.35 才预警
    const risk = proximity * 0.6 + Math.min(1, failRate * 2.5) * 0.4;
    if (risk < 0.35) continue;
    out.push({
      id: c.id, subject: c.subject || '未分类',
      front: String(c.front).slice(0, 50),
      risk: Math.round(risk * 100),
      failRate: Math.round(failRate * 100),
      reviews: t,
      dueAt: c.dueAt,
      overdueDays,
    });
  }
  return out.sort((a, b) => b.risk - a.risk).slice(0, limit);
}

// ---------- D1 单科诊断：每科的掌握度/到期/错题/易混画像 + 规则化建议 ----------
async function _getSubjectDiagnosis() {
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
// P0-3：单科诊断含易混对(300)+全卡扫描，移入 worker
export async function getSubjectDiagnosis() {
  const r = await offload('getSubjectDiagnosis', []);
  if (r !== _FALLBACK) return r;
  return _getSubjectDiagnosis();
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
async function _getGraphDrivenReviewPlan(opts = {}) {
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

  // R10 修复：邻接表以 cardId 为键，优先用边存的 fromCardId/toCardId 直连，
  // 仅遗留边（无 cardId）回退文本匹配，杜绝两卡文本相同导致的静默覆盖。
  const byId = new Map(cards.map(c => [c.id, c]));
  const byLabel = mapLabelsToCards(cards);
  const resolveEndpoint = (edge, side) => {
    const cardId = side === 'from' ? edge.fromCardId : edge.toCardId;
    if (cardId && byId.has(cardId)) return cardId;
    const lbl = side === 'from' ? edge.from : edge.to;
    const c = findCardForLabel(lbl, byLabel, cards);
    return c ? c.id : null;
  };

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
  const ensure = (cid) => { if (!idx.has(cid)) idx.set(cid, { prereqs: [], contrasts: [], related: [] }); return idx.get(cid); };
  let edgesUsed = 0;
  const unmapped = new Set();
  for (const e of edges) {
    const t = classifyEdge(e.label);
    const fromCid = resolveEndpoint(e, 'from');
    const toCid = resolveEndpoint(e, 'to');
    if (!fromCid || !toCid || fromCid === toCid) {
      if (!fromCid) unmapped.add(e.from);
      if (!toCid) unmapped.add(e.to);
      continue;
    }
    if (t === 'prereq') { ensure(fromCid).prereqs.push(toCid); edgesUsed++; }
    else if (t === 'contrast') { ensure(fromCid).contrasts.push(toCid); ensure(toCid).contrasts.push(fromCid); edgesUsed++; }
    else { ensure(fromCid).related.push(toCid); }
  }

  const added = new Map();
  const inPath = new Set();
  const path = [];

  function pushCard(c, reason) {
    if (!c || inPath.has(c.id)) return;
    inPath.add(c.id);
    path.push({ ...c, graphReason: reason });
  }

  for (const seed of seeds) {
    const prereqIds = [];
    const seenPrereq = new Set(); // Set 判重替代数组 includes（O(1)），带环图不再 O(n²)
    const visit = (cid, depth) => {
      if (depth > 3) return;
      const node = idx.get(cid);
      if (!node) return;
      for (const p of node.prereqs) {
        if (!seenPrereq.has(p)) { seenPrereq.add(p); prereqIds.push(p); }
        visit(p, depth + 1);
      }
    };
    visit(seed.id, 0);

    for (const pid of prereqIds) {
      const pc = byId.get(pid);
      if (pc) {
        if (!added.has(pc.id) && !inPath.has(pc.id)) added.set(pc.id, pc);
        pushCard(pc, '前置知识');
      }
    }
    pushCard(seed, '到期/薄弱');
  }

  const contrastPairs = [];
  const baseLen = path.length;
  for (let i = 0; i < baseLen; i++) {
    const item = path[i];
    const node = idx.get(item.id);
    if (!node || !node.contrasts.length) continue;
    for (const cid of node.contrasts) {
      const cc = byId.get(cid);
      if (cc && !inPath.has(cc.id)) {
        pushCard(cc, '易混配对');
        contrastPairs.push({ a: item.id, b: cc.id, label: item.front });
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
// P0-3：3 表扫描 + 邻接编排移入 worker
export async function getGraphDrivenReviewPlan(opts = {}) {
  const r = await offload('getGraphDrivenReviewPlan', [opts]);
  if (r !== _FALLBACK) return r;
  return _getGraphDrivenReviewPlan(opts);
}

// ---------- 学习计划自动编排（数据驱动，零 LLM 也能用）----------
// 拉取跨模块数据（薄弱/到期/遗忘风险/易混对/单科诊断/图驱动路径），
// 按 days 切成 3 阶段（抢救→巩固→收尾），每阶段含目标/任务/优先级/里程碑
// 输出 markdown content + 结构化 meta，可由 create_plan 直接持久化
async function _generateAutoPlan(days = 7) {
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
// P0-3：自动编排聚合多个重计算，整块移入 worker（子调用在 worker 内本地执行，省跨线程往返）
export async function generateAutoPlan(days = 7) {
  const r = await offload('generateAutoPlan', [days]);
  if (r !== _FALLBACK) return r;
  return _generateAutoPlan(days);
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

// ---------- 校准回测（Calibration）----------
// FSRS 预测记忆概率 vs 实际正确率的分桶对比；纯函数在 algorithms/calibration.js，这里只做 IO。
import { computeCalibration } from '../algorithms/calibration.js';
export async function getCalibration() {
  const reviews = await db.reviews.toArray();
  return computeCalibration(reviews);
}

// ---------- 到期洪峰预测（Due Forecast）----------
// 预测未来 N 天每日到期卡量（含复习推进模拟）；纯函数在 algorithms/forecast.js，这里只做 IO。
import { forecastDue } from '../algorithms/forecast.js';
export async function getDueForecast(days = 30) {
  const cards = await db.cards.toArray();
  return forecastDue(cards, days);
}

// ---------- 知识净值（Knowledge Net Worth）----------
// 卡片库「知识资产负债表」；纯函数在 algorithms/networth.js，这里只做 IO。
import { computeNetWorth } from '../algorithms/networth.js';
export async function getNetWorth() {
  const cards = await db.cards.toArray();
  return computeNetWorth(cards);
}

// ---------- 每科自适应目标保持率（per-subject adaptive desired retention）----------
// 掌握度低的科目复习更勤（更高保持率）；纯函数在 algorithms/adaptive-retention.js，这里只做 IO。
// 校准闭环：先用校准偏差 bias 全局微调 base（高估→更勤、低估→更省），再按每科掌握度自适应。
import { subjectRetentionMap } from '../algorithms/adaptive-retention.js';
import { calibrateFromStats } from '../algorithms/calibration-feedback.js';
export async function getSubjectRetentionMap() {
  const [s, calib] = await Promise.all([getStats(), getCalibration()]);
  const base = calibrateFromStats(0.9, calib);
  return subjectRetentionMap(s.mastery, base);
}

// ---------- 源→卡→数据全血缘（source lineage）----------
// 来源聚合 + 单卡血缘追溯；纯函数在 algorithms/source-trace.js，这里只做 IO。
import { sourceOverview } from '../algorithms/source-trace.js';
export async function getSourceOverview() {
  const cards = await db.cards.toArray();
  return sourceOverview(cards);
}
