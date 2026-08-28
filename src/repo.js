// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid } from './db.js';
import { computeNext, applyFeedback, scheduleReview, RETRIEVAL_STRENGTH_OPTIONS } from './srs.js';
// P3-4 插件事件钩子：业务动作后向已启用插件分发（fire-and-forget，不阻塞也不抛错）
// 静态导入无循环依赖：plugins/registry 只依赖 db.js 与 agent/registry.js，不依赖 repo.js
import { triggerHook } from './plugins/registry.js';
// P1-3 检索强度分级选项：供 Review.vue 等 UI 直接渲染选择器
export { RETRIEVAL_STRENGTH_OPTIONS };
import { mergeUserWeights, retrievability } from './fsrs.js';
import { extractImageIds } from './images.js';
import { initialStabilityForCard } from './algorithms/pretest.js';
import { buildReviewSession, retrievalGrading } from './algorithms/session.js';
// N9 纯函数层：校验/过滤/排序/统计逻辑抽至 repo-core.js（Node 可单测），repo.js 只做 IO 编排
import {
  DEFAULT_SUBJECTS,
  validateCard as _validateCard,
  tagFilter,
  gradeCard as _gradeCard,
  WRONG_REASON_MAP as _WRONG_REASON_MAP,
  WRONG_REASONS as _WRONG_REASONS,
  wrongReasonToCode as _wrongReasonToCode,
  formatDue as _formatDue,
  filterReviewCandidates,
  rankWeakCards,
  selectZombieIds,
  buildReviewSuggestion,
  computeStats,
  groupUserOps,
} from './repo-core.js';

export { DEFAULT_SUBJECTS };
export const validateCard = _validateCard;
export const gradeCard = _gradeCard;
export const WRONG_REASON_MAP = _WRONG_REASON_MAP;
export const WRONG_REASONS = _WRONG_REASONS;
export const wrongReasonToCode = _wrongReasonToCode;
export const formatDue = (ts) => _formatDue(ts);


const now = () => Date.now();

// P3-4 插件钩子触发：fire-and-forget（插件抛错/慢执行绝不影响主流程）
function fireHook(event, ...args) {
  triggerHook(event, ...args).catch(() => {});
}

// P1-1 FSRS 调度配置缓存：避免每次复习都查 db.meta（scheduler/fsrsWeights）
let _schedCache = null;
async function getSchedConfig() {
  if (_schedCache && Date.now() - _schedCache.loadedAt < 60000) return _schedCache;
  const [sched, wRow] = await Promise.all([db.meta.get('scheduler'), db.meta.get('fsrsWeights')]);
  _schedCache = {
    scheduler: sched?.value === 'fsrs' ? 'fsrs' : 'sm2',
    weights: mergeUserWeights(wRow?.value),
    loadedAt: Date.now(),
  };
  return _schedCache;
}
/** 设置变更后调用，清缓存使下次复习读到新调度器/新权重 */
export function refreshSchedConfig() { _schedCache = null; }
// 剥离 Vue 响应式代理：Dexie put 前转纯对象，避免 reactive proxy 触发 IndexedDB 结构化克隆失败（思维导图等含嵌套对象的表曾因此保存失败）
const plain = (x) => JSON.parse(JSON.stringify(x));

// validateCard 已抽至 repo-core.js（上方 re-export 保持 API 不变）

// 导出供 intelligence.js 等模块复用（避免重复实现全量读取）
export async function allCards() {
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

// tagFilter 已抽至 repo-core.js（validateCard 同批）

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

// gradeCard 已抽至 repo-core.js（上方 re-export 保持 API 不变）

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
    sourceCardId: r.value.sourceCardId || null,
    difficulty: r.value.difficulty,
    tags: r.value.tags, frontChars: [...r.value.front].length, backChars: [...r.value.back].length,
    ease: 2.5, level: 0, intervalDays: 0, dueAt: t, createdAt: t, updatedAt: t,
  };
  await db.cards.put(card);
  fireHook('onCardSaved', card);
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
    difficulty: r.value.difficulty,
    frontChars: [...r.value.front].length, backChars: [...r.value.back].length, updatedAt: now(),
  };
  await db.cards.put(card);
  fireHook('onCardSaved', card);
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
  fireHook('onCardDeleted', { id });
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
// WRONG_REASON_MAP / wrongReasonToCode / WRONG_REASONS 已抽至 repo-core.js（上方 re-export 保持 API 不变）

