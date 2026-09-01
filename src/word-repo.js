// src/word-repo.js
// 英语单词模块数据访问层（独立表，与记忆卡 repo.js 物理隔离）
//
// 设计要点：
//   - 复习调度**复用**记忆卡的底层算法：scheduleReview（SM-2/FSRS 自动切换）
//     + getSchedConfig 读取用户 FSRS 权重，保证单词与记忆卡同一套记忆曲线。
//   - 单词卡字段形状与 cards 兼容（ease/level/intervalDays/dueAt/fsrs/consolidation/
//     reviewedAt），因此 scheduleReview 可直接消费，无需重写调度逻辑。
//   - 熟词(familiar=1) 与范文(template) 不进默认复习队列：
//       · familiar 是用户主动标记「已掌握」，移出队列但保留检索/导出；
//       · template 是范文模板，无 SRS 语义，仅存储+收藏+导出。
//   - 删除走「回收站快照 + 墓碑」双写，与 deleteCard 一致，确保跨设备删除生效。
import { db, uid } from './db.js';
// 复用记忆卡调度器（SM-2/FSRS 自动切换）与权重配置：避免两套调度逻辑漂移
import { scheduleReview } from './srs.js';
import { getSchedConfig, refreshSchedConfig, formatDue, trashItem } from './repo.js';
import { retrievability } from './fsrs.js';
import { retrievalGrading } from './algorithms/session.js';
// round17 R17-11：日期 key 统一走 time.dateKey（补零）——与 streak.js 同源，杜绝两套格式
import { dateKey } from './utils/time.js';

const now = () => Date.now();
// 剥离 Vue 响应式代理：Dexie put 前转纯对象，避免 reactive proxy 触发结构化克隆失败
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---------- 常量 ----------
export const WORD_KINDS = ['word', 'phrase', 'sentence', 'template'];
// 参与 SRS 复习的 kind（template 范文不参与）
export const SCHEDULABLE_KINDS = ['word', 'phrase', 'sentence'];

// ---------- 复习调度（复用底层算法） ----------
export async function reviewWord(cardId, rating, opts = {}) {
  const card = await db.wordCards.get(cardId);
  if (!card) throw new Error('单词卡不存在');
  if (card.kind === 'template') {
    // 范文不参与调度：仅记录一次浏览（reviewedAt bump），不重排 dueAt。
    // round15 P1：不 bump updatedAt（与下方普通复习路径一致）——浏览范文是「复习动作」，
    // bump 会让跨设备同步用旧副本覆盖对端对范文的编辑。
    const t = now();
    await db.transaction('rw', db.wordCards, async () => {
      await db.wordCards.put({ ...plain(card), reviewedAt: t });
    });
    return { skipped: true, dueText: '—', reviewId: null };
  }
  const cfg = await getSchedConfig();
  const next = scheduleReview(card, rating, 1, false, {
    scheduler: cfg.scheduler,
    weights: cfg.weights,
    desiredRetention: opts.desiredRetention,
    // round16 R16-3：检索强度信号透传——采集(WordReview)/落库(wordReviews 字段)/同步(manifest)
    // 三段早已打通，唯独这最后一段断：不传的话单词侧 SRS 间隔永远享受不到
    // generate(×1.25)/explain(×1.5) 乘子（卡片侧 repo.review 早已透传，此处对齐）
    retrievalStrength: opts.retrievalStrength,
  });
  const nowTs = now();
  const predR = (card.fsrs && Number.isFinite(card.fsrs.s) && Number.isFinite(card.fsrs.last))
    ? Number(retrievability(card.fsrs.s, (nowTs - card.fsrs.last) / 86400000).toFixed(4))
    : null;
  // P2-C 口径对齐（round13）：与 repo.review 同用 retrievalGrading 定级
  // （failed/hard/medium/easy 四档 + gradeScore 0-1 + guessed/responseMs/retrievalStrength 信号），
  // 替换原单维三档（easy/hard/failed）。旧数据无 'medium'，与四档无冲突，读取无需迁移。
  const g = retrievalGrading({
    rating,
    guessed: !!opts.guessed,
    responseMs: opts.responseMs || 0,
    retrievalStrength: opts.retrievalStrength || '',
  });
  const grade = g.level;
  const reviewId = uid();
  // 复习只更新 SRS 字段与 reviewedAt，不 bump updatedAt（与 repo.review 一致：
  // 否则跨设备同步时「复习动作」会覆盖另一台设备对文字/批注的编辑）
  await db.transaction('rw', db.wordCards, db.wordReviews, async () => {
    // round17 R17-6：SM-2 路径同样推进 fsrs.last（与 repo.review 对齐）——
    // 否则切回 FSRS 时 elapsedDays 横跨整个 SM-2 期，间隔异常放大
    const fsrsNext = next.fsrs ?? (card.fsrs ? { ...card.fsrs, last: nowTs } : undefined);
    await db.wordCards.put({
      ...plain(card),
      ease: next.ease, level: next.level, intervalDays: next.intervalDays,
      dueAt: next.dueAt, consolidation: next.consolidation,
      fsrs: fsrsNext, reviewedAt: nowTs,
    });
    await db.wordReviews.put({
      id: reviewId, cardId, reviewedAt: nowTs, rating,
      predR, levelAfter: next.level, grade,
      gradeScore: g.score,
      guessed: !!opts.guessed,
      responseMs: opts.responseMs || 0,
      retrievalStrength: opts.retrievalStrength || '',
    });
  });
  return { ...next, dueText: formatDue(next.dueAt), reviewId };
}

