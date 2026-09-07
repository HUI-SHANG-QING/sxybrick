// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid } from './db.js';
import { computeNext, applyFeedback, scheduleReview, seedFsrsFromSm2, RETRIEVAL_STRENGTH_OPTIONS } from './srs.js';
// P3-4 插件事件钩子：业务动作后向已启用插件分发（fire-and-forget，不阻塞也不抛错）
// 静态导入无循环依赖：plugins/registry 只依赖 db.js 与 agent/registry.js，不依赖 repo.js
import { triggerHook } from './plugins/registry.js';
// P1-3 检索强度分级选项：供 Review.vue 等 UI 直接渲染选择器
export { RETRIEVAL_STRENGTH_OPTIONS };
import { mergeUserWeights, retrievability } from './fsrs.js';
import { extractImageIds } from './images.js';
import { initialStabilityForCard } from './algorithms/pretest.js';
import { buildReviewSession, retrievalGrading } from './algorithms/session.js';
// D3.1 笔记解析纯函数（双向链接 + 标签抽取 + 归一化）
import { normalizeNotePayload, validateNote, recognizeWikiLinks } from './utils/note-parser.js';
// P1-18 统一格式化（日期补零 / 字节）收口到 format.js，消除全局重复实现
import { pad2 } from './utils/format.js';
// 审计 D7：日期 key 统一走 time.dateKey（补零 yyyy-MM-dd），与 word/streak 同源，
// 否则 repo 本地一份 localDateStr 独立实现会在未来格式演进时跨表整日错位。
import { dateKey as createDateKey } from './utils/time.js';
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
  dayWindowOf,
} from './repo-core.js';

export { DEFAULT_SUBJECTS };
export const validateCard = _validateCard;
export const gradeCard = _gradeCard;
export const WRONG_REASON_MAP = _WRONG_REASON_MAP;
export const WRONG_REASONS = _WRONG_REASONS;
export const wrongReasonToCode = _wrongReasonToCode;
export const formatDue = (ts) => _formatDue(ts);


// 审计 C1/C4：跨设备时钟与同毫秒覆盖主要通过「确定性决胜 + 严格比较」在 sync-manifest
// 的纯合并函数里根治（mergeCardPair/mergeTombstones 已改 `>` + 字典序收敛）。
// 此处 now() 保持墙钟即可——在整进程内混用「单调时钟」与多处裸 Date.now() 会破坏
// deleteCard/restoreFromTrash 等既有「updatedAt 必须晚于墓碑」的不变量，得不偿失。
// 完整跨设备时钟偏置免疫需 per-epoch（ts,uuid）元组，属更大改造，未在此次混入。
const now = () => Date.now();

// P3-4 插件钩子触发：fire-and-forget（插件抛错/慢执行绝不影响主流程）
function fireHook(event, ...args) {
  triggerHook(event, ...args).catch(() => {});
}

// P1-1 FSRS 调度配置缓存：避免每次复习都查 db.meta（scheduler/fsrsWeights）
let _schedCache = null;
export async function getSchedConfig() {
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

/**
 * 审计 B10：切换调度器（SM-2 ↔ FSRS）的唯一入口——改标记 + 显式迁移存量状态。
 *
 * 此前切换只写 meta 标记，存量卡无任何迁移：
 *   sm2→fsrs：card.fsrs 为空 → 首审按 S0 冷启动，SM-2 积累的间隔/熟练度全部丢弃（断崖）
 *   fsrs→sm2：level/ease 是 FSRS 路径持续维护的派生值，天然连续（无需动作）
 * 迁移只写 fsrs 字段（seedFsrsFromSm2），不碰 reviewedAt/updatedAt——
 *   迁移是「状态解释方式的转换」不是复习事件：不进增量包、不跨端传播
 *   （meta.scheduler 本就不同步，每台设备各自切换各自迁移一次，幂等）。
 * @returns {Promise<{migrated:number}>} 实际播种的卡数
 */
export async function setScheduler(next) {
  const to = next === 'fsrs' ? 'fsrs' : 'sm2';
  await db.meta.put({ key: 'scheduler', value: to });
  refreshSchedConfig();
  let migrated = 0;
  if (to === 'fsrs') {
    // 批量播种：通用卡 + 单词卡（两模块共用同一调度器）
    for (const table of [db.cards, db.wordCards]) {
      const rows = await table.filter(r => !r.fsrs && (Number(r.intervalDays) > 0) && !r.consolidation).toArray();
      if (!rows.length) continue;
      const patches = rows
        .map(c => ({ key: c.id, changes: { fsrs: seedFsrsFromSm2(c) } }))
        .filter(p => p.changes.fsrs);
      if (patches.length) { await table.bulkUpdate(patches); migrated += patches.length; }
    }
  }
  return { migrated };
}
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
  // M11：全量只读一次——dueCount 是全局到期数（与过滤条件无关），
  // 旧实现末尾再 allCards() 一次 = 每次列表查询 2 次全表扫描，万卡级约翻倍耗时
  const all = await allCards();
  let cards = all;
  if (subject) cards = cards.filter(c => c.subject === subject);
  // M4 搜索扩展：q 覆盖 标题/正面/背面/标签/科目/来源/助记（大小写不敏感），
  // 原「仅 front/back 子串」行为是它的子集，向后兼容
  if (q) {
    const kw = q.toLowerCase();
    cards = cards.filter(c =>
      String(c.front || '').toLowerCase().includes(kw) ||
      String(c.back || '').toLowerCase().includes(kw) ||
      (c.tags || []).some(t => String(t).toLowerCase().includes(kw)) ||
      String(c.subject || '').toLowerCase().includes(kw) ||
      String(c.source || '').toLowerCase().includes(kw) ||
      String(c.mnemonic || '').toLowerCase().includes(kw));
  }
  cards = tagFilter(cards, tags, logic);
  if (mode === 'due') cards = cards.filter(c => c.dueAt <= now());
  if (sortBy === 'created') cards.sort((a, b) => (b.createdAt - a.createdAt) || (b.id > a.id ? 1 : -1));
  else if (sortBy === 'due') cards.sort((a, b) => (a.dueAt - b.dueAt) || (a.id < b.id ? -1 : 1));
  else if (sortBy === 'subject') cards.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || '')) || (b.updatedAt - a.updatedAt));
  else cards.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.id > a.id ? 1 : -1));
  const dueCount = all.filter(c => c.dueAt <= now()).length;
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
    // 审计 D1：初始 reviewedAt 显式为 0（与 word-repo.createWordCard 对齐），统一「未复习」
    // 哨兵语义。此前 cards 不写该字段（undefined），而 sync-manifest 曾用 `?? updatedAt`
    // 兜底，导致「只改内容未复习」的卡在 SRS 合并里覆盖对端已复习的调度。现在 0 是权威哨兵。
    ease: 2.5, level: 0, intervalDays: 0, reviewedAt: 0, fsrs: null, dueAt: t, createdAt: t, updatedAt: t,
  };
  await db.cards.put(card);
  fireHook('onCardSaved', card);
  return card;
}

export async function updateCard(id, payload) {
  // 审计 F-1：事务内重读+写——review() 的事务内 update 只写 SRS 字段，若在 get→put
  // 之间完成，整行 put 会把 ease/level/intervalDays/dueAt/reviewedAt/fsrs 全部回滚。
  return db.transaction('rw', db.cards, async () => {
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
  });
}

// ---------- 删除分级（数据生命周期统一语义，2026-08-30 收敛） ----------
//   A 可恢复删：卡片 / 备忘 / 笔记 / 计划 / 文档 / 导图 / **资料** —— trash 快照 + 墓碑，30 天内可还原
//   B 软删保内容：资料（docFile）—— 元数据 + 解析全文进 trash，原文件（OPFS/Blob）可丢，恢复后标记 storage='missing'
//   C 不可逆删：清空全部数据（stores/reset.js）—— UI 层强制「先备份」引导
// 统一原则：任何一次删除都必须 ① 先落 trash 快照 ② 再写墓碑 ③ 最后删行，且三步在同一事务内。

/** 回收站 TTL（天）：过期快照不可恢复，自动清除（墓碑保留，跨设备删除语义不受影响） */
export const TRASH_TTL_DAYS = 30;

// P2-22 回收站：删除内容前把快照写入本地 trash 表（不进同步/备份），供 30 天内恢复
// 快照约定：data 里以下划线开头的字段是「附属快照」，恢复时按类型还原到对应表，不写回主表行
//   _reviews    复习记录数组   → reviews
//   _groupLinks 卡片-卡组关联  → cardGroupLinks
//   _text/_textLen 资料解析全文 → docTexts（本地表，不同步）
//   _edges      资料→卡片图谱边 → graphEdges
export async function trashItem(id, kind, data) {
  if (!id || !data) return false;
  try {
    await db.trash.put({ id, kind, deletedAt: now(), data });
    return true;
  } catch (e) {
    // round15 P2：快照失败不再静默——删除照常完成，但回收站无快照 = 恢复不可能。
    // L-2：返回 false 让调用方（deleteCard）可提示用户，而非仅 console.warn。
    console.warn('[trash] 回收站快照写入失败（该记录将无法从回收站恢复）:', kind, id, e?.message || e);
    return false;
  }
}

/**
 * 回收站过期清理：删掉超过 TTL 的快照（墓碑保留，保证跨设备删除语义不被本地回收站绑死）。
 * 之前只在回收站页 load() 时清一次 —— 用户长期不打开该页，trash 会无限膨胀。
 * 现在导出此函数，由应用启动时（main.js）兜底调用。
 */
export async function pruneTrash(ttlDays = TRASH_TTL_DAYS, nowTs = Date.now()) {
  try {
    const cutoff = nowTs - ttlDays * 86400000;
    // 审计 F-5：索引查询替代全表 filter——trash 表已有 deletedAt 索引（db.js:181），
    // filter() 不走索引退化为全表扫描，where().below() 直接走索引范围查询。
    const stale = await db.trash.where('deletedAt').below(cutoff).primaryKeys();
    if (stale.length) await db.trash.bulkDelete(stale);
    return stale.length;
  } catch { return 0; }
}

// 恢复时对主表行的类型专属修正：
//   docFile —— 原文件（OPFS / IndexedDB Blob）在删除时已释放，无法还原；
//              显式标记 storage='missing' 并清掉 opfsPath/blob，
//              让 getFileBlob() 走「本机无原文件」分支，而不是拿着已删路径去读 OPFS 报错。
const RESTORE_TRANSFORMS = {
  docFile: (row) => {
    const r = { ...row };
    r.storage = 'missing';
    delete r.opfsPath;
    delete r.blob;
    return r;
  },
};