// 取候选卡的复习历史（单条 anyOf 索引查询，非 N 查询），供 buildReviewSession 做检索分级。
// 返回 Map<cardId, review[]>，每条 review 含 { rating, guessed, responseMs, retrievalStrength }，
// 正好喂给 session.js 的 estimateRetrievalDifficulty。
async function buildReviewsByCard(cards) {
  const ids = (cards || []).map(c => c.id);
  const map = new Map();
  if (!ids.length) return map;
  const revs = await db.reviews.where('cardId').anyOf(ids).toArray();
  for (const r of revs) {
    if (!map.has(r.cardId)) map.set(r.cardId, []);
    map.get(r.cardId).push(r);
  }
  return map;
}

// ---------- 复习 ----------
// filter: { subjects:[], tags:[], logic:'AND'|'OR'|'NOT', wrongReasons:[], includeDueOnly:true }
// 自由组合背诵：按科目/标签/错因并集·交集·差集筛选到期队列（默认全量到期，遵循复习曲线）
export async function reviewQueue(limit = 100, interleave = false, filter = {}) {
  // 筛选 + 排序核心已抽至 repo-core.filterReviewCandidates（N9）
  let cards = filterReviewCandidates(await allCards(), filter, now());
  // 三维交错（P1-2 + 2026-08-27 抽取为 algorithms/session.js 的 interleaveQueue）：
  // 科目 + 题型 + 难度，避免相邻卡片"过于相似"
  // 认知科学：交错练习（Interleaving）比集中练习（Blocked）提升远迁移 40%+；
  //   - 科目切换最强（激活不同知识网络）
  //   - 难度切换避免"难度定势"（basic/applied/challenge）
  //   - 题型切换避免"题型定势"（basic/cloze/choice/writing）
  // 算法：贪心 + 邻接惩罚。维护最近 WINDOW 张的维度集合，每步从剩余候选选 penalty 最低的，
  //   并列时按 dueAt 升序（仍优先到期卡）。变式卡同 sourceCardId 重罚（合并原 anti-adjacent 逻辑）。
  // P1-A 会话编排：用 algorithms/session.js 的 buildReviewSession 取代裸 interleaveQueue，
  //   在「交错混科」之上叠加「检索分级（难卡早重现）+ 测试间隔效应（考试窗口紧迫度）」：
  //   - 无 examAt 且不带复习历史 → rank 退化为 dueAt 序，行为与原交错一致（保序，零回归）
  //   - 有复习历史 → 提取流畅度低的难卡靠前；有 examAt → 临考卡靠前（间隔效应·考前密集重现）
  if (interleave && cards.length > 1) {
    const reviewsByCard = await buildReviewsByCard(cards);
    cards = buildReviewSession(cards, {
      interleave: true,
      examAt: filter.examAt || 0,
      reviewsByCard,
    }).queue;
  }
  return cards.slice(0, limit);
}