// 错题反思（落盘到复习记录，跨设备按 selfExplainAt 字段级合并）
export async function attachWordSelfExplanation(reviewId, text) {
  const r = await db.wordReviews.get(reviewId);
  if (!r) return null;
  const selfExplanation = String(text || '').trim().slice(0, 500);
  await db.wordReviews.put({ ...r, selfExplanation, selfExplainAt: Date.now() });
  return true;
}

// ---------- 单词卡 CRUD ----------
// v26 扩展字段（非索引，按对象属性存；AI 生成填充）
//   pos(词性) / defs(多义项[{pos,meaning}]) / synonyms / collocations / phrases /
//   examples(例句[{level,sentence,translation}]) / mnemonics(助记) /
//   rootAffix(词根词缀) / confusions(混淆项[{word,meaning}]) / syllable(音节) / audio(自定义音频)
const EXT_FIELDS = [
  'pos', 'defs', 'synonyms', 'collocations', 'phrases', 'examples',
  'mnemonics', 'rootAffix', 'confusions', 'syllable', 'audio',
];
function pickExt(payload) {
  const out = {};
  for (const k of EXT_FIELDS) {
    if (payload[k] !== undefined) out[k] = payload[k];
  }
  return out;
}

export async function createWordCard(payload = {}) {
  const kind = WORD_KINDS.includes(payload.kind) ? payload.kind : 'word';
  const t = now();
  const card = {
    id: uid(),
    kind,
    word: String(payload.word || '').trim(),
    phonetic: String(payload.phonetic || '').trim(),
    meaning: String(payload.meaning || '').trim(),
    example: String(payload.example || '').trim(),
    exampleTrans: String(payload.exampleTrans || '').trim(),
    note: String(payload.note || '').trim(),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String).filter(Boolean) : [],
    source: String(payload.source || '').trim(),
    subject: String(payload.subject || '').trim(),
    familiar: 0,
    ...pickExt(payload),
    // SRS 初始状态：新卡立即到期（进入当日复习队列）
    ease: 2.5, level: 0, intervalDays: 0, dueAt: t,
    reviewedAt: 0, consolidation: null, fsrs: null,
    createdAt: t, updatedAt: t,
  };
  if (!card.word) throw new Error('单词/内容不能为空');
  await db.wordCards.put(card);
  return card;
}