// P2-22 回收站：从 trash 恢复一条。重新插入行并 bump updatedAt（> 墓碑 deletedAt → 下次同步判定复活），
// 同时清掉本地墓碑与 trash 记录。
// 附属快照（_reviews / _groupLinks / _text / _edges）一并还原，避免「卡回来了但复习进度和分组丢了」。
export async function restoreFromTrash(t) {
  if (!t || !t.data) return false;
  const table = {
    card: 'cards', memo: 'memos', note: 'notes', plan: 'plans',
    doc: 'docs', mindmap: 'mindmaps', docFile: 'docFiles',
    wordCard: 'wordCards', wordGroup: 'wordGroups',
    // v40 卡组对等：普通卡组删除也进回收站（与 wordGroup 同机制），恢复时一并还原成员关联
    cardGroup: 'cardGroups',
  }[t.kind];
  if (!table) return false;
  // 深拷贝快照：RecycleBin.vue 的 items 是 ref 数组，元素经 Vue 深层响应式代理包裹，
  // 浅拷贝 {...t.data} 只剥最外层，tags/_reviews 等嵌套数组仍是 Proxy →
  // IndexedDB put/bulkPut 结构化克隆抛 DataCloneError: [object Array] could not be cloned。
  const data = plain(t.data);
  const reviews = data._reviews || null;
  const links = data._groupLinks || null;
  // 审计 A2：词卡快照的卡↔词关联（_cardWordLinks）——恢复时必须还原，
  // 否则删→恢复后 cardWordLinks 永久丢失；残留墓碑还会把重连尝试再删掉。
  // 注意：删通用卡（deleteCard）与删词卡（deleteWordCard）都会级联删链接并写墓碑，
  // 所以两种 kind 的快照都要带/还原该字段（deleteCard 的快照见下方同函数调用处）。
  const cwLinks = data._cardWordLinks || null;
  const linkedNoteIds = Array.isArray(data._linkedNoteIds) ? data._linkedNoteIds : null;
  const text = typeof data._text === 'string' ? data._text : null;
  const edges = data._edges || null;
  delete data._reviews; delete data._groupLinks; delete data._text; delete data._textLen; delete data._edges;
  delete data._cardWordLinks; delete data._embeddings; delete data._linkedNoteIds;
  const transform = RESTORE_TRANSFORMS[t.kind];
  const row = { ...(transform ? transform(data) : data), id: t.id, updatedAt: Date.now() };
  const tables = [db[table], db.tombstones, db.trash];
  // P1-A：单词模块的附表与记忆卡不同（wordReviews / wordGroupLinks），按 kind 分流；
  // 记忆卡（card）与普通卡组（cardGroup）都走 reviews / cardGroupLinks（原逻辑）。
  const isWord = t.kind === 'wordCard' || t.kind === 'wordGroup';
  const reviewsTable = t.kind === 'wordCard' ? db.wordReviews : db.reviews;
  const linksTable = isWord ? db.wordGroupLinks : db.cardGroupLinks;
  if (reviews && reviews.length) tables.push(reviewsTable);
  if (links && links.length) tables.push(linksTable);
  if (cwLinks && cwLinks.length) tables.push(db.cardWordLinks);
  if (text) tables.push(db.docTexts);
  if (edges && edges.length) tables.push(db.graphEdges);
  if (linkedNoteIds && linkedNoteIds.length) tables.push(db.notes);
  await db.transaction('rw', ...tables, async () => {
    await db[table].put(row);
    if (reviews && reviews.length) {
      // 复习快照的 cardId 即本卡 id，原样还原（review 自带 id 用于幂等覆盖）
      await reviewsTable.bulkPut(reviews.map(r => ({ ...r })));
      // round16 R16-1：恢复时清掉为这些复习记录写的墓碑，否则下次同步
      // 会被自己的墓碑重新删掉（与下方 groupLink 墓碑清理同机制）
      await db.tombstones.bulkDelete(reviews.map(r => r.id));
    }
    if (links && links.length) {
      await linksTable.bulkPut(links.map(l => ({ ...l })));
      // 连带清除「删卡/删词组时为这些关联行写的墓碑」，否则恢复后
      // 下次同步会被自己的墓碑重新删掉（墓碑 deletedAt > link.addedAt）
      await db.tombstones.bulkDelete(links.map(l => l.id));
    }
    if (cwLinks && cwLinks.length) {
      // 审计 A2：还原卡↔词关联 + 清掉为这些链接写的墓碑（同 links 机制）
      await db.cardWordLinks.bulkPut(cwLinks.map(l => ({ ...l })));
      await db.tombstones.bulkDelete(cwLinks.map(l => l.id));
    }
    if (text) {
      await db.docTexts.put({
        id: t.id, text, textLen: data._textLen ?? text.length, updatedAt: Date.now(),
      });
    }
    if (edges && edges.length) {
      // bump updatedAt 让恢复后的边在下次同步时压过对端仍存在的旧副本
      await db.graphEdges.bulkPut(edges.map(e => ({ ...e, updatedAt: Date.now() })));
      // 同时清掉删资料时为这些边写的墓碑，否则恢复后会被自己的墓碑再删一遍
      await db.tombstones.bulkDelete(edges.map(e => e.id));
    }
    await db.tombstones.delete(t.id);
    await db.trash.delete(t.id);
    // 审计 #10：notes 链接复原——deleteCard 清了 linkedCardIds 里对该卡的引用（无墓碑），
    // 恢复时按快照补回（幂等：若用户手动加回了则 Set 自动去重）
    if (linkedNoteIds && linkedNoteIds.length) {
      const noteRows = (await db.notes.bulkGet(linkedNoteIds)).filter(Boolean);
      for (const n of noteRows) {
        const set = new Set(n.linkedCardIds || []);
        if (!set.has(t.id)) {
          set.add(t.id);
          await db.notes.put({ ...n, linkedCardIds: [...set], updatedAt: Date.now() });
        }
      }
    }
    // 审计：清 embedding 墓碑——deleteCard 已补写墓碑（kind='embedding'），
    // 恢复时必须一并清掉，否则每次同步 applyTombstones 会把重建的向量再删一遍，
    // RAG 对该资料永久失明。对 card/docFile 均适用。
    const embeddingTombStale = (await db.tombstones.toArray())
      .filter(tb => (tb?.kind || 'card') === 'embedding')
      .filter(tb => {
        if (t.kind === 'docFile') return tb.id === t.id;
        // card：清掉 sourceId=t.id 的所有 embedding 墓碑（id 格式 embed-${sourceId}-...）
        return typeof tb.id === 'string' && tb.id.startsWith(`embed-${t.id}-`);
      });
    if (embeddingTombStale.length) await db.tombstones.bulkDelete(embeddingTombStale.map(tb => tb.id));
    // 审计 F-3：资料恢复后自动触发 RAG 重建——docFile 和 doc（AI 文档）均可能含向量嵌入，
    // 删除时 embed 墓碑已写，恢复时墓碑虽清但向量未重建 → RAG 对该资料永久失明。
    if (t.kind === 'docFile' || t.kind === 'doc') {
      try { const { parseDoc } = await import('./docs-lib.js'); parseDoc(t.id).catch(() => {}); } catch { /* import 失败不阻塞恢复 */ }
    }
  });
  return true;
}