export async function review(cardId, rating, intensity = 1, guessed = false, opts = {}) {
  const card = await db.cards.get(cardId);
  if (!card) throw new Error('卡片不存在');
  // P1-1：读取调度器配置（FSRS opt-in）+ 用户训练权重（带 60s 缓存）
  const cfg = await getSchedConfig();
  // 每复习难度评分（0/1/2）：opts 优先，否则取卡片内容难度映射值
  // 注意：difficulty 是卡片固有内容属性（basic/applied/challenge），复习不应回写覆盖它
  const DIFF_MAP = { basic: 0, applied: 1, challenge: 2 };
  const toDiffNum = (v) => DIFF_MAP[v] ?? (Number.isFinite(Number(v)) ? Number(v) : null);
  const difficulty = toDiffNum(opts.difficulty) ?? toDiffNum(card.difficulty) ?? 1;
  const wrongReason = opts.wrongReason || card.wrongReason || '';
  // 自适应节奏（C4）：按该卡近 10 次复习的错误率微调间隔（仅开启时计算）
  let adaptive = null;
  if (opts.adaptive) {
    const recent = await db.reviews.where('cardId').equals(cardId).reverse().sortBy('reviewedAt');
    const last10 = recent.slice(0, 10);
    const fail = last10.filter(r => r.rating === 0).length;
    adaptive = { reviews: last10.length, failRate: last10.length ? fail / last10.length : 0 };
  }
  // 冷启动前测：若该科目做过前测且本卡无复习历史，用估计的初始稳定度替代 FSRS 默认 S0
  const pretestRow = await db.meta.get('pretestStability');
  const pretestMap = pretestRow && typeof pretestRow.value === 'object' ? pretestRow.value : null;
  const initialStability = initialStabilityForCard(card, pretestMap);
  const next = scheduleReview(card, rating, intensity, guessed, {
    difficulty, wrongReason, adaptive,
    scheduler: cfg.scheduler, weights: cfg.weights, initialStability,
    // P1-3 检索强度分级 + 考试窗口感知/节假日弹性：必须透传，否则 UI 选择不生效
    retrievalStrength: opts.retrievalStrength,
    examAt: opts.examAt || 0,
    desiredRetention: opts.desiredRetention,
    restDays: opts.restDays,
  });
  // P1-A 检索分级：把这一次提取尝试定级（failed/hard/medium/easy），写入复习记录，
  // 供 buildReviewSession 的 estimateRetrievalDifficulty 估算「当前检索难度」→ 难卡早重现 / 间隔效应。
  // 信号来源：用户自评 rating + 是否蒙对 guessed + 作答时长 responseMs + 检索强度 retrievalStrength。
  const grade = retrievalGrading({
    rating,
    guessed: !!guessed,
    responseMs: opts.responseMs || 0,
    retrievalStrength: opts.retrievalStrength || '',
  });
  // 复习只更新 SRS 字段与 reviewedAt，不 bump updatedAt、不回写 difficulty（内容属性）：
  // 否则跨设备同步时「复习动作」会覆盖另一台设备对卡片文字/难度的编辑（数据丢失）
  // consolidation 字段：短期巩固状态（null/1/2），跟随 SRS 一并写回
  // fsrs：FSRS 状态 {s,d,reps,last}；SM-2 路径 next.fsrs 为 undefined → 保留 card.fsrs（切换调度器后可无缝接续）
  // wrongReasonAt：错因独立时间戳，跨设备合并时按此取新者（不跟随 updatedAt 也不跟随 reviewedAt）
  const nowTs = now();
  // 校准回测（calibration）：用复习前的 fsrs 状态计算当时预测 R，落盘进复习记录。
  // 历史记录无 predR 由 calibration.js 回溯模拟补估；从这里起的新数据都是真实值。
  const predR = (card.fsrs && Number.isFinite(card.fsrs.s) && Number.isFinite(card.fsrs.last))
    ? Number(retrievability(card.fsrs.s, (nowTs - card.fsrs.last) / 86400000).toFixed(4))
    : null;
  await db.cards.put({ ...card, ease: next.ease, level: next.level, intervalDays: next.intervalDays, dueAt: next.dueAt, consolidation: next.consolidation, fsrs: next.fsrs ?? card.fsrs, wrongReason, wrongReasonAt: nowTs, reviewedAt: nowTs });
  const reviewId = uid();
  await db.reviews.put({
    id: reviewId, cardId, reviewedAt: now(), rating,
    predR,
    levelAfter: next.level, guessed: !!guessed, difficulty, wrongReason,
    retrievalStrength: opts.retrievalStrength || '',
    responseMs: opts.responseMs || 0,
    grade: grade.level, gradeScore: grade.score,
  });
  fireHook('onReviewRated', { cardId, rating, reviewId, guessed: !!guessed });
  return { ...next, dueText: formatDue(next.dueAt), reviewId };
}

// 自我解释钩子（学习科学：错题后一句话反思「为什么错 / 正确理解」），
// 落盘到对应复习记录。selfExplainAt 独立时间戳供跨设备按新取新。
export async function attachSelfExplanation(reviewId, text) {
  const r = await db.reviews.get(reviewId);
  if (!r) return null;
  const selfExplanation = String(text || '').trim().slice(0, 500);
  await db.reviews.put({ ...r, selfExplanation, selfExplainAt: Date.now() });
  return true;
}

// formatDue 已抽至 repo-core.js（上方 re-export 保持 API 不变）

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
  // 排名核心已抽至 repo-core.rankWeakCards（N9）
  const [cards, reviews] = await Promise.all([allCards(), db.reviews.toArray()]);
  return rankWeakCards(cards, reviews, { limit, minFail });
}

// ---------- 复习提醒建议 ----------
export async function getReviewSuggestion() {
  // 建议核心已抽至 repo-core.buildReviewSuggestion（N9）
  const [cards, reviews] = await Promise.all([allCards(), db.reviews.toArray()]);
  return buildReviewSuggestion(cards, reviews, now());
}