export async function updateWordCard(id, patch = {}) {
  const cur = await db.wordCards.get(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of ['word', 'phonetic', 'meaning', 'example', 'exampleTrans', 'note', 'source', 'subject']) {
    if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
  }
  if (patch.kind !== undefined && WORD_KINDS.includes(patch.kind)) next.kind = patch.kind;
  if (patch.tags !== undefined && Array.isArray(patch.tags)) {
    next.tags = patch.tags.map(String).filter(Boolean);
  }
  // v26 扩展字段：整体覆盖（AI 生成结果或手动编辑的数组/对象）
  for (const k of EXT_FIELDS) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (!next.word) throw new Error('单词/内容不能为空');
  next.updatedAt = now();
  await db.wordCards.put(next);
  return next;
}

// 删除单词卡：回收站快照 + 墓碑（跨设备删除同步）+ 删卡 + 删复习记录 + 删词组关联
export async function deleteWordCard(id) {
  const old = await db.wordCards.get(id);
  if (!old) return false;
  const imgIds = []; // 单词模块无图片字段，占位以对齐 deleteCard 流程
  await db.transaction('rw', db.wordCards, db.trash, db.tombstones, db.wordReviews, db.wordGroupLinks, async () => {
    const reviews = await db.wordReviews.where('cardId').equals(id).toArray();
    const links = await db.wordGroupLinks.where('cardId').equals(id).toArray();
    await trashItem(id, 'wordCard', { ...plain(old), _reviews: reviews, _groupLinks: links });
    await db.tombstones.put({ id, kind: 'wordCard', deletedAt: now() });
    // round15 P1：wordReviews 是 idOnly 幂等表——本端删除行不写墓碑的话，
    // 对端残留的复习记录会随每次增量包反复回传（孤儿行常驻 + 统计污染）。
    if (reviews.length) {
      await db.tombstones.bulkPut(reviews.map(r => ({ id: r.id, kind: 'wordReview', deletedAt: now() })));
    }
    if (links.length) {
      await db.tombstones.bulkPut(links.map(l => ({ id: l.id, kind: 'wordGroupLink', deletedAt: now() })));
    }
    await db.wordCards.delete(id);
    await db.wordReviews.where('cardId').equals(id).delete();
    await db.wordGroupLinks.where('cardId').equals(id).delete();
  });
  return true;
}

// ---------- 熟词标记 / 批注 ----------
// 标记熟词：移出默认复习队列（dueAt 推到一年外），但不删除，可检索/导出
export async function markFamiliar(id, value = 1) {
  const cur = await db.wordCards.get(id);
  if (!cur) return null;
  const v = value ? 1 : 0;
  const patch = { familiar: v, updatedAt: now() };
  if (v === 1) patch.dueAt = now() + 365 * 86400000; // 熟词一年后到期（等于移出活跃队列）
  else patch.dueAt = now(); // 取消熟词：立即重新进入复习队列
  await db.wordCards.put({ ...cur, ...patch });
  return { ...cur, ...patch };
}

// 设置批注（note 字段，updatedAt 跟踪；跨设备按 updatedAt 合并）
export async function setWordNote(id, text) {
  const cur = await db.wordCards.get(id);
  if (!cur) return null;
  const note = String(text || '').slice(0, 2000);
  await db.wordCards.put({ ...cur, note, updatedAt: now() });
  return { ...cur, note, updatedAt: now() };
}

// ---------- 词组（多对多，仿卡组） ----------
export async function listWordGroups() {
  return db.wordGroups.orderBy('sortOrder').toArray();
}

export async function createWordGroup(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('词组名称不能为空');
  const t = now();
  const g = {
    id: uid(),
    name,
    description: String(payload.description || '').trim(),
    color: payload.color || '#4f7cff',
    status: payload.status === 'archived' ? 'archived' : 'active',
    sortOrder: Number(payload.sortOrder) || 0,
    createdAt: t, updatedAt: t,
  };
  await db.wordGroups.put(g);
  return g;
}

export async function updateWordGroup(id, patch = {}) {
  const cur = await db.wordGroups.get(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of ['name', 'description', 'color', 'status']) {
    if (patch[k] !== undefined) next[k] = k === 'name' ? String(patch[k]).trim() : patch[k];
  }
  if (patch.sortOrder !== undefined) next.sortOrder = Number(patch.sortOrder) || 0;
  if (!next.name) throw new Error('词组名称不能为空');
  next.updatedAt = now();
  await db.wordGroups.put(next);
  return next;
}