export async function deleteCard(id) {
  const old = await db.cards.get(id);
  if (!old) return;
  const imgIds = [...extractImageIds(JSON.stringify(old))];
  // 事务内一次性完成 回收站快照 + 墓碑 + 删卡 + 删复习 + 删卡组关联 + 切断图谱边，保证原子、无悬空引用
  // 注：cardGroupLinks 此前漏删 —— 删卡后关联行原样留在库里（还进同步包跨设备传播），
  //     卡组详情页会统计到已被删除的「幽灵卡」，且永不清理。
  await db.transaction('rw', db.cards, db.trash, db.tombstones, db.reviews, db.graphEdges, db.cardGroupLinks, db.cardWordLinks, db.embeddings, db.notes, async () => {
    // 1) 回收站快照（含复习记录 + 卡组关联 + 卡↔词关联，便于恢复时一并还原）
    const reviews = await db.reviews.where('cardId').equals(id).toArray();
    const links = await db.cardGroupLinks.where('cardId').equals(id).toArray();
    const cwLinks = await db.cardWordLinks.where('cardId').equals(id).toArray();
    // 审计 A2：与 deleteWordCard 对称——删通用卡也会级联删链接+写墓碑，
    // 快照不带 _cardWordLinks 的话恢复后关联同样永久丢失
    // 审计 #10：记录被清洗引用的 noteId，恢复时补回 linkedCardIds
    const linkedNoteIds = (await db.notes.toArray())
      .filter(n => Array.isArray(n.linkedCardIds) && n.linkedCardIds.includes(id))
      .map(n => n.id);
    await trashItem(id, 'card', { ...old, _reviews: reviews, _groupLinks: links, _cardWordLinks: cwLinks, _linkedNoteIds: linkedNoteIds });
    // 2) 墓碑（跨设备删除同步）：卡片本体 + 它的每一条卡组关联
    //    关联行不写墓碑的话，对端会在下次同步把「已删卡 → 卡组」的关联原样推回来，
    //    形成永远删不掉、且指向幽灵卡的悬空行
    await db.tombstones.put({ id, kind: 'card', deletedAt: now() });
    if (links.length) {
      await db.tombstones.bulkPut(links.map(l => ({ id: l.id, kind: 'groupLink', deletedAt: now() })));
    }
    // round15 P1：图谱边必须写墓碑——本端 filter 删除后，若不写墓碑，
    // 对端旧边会在下次同步按 updatedAt 合并被推回，幽灵边复活。
    // round26 H-2：fromCardId/toCardId 已建索引（v28），改走索引范围查询替代全表 filter。
    // 自环边（fromCardId===toCardId）会被两条索引各命中一次，Map 按 id 去重。
    const edgeMap = new Map();
    for (const e of await db.graphEdges.where('fromCardId').equals(id).toArray()) edgeMap.set(e.id, e);
    for (const e of await db.graphEdges.where('toCardId').equals(id).toArray()) edgeMap.set(e.id, e);
    const edges = [...edgeMap.values()];
    if (edges.length) {
      await db.tombstones.bulkPut(edges.map(e => ({ id: e.id, kind: 'graphEdge', deletedAt: now() })));
    }
    // round16 R16-1：复习记录（同步表 kind='review'）同样必须写墓碑——
    // round15 只给 deleteWordCard 的 wordReviews 补了墓碑，记忆卡侧 deleteCard 漏了同款。
    // 物理删行不写墓碑 → 对端残留的 review 行随每次增量包反复回传（idOnly 幂等表），
    // 形成「卡没了、复习还在」的孤儿行；恢复卡片后与卡 id 不匹配成为永久垃圾。
    if (reviews.length) {
      await db.tombstones.bulkPut(reviews.map(r => ({ id: r.id, kind: 'review', deletedAt: now() })));
    }
    // 3) 删卡
    await db.cards.delete(id);
    // 4) 删复习记录
    await db.reviews.where('cardId').equals(id).delete();
    // 5) 删卡组关联（此前漏删 → 指向已删卡的悬空行常驻并进同步包）
    await db.cardGroupLinks.where('cardId').equals(id).delete();
    // 5.5) v31：删通用卡↔英语词卡链接（同 cardGroupLinks 逻辑：不写墓碑 → 对端悬空链接复活）
    //      cwLinks 已在第 1 步快照时查出，此处复用，避免重复查询
    if (cwLinks.length) {
      await db.tombstones.bulkPut(cwLinks.map(l => ({ id: l.id, kind: 'cardWordLink', deletedAt: now() })));
    }
    await db.cardWordLinks.where('cardId').equals(id).delete();
    // 6) 切断关联图谱边（round26 H-2：复用上面已查出的 edges，bulkDelete 一次删净）
    if (edges.length) await db.graphEdges.bulkDelete(edges.map(e => e.id));
    // 7) 删向量索引（round15 P1：此前漏删，本端 RAG 检索到已删卡的幽灵向量）
    //    审计：必须先写墓碑再物理删，否则对端残留 embeddings 行随增量包反复回传；
    //    restoreFromTrash 清墓碑时才能正确复活（见上方 _embeddings 分支）
    const embRows = await db.embeddings.where('sourceId').equals(id).and(e => e.sourceType === 'card').toArray();
    if (embRows.length) {
      await db.tombstones.bulkPut(embRows.map(e => ({ id: e.id, kind: 'embedding', deletedAt: now() })));
    }
    await db.embeddings.where('sourceId').equals(id).and(e => e.sourceType === 'card').delete();
    // 8) M5 残余：剔除所有笔记 linkedCardIds 里对该卡的引用（删卡后留 [[cardId]]
    //    结构上仍是悬空引用；笔记侧把引用数组清洗掉并 bump updatedAt 随内容侧同步）
    const linkedNotes = (await db.notes.toArray())
      .filter(n => Array.isArray(n.linkedCardIds) && n.linkedCardIds.includes(id));
    for (const n of linkedNotes) {
      await db.notes.put({ ...n, linkedCardIds: n.linkedCardIds.filter(x => x !== id), updatedAt: now() });
    }
  });
  // 9) 清理不再被任何卡片引用的孤儿图片。round26 D3：**先写墓碑、后物理删**——
  //    崩溃落在两步之间时不会出现「图已删但对端不知情」的坏方向（最坏仅本地图残留）。
  const orphanImages = await findOrphanImages(imgIds);
  if (orphanImages.length) {
    await db.tombstones.bulkPut(orphanImages.map(id => ({ id, kind: 'image', deletedAt: now() })));
    await db.images.bulkDelete(orphanImages);
  }
  fireHook('onCardDeleted', { id });
}

/**
 * 删除卡片后，清理不再被任何卡/词卡引用的图片；返回实际被删的图片 id（供写墓碑）。
 * 审计 A1 同源修复：存活集此前只扫通用卡的 front/back——与 hub 侧 GC 同构的误删路径
 * （某图仅被词卡引用时，删任意一张通用卡都会把它当孤儿删掉）。
 * 改为扫 cards + wordCards 全表的所有字符串字段（JSON.stringify 整行），与 hub 口径一致。
 * 审计 L5：图片同样可能被 notes.content / docs / memos / mindmaps 里的 [[sxy-img]] 引用——
 * 只扫卡/词卡会误删「仅被笔记等正文引用」的图片。补扫正文表（与 hub 的 GC 口径对齐）。
 */
export async function cleanupOrphanImages(ids) {
  if (!ids.length) return [];
  const idSet = new Set(ids);
  // round26 D4：**移除 imageRefs 索引快速路径**——该索引由 rebuildImageRefs 全量重建，
  // 但全仓除其自身外无任何调用方（写路径不维护引用集）→ 一旦有人触发 rebuild（indexedCount>0），
  // 快速路径会用**过期引用**判定孤儿，误删仍被其他卡引用的图片。
  // 统一走全表扫描兜底（正确性优先；图引用量级小，扫描成本可接受）。
  // 全表扫描（扫 cards+wordCards+notes+docs+memos+mindmaps）
  const [cards, wordCards, notes, docs, memos, mindmaps] = await Promise.all([
    allCards(), db.wordCards.toArray(), db.notes.toArray(),
    db.docs.toArray(), db.memos.toArray(), db.mindmaps.toArray(),
  ]);
  const used = new Set();
  for (const c of [...cards, ...wordCards, ...notes, ...docs, ...memos, ...mindmaps]) {
    for (const i of extractImageIds(JSON.stringify(c))) used.add(i);
  }
  const removed = [];
  for (const id of idSet) if (!used.has(id)) { await db.images.delete(id); removed.push(id); }
  return removed;
}

/**
 * 审计：重建 imageRefs 反向索引（db.js v32）。
 * 扫描所有含 sxy-img:// 引用的表，提取每行内引用的图片 id，写入 imageRefs 表。
 * 幂等：每次全量清空后重建，保证索引与主表一致。
 * @returns {Promise<number>} 写入的引用行总数
 */
// round26 D3：孤儿图**纯读预检**（不删除）。配合删除路径「先写墓碑 → 后物理删」，
// 消除「图已物理删但墓碑未写 → 删除不跨设备传播」的窗口（崩溃点落在两步骤之间时，
// 最坏只剩本地图残留，墓碑已发出去让对端对齐删除，无坏方向）。
export async function findOrphanImages(ids) {
  const idSet = new Set((ids || []).filter(Boolean));
  if (!idSet.size) return [];
  const [cards, wordCards, notes, docs, memos, mindmaps] = await Promise.all([
    allCards(), db.wordCards.toArray(), db.notes.toArray(),
    db.docs.toArray(), db.memos.toArray(), db.mindmaps.toArray(),
  ]);
  const used = new Set();
  for (const c of [...cards, ...wordCards, ...notes, ...docs, ...memos, ...mindmaps]) {
    for (const i of extractImageIds(JSON.stringify(c))) used.add(i);
  }
  return [...idSet].filter((id) => !used.has(id));
}

export async function rebuildImageRefs() {
  const refTables = [
    { name: 'cards', rows: await allCards() },
    { name: 'wordCards', rows: await db.wordCards.toArray() },
    { name: 'notes', rows: await db.notes.toArray() },
    { name: 'docs', rows: await db.docs.toArray() },
    { name: 'memos', rows: await db.memos.toArray() },
    { name: 'mindmaps', rows: await db.mindmaps.toArray() },
  ];
  const refs = [];
  for (const { name, rows } of refTables) {
    for (const row of rows) {
      const imageIds = extractImageIds(JSON.stringify(row));
      for (const imgId of imageIds) {
        refs.push({ id: `${imgId}:${name}:${row.id}`, imageId: imgId, refTable: name, refId: row.id });
      }
    }
  }
  await db.transaction('rw', db.imageRefs, async () => {
    await db.imageRefs.clear();
    if (refs.length) await db.imageRefs.bulkPut(refs);
  });
  return refs.length;
}

/**
 * 审计 C5（跨设备孤儿复习行清扫）：删除墓碑只清除「被删行」本身，不会级联它的子表——
 * 本地 deleteCard 会把 reviews 快照进回收站并删行，但**对端**只收到卡片墓碑，
 * 该卡的历史 reviews/wordReviews 没有墓碑可对，于是长期离线设备上留下
 * 「父卡已不存在」的孤儿复习行，永久占空间并污染统计（今日复习数/热力图/画像）。
 * 修复：每次同步/导入墓碑应用完之后清扫一次——只删「父卡 id 在当前库确实不存在」的行。
 * 范围严格收窄：回收站恢复（restoreFromTrash）是从快照 bulkPut 复习行，与这里不冲突；
 * 空/缺 cardId 的遗留脏行一并清理。幂等，可重复执行。
 * @returns {Promise<number>} 清理的孤儿行总数
 */
export async function sweepOrphanRows() {
  const [cards, wordCards, reviews, wordReviews] = await Promise.all([
    db.cards.toArray(), db.wordCards.toArray(), db.reviews.toArray(), db.wordReviews.toArray(),
  ]);
  const cardIds = new Set(cards.map(c => c.id));
  const wordCardIds = new Set(wordCards.map(c => c.id));
  const delReviews = reviews.filter(r => !cardIds.has(r.cardId)).map(r => r.id);
  const delWord = wordReviews.filter(r => !wordCardIds.has(r.cardId)).map(r => r.id);
  if (delReviews.length) await db.reviews.bulkDelete(delReviews);
  if (delWord.length) await db.wordReviews.bulkDelete(delWord);
  return delReviews.length + delWord.length;
}

/**
 * 审计（幽灵卡自愈）：历史 fsrs 缺陷（2026-08 修复前）可能把 dueAt 写成 NaN，
 * 经备份 JSON 往返又可能变 null——`NaN <= now` 恒假，这类卡会永久消失在复习队列，
 * 且永远不会被复习到（也就无法被调度器重写自愈）。
 * 这里把「确定损坏的 dueAt（NaN/null，不含 undefined——无该字段的老数据另作他论）」
 * 一次性改写为 0（立即到期一次 → 复习后调度器写回有限值）。
 * 本机执行即可（每台设备各自启动时自愈），不 bump updatedAt，避免触发一次全网同步风暴。
 * @param {{force?:boolean}} opts force=true 时跳过「已执行」标记（导入后调，处理刚导入的坏行）
 * @returns {Promise<number>} 修复行数
 */