// ---------- 统计 ----------
export async function getStats() {
  // 统计核心已抽至 repo-core.computeStats（N9）
  const [cards, reviews] = await Promise.all([allCards(), db.reviews.toArray()]);
  return computeStats(cards, reviews, now());
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
  fireHook('onMemoSaved', m);
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
  const p = plain({ ...old, ...(patch || {}), updatedAt: now() });
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
  // R10 修复：边存卡片 id 直连，避免文本匹配静默覆盖（两卡文本相同时旧逻辑会覆盖）
  // from/to 仍保留（兼容遗留数据 + 图谱节点显示用 label）；fromCardId/toCardId 为稳定连接键
  const fromCardId = payload?.fromCardId ? String(payload.fromCardId) : '';
  const toCardId = payload?.toCardId ? String(payload.toCardId) : '';
  // Phase 6.6：资料边（资料 → 卡片「涵盖」）用 docId 标识来源资料 + type 区分
  const docId = String(payload?.docId || '');
  const type = String(payload?.type || '');
  // 去重优先级：docId（资料边）> cardId（卡片边）> label（遗留兼容）
  const exists = await db.graphEdges.filter(e => {
    const sameLabel = (e.label || '相关') === label;
    if (docId) return e.docId === docId && e.to === to && sameLabel;
    if (fromCardId && toCardId) return e.fromCardId === fromCardId && e.toCardId === toCardId && sameLabel;
    return e.from === from && e.to === to && sameLabel;
  }).first();
  if (exists) return null;
  const t = now();
  const e = {
    id: uid(), from, to, fromCardId, toCardId,
    label,
    subject,
    docId,
    type,
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
  const d = plain({ ...old, ...(patch || {}), updatedAt: now() });
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
  const m = { id: uid(), title, root: plain(root), createdAt: t, updatedAt: t };
  await db.mindmaps.put(m);
  return m;
}
export async function updateMindmap(id, patch) {
  const old = await db.mindmaps.get(id);
  if (!old) throw new Error('导图不存在');
  const m = plain({ ...old, ...(patch || {}), updatedAt: now() });
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
    // data 可能是视图传入的 Vue 响应式代理（ref.value），直接 put 会触发 IndexedDB 结构化克隆失败
    data: plain(payload?.data || {}),
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
  fireHook('onExamFinished', e);
  return e;
}
export async function deleteExam(id) {
  await db.exams.delete(id);
  await db.tombstones.put({ id, kind: 'exam', deletedAt: now() }); // 墓碑：跨设备同步删除
}
export async function updateExam(id, patch) {
  const old = await db.exams.get(id);
  if (!old) throw new Error('成绩不存在');
  const e = plain({ ...old, ...(patch || {}), updatedAt: now() });
  await db.exams.put(e);
  return e;
}

// ————————————————————————————————————————————————————————————
// 新增：资产体检 / 埋点 / 最佳最坏拍档 / 隐私数据（P1·8 八项接口）
// ————————————————————————————————————————————————————————————

// 1) 僵尸卡 ID 集合（90 天到期且从未复习）
export async function zombieCardIds() {
  // 判定核心已抽至 repo-core.selectZombieIds（N9）
  const [cards, reviewed] = await Promise.all([
    db.cards.toArray(),
    db.reviews.toArray().then(rs => rs.map(r => r.cardId)),
  ]);
  return selectZombieIds(cards, reviewed, Date.now());
}

// 2) 埋点写入（同步到 telemetry A 级），返回立即 flush 的 Promise
import { trackAction, flushTelemetry } from './utils/telemetry.js';
export async function recordUserOp(type, payload = null, extra = {}) {
  trackAction(type, payload, extra);
  return flushTelemetry();
}

// 3) 查询 userOps + 分组聚合（仪表盘数据层核心）
// opts:
//   from: ms (inclusive, nullable)
//   to:   ms (inclusive, nullable)
//   groupBy: 'day' | 'hour' | 'module' | 'type' | 'category' | 'dayHour' | null(全量返回数组)
// 返回：groupBy=null → 原始数组；否则 Map(key → count) 或 数组（day/hour 有序）
export async function queryUserOps(opts = {}) {
  const { from = 0, to = Date.now(), groupBy = null } = opts;
  let arr;
  if (from > 0) {
    arr = await db.userOps.where('t').between(from, to, true, true).toArray();
  } else {
    arr = (await db.userOps.toArray()).filter(o => (o.t || 0) <= to);
  }
  if (!groupBy) return arr;
  // 分组聚合核心已抽至 repo-core.groupUserOps（N9）
  return groupUserOps(arr, groupBy);
}

// 4) 最佳 / 最坏拍档（A/B/C/D 四类 + 近期/长期 + 正/反 共 16 种组合）
// kind:
//   A = 最高频学习科目（/最冷门）
//   B = 最高频 Agent 工具调（/最少）
//   C = 最常共现知识点 pair（/最少）
//   D = 最活跃单份资产（/最不活跃僵尸单份）
// rangeDays: 7 = 近期, 90 = 长期
// worst: false=最佳, true=最坏
export async function bestWorstPartners({ rangeDays = 7, kind = 'D', worst = false }) {
  const since = Date.now() - rangeDays * 24 * 3600 * 1000;
  const ops = await db.userOps.where('t').above(since - 1).toArray();
  const dataNotEnough = { notEnough: true, title: '数据不足，继续积累', desc: `近 ${rangeDays} 天操作样本偏少，无法稳定分析。再多使用几天系统就会有结果。`, items: [] };

  // —— A：科目学习频次（基于复习评分/卡片新建）
  if (kind === 'A') {
    // 优先从 cards.reviews + card subject 取真实数据
    const reviews = (await db.reviews.where('reviewedAt').above(since - 1).toArray());
    if (reviews.length < 3) return dataNotEnough;
    const cardMap = new Map((await db.cards.bulkGet(reviews.map(r => r.cardId)).then(list => list.filter(Boolean).map(c => [c.id, c]))));
    const cnt = new Map();
    for (const r of reviews) {
      const c = cardMap.get(r.cardId); const k = c?.subject || '未分类';
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    let arr = [...cnt.entries()].map(([k,c])=>({key:k,count:c}));
    arr.sort((a,b)=>worst ? a.count-b.count : b.count-a.count);
    if (!arr.length) return dataNotEnough;
    const top = arr.slice(0, 1)[0];
    return {
      notEnough: false,
      title: (worst ? '最冷门学习科目' : '最高频学习科目') + `（近 ${rangeDays} 天）`,
      desc: `${top.key}：${top.count} 次复习`,
      items: arr.slice(0, 5),
      primary: top.key,
      suggest: worst
        ? `建议优先补短板：在「${top.key}」安排 30 分钟专项复习`
        : `优势科目「${top.key}」已形成节奏，可推进到更难章节。`,
    };
  }

  // —— B：最高频 Agent 工具（基于 userOps type=ai_call，payload.agentId）
  if (kind === 'B') {
    const calls = ops.filter(o => o.type === 'ai_call' || o.type === 'agent_tool_call');
    if (calls.length < 3) return dataNotEnough;
    const cnt = new Map();
    for (const o of calls) { const k = o.payload?.agentId || o.category || 'chat'; cnt.set(k, (cnt.get(k)||0)+1); }
    let arr = [...cnt.entries()].map(([k,c])=>({key:k,count:c}));
    arr.sort((a,b)=>worst ? a.count-b.count : b.count-a.count);
    if (!arr.length) return dataNotEnough;
    const top = arr[0];
    return {
      notEnough: false,
      title: (worst ? '最少被调 Agent 工具' : '最高频 Agent 工具') + `（近 ${rangeDays} 天）`,
      desc: `${top.key}：${top.count} 次调用`,
      items: arr.slice(0, 5),
      primary: top.key,
      suggest: worst
        ? `${top.key} 还有挖掘空间，遇到不确定的知识可尝试调用它。`
        : `${top.key} 是你的得力助手，继续保持协同节奏。`,
    };
  }

  // —— C：最常共现知识点对（基于复习连续两张卡 subject + tags + front 首字共现）
  if (kind === 'C') {
    const reviews = (await db.reviews.where('reviewedAt').above(since - 1).limit(200).reverse().toArray()).reverse();
    if (reviews.length < 8) return dataNotEnough;
    const cardIds = [...new Set(reviews.map(r => r.cardId))];
    const cardMap = new Map((await db.cards.bulkGet(cardIds).then(list => list.filter(Boolean).map(c => [c.id, c]))));
    const pairCnt = new Map();
    let prevKey = null;
    for (const r of reviews) {
      const c = cardMap.get(r.cardId); if (!c) continue;
      // 签名 = subject + (tags[0] || front 前 4 字)
      const sig = `${c.subject || '未分类'}|${(c.tags?.[0] || String(c.front||'').slice(0,4))}`;
      if (prevKey && prevKey !== sig) {
        const k = [prevKey, sig].sort().join(' ⇄ ');
        pairCnt.set(k, (pairCnt.get(k) || 0) + 1);
      }
      prevKey = sig;
    }
    if (pairCnt.size < 2) return dataNotEnough;
    let arr = [...pairCnt.entries()].map(([k,c])=>({key:k,count:c}));
    arr.sort((a,b)=>worst ? a.count-b.count : b.count-a.count);
    const top = arr[0];
    return {
      notEnough: false,
      title: (worst ? '最少共现知识对' : '最常共现知识对') + `（近 ${rangeDays} 天）`,
      desc: `${top.key}：共现 ${top.count} 次`,
      items: arr.slice(0, 5),
      primary: top.key,
      suggest: worst
        ? `${top.key} 组合联系薄弱，建议把两者放一张导图里加强关联。`
        : `${top.key} 已经形成强关联，可尝试合并为高维模型。`,
    };
  }

  // —— D：最活跃 / 最不活跃 单份资产（基于 userOps 里卡片 id 出现的次数 / 僵尸）
  if (kind === 'D') {
    // 先从 reviews + ops 聚合每卡片的活跃分
    const reviews = (await db.reviews.where('reviewedAt').above(since - 1).toArray());
    const opCards = [];
    for (const o of ops) { if (o.payload?.cardId) opCards.push(String(o.payload.cardId)); }
    const score = new Map();
    for (const r of reviews) score.set(r.cardId, (score.get(r.cardId)||0) + 3); // 复习 = 3 分
    for (const cid of opCards)  score.set(cid,    (score.get(cid)||0) + 1);       // DOM/业务提及 = 1 分
    let arr;
    if (worst) {
      // 最坏：范围时间内分数为 0 且历史总复习为 0 的僵尸卡
      const all = await db.cards.orderBy('createdAt').limit(500).toArray();
      const reviewed = new Set(reviews.map(r => r.cardId));
      const scopedZero = all.filter(c => !score.has(c.id)).map(c => ({ card: c, score: 0 }));
      const neverReviewed = scopedZero.filter(x => !reviewed.has(x.card.id));
      if (!neverReviewed.length) return dataNotEnough;
      neverReviewed.sort((a,b)=>(a.card.createdAt||0)-(b.card.createdAt||0)); // 最老在前
      const top = neverReviewed[0].card;
      arr = neverReviewed.slice(0, 10).map(x => ({
        key: String(x.card.front||'').slice(0, 30) || '（空卡）',
        count: 0,
        cardId: x.card.id,
      }));
      return {
        notEnough: false,
        title: `最不活跃的僵尸单份资产（近 ${rangeDays} 天）`,
        desc: `${String(top.front||'').slice(0,50) || '（空卡）'} · 创建于 ${new Date(top.createdAt||0).toLocaleDateString()} · 从未复习`,
        items: arr,
        primary: String(top.front||'').slice(0, 40),
        cardId: top.id,
        suggest: '建议今天就把它加入复习队列，把僵尸资产唤醒。',
      };
    }
    // 最佳：score 最高
    if (score.size < 5) return dataNotEnough;
    arr = [...score.entries()].map(([k,c])=>({cardId:String(k),count:c}));
    arr.sort((a,b)=>b.count-a.count);
    // 取 top10，把卡片信息补全
    const ids = arr.slice(0, 10).map(x => x.cardId);
    const cards = await db.cards.bulkGet(ids);
    const cardOf = new Map();
    for (const c of cards) if (c) cardOf.set(c.id, c);
    const items = arr.slice(0, 10).map(x => ({
      key: String(cardOf.get(x.cardId)?.front || x.cardId).slice(0, 40),
      count: x.count,
      cardId: x.cardId,
    }));
    const top = items[0];
    return {
      notEnough: false,
      title: `最活跃单份资产「最佳拍档」（近 ${rangeDays} 天）`,
      desc: `${top.key} · 互动分数 ${top.count}`,
      items,
      primary: top.key,
      cardId: top.cardId,
      suggest: `它是你近期最常用的知识点，考虑围绕它构建一张导图，把网络效应放大。`,
    };
  }
  return dataNotEnough;
}

// 5) 隐私数据 CRUD（B 档超级详尽结构化）
export async function savePrivacyRecord(record) {
  const nowTs = Date.now();
  let payload;
  if (record?.id) {
    const old = await db.privacyRecords.get(record.id);
    payload = plain({
      ...(old || {}),
      ...record,
      updatedAt: nowTs,
    });
  } else {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const today = new Date();
    const p = n => String(n).padStart(2, '0');
    const dateKey = record?.date || `${today.getFullYear()}-${p(today.getMonth()+1)}-${p(today.getDate())}`;
    payload = plain({
      id,
      date: dateKey,
      startTime: record?.startTime ?? nowTs,
      endTime: record?.endTime ?? nowTs,
      type: record?.type || 'other',
      subType: record?.subType || '',
      location: record?.location || '',
      people: Array.isArray(record?.people) ? record.people : [],
      mood: Number(record?.mood) || 3,
      energy: Number(record?.energy) || 3,
      focus: Number(record?.focus) || 3,
      pleasure: Number(record?.pleasure) || 3,
      stress: Number(record?.stress) || 3,
      painIndex: Number(record?.painIndex) || 0,
      painParts: Array.isArray(record?.painParts) ? record.painParts : [],
      sleepBlock: record?.sleepBlock || null,
      eatBlock: record?.eatBlock || null,
      moveBlock: record?.moveBlock || null,
      learnBlock: record?.learnBlock || null,
      workBlock: record?.workBlock || null,
      screenBlock: record?.screenBlock || null,
      financeBlock: record?.financeBlock || null,
      mental: record?.mental || '',
      customTags: Array.isArray(record?.customTags) ? record.customTags : [],
      customKV: record?.customKV || {},
      createdAt: old?.createdAt || nowTs,
      updatedAt: nowTs,
    });
  }
  await db.privacyRecords.put(payload);
  return payload;
}
export async function listPrivacyRecords({ fromDate, toDate, type, limit = 500 } = {}) {
  let arr = await db.privacyRecords.orderBy('updatedAt').reverse().limit(limit).toArray();
  if (fromDate) arr = arr.filter(r => (r.date || '') >= fromDate);
  if (toDate)   arr = arr.filter(r => (r.date || '') <= toDate);
  if (type)     arr = arr.filter(r => r.type === type);
  return arr;
}
export async function getPrivacyRecord(id) { return (await db.privacyRecords.get(id)) || null; }
export async function deletePrivacyRecord(id) {
  await db.privacyRecords.delete(id);
  await db.tombstones.put({ id, kind: 'privacy', deletedAt: Date.now() });
}

// 6) 隐私人物画像报告（启发式本地算法 + 可选 AI 增强）
// 返回 { physical, behavioral, mental, prediction } 四大块文字
export async function privacyPersonaReport({ rangeDays = 7, includeUserOps = true } = {}) {
  const since = Date.now() - rangeDays * 24 * 3600 * 1000;
  const records = (await db.privacyRecords.toArray()).filter(r => (r.updatedAt || 0) >= since);
  const N = records.length;
  const lines = [];
  lines.push(`【画像周期】近 ${rangeDays} 天，共 ${N} 条隐私记录。${includeUserOps ? '已叠加系统真实操作埋点。' : ''}`);

  // 物理画像：睡眠趋势 / 能量潮汐 / 饮食风险 / 疼痛高发
  const sleepHrs = records.map(r => r.sleepBlock?.hours).filter(v => Number.isFinite(v));
  const avgSleep = sleepHrs.length ? sleepHrs.reduce((a,b)=>a+b,0)/sleepHrs.length : null;
  const mood = records.map(r => Number(r.mood)||0).filter(v=>v>0);
  const avgMood = mood.length ? mood.reduce((a,b)=>a+b,0)/mood.length : null;
  const energy = records.map(r => Number(r.energy)||0).filter(v=>v>0);
  const avgEnergy = energy.length ? energy.reduce((a,b)=>a+b,0)/energy.length : null;
  const stress = records.map(r => Number(r.stress)||0).filter(v=>v>0);
  const avgStress = stress.length ? stress.reduce((a,b)=>a+b,0)/stress.length : null;

  const physical = [];
  if (avgSleep !== null) physical.push(`平均睡眠 ${avgSleep.toFixed(1)}h${avgSleep < 6.5 ? ' ⚠ 偏少，长期缺觉会显著削弱记忆巩固与判断力。' : avgSleep > 8.5 ? '，睡眠充足，是学习效率的基础。' : '，在健康区间。'}`);
  const caffMg = records.reduce((s,r)=>s + (Number(r.eatBlock?.caffeineMg)||0), 0);
  if (caffMg > 0) physical.push(`周期咖啡因摄入 ${Math.round(caffMg)}mg${caffMg / rangeDays > 300 ? ' ⚠ 日均超 300mg，会影响深睡结构，建议减半。' : '。'}`);
  const painScores = records.map(r => Number(r.painIndex)||0).filter(v=>v>0);
  if (painScores.length) {
    const allParts = new Map();
    for (const r of records) for (const p of (r.painParts||[])) allParts.set(p,(allParts.get(p)||0)+1);
    const topPart = [...allParts.entries()].sort((a,b)=>b[1]-a[1])[0];
    physical.push(`躯体疼痛发作 ${painScores.length} 天，高发部位：${topPart ? topPart[0] : '无'}，建议安排放松或就医。`);
  }
  if (!physical.length) physical.push('（周期内暂无完整睡眠/饮食指标，建议在隐私模块补录。）');

  // 行为画像：科目强弱 / 注意力黄金时段 / 休息缺口（融合 userOps）
  const behavioral = [];
  if (includeUserOps) {
    const ops = await db.userOps.where('t').above(since - 1).toArray();
    const reviews = ops.filter(o => o.type === 'review_rate');
    if (reviews.length) {
      const hrs = new Map();
      for (const o of reviews) { const h = new Date(o.t).getHours(); hrs.set(h,(hrs.get(h)||0)+1); }
      const topH = [...hrs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([h,c])=>`${String(h).padStart(2,'0')}点(${c}次)`).join('、');
      behavioral.push(`复习时段热力峰值：${topH}。建议把最难的知识点安排在黄金时段。`);
    } else { behavioral.push('周期内暂无复习记录，难以锁定注意力黄金时段。'); }
    // 连续高强度：看日期序列是否出现 7 天全勤但 avgEnergy < 3
    const daySet = new Set(ops.map(o=>new Date(o.t).toDateString()));
    if (daySet.size >= rangeDays * 0.8 && avgEnergy !== null && avgEnergy < 3) {
      behavioral.push('⚠ 出现连续高强度周期但能量分偏低，存在疲劳缺口。建议明天安排一次主动休息。');
    }
  } else {
    behavioral.push('（未融合系统操作，打开 includeUserOps 可得更准确行为画像。）');
  }

  // 情绪/精神画像：高频情绪词 + 压力趋势
  const mental = [];
  if (avgMood !== null) mental.push(`平均心情：${avgMood.toFixed(1)} / 5 ${avgMood>=4?'（非常棒，继续保持）':avgMood<=2.5?'⚠ 偏低，建议安排社交/运动/复盘支持':'（稳定）'}`);
  if (avgStress !== null) mental.push(`平均压力：${avgStress.toFixed(1)} / 5 ${avgStress>=4?'⚠ 偏高，建议冥想或减少承诺。':avgStress<=2?'（松弛，适合攻坚）':'（适度）'}`);
  // 精神心得词频（去停用词后取前 6 高频 2+ 字词，不依赖第三方库，简化做）
  const mentStr = records.map(r => r.mental || '').join('\n');
  if (mentStr.length > 20) {
    const stop = new Set(['的','了','和','是','我','也','就','在','都','有','这','不','你','他','她','一','个','很','上','下','会','要','去','把','还','没','吗','呢','啊','吧']);
    const grams = new Map();
    for (let i = 0; i < mentStr.length - 1; i++) {
      const s = mentStr.slice(i, i+2);
      if (/[\u4e00-\u9fa5]{2}/.test(s) && !stop.has(s[0]) && !stop.has(s[1])) grams.set(s, (grams.get(s)||0)+1);
    }
    const top = [...grams.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k])=>k);
    if (top.length) mental.push(`精神高频词：${top.join(' · ')}。`);
  }
  if (!mental.length) mental.push('（周期内暂无心情/心得记录，建议在「精神」块补日记。）');

  // 下一步预测 + 调节建议（纯文字报告，不改系统任何参数，完全实验室）
  const pred = [];
  if (avgSleep !== null && avgSleep < 6.5) {
    pred.push('🌙 睡眠预测：若未来 48 小时仍低于 6.5h，次日「记住了」自评率预计下降 15~22%，「没记住」比例上升。建议今晚 23:30 前入睡。');
  }
  if (avgEnergy !== null && avgEnergy < 2.8) {
    pred.push('🔋 能量预测：当前能量分偏低，明日专注深度任务（费曼/模考）的容错空间小。建议先完成 20 分钟轻度整理/标签补全类任务积累状态。');
  }
  if (avgStress !== null && avgStress >= 4) {
    pred.push('🧘 压力预测：压力分持续偏高，接下来 3 天遗忘曲线更陡，薄弱卡复习失败率上升。建议插入 1 场 25 分钟番茄+5 分钟冥想缓冲。');
  }
  if (caffMg / rangeDays > 300) {
    pred.push('☕ 咖啡因预测：高咖啡因 + 睡眠不足的组合会制造「假能量」，真实学习产出反而下降。建议用散步/冷水脸替代下午提神咖啡。');
  }
  if (!pred.length) pred.push('📈 综合预测：周期数据整体健康。继续保持现有节奏的同时，可尝试把复习间隔 +10%（SRS ease 加成），进一步压缩总复习时长。');

  return {
    physical: physical.join('\n'),
    behavioral: behavioral.join('\n'),
    mental: mental.join('\n'),
    prediction: pred.join('\n'),
    stats: { N, rangeDays, avgSleep, avgMood, avgEnergy, avgStress },
  };
}