export async function deleteWordGroup(id) {
  const g = await db.wordGroups.get(id);
  if (!g) return false;
  await db.transaction('rw', db.wordGroups, db.wordGroupLinks, db.tombstones, db.trash, async () => {
    const links = await db.wordGroupLinks.where('groupId').equals(id).toArray();
    // P1-A：词组删除也写回收站快照（含成员关联），否则回收站永远无法恢复词组
    await trashItem(id, 'wordGroup', { ...plain(g), _groupLinks: links });
    await db.wordGroupLinks.where('groupId').equals(id).delete();
    await db.wordGroups.delete(id);
    await db.tombstones.put({ id, kind: 'wordGroup', deletedAt: now() });
    if (links.length) {
      await db.tombstones.bulkPut(links.map(l => ({ id: l.id, kind: 'wordGroupLink', deletedAt: now() })));
    }
  });
  return true;
}

// 某词组内的单词卡 id
export async function wordGroupCardIds(groupId) {
  const links = await db.wordGroupLinks.where('groupId').equals(groupId).toArray();
  return links.map(l => l.cardId);
}

// 某单词卡所属词组
export async function wordGroupsOfCard(cardId) {
  const links = await db.wordGroupLinks.where('cardId').equals(cardId).toArray();
  const groups = await db.wordGroups.bulkGet(links.map(l => l.groupId));
  return groups.filter(Boolean);
}

// 批量把单词卡移入/移出词组（幂等移入；移出写墓碑）
export async function setWordGroups(cardIds, addGroupIds = [], removeGroupIds = []) {
  const t0 = Date.now();
  let added = 0, removed = 0;
  await db.transaction('rw', db.wordCards, db.wordGroups, db.wordGroupLinks, db.tombstones, async () => {
    const cards = cardIds && cardIds.length ? await db.wordCards.bulkGet(cardIds) : [];
    const validIds = cards.filter(Boolean).map(c => c.id);
    const validAdd = new Set((await db.wordGroups.bulkGet(addGroupIds || [])).filter(Boolean).map(g => g.id));
    const validRemove = new Set((await db.wordGroups.bulkGet(removeGroupIds || [])).filter(Boolean).map(g => g.id));
    if (validAdd.size) {
      const existing = await db.wordGroupLinks.where('groupId').anyOf([...validAdd]).toArray();
      const existSet = new Set(existing.map(l => `${l.cardId}|${l.groupId}`));
      const toAdd = [];
      for (const cid of validIds) for (const gid of validAdd) {
        if (!existSet.has(`${cid}|${gid}`)) {
          toAdd.push({ id: uid(), cardId: cid, groupId: gid, addedAt: t0 });
          existSet.add(`${cid}|${gid}`);
        }
      }
      if (toAdd.length) { added = toAdd.length; await db.wordGroupLinks.bulkAdd(toAdd); }
    }
    if (validRemove.size) {
      const toDel = await db.wordGroupLinks.where('cardId').anyOf(validIds).toArray();
      const gone = toDel.filter(l => validRemove.has(l.groupId));
      if (gone.length) {
        removed = gone.length;
        await db.wordGroupLinks.bulkDelete(gone.map(l => l.id));
        await db.tombstones.bulkPut(gone.map(l => ({ id: l.id, kind: 'wordGroupLink', deletedAt: t0 })));
      }
    }
  });
  return { added, removed };
}

// ---------- 列表 / 筛选 / 统计 ----------
/**
 * 列出单词卡（支持筛选）
 * @param {object} filter { kind?, familiar?, groupId?, q?, reviewedOnly?, schedulableOnly? }
 *   - kind：'word'|'phrase'|'sentence'|'template' 单选
 *   - familiar：1/0 熟词筛选
 *   - groupId：仅某词组内
 *   - q：关键字（word/meaning/phonetic/note 模糊）
 *   - reviewedOnly：true=只显示已背（reviewedAt>0）；false=只显示未背；不传=全部
 *   - schedulableOnly：true=排除 template（不参与 SRS）
 */