export async function repairBrokenDueAt({ force = false } = {}) {
  const FLAG = 'sxy_heal_broken_dueat_v1';
  if (!force) {
    try { if (localStorage.getItem(FLAG)) return 0; } catch { /* 隐私模式忽略 */ }
  }
  let fixed = 0;
  const heal = async (table) => {
    const broken = await table.filter(c => {
      const d = c.dueAt;
      return d !== undefined && (d === null || Number.isNaN(d));
    }).toArray();
    if (!broken.length) return;
    await table.bulkPut(broken.map(c => ({ ...c, dueAt: 0 })));
    fixed += broken.length;
  };
  await heal(db.cards);
  await heal(db.wordCards);
  if (!force) { try { localStorage.setItem(FLAG, '1'); } catch { /* 忽略 */ } }
  if (fixed) console.info(`[repo] 修复 ${fixed} 张损坏 dueAt(NaN/null) 卡片为「立即到期」（自愈）`);
  return fixed;
}

// 手动标记 / 取消标记错题
export async function setMarked(id, marked) {
  const card = await db.cards.get(id);
  if (!card) throw new Error('卡片不存在');
  // 审计 B11 同款：差量写——marked/updatedAt 只 merge 这两个字段，
  // 不再 put 整行（避免窗口期内的并发内容编辑被旧快照覆盖）
  await db.cards.update(id, { marked: !!marked, updatedAt: now() });
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
  // 审计 D3（全表扫描）：此前固定 `allCards()` 物化全表再内存过滤，万卡级每次进队列都要
  // 全量 toArray + sort。dueAt 已建索引（db.js），且 filterReviewCandidates 默认只保留
  // dueAt<=now 的卡——与索引 `belowOrEqual(now)` 语义一致（dueAt 为 undefined/NaN 时
  // `<= now` 恒 false，索引同样不返回），故默认路径可先用索引把候选收窄到「已到期」，
  // 再筛科目/标签/错因。仅 includeDueOnly===false（重复复习全量场景）才必须全表扫描。
  const nowTs = now();
  const scanAll = filter?.includeDueOnly === false;
  const pool = scanAll ? await allCards() : await db.cards.where('dueAt').belowOrEqual(nowTs).toArray();
  // 筛选 + 排序核心已抽至 repo-core.filterReviewCandidates（N9）
  let cards = filterReviewCandidates(pool, filter, nowTs);
  // M1 卡组：
  //  - groupFilter: 'all'(默认) | 'archived-only'(仅备用组) | [groupId,...](指定组)
  //  - parkArchived: 默认 true——只属于备用组（archived）的卡不进队列（未分组卡照常）
  const groupFilter = filter.groupFilter;
  if (groupFilter && groupFilter !== 'all') {
    const links = await db.cardGroupLinks.toArray();
    if (Array.isArray(groupFilter) && groupFilter.length) {
      const idSet = new Set(groupFilter);
      cards = cards.filter(c => links.some(l => l.cardId === c.id && idSet.has(l.groupId)));
    } else if (groupFilter === 'archived-only') {
      const groups = await db.cardGroups.toArray();
      const arch = new Set(groups.filter(g => g.status === 'archived').map(g => g.id));
      cards = cards.filter(c => links.some(l => l.cardId === c.id && arch.has(l.groupId)));
    }
  } else if (filter.parkArchived !== false) {
    const parked = await getParkedCardIds();
    if (parked.size) cards = cards.filter(c => !parked.has(c.id));
  }
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
  // 审计 L2：rating 白名单防御——原实现把任意值丢进 scheduleReview 的 else 分支当「没记住」
  // 做遗忘回退（评 3/评 -1 都会当 rating 0），且 UI 断点难查。入口即拦非 0/1/2。
  const rv = Number(rating);
  if (!Number.isFinite(rv) || ![0, 1, 2].includes(rv)) throw new Error('非法评分 rating（仅 0/1/2）');
  // P1-1：读取调度器配置（FSRS opt-in）+ 用户训练权重（带 60s 缓存）
  const cfg = await getSchedConfig();
  // ⚠️ 错因不再「终身携带」（2026-08-30 修复）：
  //   原写法 `opts.wrongReason || card.wrongReason` 会让一次错因永久生效 ——
  //   标过一次「概念混淆」后，即便之后连答 20 次全对，每次间隔仍被 ×0.6，
  //   这张卡永远升不到正常梯度。
  //   修正：答对（rating=2）且本次没有上报新错因 → 清空历史错因。
  //   答错 / 答模糊（rating<2）则保留，直到真正答对为止。
  const incomingReason = String(opts.wrongReason || '').trim();
  const reviewId = uid();
  // 审计 B11：读+写放进同一事务。此前「事务外读 → 纯计算 → 事务内整行回写」
  // 的窗口期内，同卡可能已被对端同步到达/另一路复习写入变更，旧快照会把新内容覆盖掉
  // （丢内容字段的编辑）。Dexie 对同 store 的事务串行化，事务内读到的 card
  // 就是本次写操作前的最新已提交状态；meta 也进事务表（前测读取与写入快照一致）。
  return db.transaction('rw', db.cards, db.reviews, db.meta, async () => {
    const card = await db.cards.get(cardId);
    if (!card) throw new Error('卡片不存在');
    // 每复习难度评分（0/1/2）：opts 优先，否则取卡片内容难度映射值
    // 注意：difficulty 是卡片固有内容属性（basic/applied/challenge），复习不应回写覆盖它
    const DIFF_MAP = { basic: 0, applied: 1, challenge: 2 };
    const toDiffNum = (v) => DIFF_MAP[v] ?? (Number.isFinite(Number(v)) ? Number(v) : null);
    const difficulty = toDiffNum(opts.difficulty) ?? toDiffNum(card.difficulty) ?? 1;
    // 参与**本次**间隔计算的错因：本次上报的优先，否则沿用卡上已有的。
    //   （答对也要按错因轻重缩短间隔 —— 见设置里 SM-2 的「错因惩罚」说明）
    const wrongReason = incomingReason || card.wrongReason || '';
    // 写回卡片的错因：答对且本次没有上报新错因 → 清空历史错因（clearedReason 标记「确实清掉了东西」）
    const clearedReason = Number(rating) === 2 && !incomingReason && !!card.wrongReason;
    const nextWrongReason = clearedReason ? '' : wrongReason;
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
    // P0 修正：仅当本次确有错因内容时才推进 wrongReasonAt，
    // 否则「记住了」(空错因) 以新时间戳覆盖他机真实错因 → 跨设备错因丢失。
    // 例外：主动清空错因（clearedReason）也必须 bump ——
    //   mergeCardPair 在两端 wrongReasonAt 相等时会优先保留「有内容」的一方，
    //   若清空时不推进时间戳，对端的旧错因会在下次同步把清空顶回来，清除永远不生效。
    const nowTs = now();
    const wrongReasonAt = (nextWrongReason || clearedReason) ? nowTs : (card.wrongReasonAt ?? 0);
    // 校准回测（calibration）：用复习前的 fsrs 状态计算当时预测 R，落盘进复习记录。
    // 历史记录无 predR 由 calibration.js 回溯模拟补估；从这里起的新数据都是真实值。
    const predR = (card.fsrs && Number.isFinite(card.fsrs.s) && Number.isFinite(card.fsrs.last))
      ? Number(retrievability(card.fsrs.s, (nowTs - card.fsrs.last) / 86400000).toFixed(4))
      : null;
    // round17 R17-6：SM-2 路径 next.fsrs 为 undefined 时，不能原样保留 card.fsrs——
    // 那样 fsrs.last 永远停在「最后一次 FSRS 复习」时刻，用户切回 FSRS 后 elapsedDays
    // 横跨整个 SM-2 期 → 预测 R≈0 → stabilityAfterRecall 的 e^(w9(1-R))-1 被异常放大。
    // 正确语义：无论哪种调度器，last 都应推进到「本次实际复习时刻」；s/d 保持 FSRS 上次状态。
    const fsrsNext = next.fsrs ?? (card.fsrs ? { ...card.fsrs, last: nowTs } : undefined);
    // 审计 B11：差量写——只 merge 本次改动的 SRS 字段，不再 put 整行。
    // 即使读快照因任何原因落后于存储，内容字段也不会被旧值覆盖；
    // fsrs 为 undefined 时不进更新对象（保留卡上原值，不触发 Dexie 对 undefined 的语义歧义）。
    const cardUpdate = {
      ease: next.ease, level: next.level, intervalDays: next.intervalDays,
      dueAt: next.dueAt, consolidation: next.consolidation,
      wrongReason: nextWrongReason, wrongReasonAt, reviewedAt: nowTs,
    };
    if (fsrsNext !== undefined) cardUpdate.fsrs = fsrsNext;
    // 卡片与复习记录同事务双写：任何一步失败整体回滚，不留半残状态
    await db.cards.update(cardId, cardUpdate);
    await db.reviews.put({
      id: reviewId, cardId, reviewedAt: nowTs, rating,
      predR,
      levelAfter: next.level, guessed: !!guessed, difficulty, wrongReason,
      retrievalStrength: opts.retrievalStrength || '',
      responseMs: opts.responseMs || 0,
      grade: grade.level, gradeScore: grade.score,
    });
    fireHook('onReviewRated', { cardId, rating, reviewId, guessed: !!guessed });
    return { ...next, dueText: formatDue(next.dueAt), reviewId };
  });
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
  // 审计 B12：读+写同事务 + 差量写（与 review 同款修复）。
  // 此前事务外 get → 纯计算 → 事务内整行 put，窗口期内的并发写会被旧快照覆盖。
  return db.transaction('rw', db.cards, async () => {
    const card = await db.cards.get(cardId);
    if (!card) return null;
    const f = applyFeedback(card, signal);
    // M1 时间戳铁律：ease/dueAt 属 SRS 调度字段，按 reviewedAt 决定同步水位——
    // 不 bump reviewedAt 则本次排期变更不进增量包，对端回滚。不碰 updatedAt（内容侧）。
    // 差量写：只 merge 本次改动的 SRS 字段，不回写整行。
    await db.cards.update(cardId, { ease: f.ease, dueAt: f.dueAt, reviewedAt: Date.now() });
    return f;
  });
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
  const old = await db.memos.get(id);
  if (!old) return;
  // 事务：快照 + 删行 + 墓碑同生共死，杜绝「删了行但墓碑没写」→ 对端永久残留
  await db.transaction('rw', db.memos, db.trash, db.tombstones, async () => {
    await trashItem(id, 'memo', old);
    await db.memos.delete(id);
    await db.tombstones.put({ id, kind: 'memo', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
}

// ───────────── 每日规划/打卡（D8：口述→任务→四象限→打卡→早晚对比） ─────────────

/**
 * 创建每日计划：口述文本 → 解析任务 → 入库（计划头 + 任务明细）。
 * - 当天已有计划 → 覆盖重建（删旧+写墓碑），避免多 plan 堆积（历史列表"全是今日"根因）
 * - 支持直接传入解析好的 tasks（前端预览结果原样入库，保证 预览=入库 一致）
 * @param {object} payload { rawInput, date?, tasks? }
 * @returns {{ plan, tasks }}
 */
export async function createDailyPlan(payload) {
  const rawInput = String(payload?.rawInput || '').trim();
  if (!rawInput) throw new Error('请输入今日规划内容');
  const date = payload?.date || localDateStr();
  const t = now();

  // 优先使用调用方解析好的任务（预览一致），否则离线解析。
  // 解析是纯计算且含动态 import，必须在 Dexie 事务外完成（事务 Zone 内不能 await 非库 promise）。
  let parsed = Array.isArray(payload.tasks) && payload.tasks.length ? payload.tasks : null;
  if (!parsed) {
    const { parsePlan } = await import('./utils/plan-parser.js');
    parsed = parsePlan(rawInput);
  }
  const planId = uid();
  const tasks = parsed.map(task => ({
    id: uid(),
    planId,
    date,
    ...task,
    status: 'pending',
    completedAt: null,
    completionNote: '',
    createdAt: t, updatedAt: t,
  }));
  const plan = { id: planId, date, rawInput, status: 'active', createdAt: t, updatedAt: t };

  // 覆盖重建 + 新建全部包进单个事务（round15 P1：任一步失败整体回滚，
  // 杜绝「旧计划已清空但新计划未建成」的半残态——此前逐条删除无事务保护）
  await db.transaction('rw', db.dailyPlans, db.dailyTasks, db.tombstones, async () => {
    const existing = await db.dailyPlans.where('date').equals(date).toArray();
    for (const p of existing) {
      // 级联删任务必须逐条写墓碑，否则对端会把旧任务推回来、与新计划混在一起
      await cascadeDeletePlanTasks(p.id, t);
      await db.dailyPlans.delete(p.id);
      await db.tombstones.put({ id: p.id, kind: 'dailyPlan', deletedAt: t });
    }
    await db.dailyPlans.put(plan);
    if (tasks.length) await db.dailyTasks.bulkPut(tasks);
  });
  fireHook('onDailyPlanSaved', { plan, tasks });
  return { plan, tasks };
}

/** 今天的日期串 YYYY-MM-DD（本地时区）——统一委托 time.dateKey，见顶部 D7 注释 */
const localDateStr = (d) => createDateKey(d ? new Date(d).getTime() : undefined);

/** 列出某天的计划（默认今天），含任务明细；当天多份时取 updatedAt 最新的一份 */
export async function listDailyPlan(date = localDateStr()) {
  const plans = await db.dailyPlans.where('date').equals(date).toArray();
  if (!plans.length) return null;
  plans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const plan = plans[0];
  const tasks = await db.dailyTasks.where('planId').equals(plan.id).toArray();
  return { plan, tasks };
}

/** 列出最近 N 天（含今天）的计划头（历史趋势用） */
export async function listDailyPlans(limit = 30) {
  return db.dailyPlans.orderBy('date').reverse().limit(limit).toArray();
}

/**
 * 最近 N 天计划摘要（按日期合并去重，历史回溯/热力图用）。
 * 同一天多份计划合并 total/done，取最新 updatedAt 排序。
 * @param {number} [days=30]
 * @returns {Array<{ date, total, done, updatedAt }>}
 */
export async function listDailyPlanSummary(days = 30) {
  const plans = await db.dailyPlans.orderBy('date').reverse().limit(days * 3).toArray();
  const byDate = new Map();
  // BUG-09：循环内逐 plan 串行查 dailyTasks = N 次索引查询（N 可达 90）。
  // 改 anyOf 一次批量拉取后按 planId 分组，查询次数从 O(N) 降到 O(1)。
  const planIds = plans.map((p) => p.id);
  const allTasks = planIds.length
    ? await db.dailyTasks.where('planId').anyOf(planIds).toArray()
    : [];
  const tasksByPlan = new Map();
  for (const t of allTasks) {
    const arr = tasksByPlan.get(t.planId) || [];
    arr.push(t);
    tasksByPlan.set(t.planId, arr);
  }
  for (const p of plans) {
    const tasks = tasksByPlan.get(p.id) || [];
    const cur = byDate.get(p.date) || { date: p.date, total: 0, done: 0, updatedAt: 0 };
    cur.total += tasks.length;
    cur.done += tasks.filter(t => t.status === 'done').length;
    cur.updatedAt = Math.max(cur.updatedAt, p.updatedAt || 0);
    byDate.set(p.date, cur);
  }
  return [...byDate.values()]
    .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.date < b.date ? 1 : -1))
    .slice(0, days);
}

/** 更新任务（中途调整：加/删/改象限/打卡） */
export async function updateDailyTask(id, patch) {
  // round17 R17-29：读-改-写包进事务（防并发打卡/编辑互相覆盖 = lost update，
  // 兄弟函数 checkinDailyTask 已事务化，此路径是漏网）+ patch 脱壳（调用方可能传
  // Vue reactive 对象，直接展开落库会触发 Dexie structuredClone 的 DataCloneError）
  // 审计 B5：补上与 checkinDailyTask 同款的状态白名单——原实现直接合并 patch，调用方
  // 可写入任意 status 值（如 'any-invalid'），listDailyPlanSummary 只认 'done'，非法值
  // 既不算完成也不算打卡 → 幽灵任务。同时统一维护 completedAt 语义。
  const p = patch ? plain(patch) : {};
  if (p.status !== undefined) {
    const valid = ['done', 'partial', 'skipped', 'pending'];
    if (!valid.includes(p.status)) throw new Error('非法打卡状态');
    // 统一 completedAt：只有 'done' 才带完成时刻，其余清空（与 checkinDailyTask 同口径）
    p.completedAt = p.status === 'done' ? now() : null;
  }
  let task;
  await db.transaction('rw', db.dailyTasks, async () => {
    const old = await db.dailyTasks.get(id);
    if (!old) throw new Error('任务不存在');
    task = { ...old, ...p, updatedAt: now() };
    await db.dailyTasks.put(task);
  });
  return task;
}

/** 删除任务 */
export async function deleteDailyTask(id) {
  // round15 P2：delete + 墓碑包进同一事务——此前无事务，墓碑写失败时对端无墓碑
  // 会把已删任务推回，删除永不生效。
  await db.transaction('rw', db.dailyTasks, db.tombstones, async () => {
    await db.dailyTasks.delete(id);
    await db.tombstones.put({ id, kind: 'dailyTask', deletedAt: now() });
  });
}

/**
 * 中途追加任务到现有当日计划（口述/手动添加均可）。
 * @param {string} planId 关联的 dailyPlans.id
 * @param {object} task 任务字段（title/type/quadrant/...），缺省字段会被填默认值
 */
export async function addDailyTask(planId, task = {}) {
  const plan = await db.dailyPlans.get(planId);
  if (!plan) throw new Error('当日计划不存在，请先创建计划');
  const t = now();
  const row = {
    id: uid(),
    planId,
    date: plan.date,
    title: String(task.title || '新任务').slice(0, 200),
    type: task.type || 'other',
    important: !!task.important,
    urgent: !!task.urgent,
    quadrant: task.quadrant || 'Q4',
    targetCount: Number.isFinite(task.targetCount) ? Number(task.targetCount) : null,
    estimatedMinutes: Number.isFinite(task.estimatedMinutes) ? Number(task.estimatedMinutes) : null,
    subject: task.subject || '',
    scheduledHour: Number.isFinite(task.scheduledHour) ? Math.floor(task.scheduledHour) : null,
    status: 'pending',
    completedAt: null,
    completionNote: '',
    createdAt: t, updatedAt: t,
  };
  await db.dailyTasks.put(row);
  // 同步更新计划头的 updatedAt（便于跨设备同步）
  await db.dailyPlans.put({ ...plan, updatedAt: t });
  fireHook('onDailyTaskAdded', row);
  return row;
}

/** 把口述文本解析后批量追加到现有当日计划（中途补充） */
export async function appendDailyTasksByText(planId, text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const { parsePlan } = await import('./utils/plan-parser.js');
  const parsed = parsePlan(raw);
  const rows = [];
  for (const p of parsed) rows.push(await addDailyTask(planId, p));
  return rows;
}

/**
 * 级联删除某计划下的全部任务，并为每一行写 dailyTask 墓碑。
 * 只删行不写墓碑的话，对端设备下次同步会把这些任务原样推回来（删除永不生效）。
 * @returns {Promise<number>} 删除的任务数
 */
async function cascadeDeletePlanTasks(planId, ts = now()) {
  const tasks = await db.dailyTasks.where('planId').equals(planId).toArray();
  if (!tasks.length) return 0;
  await db.dailyTasks.where('planId').equals(planId).delete();
  await db.tombstones.bulkPut(tasks.map(x => ({ id: x.id, kind: 'dailyTask', deletedAt: ts })));
  return tasks.length;
}

/** 删除整日计划 + 其任务（联级） */
export async function deleteDailyPlan(planId) {
  const t = now();
  // round17 R17-10：删计划 + 级联删任务 + 双墓碑包进同一事务（createDailyPlan:606 已事务化，
  // 删除路径此前漏了同款）——中途任一步异常会留下「计划没了但任务/墓碑残留」的孤儿数据，
  // 且墓碑缺失会让对端同步把已删任务推回
  await db.transaction('rw', db.dailyPlans, db.dailyTasks, db.tombstones, async () => {
    await cascadeDeletePlanTasks(planId, t);
    await db.dailyPlans.delete(planId);
    await db.tombstones.put({ id: planId, kind: 'dailyPlan', deletedAt: t });
  });
}

/**
 * 任务打卡：设置状态 + 完成时间 + 备注。
 * @param {string} taskId
 * @param {'done'|'partial'|'skipped'|'pending'} status
 * @param {string} note 备注
 */
export async function checkinDailyTask(taskId, status = 'done', note = '') {
  return db.transaction('rw', db.dailyTasks, async () => {
    const old = await db.dailyTasks.get(taskId);
    if (!old) throw new Error('任务不存在');
    const valid = ['done', 'partial', 'skipped', 'pending'];
    if (!valid.includes(status)) throw new Error('非法打卡状态');
    const task = {
      ...old,
      status,
      completedAt: status === 'done' ? now() : null,
      completionNote: note,
      updatedAt: now(),
    };
    await db.dailyTasks.put(task);
    fireHook('onDailyTaskCheckin', task);
    return task;
  });
}

// ───────────── 跨模块协同（D8.4）：打卡时拉真实数据 ─────────────

/**
 * 拉取某天的真实学习数据，用于任务打卡时对比。
 * @returns {{
 *   reviewsToday: number,          // 今日复习次数
 *   pomodoroMinutes: number,       // 今日番茄分钟
 *   docsToday: number,             // 今日新建/阅读资料数
 * }}
 */
export async function getDailyReality(date = localDateStr()) {
  // 审计 B3：窗口统一走 repo-core.dayWindowOf（左闭右开），与 computeStats 同一口径
  const { start: dayStart, end: dayEnd } = dayWindowOf(new Date(`${date}T00:00:00`).getTime());

  // 今日复习数（reviews 表）
  let reviewsToday = 0;
  try {
    // 左闭右开：与 dayWindowOf 一致（此前 end 取闭区间会把次日 00:00:00 整点那条算进来）
    reviewsToday = await db.reviews.where('reviewedAt').between(dayStart, dayEnd, true, false).count();
  } catch { reviewsToday = 0; }

  // 今日番茄分钟（pomoSessions 表）
  let pomodoroMinutes = 0;
  try {
    const sessions = await db.pomoSessions.where('startedAt').between(dayStart, dayEnd, true, true).toArray();
    // round17 R17-1：pomoSessions 的字段是 duration（单位：分钟，见 addPomoSession），
    // 此前误读 durationMs 并再 ÷60000 —— 该字段根本不存在，专注分钟恒为 0。
    // 与 analytics.js:144 / intelligence.js / WeeklyReport 的已有口径对齐。
    pomodoroMinutes = Math.round(sessions.reduce((s, x) => s + (x?.duration || 0), 0));
  } catch { pomodoroMinutes = 0; }

  // 今日新建资料（docFiles 表，createdAt）
  let docsToday = 0;
  try {
    docsToday = await db.docFiles.where('createdAt').between(dayStart, dayEnd, true, true).count();
  } catch { docsToday = 0; }

  return { reviewsToday, pomodoroMinutes, docsToday };
}

// ───────────── 笔记（D3.1：完整笔记系统，区别于 memos 四象限短备忘） ─────────────

/**
 * 列表（按 updatedAt 倒序），支持 q 关键词、category、tags 过滤
 */
export async function listNotes({ q = '', category = '', tags = [] } = {}) {
  let rows = await db.notes.orderBy('updatedAt').reverse().toArray();
  if (category) rows = rows.filter(n => (n.category || '') === category);
  if (Array.isArray(tags) && tags.length) {
    const setLower = new Set(tags.map(t => String(t).toLowerCase()));
    rows = rows.filter(n => Array.isArray(n.tags) && n.tags.some(t => setLower.has(String(t).toLowerCase())));
  }
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter(n =>
      (n.title || '').toLowerCase().includes(ql)
      || (n.content || '').toLowerCase().includes(ql)
      || (n.category || '').toLowerCase().includes(ql)
      || (Array.isArray(n.tags) && n.tags.some(t => String(t).toLowerCase().includes(ql)))
    );
  }
  return rows;
}

export async function getNote(id) {
  return db.notes.get(id);
}

/** 创建笔记（自动从 content/tags 抽取双向链接与 #标签） */
export async function createNote(payload) {
  const norm = normalizeNotePayload(payload);
  const check = validateNote(norm);
  if (!check.valid) throw new Error('笔记无效：' + check.errors.join('；'));
  const t = now();
  const note = { id: uid(), ...norm, createdAt: t, updatedAt: t };
  await db.notes.put(note);
  fireHook('onNoteSaved', note);
  return note;
}

/** 更新笔记（重新抽取链接 + 标签；只要传入的字段就以传入为准，未传字段保留原值） */
export async function updateNote(id, payload) {
  // 审计：事务内重读+合并，防止并发编辑 lost update（笔记长文 Markdown 并发窗口更实际）
  return db.transaction('rw', db.notes, async () => {
    const cur = await db.notes.get(id);
    if (!cur) return null;
    const norm = normalizeNotePayload({ ...cur, ...payload, createdAt: cur.createdAt });
    const check = validateNote(norm);
    if (!check.valid) throw new Error('笔记无效：' + check.errors.join('；'));
    const t = now();
    const out = { ...cur, ...norm, id, updatedAt: t };
    await db.notes.put(out);
    fireHook('onNoteSaved', out);
    return out;
  });
}

export async function deleteNote(id) {
  const old = await db.notes.get(id);
  if (!old) return;
  // 审计 F-22：级联清洗引用——笔记的 linkedCardIds 记录了关联卡片，
  // 删笔记后卡片侧的「关联笔记」信息成为幽灵引用。
  const linkedCardIds = Array.isArray(old.linkedCardIds) ? old.linkedCardIds : [];
  await db.transaction('rw', db.notes, db.trash, db.tombstones, db.cards, async () => {
    await trashItem(id, 'note', old);
    await db.notes.delete(id);
    await db.tombstones.put({ id, kind: 'note', deletedAt: now() });
    // 反向清洗：卡片侧的 notes 引用（通过 card.linkedNoteIds 或 content 引用）
    if (linkedCardIds.length) {
      const cards = (await db.cards.bulkGet(linkedCardIds)).filter(Boolean);
      for (const c of cards) {
        if (Array.isArray(c.linkedNoteIds) && c.linkedNoteIds.includes(id)) {
          await db.cards.update(c.id, { linkedNoteIds: c.linkedNoteIds.filter(x => x !== id), updatedAt: now() });
        }
      }
    }
  });
}

/** 反向链接：哪些笔记的 content 里有 [[id]]？ */
export async function findNotesLinkingTo(targetId) {
  const notes = await db.notes.toArray();
  return notes.filter(n => (n?.content || '') && recognizeWikiLinks(n.content).some(l => l.id === targetId));
}

/** 取得所有 notes 的分类（去重，按字母序） */
export async function getNoteCategories() {
  const rows = await db.notes.toArray();
  const set = new Set();
  for (const n of rows) {
    const c = (n.category || '').trim();
    if (c) set.add(c);
  }
  return [...set].sort();
}

/** 取得所有 notes 用过的标签集合（去重） */
export async function getNoteTags() {
  const rows = await db.notes.toArray();
  const set = new Set();
  for (const n of rows) if (Array.isArray(n.tags)) for (const t of n.tags) if (t) set.add(String(t).toLowerCase());
  return [...set].sort();
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
  return db.transaction('rw', db.plans, async () => {
    const old = await db.plans.get(id);
    if (!old) throw new Error('计划不存在');
    const p = plain({ ...old, ...(patch || {}), updatedAt: now() });
    await db.plans.put(p);
    return p;
  });
}
export async function deletePlan(id) {
  const old = await db.plans.get(id);
  if (!old) return;
  await db.transaction('rw', db.plans, db.trash, db.tombstones, async () => {
    await trashItem(id, 'plan', old);
    await db.plans.delete(id);
    await db.tombstones.put({ id, kind: 'plan', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
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
  // round26 H-2：卡片边走 fromCardId 索引范围查询（每卡出边量小），
  // docId/遗留 label 边保留 filter 全表扫（调用频次低，全表边数千以内可接受）。
  let exists = null;
  if (docId) {
    exists = await db.graphEdges.filter(e => e.docId === docId && e.to === to && (e.label || '相关') === label).first();
  } else if (fromCardId && toCardId) {
    exists = await db.graphEdges
      .where('fromCardId').equals(fromCardId)
      .and(e => e.toCardId === toCardId && (e.label || '相关') === label)
      .first();
  } else {
    exists = await db.graphEdges.filter(e => e.from === from && e.to === to && (e.label || '相关') === label).first();
  }
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
  // round15 P2：delete + 墓碑同事务（防墓碑写失败导致对端回灌已删边）
  await db.transaction('rw', db.graphEdges, db.tombstones, async () => {
    await db.graphEdges.delete(id);
    await db.tombstones.put({ id, kind: 'graphEdge', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
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
  return db.transaction('rw', db.docs, async () => {
    const old = await db.docs.get(id);
    if (!old) throw new Error('文档不存在');
    const d = plain({ ...old, ...(patch || {}), updatedAt: now() });
    await db.docs.put(d);
    return d;
  });
}
export async function deleteDoc(id) {
  const old = await db.docs.get(id);
  if (!old) return;
  // 审计 F-2：补全级联——此前只有 3 步（trashItem→delete→tombstone），缺少：
  //   ① docTexts 快照（恢复时无全文）
  //   ② graphEdges 快照+删+墓碑（幽灵边常驻并跨设备传播）
  //   ③ embeddings 删+墓碑（RAG 检索到已删资料的幽灵向量）
  const text = await db.docTexts.get(id);
  const edgeMap = new Map();
  for (const e of await db.graphEdges.where('from').equals(id).toArray()) edgeMap.set(e.id, e);
  for (const e of await db.graphEdges.where('to').equals(id).toArray()) edgeMap.set(e.id, e);
  const edges = [...edgeMap.values()];
  const embRows = await db.embeddings.where('sourceId').equals(id).and(e => e.sourceType === 'doc').toArray();
  await db.transaction('rw', db.docs, db.trash, db.tombstones, db.docTexts, db.graphEdges, db.embeddings, async () => {
    await trashItem(id, 'doc', { ...old, _text: text?.text || null, _textLen: text?.textLen || null, _edges: edges });
    await db.docs.delete(id);
    await db.tombstones.put({ id, kind: 'doc', deletedAt: now() });
    // 级联删 docTexts
    if (text) await db.docTexts.delete(id);
    // 级联删 graphEdges + 墓碑
    if (edges.length) {
      await db.tombstones.bulkPut(edges.map(e => ({ id: e.id, kind: 'graphEdge', deletedAt: now() })));
      await db.graphEdges.bulkDelete(edges.map(e => e.id));
    }
    // 级联删 embeddings + 墓碑
    if (embRows.length) {
      await db.tombstones.bulkPut(embRows.map(e => ({ id: e.id, kind: 'embedding', deletedAt: now() })));
      await db.embeddings.bulkDelete(embRows.map(e => e.id));
    }
  });
}

// ---------- 番茄专注记录（可持久化、随数据包同步） ----------
/**
 * 记录一次专注。
 * duration 单位**分钟**（与 analytics/intelligence/WeeklyReport 口径一致，见 round17 R17-1）。
 * partial=1 表示「未跑满一个完整番茄」（如中途关页、提前结束）：
 *   其 duration 仍计入「专注分钟」统计（真实付出，不该抹掉），
 *   但不计入「今日番茄数 / 成就进度」——否则开 2 分钟关页也能刷满成就（round18 R18-6）。
 * 旧数据无 partial 字段 → 视为完整番茄，向后兼容。
 */
export async function addPomoSession(payload) {
  const t = now();
  const s = {
    id: uid(),
    startedAt: payload?.startedAt || t,
    duration: Number(payload?.duration) || 0, // 分钟
    tag: String(payload?.tag || '').trim().slice(0, 30),
    partial: payload?.partial ? 1 : 0,
    createdAt: t,
  };
  // M-1：roundId 存入数据库——即便 localStorage 被清，同 roundId 拒绝二次入账。
  // v28 schema 已建 roundId 索引，Pomodoro.vue finish() 传入 roundId 参数。
  if (payload?.roundId) s.roundId = String(payload.roundId);
  await db.pomoSessions.put(s);
  return s;
}
export async function listPomoSessions(limit = 200) {
  return db.pomoSessions.orderBy('startedAt').reverse().limit(limit).toArray();
}
/**
 * 今日**完整**番茄数（partial 不计）。
 * 数据源 = pomoSessions 表（随同步跨设备一致），跨天自动归零。
 */
/**
 * 单一事实源（round19 R19-2 根治）：一个番茄会话是否计入「完整番茄数/成就」。
 * 未跑满一个完整番茄的 partial 会话（中途关页、提前结束）不计入——否则开 2 分钟关页
 * 也能刷出 pomo_1/pomo_50。countPomoToday / achievements / analytics / WeeklyReport
 * 全部走它，避免口径再次分裂。
 * @param {object} p pomoSessions 行（需含 partial 字段；旧数据无该字段视为完整番茄）
 */
export function isPomoCountable(p) {
  return !p || !p.partial;
}

export async function countPomoToday() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  // H-3：原实现先把今日全部行 toArray() 再内存 .filter(partial) —— partial 行多时
  // 整批拉回内存。改为 .and() 在索引游标上过滤 + count()，全程流式不物化。
  return db.pomoSessions.where('startedAt').aboveOrEqual(dayStart.getTime())
    .and((p) => isPomoCountable(p))
    .count();
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
  return db.transaction('rw', db.mindmaps, async () => {
    const old = await db.mindmaps.get(id);
    if (!old) throw new Error('导图不存在');
    const m = plain({ ...old, ...(patch || {}), updatedAt: now() });
    await db.mindmaps.put(m);
    return m;
  });
}
export async function deleteMindmap(id) {
  const old = await db.mindmaps.get(id);
  if (!old) return;
  await db.transaction('rw', db.mindmaps, db.trash, db.tombstones, async () => {
    await trashItem(id, 'mindmap', old);
    await db.mindmaps.delete(id);
    await db.tombstones.put({ id, kind: 'mindmap', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
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
  // round15 P2：delete + 墓碑同事务
  await db.transaction('rw', db.weeklyReports, db.tombstones, async () => {
    await db.weeklyReports.delete(id);
    await db.tombstones.put({ id, kind: 'weeklyReport', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
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
    // round15 P2：与其它写库一致 plain() 脱壳——此前直接存 payload.questions，
    // 调用方若传 Vue reactive 数组，Dexie structuredClone 抛 DataCloneError 整单写不进
    questions: Array.isArray(payload?.questions) ? plain(payload.questions) : [],
    score: Number(payload?.score) || 0,
    total: Number(payload?.total) || 0,
    createdAt: t, updatedAt: t,
  };
  await db.exams.put(e);
  fireHook('onExamFinished', e);
  return e;
}
export async function deleteExam(id) {
  // round15 P2：delete + 墓碑同事务
  await db.transaction('rw', db.exams, db.tombstones, async () => {
    await db.exams.delete(id);
    await db.tombstones.put({ id, kind: 'exam', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
}
export async function updateExam(id, patch) {
  return db.transaction('rw', db.exams, async () => {
    const old = await db.exams.get(id);
    if (!old) throw new Error('成绩不存在');
    const e = plain({ ...old, ...(patch || {}), updatedAt: now() });
    await db.exams.put(e);
    return e;
  });
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
  const tIdx = db.userOps.where('t');
  // 审计 D9：无 from 时原实现全表 toArray + 内存过滤（埋点十万行场景徒增物化）。
  // 统一用 't' 索引范围，只物化 [0, to] 区间。
  const arr = from > 0
    ? await tIdx.between(from, to, true, true).toArray()
    : await tIdx.belowOrEqual(to).toArray();
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
// 卡片展示名：空卡面用语言中立的 '—' 占位。
// 数据层不能产出中文占位符（旧实现写死 '（空卡）'）—— 它不经过 i18n，英文界面下会露馅。
function cardLabel(card, max = 30) {
  const s = String(card?.front || '').trim();
  return s ? s.slice(0, max) : '—';
}

export async function bestWorstPartners({ rangeDays = 7, kind = 'D', worst = false }) {
  const since = Date.now() - rangeDays * 24 * 3600 * 1000;
  const ops = await db.userOps.where('t').above(since - 1).toArray();
  // 结论文案不再在这里拼中文：数据层只回 i18n code + params，
  // 由视图用 t('views.userDashboard.partner.<code>.title', undefined, params) 组装。
  // 旧实现把 localized 散文埋在领域层里 —— 切英文后整块结论仍是中文，且无法单测。
  const dataNotEnough = {
    notEnough: true,
    items: [],
    i18n: { code: 'notEnough', params: { days: rangeDays } },
  };

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
      items: arr.slice(0, 5),
      primary: top.key,
      i18n: {
        code: worst ? 'a.worst' : 'a.best',
        params: { days: rangeDays, name: top.key, count: top.count },
      },
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
      items: arr.slice(0, 5),
      primary: top.key,
      i18n: {
        code: worst ? 'b.worst' : 'b.best',
        params: { days: rangeDays, name: top.key, count: top.count },
      },
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
    if (worst) {
      // 审计 B7：共现一次的组合（count=1）只是复习序列里两张相邻卡的随机噪声，不是
      // 「弱关联」信号——若在它们里比「最少」，几乎总是从一大堆 count=1 里挑一个，
      // 结论无意义且对 Map 插入序敏感。故「最少共现」只在真正重复出现（count>=2）的
      // 组合里比较：出现得最少但仍成对 = 最弱的真实联系，建议才成立。
      arr = arr.filter(x => x.count >= 2);
      if (!arr.length) return dataNotEnough;
    }
    // 排序加 key 字典序决胜：消除同 count 时对遍历顺序的依赖（确定性收敛）
    arr.sort((a, b) => (worst ? a.count - b.count : b.count - a.count) || (a.key < b.key ? -1 : 1));
    const top = arr[0];
    return {
      notEnough: false,
      items: arr.slice(0, 5),
      primary: top.key,
      i18n: {
        code: worst ? 'c.worst' : 'c.best',
        params: { days: rangeDays, name: top.key, count: top.count },
      },
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
        key: cardLabel(x.card),
        count: 0,
        cardId: x.card.id,
      }));
      return {
        notEnough: false,
        items: arr,
        primary: cardLabel(top, 40),
        cardId: top.id,
        i18n: {
          code: 'd.worst',
          // createdAt 传原始时间戳：日期的本地化交给视图层的 fmtLocaleDate，
          // 数据层不做 toLocaleDateString（那会跟随操作系统语言，而非用户在 App 里选的语言）
          params: { days: rangeDays, name: cardLabel(top, 50), createdAt: top.createdAt || 0 },
        },
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
      key: cardOf.get(x.cardId) ? cardLabel(cardOf.get(x.cardId)) : String(x.cardId).slice(0, 40),
      count: x.count,
      cardId: x.cardId,
    }));
    const top = items[0];
    return {
      notEnough: false,
      items,
      primary: top.key,
      cardId: top.cardId,
      i18n: {
        code: 'd.best',
        params: { days: rangeDays, name: top.key, count: top.count },
      },
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
    const dateKey = record?.date || `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}`;
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
      // 审计：以下5个 UI 字段在新建分支漏存——编辑靠 ...record 透传能存，新建却丢
      anxiety: Number(record?.anxiety) || 3,
      depression: Number(record?.depression) || 3,
      confidence: Number(record?.confidence) || 3,
      stressSource: record?.stressSource || '',
      exciteBlock: record?.exciteBlock || null,
      customTags: Array.isArray(record?.customTags) ? record.customTags : [],
      customKV: record?.customKV || {},
      createdAt: nowTs,
      updatedAt: nowTs,
    });
  }
  await db.privacyRecords.put(payload);
  return payload;
}
export async function listPrivacyRecords({ fromDate, toDate, type, limit = 500 } = {}) {
  // 审计 D2（limit 先于过滤会静默漏数）：原实现 `orderBy(updatedAt).limit(limit)` 先截断、
  // 再按 date/type 内存过滤——只要「最近 limit 条」里含被过滤掉的记录，更早的匹配行
  // 就永远不会返回（即使命中总量远超 limit）。date 已建索引（db.js v14）。改为一条
  // 索引范围查询定位匹配行，再在结果内 limit，保证「返回条数=min(命中,limit)」而非更少。
  let arr;
  const hasRange = !!fromDate || !!toDate;
  if (hasRange) {
    const from = fromDate || '0';
    const to = toDate || '\uffff';
    arr = await db.privacyRecords.where('date').between(from, to).toArray();
    if (type) arr = arr.filter(r => r.type === type);
    arr.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.id > a.id ? 1 : -1));
    return arr.slice(0, limit);
  }
  arr = await db.privacyRecords.orderBy('updatedAt').reverse().toArray();
  if (type) arr = arr.filter(r => r.type === type);
  return arr.slice(0, limit);
}
export async function getPrivacyRecord(id) { return (await db.privacyRecords.get(id)) || null; }
export async function deletePrivacyRecord(id) {
  // round15 P2：delete + 墓碑同事务（隐私表默认不入同步，但 opt-in 后墓碑必须可靠）
  await db.transaction('rw', db.privacyRecords, db.tombstones, async () => {
    await db.privacyRecords.delete(id);
    await db.tombstones.put({ id, kind: 'privacy', deletedAt: Date.now() });
  });
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

// ---------- M1 卡组（cardGroups + cardGroupLinks） ----------
// 卡片全局唯一、学习数据不随分组隔离：卡组只是「视图筛选 + 停车标记」，
// 复习动作始终写卡片的全局 SRS 字段。

/** 卡组列表（按 sortOrder, createdAt 排序） */
export async function listCardGroups() {
  const groups = await db.cardGroups.orderBy('sortOrder').toArray();
  return groups.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.createdAt - b.createdAt);
}

/** 新建卡组。返回卡组行 */
export async function createCardGroup({ name, description = '', color = '', status = 'active' }) {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('卡组名称不能为空');
  const maxSort = (await db.cardGroups.toCollection().count()) || 0;
  const row = {
    id: uid(),
    name: n,
    description: String(description ?? ''),
    color: String(color ?? ''),
    status: status === 'archived' ? 'archived' : 'active',
    sortOrder: maxSort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.cardGroups.add(row);
  fireHook('cardGroup.created', row);
  return row;
}

/** 更新卡组（重命名/描述/颜色/状态/排序）。只改传入字段，bump updatedAt */
export async function updateCardGroup(id, patch) {
  return db.transaction('rw', db.cardGroups, async () => {
    const cur = await db.cardGroups.get(id);
    if (!cur) return null;
    const next = { ...cur };
    for (const k of ['name', 'description', 'color', 'status']) {
      if (patch[k] !== undefined) next[k] = k === 'name' ? String(patch[k]).trim() : patch[k];
    }
    if (patch.sortOrder !== undefined) next.sortOrder = Number(patch.sortOrder) || 0;
    if (!next.name) throw new Error('卡组名称不能为空');
    next.updatedAt = Date.now();
    await db.cardGroups.put(next);
    fireHook('cardGroup.updated', next);
    return next;
  });
}

/** 删除卡组（级联删除其全部关联；卡片本身不受影响） */
export async function deleteCardGroup(id) {
  const g = await db.cardGroups.get(id);
  if (!g) return false;
  // 墓碑：卡组本体 kind=cardGroup、被级联删掉的全部关联行 kind=groupLink。
  // 此前两者都不写墓碑 —— 结果是「A 设备删卡组 → B 设备下次同步原样推回来」，
  // 删除永不生效（sync-manifest 的注释早就声明要走墓碑，只是实现没跟上）。
  // v40 卡组对等：与英语词组同机制，删前写回收站快照（含成员关联），回收站可恢复。
  await db.transaction('rw', db.cardGroups, db.cardGroupLinks, db.tombstones, db.trash, async () => {
    const links = await db.cardGroupLinks.where('groupId').equals(id).toArray();
    await trashItem(id, 'cardGroup', { ...plain(g), _groupLinks: links });
    await db.cardGroupLinks.where('groupId').equals(id).delete();
    await db.cardGroups.delete(id);
    await db.tombstones.put({ id, kind: 'cardGroup', deletedAt: now() });
    if (links.length) {
      await db.tombstones.bulkPut(links.map(l => ({ id: l.id, kind: 'groupLink', deletedAt: now() })));
    }
  });
  fireHook('cardGroup.deleted', g);
  return true;
}

/** 某卡组内的卡片 id 列表 */
export async function cardGroupCardIds(groupId) {
  const links = await db.cardGroupLinks.where('groupId').equals(groupId).toArray();
  return links.map(l => l.cardId);
}

/** 某卡片所属的卡组列表 */
export async function cardGroupsOfCard(cardId) {
  const links = await db.cardGroupLinks.where('cardId').equals(cardId).toArray();
  const groups = await db.cardGroups.bulkGet(links.map(l => l.groupId));
  return groups.filter(Boolean);
}

/**
 * 把一组卡片移入/移出多个卡组。
 * 移入：按 (cardId, groupId) 幂等（已存在不重复插入）；
 * 移出：删行即操作（同步端按墓碑时间戳合并「移入 vs 移出」冲突，见 sync-manifest 注释）
 */
export async function setCardGroups(cardIds, addGroupIds = [], removeGroupIds = []) {
  const t0 = Date.now();
  let added = 0, removed = 0;
  // 事务必须声明全部涉及表（cards/cardGroups/cardGroupLinks/tombstones）：
  // 漏声明的表在事务内访问会触发嵌套事务（fake-indexeddb 直接 NotFoundError，浏览器里死锁）
  await db.transaction('rw', db.cards, db.cardGroups, db.cardGroupLinks, db.tombstones, async () => {
    const cards = (cardIds && cardIds.length) ? await db.cards.bulkGet(cardIds) : [];
    const validIds = cards.filter(Boolean).map(c => c.id);
    const validAdd = new Set((await db.cardGroups.bulkGet(addGroupIds || [])).filter(Boolean).map(g => g.id));
    const validRemove = new Set((await db.cardGroups.bulkGet(removeGroupIds || [])).filter(Boolean).map(g => g.id));
    if (validAdd.size) {
      const existing = await db.cardGroupLinks.where('groupId').anyOf([...validAdd]).toArray();
      const existSet = new Set(existing.map(l => `${l.cardId}|${l.groupId}`));
      const toAdd = [];
      for (const cid of validIds) for (const gid of validAdd) {
        if (!existSet.has(`${cid}|${gid}`)) {
          toAdd.push({ id: uid(), cardId: cid, groupId: gid, addedAt: t0 });
          existSet.add(`${cid}|${gid}`);
        }
      }
      if (toAdd.length) { added = toAdd.length; await db.cardGroupLinks.bulkAdd(toAdd); }
    }
    if (validRemove.size) {
      const toDel = await db.cardGroupLinks.where('cardId').anyOf(validIds).toArray();
      const gone = toDel.filter(l => validRemove.has(l.groupId));
      if (gone.length) {
        removed = gone.length;
        await db.cardGroupLinks.bulkDelete(gone.map(l => l.id));
        // 「移出」必须写墓碑，否则对端会在下次同步把这条关联推回来（移出永不生效）。
        // 冲突裁决由 sync-manifest 的 applyTombstones 负责：
        //   移出时间(deletedAt) vs 加入时间(addedAt) 谁新听谁。
        // 注意：重新移入会生成全新的 link id（uid），不会被旧墓碑误删。
        await db.tombstones.bulkPut(gone.map(l => ({ id: l.id, kind: 'groupLink', deletedAt: t0 })));
      }
    }
  });
  fireHook('cardGroup.linked', { cardIds, addGroupIds, removeGroupIds });
  return { added, removed };
}

/**
 * 复习候选卡组的「停车」判断（M1 核心规则）：
 * 一张卡属于任意 active 卡组 → 可进入默认复习队列；
 * 只属于 archived 卡组（或不属于任何卡组）→ 不进默认队列（「未分组的卡照旧参与」保持向后兼容）。
 * 返回 { parked: 被停车的卡 id 集合 }，供 Review 构建队列时排除。
 */
export async function getParkedCardIds() {
  const [links, groups, cards] = await Promise.all([
    db.cardGroupLinks.toArray(),
    db.cardGroups.toArray(),
    db.cards.toArray(),
  ]);
  if (!groups.length || !links.length) return new Set();
  const statusOf = new Map(groups.map(g => [g.id, g.status]));
  const activeOf = new Map(); // cardId -> 是否有 active 卡组
  const anyOf = new Set();     // cardId -> 是否属于任意卡组
  for (const l of links) {
    anyOf.add(l.cardId);
    if (statusOf.get(l.groupId) === 'active') activeOf.set(l.cardId, true);
  }
  // 只把「显式分过组且全在备用组」的卡停车；未分组卡保持旧行为（照常复习）
  const parked = new Set();
  for (const c of cards) {
    if (anyOf.has(c.id) && !activeOf.has(c.id)) parked.add(c.id);
  }
  return parked;
}

// ---------- v31：通用卡 ↔ 英语词卡链接（cardWordLinks，多对多「同一知识点」） ----------
// 设计：只存映射，不互串内容。cards 与 wordCards 字段/SRS 各自独立同步，
//   本表让通用卡详情可挂多个英语词（如「操作系统死锁」卡挂「deadlock」词卡），
//   英语词详情可回看其通用卡；随 sync-manifest 的 idOnly 策略跨设备一致。
// id = `${cardId}:${wordCardId}` 确定性拼接，两端同 id 幂等。

export async function linkCardWord(cardId, wordCardId) {
  if (!cardId || !wordCardId) return null;
  const id = `${cardId}:${wordCardId}`;
  const row = { id, cardId, wordCardId, addedAt: Date.now() };
  await db.cardWordLinks.put(row);
  return row;
}

export async function unlinkCardWord(cardId, wordCardId) {
  const id = `${cardId}:${wordCardId}`;
  const cur = await db.cardWordLinks.get(id);
  if (!cur) return false;
  await db.transaction('rw', db.cardWordLinks, db.tombstones, async () => {
    await db.cardWordLinks.delete(id);
    await db.tombstones.put({ id, kind: 'cardWordLink', deletedAt: Date.now() });
  });
  return true;
}

export async function wordCardsOfCard(cardId) {
  const links = await db.cardWordLinks.where('cardId').equals(cardId).sortBy('addedAt');
  if (!links.length) return [];
  const cards = await db.wordCards.bulkGet(links.map(l => l.wordCardId));
  return links.map(l => cards.find(c => c && c.id === l.wordCardId)).filter(Boolean);
}

export async function cardOfWord(wordCardId) {
  // 反向查找：一个英语词可对应多张通用卡，返回第一张（按 addedAt 最早）
  const links = await db.cardWordLinks.where('wordCardId').equals(wordCardId).sortBy('addedAt');
  if (!links.length) return null;
  const c = await db.cards.get(links[0].cardId);
  return c || null;
}

export async function allCardWordLinks() {
  return db.cardWordLinks.toArray();
}