export async function listWordCards(filter = {}) {
  let rows = await db.wordCards.toArray();
  const q = String(filter.q || '').trim().toLowerCase();
  if (filter.kind) rows = rows.filter(r => r.kind === filter.kind);
  if (filter.familiar !== undefined && filter.familiar !== null) {
    rows = rows.filter(r => (r.familiar ? 1 : 0) === (Number(filter.familiar) ? 1 : 0));
  }
  if (filter.schedulableOnly) rows = rows.filter(r => SCHEDULABLE_KINDS.includes(r.kind));
  if (filter.reviewedOnly === true) rows = rows.filter(r => r.reviewedAt > 0);
  if (filter.reviewedOnly === false) rows = rows.filter(r => !r.reviewedAt);
  if (filter.groupId) {
    const ids = new Set(await wordGroupCardIds(filter.groupId));
    rows = rows.filter(r => ids.has(r.id));
  }
  if (q) {
    rows = rows.filter(r =>
      (r.word || '').toLowerCase().includes(q) ||
      (r.meaning || '').toLowerCase().includes(q) ||
      (r.phonetic || '').toLowerCase().includes(q) ||
      (r.note || '').toLowerCase().includes(q) ||
      (r.example || '').toLowerCase().includes(q));
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows;
}

// 复习队列：参与 SRS 且未标记为熟词且已到期（含从未复习的新卡）
export async function dueWordCards(opts = {}) {
  let rows = await db.wordCards.toArray();
  const t = now();
  rows = rows.filter(r =>
    SCHEDULABLE_KINDS.includes(r.kind) &&
    !r.familiar &&
    (r.dueAt || 0) <= t);
  if (opts.kind) rows = rows.filter(r => r.kind === opts.kind);
  if (opts.groupId) {
    const ids = new Set(await wordGroupCardIds(opts.groupId));
    rows = rows.filter(r => ids.has(r.id));
  }
  // 新卡（从未复习）优先，其次按到期时间升序
  rows.sort((a, b) => {
    const an = a.reviewedAt ? 0 : 1, bn = b.reviewedAt ? 0 : 1;
    if (an !== bn) return bn - an;
    return (a.dueAt || 0) - (b.dueAt || 0);
  });
  return rows;
}

// 统计：待复习 / 已掌握 / 今日新学 / 熟词 / 总数 / 范文数
export async function wordStats() {
  const rows = await db.wordCards.toArray();
  const t = now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  let due = 0, mastered = 0, newToday = 0, familiar = 0, templates = 0;
  for (const r of rows) {
    if (r.kind === 'template') { templates++; continue; }
    if (r.familiar) { familiar++; continue; }
    if ((r.createdAt || 0) >= dayStart) newToday++;
    if ((r.dueAt || 0) <= t) due++;
    // N-8（审计口径说明）：mastered 用 level>=4 || intervalDays>=21 双条件。
    //   FSRS 路径 level 封顶 4（需 S≥15 天）；SM-2 路径 level 无上限——两套调度器
    //   「已掌握」的实际门槛不同（FSRS 更严）。UI 统计口径可接受，但跨模块对比
    //   （如 P2-B union 视图的成就/周报）需知晓此差异。
    if (r.level >= 4 || (r.intervalDays || 0) >= 21) mastered++;
  }
  return {
    total: rows.length,
    due, mastered, newToday, familiar, templates,
    schedulable: rows.length - templates,
  };
}

// 复习历史（已背查看）：按时间倒序
export async function wordReviewHistory(limit = 200) {
  const rows = await db.wordReviews.orderBy('reviewedAt').reverse().limit(limit).toArray();
  const cards = await db.wordCards.bulkGet(rows.map(r => r.cardId));
  const byId = new Map(cards.filter(Boolean).map(c => [c.id, c]));
  return rows.map(r => ({ ...r, card: byId.get(r.cardId) || null }));
}

// 今日已背次数 / 累计复习次数（学习统计页用）
export async function wordReviewedToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = await db.wordReviews.where('reviewedAt').aboveOrEqual(start.getTime()).toArray();
  return rows.length;
}
export async function wordReviewedTotal() {
  return db.wordReviews.count();
}

// ---------- 设置（wordSettings：单行 id='me'） ----------
// v26 字段：accent(发音口音) / learnPace / recallPace / spellHint(拼写提示) /
//   exampleLevels(默认生成难度) / aiEnabled(自动生成开关) / llmProvider / llmModel /
//   llmApiKey(本地，不同步) / llmBase / mnemonicOrder(助记顺序) / splitMnemonic(拆分助记) /
//   confusion(混淆项辨析) / aiFallback(回退策略) / dailyGoal(每日新学量)
const WORD_SETTINGS_DEFAULT = {
  id: 'me',
  accent: 'en-US',          // 发音口音：en-US / en-GB / auto
  learnPace: 'normal',      // 学习节奏：slow/normal/fast
  recallPace: 'normal',     // 复习节奏
  spellHint: true,          // 拼写提示（默写时显示首字母/长度）
  exampleLevels: ['simple', 'long', 'en1', 'en2'], // 默认生成例句难度
  aiEnabled: true,          // AI 自动生成开关
  llmProvider: '',          // doubao/deepseek/openai
  llmModel: '',
  llmApiKey: '',            // 本地凭证，不同步
  llmBase: '',
  mnemonicOrder: 'auto',    // 助记顺序：auto/pos-first/example-first
  splitMnemonic: false,     // 拆分助记（按音节/词根拆）
  confusion: true,          // 混淆项辨析
  aiFallback: 'template',   // AI 失败回退：template(本地模板)/silent(静默)
  dailyGoal: 20,            // 每日新学目标
  updatedAt: 0,
};

export async function getWordSettings() {
  const row = await db.wordSettings.get('me');
  return { ...WORD_SETTINGS_DEFAULT, ...(row || {}) };
}

export async function saveWordSettings(patch = {}) {
  const cur = await getWordSettings();
  const next = { ...cur, ...patch, id: 'me', updatedAt: now() };
  await db.wordSettings.put(next);
  return next;
}

// ---------- 每日签到（wordCheckins：id=`c-${date}`，date=YYYY-MM-DD） ----------
// round17 R17-11：委托给 time.dateKey（同一实现，杜绝与 streak.js 的两套格式漂移）
export function todayStr(d = new Date()) {
  return dateKey(d.getTime());
}

export async function checkInToday() {
  const date = todayStr();
  const id = `c-${date}`;
  const existing = await db.wordCheckins.get(id);
  if (existing) return { done: true, streak: await wordCheckinStreak(), date };
  const streak = await wordCheckinStreak();
  const rec = { id, date, count: streak + 1, createdAt: now() };
  await db.wordCheckins.put(rec);
  return { done: false, streak: rec.count, date, isNew: true };
}

// 当前连续签到天数（从今天往前数；今天未签则从昨天往前数）
export async function wordCheckinStreak() {
  const all = await db.wordCheckins.toArray();
  const set = new Set(all.map(r => r.date));
  let streak = 0;
  const d = new Date();
  // 若今天未签，从昨天起算
  if (!set.has(todayStr(d))) d.setDate(d.getDate() - 1);
  while (set.has(todayStr(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// 签到日历数据：返回最近 N 天（默认 35，5 周）的 {date, checked} 数组（含今日）
export async function wordCheckinCalendar(days = 35) {
  const all = await db.wordCheckins.toArray();
  const set = new Set(all.map(r => r.date));
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const date = todayStr(d);
    out.push({ date, checked: set.has(date), weekday: d.getDay() });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ---------- 大纲词表元信息（wordSyllabusMeta：单行 id='kaoyan2027'，仅展示用） ----------
export async function saveSyllabusMetaRow(meta = {}) {
  const row = { id: 'kaoyan2027', ...meta, loadedAt: now() };
  await db.wordSyllabusMeta.put(row);
  return row;
}
export async function getSyllabusMetaRow() {
  return db.wordSyllabusMeta.get('kaoyan2027');
}
