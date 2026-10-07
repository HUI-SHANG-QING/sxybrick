// 本文件由 repo.js 物理拆分而来（方案 A：**只搬移、不改任何逻辑**）。
// 业务域：卡片 CRUD / 复习调度 / 统计缓存 / 回收站 / 笔记·资料·导图·考试·周报·成就 / 关联表 / 孤儿清理（底层）
// 依赖方向：本文件 → db.js|srs.js|...（最底层，无同层依赖）
// 5 个模块级缓存变量（_schedCache/_dashSnap/_dashLoading/_failCountCache/_failCountForced）
// 与其读写函数同处 cards.js —— 缓存绝不分裂。

// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid, currentDbMode } from '../db.js';
import { applyFeedback, scheduleReview, seedFsrsFromSm2, RETRIEVAL_STRENGTH_OPTIONS } from '../srs.js';
// P3-4 插件事件钩子：业务动作后向已启用插件分发（fire-and-forget，不阻塞也不抛错）
// 静态导入无循环依赖：plugins/registry 只依赖 db.js 与 agent/registry.js，不依赖 repo.js
import { triggerHook } from '../plugins/registry.js';
// P1-3 检索强度分级选项：供 Review.vue 等 UI 直接渲染选择器
export { RETRIEVAL_STRENGTH_OPTIONS };
import { mergeUserWeights, retrievability } from '../fsrs.js';
import { extractImageIds, IMAGE_REF_TABLES } from '../images.js';
import { initialStabilityForCard } from '../algorithms/pretest.js';
import { buildReviewSession, retrievalGrading } from '../algorithms/session.js';
// D3.1 笔记解析纯函数（双向链接 + 标签抽取 + 归一化）
import { normalizeNotePayload, validateNote, recognizeWikiLinks } from '../utils/note-parser.js';
// P1-18 统一格式化（日期补零 / 字节）收口到 format.js，消除全局重复实现
// 审计 D7：日期 key 统一走 time.dateKey（补零 yyyy-MM-dd），与 word/streak 同源，
// 否则 repo 本地一份 localDateStr 独立实现会在未来格式演进时跨表整日错位。
import { dateKey as createDateKey } from '../utils/time.js';
import { CARD_CONTENT_FIELDS, tombKindTable } from '../sync-manifest.js';
// 向量行 id 的确定性形态与前缀匹配（agent/embedding-key.js 无任何依赖，静态导入不成环）
import { embeddingIdPrefix } from '../agent/embedding-key.js';
// N9 纯函数层：校验/过滤/排序/统计逻辑抽至 repo-core.js（Node 可单测），repo.js 只做 IO 编排
import { DEFAULT_SUBJECTS, validateCard as _validateCard, tagFilter, applyCardFilters, gradeCard as _gradeCard, WRONG_REASON_MAP as _WRONG_REASON_MAP, WRONG_REASONS as _WRONG_REASONS, wrongReasonToCode as _wrongReasonToCode, formatDue as _formatDue, filterReviewCandidates, dueOf, rankWeakCards, buildReviewSuggestion, computeStats, isRealReview, realReviews } from '../repo-core.js';
export { DEFAULT_SUBJECTS };
export const validateCard = _validateCard;
export const gradeCard = _gradeCard;
export const WRONG_REASON_MAP = _WRONG_REASON_MAP;
export const WRONG_REASONS = _WRONG_REASONS;
export const wrongReasonToCode = _wrongReasonToCode;
export const formatDue = (ts) => _formatDue(ts);
// round29：re-export 供列表侧复用——错题集等自定义数据源要按与 listCards 完全一致的
// AND/OR/NOT 语义过滤标签，此前 Cards.vue 拿不到它（只在 listCards 内部用）。
export { tagFilter, applyCardFilters };

// round30 P2-7：单日任务时长绝对上界（分钟）。单任务不可能超过一天，
// 防止 LLM/手动输入超大值污染时间轴渲染、联动分析（规划/实际完成率）与跨设备同步。
// round30 P2-7：单日任务时长绝对上界（分钟）。单任务不可能超过一天，
// 防止 LLM/手动输入超大值污染时间轴渲染、联动分析（规划/实际完成率）与跨设备同步。
const MAX_ESTIMATED_MINUTES = 1440;
// 审计 C1/C4：跨设备时钟与同毫秒覆盖主要通过「确定性决胜 + 严格比较」在 sync-manifest
// 的纯合并函数里根治（mergeCardPair/mergeTombstones 已改 `>` + 字典序收敛）。
// 此处 now() 保持墙钟即可——在整进程内混用「单调时钟」与多处裸 Date.now() 会破坏
// deleteCard/restoreFromTrash 等既有「updatedAt 必须晚于墓碑」的不变量，得不偿失。
// 完整跨设备时钟偏置免疫需 per-epoch（ts,uuid）元组，属更大改造，未在此次混入。
const now = () => Date.now();

// P3-4 插件钩子触发：fire-and-forget（插件抛错/慢执行绝不影响主流程）
// P3-4 插件钩子触发：fire-and-forget（插件抛错/慢执行绝不影响主流程）
function fireHook(event, ...args) {
  triggerHook(event, ...args).catch(() => {});
}

// P1-1 FSRS 调度配置缓存：避免每次复习都查 db.meta（scheduler/fsrsWeights）
// P1-1 FSRS 调度配置缓存：避免每次复习都查 db.meta（scheduler/fsrsWeights）
let _schedCache = null;
export async function getSchedConfig() {
  // round68 S7（P2）：缓存必须校验 db 实例 mode——setDbInstance('test'/'real') 切换
  // 实例后 60s 内，旧缓存会让演示/真实库混用另一实例的 scheduler/weights
  // （dashboardSnapshot 的 key 已纳入 mode，此处补齐同款口径）。
  if (_schedCache && _schedCache.mode === currentDbMode() && Date.now() - _schedCache.loadedAt < 60000) return _schedCache;
  const [sched, wRow] = await Promise.all([db.meta.get('scheduler'), db.meta.get('fsrsWeights')]);
  _schedCache = {
    scheduler: sched?.value === 'fsrs' ? 'fsrs' : 'sm2',
    weights: mergeUserWeights(wRow?.value),
    loadedAt: Date.now(),
    mode: currentDbMode(),
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
      // 审计（调度器切换语义边界）：此前过滤 `!r.consolidation`，把正处于 SM-2 巩固阶段
      // （consolidation=1 当日巩固 / 2 隔日巩固）的卡**排除在 FSRS 播种之外**——
      // 于是这批卡与其余卡走了两套口径（其余有播种 fsrs 状态，这批没有），
      // 切回 SM-2 时又带着旧的巩固阶段继续跑，进度不可比。
      // 改为：只要已有复习进度（intervalDays>0）就一视同仁播种，
      // 巩固状态本身不在切换时清除——FSRS 路径本就会把 consolidation 写回 null
      // （fsrs.js:212 明确不复用 SM-2 巩固状态机），且 SM-2 侧有「巩固超期自动毕业」
      // 兜底（srs.js:85-89），不会残留僵死状态。
      const rows = await table.filter(r => !r.fsrs && (Number(r.intervalDays) > 0)).toArray();
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
// 剥离 Vue 响应式代理：Dexie put 前转纯对象，避免 reactive proxy 触发 IndexedDB 结构化克隆失败（思维导图等含嵌套对象的表曾因此保存失败）
const plain = (x) => JSON.parse(JSON.stringify(x));

// validateCard 已抽至 repo-core.js（上方 re-export 保持 API 不变）

// 导出供 intelligence.js 等模块复用（避免重复实现全量读取）
// 导出供 intelligence.js 等模块复用（避免重复实现全量读取）
export async function allCards() {
  return db.cards.toArray();
}

// ---------- 科目 / 标签 ----------
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
    if (subject && String(c.subject || '').trim() !== String(subject).trim()) continue;
    for (const t of (c.tags || [])) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// tagFilter 已抽至 repo-core.js（validateCard 同批）

// ---------- 卡片列表 ----------
// ---------- 卡片列表 ----------
export async function listCards({ q = '', subject = '', tags = [], logic = 'AND', mode = 'all', sortBy = 'updated' } = {}) {
  // M11：全量只读一次——dueCount 是全局到期数（与过滤条件无关），
  // 旧实现末尾再 allCards() 一次 = 每次列表查询 2 次全表扫描，万卡级约翻倍耗时
  const all = await allCards();
  // round29：筛选口径收敛到 repo-core.applyCardFilters（与错题集等自定义数据源同源）。
  // 语义不变：科目精确匹配；q 覆盖 正面/背面/标签/科目/来源/助记（大小写不敏感）；
  // 标签走 tagFilter 的 AND/OR/NOT。
  let cards = applyCardFilters(all, { q, subject, tags, logic });
  // round48：到期过滤统一走 dueOf（与下方 dueCount 同口径）——裸比较 `c.dueAt <= now()` 与
  // dueOf 在 dueAt 为 NaN 时结论相反（NaN<=now 恒 false；dueOf 归一到 0 视为到期），
  // 会出现「标题显示到期 N 张、列表却只有 N-1 条」的口径错位。
  if (mode === 'due') cards = cards.filter(c => dueOf(c) <= now());
  if (sortBy === 'created') cards.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  else if (sortBy === 'due') cards.sort((a, b) => (a.dueAt - b.dueAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  else if (sortBy === 'subject') cards.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || '')) || (b.updatedAt - a.updatedAt));
  else cards.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // round29：dueCount 是「全部卡片」的到期数（与筛选无关），此前在已经拿到 all 之后
  // 又全表 filter 一遍；排序本身是 O(n log n)，这里顺带一次遍历算完即可。
  const nowTs = now();
  let dueCount = 0;
  for (const c of all) if (dueOf(c) <= nowTs) dueCount++;
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
    // 审计 P2-2（round33）：创建时带错因则初始化 wrongReasonAt——否则合并侧 WRA=0
    // 时「优先保留有内容一方」会把后续清空操作顶回。
    wrongReasonAt: r.value.wrongReason ? t : 0,
    sourceCardId: r.value.sourceCardId || null,
    difficulty: r.value.difficulty,
    tags: r.value.tags, frontChars: [...r.value.front].length, backChars: [...r.value.back].length,
    // 审计 D1：初始 reviewedAt 显式为 0（与 word-repo.createWordCard 对齐），统一「未复习」
    // 哨兵语义。此前 cards 不写该字段（undefined），而 sync-manifest 曾用 `?? updatedAt`
    // 兜底，导致「只改内容未复习」的卡在 SRS 合并里覆盖对端已复习的调度。现在 0 是权威哨兵。
    ease: 2.5, level: 0, intervalDays: 0, reviewedAt: 0, fsrs: null, dueAt: t, createdAt: t, updatedAt: t,
    // round29：字段级合并的写入侧。新卡所有内容字段的时间戳 = 创建时刻；
    // 之后 updateCard 只 bump 本次真正改动的字段，让跨设备合并能逐字段取新
    // （不再整行覆盖）。老数据没有该字段 → 合并侧自动退回整行 LWW，向后兼容。
    fieldTs: CARD_CONTENT_FIELDS.reduce((m, f) => { m[f] = t; return m; }, {}),
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
      // 审计 P0：marked/difficulty 用 payload 显式传入值，未传则保留 old——
      // validateCard 是创建校验器，对未传字段硬编码默认值（marked:false, difficulty:'basic'），
      // 直接用 r.value 覆盖会把已标星的卡 marked:true→false、已设为 challenge 的卡重置为 basic。
      marked: payload.marked !== undefined ? r.value.marked : (old.marked ?? false),
      mnemonic: r.value.mnemonic,
      wrongReason: r.value.wrongReason,
      // 审计 P2-3（round33→34）：wrongReason 变化（含经 CardModal 清空）必须推进 wrongReasonAt。
      // round33 曾用「旧值+1」当清空哨兵——旧 WRA=0 时哨兵=1，对端任何真实时间戳必胜，
      // 清空仍被顶回。改为 now()，与 review 路径（:886）同口径：清空也按真实时间取新。
      wrongReasonAt: r.value.wrongReason !== (old.wrongReason || '') ? now() : (old.wrongReasonAt || 0),
      difficulty: payload.difficulty !== undefined ? r.value.difficulty : (old.difficulty ?? 'basic'),
      frontChars: [...r.value.front].length, backChars: [...r.value.back].length, updatedAt: now(),
    };
    // round29：只给「本次真正变化」的内容字段打时间戳（逐字段 diff）。
    // 这样设备 A 改 front、设备 B 改 back 时，合并侧能各自取新，而不是整行互相覆盖。
    const t = card.updatedAt;
    const fieldTs = { ...(old.fieldTs || {}) };
    for (const f of CARD_CONTENT_FIELDS) {
      if (JSON.stringify(card[f]) !== JSON.stringify(old[f])) fieldTs[f] = t;
    }
    card.fieldTs = fieldTs;
    await db.cards.put(card);
    // round75 审计：字段编辑后**显式失效**共享快照。
    // 快照 key 含「卡数 + 最大 updatedAt」，本函数 bump 了 updatedAt 故通常能天然换 key；
    // 但**同一毫秒内的第二次编辑**（updatedAt 与当前最大值相同）不会换 key → 命中陈旧快照，
    // 于是「知识净值 / 到期预测 / 来源血缘」这些走快照的分析会显示旧值。
    // 显式失效把这条例外彻底封死，且与 review / applyCardFeedback 等写路径口径一致。
    invalidateDashboardCache();
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
    // round68 S5（P2）：快照失败必须中止删除——此前仅 console + 返回 false，而全部
    // 调用点（deleteCard/deleteMemo/deleteNote/deleteDoc/deleteDailyPlan/deleteCardGroup/
    // deleteWordCard/deleteWordGroup/deleteDocFile 等）都未检查返回值 → 配额写满等场景下
    // 「回收站无快照 + 主行已被删」= 数据不可恢复。所有调用点均在 Dexie 事务内，
    // 抛错使整个删除事务回滚（主行/墓碑/级联一并撤销），失败路径有重试通道。
    console.warn('[trash] 回收站快照写入失败，中止本次删除（事务回滚）:', kind, id, e?.message || e);
    throw e;
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
    // 审计（round35 小问题1）：每日计划删除进回收站，恢复时还原计划+任务
    dailyPlan: 'dailyPlans',
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
  // v34：卡↔卡关联快照（deleteCard 双向快照）——不还原的话「删→恢复」后关联永久丢失，
  // 且残留墓碑会把重连尝试再删一遍（与 cwLinks 完全同机制）。
  const ccLinks = data._cardLinks || null;
  const linkedNoteIds = Array.isArray(data._linkedNoteIds) ? data._linkedNoteIds : null;
  // 审计 P0：deleteNote 快照含 linkedCardIds（笔记关联的卡片 id 列表），
  // deleteNote 事务清洗了卡片侧的 linkedNoteIds，恢复时必须加回。
  const noteLinkedCardIds = t.kind === 'note' && Array.isArray(data.linkedCardIds) ? data.linkedCardIds : null;
  const text = typeof data._text === 'string' ? data._text : null;
  // 审计 P3（round37）：_textLen 在下方的清理里被 delete，恢复写 docTexts 时再读
  // `data._textLen ?? text.length` 恒走 fallback → 原长度被静默改写（死代码）。
  // 删除前先取出，恢复时按快照原值还原。
  const savedTextLen = Number.isFinite(data._textLen) ? data._textLen : null;
  const edges = data._edges || null;
  // 审计（round35 小问题1）：每日计划快照含 _tasks，恢复时还原到 dailyTasks 表
  const dailyTasks = t.kind === 'dailyPlan' ? (data._tasks || null) : null;
  // round54 P1：卡片快照含 _images（删卡会级联物理删图），恢复时必须一并写回 db.images
  const cardImages = t.kind === 'card' && Array.isArray(data._images) ? data._images : null;
  // v35：卡片快照里的批注（deleteCard 会级联物理删批注 + 写墓碑）——不还原则「删→恢复」后
  // 批注永久丢失，且残留墓碑会把任何重建尝试再删一遍（与 _cardLinks/_images 同机制）。
  const annots = t.kind === 'card' && Array.isArray(data._annotations) ? data._annotations : null;
  delete data._reviews; delete data._groupLinks; delete data._text; delete data._textLen; delete data._edges;
  delete data._cardWordLinks; delete data._embeddings; delete data._linkedNoteIds; delete data._tasks;
  delete data._cardLinks; delete data._images; delete data._annotations;
  const transform = RESTORE_TRANSFORMS[t.kind];
  // round68 S6（P2）：恢复必须重盖 fieldTs——快照里的 fieldTs 是删除前的旧值，
  // 若对端仍持有墓碑（本端只清了本地墓碑），下轮同步字段级合并会因
  // fieldTs.* < 对端墓碑 deletedAt 把恢复的内容字段判为「已删字段」而清空。
  // 统一 bump 到恢复时刻，让恢复内容在字段层赢过所有旧墓碑（notes 路径 :459 已同款）。
  const restoredTs = Date.now();
  const restoredFieldTs = Object.keys(data.fieldTs || {}).length
    ? Object.fromEntries(Object.keys(data.fieldTs).map(k => [k, restoredTs]))
    : undefined;
  const row = { ...(transform ? transform(data) : data), id: t.id, updatedAt: restoredTs,
    ...(restoredFieldTs ? { fieldTs: restoredFieldTs } : {}) };
  const tables = [db[table], db.tombstones, db.trash];
  // P1-A：单词模块的附表与记忆卡不同（wordReviews / wordGroupLinks），按 kind 分流；
  // 记忆卡（card）与普通卡组（cardGroup）都走 reviews / cardGroupLinks（原逻辑）。
  const isWord = t.kind === 'wordCard' || t.kind === 'wordGroup';
  const reviewsTable = t.kind === 'wordCard' ? db.wordReviews : db.reviews;
  const linksTable = isWord ? db.wordGroupLinks : db.cardGroupLinks;
  if (reviews && reviews.length) tables.push(reviewsTable);
  if (links && links.length) tables.push(linksTable);
  if (cwLinks && cwLinks.length) tables.push(db.cardWordLinks);
  if (ccLinks && ccLinks.length) tables.push(db.cardLinks);
  if (text) tables.push(db.docTexts);
  if (edges && edges.length) tables.push(db.graphEdges);
  if (linkedNoteIds && linkedNoteIds.length) tables.push(db.notes);
  if (noteLinkedCardIds && noteLinkedCardIds.length) tables.push(db.cards);
  if (dailyTasks && dailyTasks.length) tables.push(db.dailyTasks);
  if (cardImages && cardImages.length) tables.push(db.images);
  if (annots && annots.length) tables.push(db.cardAnnots);
  await db.transaction('rw', ...tables, async () => {
    await db[table].put(row);
    // 审计 P2：恢复 note 时裁剪幽灵 linkedCardIds——快照中的 linkedCardIds 可能包含
    // 已被 pruneTrash 永久删除的卡片 ID（bulkGet 返回 null），残留会导致 UI 显示
    // 「关联了 N 张卡片」但点进去找不到对应卡片。事务内 bulkGet 求交集，只保留仍存在的卡片。
    if (t.kind === 'note' && noteLinkedCardIds && noteLinkedCardIds.length) {
      const existingCards = await db.cards.bulkGet(noteLinkedCardIds);
      const existingIds = existingCards.filter(Boolean).map(c => c.id);
      if (existingIds.length !== noteLinkedCardIds.length) {
        await db.notes.update(t.id, { linkedCardIds: existingIds, updatedAt: Date.now() });
      }
    }
    if (reviews && reviews.length) {
      // 复习快照的 cardId 即本卡 id，原样还原（review 自带 id 用于幂等覆盖）
      await reviewsTable.bulkPut(reviews.map(r => ({ ...r })));
      // round16 R16-1：恢复时清掉为这些复习记录写的墓碑，否则下次同步
      // 会被自己的墓碑重新删掉（与下方 groupLink 墓碑清理同机制）
      await db.tombstones.bulkDelete(reviews.map(r => r.id));
    }
    if (links && links.length) {
      // 审计 P1-2（round36）：links 同样 bump updatedAt——源端 deleteCard/deleteWordGroup
      // 会为这些关联行写墓碑，原样恢复的旧行在墓碑回灌下二次丢失（同 cwLinks/dailyTasks）。
      await linksTable.bulkPut(links.map(l => ({ ...l, updatedAt: Date.now() })));
      // 连带清除「删卡/删词组时为这些关联行写的墓碑」，否则恢复后
      // 下次同步会被自己的墓碑重新删掉（墓碑 deletedAt > link.addedAt）
      await db.tombstones.bulkDelete(links.map(l => l.id));
    }
    if (cwLinks && cwLinks.length) {
      // 审计 A2：还原卡↔词关联 + 清掉为这些链接写的墓碑（同 links 机制）
      // 审计 P1-2（round36）：恢复统一 bump updatedAt——原样写回的旧时间戳小于对端墓碑
      // deletedAt，下轮同步墓碑回灌会把恢复的行再删一遍（快照已消费 → 永久丢失）。
      await db.cardWordLinks.bulkPut(cwLinks.map(l => ({ ...l, updatedAt: Date.now() })));
      await db.tombstones.bulkDelete(cwLinks.map(l => l.id));
    }
    if (annots && annots.length) {
      // v35：还原批注 + 清掉删卡时为它们写的墓碑（同 cwLinks 机制）。
      // 必须 bump updatedAt：原样写回的旧时间戳 < 对端墓碑 deletedAt，
      // 下轮同步墓碑回灌会把刚恢复的批注再删一遍。
      await db.cardAnnots.bulkPut(annots.map(a => ({ ...a, updatedAt: Date.now() })));
      await db.tombstones.bulkDelete(annots.map(a => a.id));
    }
    if (ccLinks && ccLinks.length) {
      // v34：还原卡↔卡关联 + 清墓碑（同 cwLinks 机制；idOnly 表靠墓碑判生死）
      await db.cardLinks.bulkPut(ccLinks.map(l => ({ ...l, updatedAt: Date.now() })));
      await db.tombstones.bulkDelete(ccLinks.map(l => l.id));
    }
    if (text) {
      await db.docTexts.put({
        id: t.id, text, textLen: savedTextLen ?? text.length, updatedAt: Date.now(),
      });
    }
    if (edges && edges.length) {
      // bump updatedAt 让恢复后的边在下次同步时压过对端仍存在的旧副本
      await db.graphEdges.bulkPut(edges.map(e => ({ ...e, updatedAt: Date.now() })));
      // 同时清掉删资料时为这些边写的墓碑，否则恢复后会被自己的墓碑再删一遍
      await db.tombstones.bulkDelete(edges.map(e => e.id));
    }
    // 审计（round35 小问题1）：恢复每日计划的任务 + 清掉为它们写的墓碑
    // 审计 P1-2（round36）：tasks 统一 bump updatedAt（同 graphEdges :405 口径）——
    // deleteDailyPlan 给每个任务写了 dailyTask 墓碑，原样恢复的旧 updatedAt ≤ deletedAt，
    // 下轮同步墓碑回灌 → 任务再删光且快照已消费，永久丢失。
    if (dailyTasks && dailyTasks.length) {
      await db.dailyTasks.bulkPut(dailyTasks.map(task => ({ ...task, updatedAt: Date.now() })));
      await db.tombstones.bulkDelete(dailyTasks.map(task => task.id));
    }
    if (cardImages && cardImages.length) {
      // round54 P1：按原 id 写回图片（正文 sxy-img://<id> 才能重新解析）。
      // 必须 bump updatedAt —— livenessTs 取所有时间字段最大值，只有让它「晚于」删卡时写的
      // image 墓碑，才不会被下轮同步的 applyTombstones 再删一遍（快照已消费 → 永久丢失）。
      await db.images.bulkPut(cardImages.map(img => ({ ...img, updatedAt: Date.now() })));
      await db.tombstones.bulkDelete(cardImages.map(img => img.id));
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
          // round34 H1：linkedCardIds 变更必须 bump fieldTs，否则字段级合并会把它当未变更而丢改
          await db.notes.put({ ...n, linkedCardIds: [...set], updatedAt: Date.now(),
            fieldTs: { ...(n.fieldTs || {}), linkedCardIds: Date.now() } });
        }
      }
    }
    // 审计 P0：恢复 note 时把 note.id 加回对应卡片的 linkedNoteIds（deleteNote 清洗了）
    if (noteLinkedCardIds && noteLinkedCardIds.length) {
      const cards = (await db.cards.bulkGet(noteLinkedCardIds)).filter(Boolean);
      for (const c of cards) {
        const set = new Set(c.linkedNoteIds || []);
        if (!set.has(t.id)) {
          set.add(t.id);
          const tNow = now();
          // round29：派生/状态字段同样要登记字段级时间戳，否则合并时随整行 LWW 漂移
          await db.cards.update(c.id, {
            linkedNoteIds: [...set], updatedAt: tNow,
            fieldTs: { ...(c.fieldTs || {}), linkedNoteIds: tNow },
          });
        }
      }
    }
    // 审计：清 embedding 墓碑——deleteCard 已补写墓碑（kind='embedding'），
    // 恢复时必须一并清掉，否则每次同步 applyTombstones 会把重建的向量再删一遍，
    // RAG 对该资料永久失明。对 card/docFile 均适用。
    const embeddingTombStale = (await db.tombstones.toArray())
      .filter(tb => (tb?.kind || 'card') === 'embedding')
      .filter(tb => {
        // 向量行 id = embed-<sourceType>-<sourceId>-<chunkIdx>（agent/embedding-key.js）。
        // 历史 bug（round112 顺手修）：旧实现分两支，docFile 支判 `tb.id === t.id`（拿资料 id
        // 比向量行 id，永不命中），card 支的前缀少了 sourceType 段（`embed-<id>-`）——
        // 两支都从未命中，等于「恢复后不清向量墓碑」。在随机 id 时代那只是无害死代码，
        // 但 id 换成确定性键后，重建出来的向量行**与墓碑同 id**：不清墓碑就会在下一次
        // 同步被 applyTombstones 删掉 → RAG 对该卡/资料永久失明。
        const srcType = (t.kind === 'card') ? 'card' : 'doc';
        const prefix = embeddingIdPrefix(srcType, t.id);
        return !!prefix && typeof tb.id === 'string' && tb.id.startsWith(prefix);
      });
    if (embeddingTombStale.length) await db.tombstones.bulkDelete(embeddingTombStale.map(tb => tb.id));
  });
  // 审计 F-3 + D-8（round33）：RAG 向量重建**移到事务提交后**再触发——
  // 旧实现把 parseDoc/indexCard 的 fire-and-forget 放在事务回调内，异步重建可能跨越
  // 事务边界触发 TransactionInactiveError，被 .catch 吞掉 → 该卡/资料向量永久失明且无提示。
  if (t.kind === 'docFile' || t.kind === 'doc') {
    try {
      const { parseDoc } = await import('../docs-lib.js');
      parseDoc(t.id).catch((e) => { console.warn('[restore] parseDoc 重建失败', e?.message || e); });
    } catch { /* import 失败不阻塞恢复 */ }
  }
  // 卡片恢复后同样触发向量重建——deleteCard 已物理删 embeddings 行，
  // 墓碑虽清但 card 恢复后无人重建向量 → RAG/语义搜索对该卡永久失明。
  if (t.kind === 'card') {
    try {
      const { indexCard } = await import('../agent/retrieval.js');
      const card = await db.cards.get(t.id);
      if (card) indexCard(card).catch((e) => { console.warn('[restore] indexCard 重建失败', e?.message || e); });
    } catch { /* import 失败不阻塞恢复 */ }
  }
  return true;
}

export async function deleteCard(id) {
  const old = await db.cards.get(id);
  if (!old) return;
  const imgIds = [...extractImageIds(JSON.stringify(old))];
  // 事务内一次性完成 回收站快照 + 墓碑 + 删卡 + 删复习 + 删卡组关联 + 切断图谱边，保证原子、无悬空引用
  // 注：cardGroupLinks 此前漏删 —— 删卡后关联行原样留在库里（还进同步包跨设备传播），
  //     卡组详情页会统计到已被删除的「幽灵卡」，且永不清理。
  await db.transaction('rw', db.cards, db.trash, db.tombstones, db.reviews, db.graphEdges, db.cardGroupLinks, db.cardWordLinks, db.cardLinks, db.embeddings, db.notes, db.images, db.cardAnnots, async () => {
    // 1) 回收站快照（含复习记录 + 卡组关联 + 卡↔词关联，便于恢复时一并还原）
    const reviews = await db.reviews.where('cardId').equals(id).toArray();
    // v35：批注（cardAnnots）——与 reviews 同机制：删卡会级联物理删批注并写墓碑，
    // 快照不带它的话「删→恢复」后批注永久丢失（且残留墓碑会把重建尝试再删一遍）。
    const annots = await db.cardAnnots.where('cardId').equals(id).toArray();
    const links = await db.cardGroupLinks.where('cardId').equals(id).toArray();
    const cwLinks = await db.cardWordLinks.where('cardId').equals(id).toArray();
    // v34：卡↔卡关联是双向存储，两个方向都要查（Map 按 id 去重，自环已被 linkCards 拒绝）
    const ccMap = new Map();
    for (const l of await db.cardLinks.where('fromCardId').equals(id).toArray()) ccMap.set(l.id, l);
    for (const l of await db.cardLinks.where('toCardId').equals(id).toArray()) ccMap.set(l.id, l);
    const ccLinks = [...ccMap.values()];
    // 审计 A2：与 deleteWordCard 对称——删通用卡也会级联删链接+写墓碑，
    // 快照不带 _cardWordLinks 的话恢复后关联同样永久丢失
    // 审计 #10：记录被清洗引用的 noteId，恢复时补回 linkedCardIds
    // 性能：此前这里与下方第 8 步**各扫一次 db.notes 全表**（同一次删除里两遍全表物化，
    // 笔记多时删卡明显变慢）。两次都在同一事务内且中间不写 notes，故只扫一次、两处复用。
    // round29：清洗「其它卡 → 本卡」的变式血缘引用。此前只清了 notes.linkedCardIds，
    // 派生卡的 sourceCardId 会指向已删除的源卡（幽灵引用），跨设备后血缘/变式重罚逻辑失效。
    // 删卡是低频操作，这里用一次全表 filter 换引用完整性（sourceCardId 无索引）。
    const derivedCards = await db.cards.filter(c => c.sourceCardId === id).toArray();
    for (const d of derivedCards) {
      const tNow = now();
      await db.cards.update(d.id, {
        sourceCardId: null, updatedAt: tNow,
        fieldTs: { ...(d.fieldTs || {}), sourceCardId: tNow },
      });
    }
    const allNotes = await db.notes.toArray();
    const linkedNotes = allNotes.filter(n => Array.isArray(n.linkedCardIds) && n.linkedCardIds.includes(id));
    const linkedNoteIds = linkedNotes.map(n => n.id);
    // round54（P1 修复）：图片必须一起快照。本函数末尾会级联**物理删除**「不再被任何卡引用」
    // 的图（见「清理孤儿图片」+ db.images.bulkDelete）。此前快照不含图片、restoreFromTrash 也不还原
    // db.images → 删卡再还原，卡回来了但图永久丢失（正文 sxy-img:// 占位符全部悬空，且无法找回）。
    const cardImages = imgIds.length ? (await db.images.bulkGet(imgIds)).filter(Boolean) : [];
    await trashItem(id, 'card', { ...old, _reviews: reviews, _groupLinks: links, _cardWordLinks: cwLinks, _cardLinks: ccLinks, _linkedNoteIds: linkedNoteIds, _images: cardImages, _annotations: annots });
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
    // v35：批注（cardAnnots）同理——物理删行不写墓碑，对端残留的批注行会随增量包反复回传，
    // 形成「卡没了、批注还挂在幽灵 cardId 上」的垃圾行（正是 sweepOrphanRows 要兜的那个坏状态）。
    if (annots.length) {
      await db.tombstones.bulkPut(annots.map(a => ({ id: a.id, kind: 'cardAnnot', deletedAt: now() })));
    }
    // 3) 删卡
    await db.cards.delete(id);
    // 4) 删复习记录
    await db.reviews.where('cardId').equals(id).delete();
    // 4.5) v35：删该卡的批注（本端级联；跨设备残留由 sweepOrphanRows 兜底）
    await db.cardAnnots.where('cardId').equals(id).delete();
    // 5) 删卡组关联（此前漏删 → 指向已删卡的悬空行常驻并进同步包）
    await db.cardGroupLinks.where('cardId').equals(id).delete();
    // 5.5) v31：删通用卡↔英语词卡链接（同 cardGroupLinks 逻辑：不写墓碑 → 对端悬空链接复活）
    //      cwLinks 已在第 1 步快照时查出，此处复用，避免重复查询
    if (cwLinks.length) {
      await db.tombstones.bulkPut(cwLinks.map(l => ({ id: l.id, kind: 'cardWordLink', deletedAt: now() })));
    }
    await db.cardWordLinks.where('cardId').equals(id).delete();
    // 5.6) v34：删通用卡↔通用卡关联（双向）。同 cardWordLinks：不写墓碑 →
    //      对端悬空关联在下次同步被推回，形成指向幽灵卡的永久垃圾行。
    if (ccLinks.length) {
      await db.tombstones.bulkPut(ccLinks.map(l => ({ id: l.id, kind: 'cardLink', deletedAt: now() })));
    }
    await db.cardLinks.where('fromCardId').equals(id).delete();
    await db.cardLinks.where('toCardId').equals(id).delete();
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
    //    复用第 1 步的 linkedNotes（同一事务内，中间无写入），不再重复全表扫描
    for (const n of linkedNotes) {
      // round34 H1：linkedCardIds 变更 bump fieldTs，字段级合并才认得这次改动
      await db.notes.put({ ...n, linkedCardIds: n.linkedCardIds.filter(x => x !== id), updatedAt: now(),
        fieldTs: { ...(n.fieldTs || {}), linkedCardIds: now() } });
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
 * 删除孤儿图片（卡片页「孤儿图片」面板的清理入口）。
 *
 * round123 审计：此前视图层（Cards.vue）直接 `db.images.delete(id)`，**不写墓碑** ——
 * 与项目口径不一致：deleteCard 的孤儿图清理（本文件 :698-704）与 deleteNote 的同款清理
 * 都是「先 bulkPut kind='image' 墓碑 → 再物理删」。缺墓碑的后果：
 *   `images` 是同步表且按 idOnly 幂等，本机删掉的图会在下一次同步被对端/hub 原样灌回来
 *   ⇒ 用户点「清理孤儿图」后，换设备或下次同步图又出现，清理静默失效。
 * 收口到本函数后视图层不再直接碰 db.images，且与其余删图路径同口径。
 *
 * @param {string[]} ids 待删图片 id 列表（自动去重、过滤空值）
 * @returns {Promise<number>} 实际删除的图片数量
 */
export async function deleteOrphanImages(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return 0;
  const ts = now();
  await db.transaction('rw', db.images, db.tombstones, async () => {
    await db.tombstones.bulkPut(list.map(id => ({ id, kind: 'image', deletedAt: ts })));
    await db.images.bulkDelete(list);
  });
  return list.length;
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
  // round43 N2：扫描口径统一为 images.js 的 IMAGE_REF_TABLES 常量清单（含 docFiles/aiChats，
  // 资料解析文本也可能含 sxy-img:// 占位符，statImageAssets 已扫它——GC 漏扫会误删仍被
  // 资料引用的图）。备份侧 collectPackImageIds 与导入侧存活集扫描同源引用此清单，
  // 不再是历史上的「写死六表全表扫描」，新增引用表时只改常量一处。
  const rows = await Promise.all(IMAGE_REF_TABLES.map((t) => db[t].toArray()));
  const used = new Set();
  for (const c of rows.flat()) {
    for (const i of extractImageIds(JSON.stringify(c))) used.add(i);
  }
  const removed = [...idSet].filter(id => !used.has(id));
  if (removed.length) {
    // round123 审计：本函数此前是「纯物理删」，契约要求**调用方**先写墓碑（见上方 round26 D3 注释）。
    // 但它当前**没有任何调用方**（死导出），而该契约极易被漏 —— 一旦有人直接调用就会造成
    // 「本地删了、同步灌回来」的静默失效。改为**自包含**「先写墓碑、后物理删」，
    // 调用方无需再操心；与 deleteCard / deleteNote / deleteOrphanImages 完全同口径。
    await db.transaction('rw', db.images, db.tombstones, async () => {
      await db.tombstones.bulkPut(removed.map(id => ({ id, kind: 'image', deletedAt: Date.now() })));
      await db.images.bulkDelete(removed);
    });
  }
  return removed;
}

// round26 D3：孤儿图**纯读预检**（不删除）。配合删除路径「先写墓碑 → 后物理删」，
// 消除「图已物理删但墓碑未写 → 删除不跨设备传播」的窗口（崩溃点落在两步骤之间时，
// 最坏只剩本地图残留，墓碑已发出去让对端对齐删除，无坏方向）。
// round38 ②：此前的 rebuildImageRefs / imageRefs 派生索引已删除（只写不读、且 round26 D4
// 判定其快速路径不安全）——孤儿判定统一走本函数的六表全量扫描（正确性优先）。
// round26 D3：孤儿图**纯读预检**（不删除）。配合删除路径「先写墓碑 → 后物理删」，
// 消除「图已物理删但墓碑未写 → 删除不跨设备传播」的窗口（崩溃点落在两步骤之间时，
// 最坏只剩本地图残留，墓碑已发出去让对端对齐删除，无坏方向）。
// round38 ②：此前的 rebuildImageRefs / imageRefs 派生索引已删除（只写不读、且 round26 D4
// 判定其快速路径不安全）——孤儿判定统一走本函数的六表全量扫描（正确性优先）。
export async function findOrphanImages(ids) {
  const idSet = new Set((ids || []).filter(Boolean));
  if (!idSet.size) return [];
  // round43 N2：与 cleanupOrphanImages 同源——表清单统一走 images.js 的 IMAGE_REF_TABLES
  const rows = await Promise.all(IMAGE_REF_TABLES.map((t) => db[t].toArray()));
  const used = new Set();
  for (const c of rows.flat()) {
    for (const i of extractImageIds(JSON.stringify(c))) used.add(i);
  }
  return [...idSet].filter((id) => !used.has(id));
}

// round38 ②：rebuildImageRefs 已随 imageRefs 死表一并删除（见 findOrphanImages 上方说明）。

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
  const [cards, wordCards, reviews, wordReviews, annots] = await Promise.all([
    db.cards.toArray(), db.wordCards.toArray(), db.reviews.toArray(), db.wordReviews.toArray(),
    db.cardAnnots.toArray(),
  ]);
  const cardIds = new Set(cards.map(c => c.id));
  const wordCardIds = new Set(wordCards.map(c => c.id));
  const delReviews = reviews.filter(r => !cardIds.has(r.cardId)).map(r => r.id);
  const delWord = wordReviews.filter(r => !wordCardIds.has(r.cardId)).map(r => r.id);
  // v35：批注孤儿。**跨设备场景是主要来源**——对端删卡只发 kind='card' 墓碑，
  // 本端卡片被级联删除，但它的批注行没有对应墓碑（本端从未删过这些批注）→ 永久残留。
  // 顺带清掉 cardId 缺失/为空的脏行（与上方 reviews 同口径）。
  const delAnnots = annots.filter(a => !a.cardId || !cardIds.has(a.cardId)).map(a => a.id);
  // round43 N3：清孤儿复习同样必须写墓碑——本端物理删行后若无墓碑，
  // 对端同 id 行（老包/bridge 通道/未收到删除的设备）下次合并会按「新行」回灌，
  // 幽灵复习复活计入统计。与 deleteCard（repo.js:555-561 round16 R16-1）和
  // 导入侧 wordCard 级联（sync.js:972-988 round34 P2-5）的墓碑纪律同口径：删谁就给谁写墓碑。
  if (delReviews.length || delWord.length || delAnnots.length) {
    const nowTs = now();
    await db.transaction('rw', db.reviews, db.wordReviews, db.cardAnnots, db.tombstones, async () => {
      if (delReviews.length) {
        await db.reviews.bulkDelete(delReviews);
        await db.tombstones.bulkPut(delReviews.map(id => ({ id, kind: 'review', deletedAt: nowTs })));
        invalidateFailCountCache();
        invalidateDashboardCache();
      }
      if (delWord.length) {
        await db.wordReviews.bulkDelete(delWord);
        await db.tombstones.bulkPut(delWord.map(id => ({ id, kind: 'wordReview', deletedAt: nowTs })));
      }
      if (delAnnots.length) {
        await db.cardAnnots.bulkDelete(delAnnots);
        await db.tombstones.bulkPut(delAnnots.map(id => ({ id, kind: 'cardAnnot', deletedAt: nowTs })));
      }
    });
  }
  return delReviews.length + delWord.length + delAnnots.length;
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
// round34 M3：墓碑表（tombstones）永不清理——每次增量备份全量随包发送，
// 删除越多包越大、同步/导入越慢。补一个 TTL/GC：删除时间超过最大离线窗口的墓碑，
// 且本地对应行确实已不存在（避免误删仍在等待传播的删除），定期清除。
// 保留 30 天窗口给所有设备完成同步；超期且本地无残留行即可安全 GC。
// round38 ④：墓碑 kind → 表名映射改为从同步清单自动派生（tombKindTable），
// 杜绝手写清单漂移导致某些 kind（如 groupLink/pomo/memory/privacy）的墓碑永不 GC。
const TOMB_KIND_TABLE = tombKindTable();
// 手动标记 / 取消标记错题
export async function setMarked(id, marked) {
  // 审计 B11 同款：差量写——marked/updatedAt 只 merge 这两个字段，
  // 不再 put 整行（避免窗口期内的并发内容编辑被旧快照覆盖）。
  // round30（P1-2）：补字段级时间戳 fieldTs.marked——marked 在 CARD_CONTENT_FIELDS，
  // 若无 fieldTs 则合并时退化为整行 content 赢家；当另一台设备后改其它字段（updatedAt 更大）
  // 时，本端标星会被整行覆盖丢。事务内重读 cur 取其 fieldTs 合并。
  return db.transaction('rw', db.cards, async () => {
    const card = await db.cards.get(id);
    if (!card) throw new Error('卡片不存在');
    const t = now();
    await db.cards.update(id, { marked: !!marked, updatedAt: t, fieldTs: { ...(card.fieldTs || {}), marked: t } });
    // round75 审计：同 updateCard —— 纯字段变更必须显式失效（同毫秒二次写不换 key）
    invalidateDashboardCache();
    return { ...card, marked: !!marked, updatedAt: t };
  });
}

// ---------- 排期调整：把某张卡拉进「今日复习」 ----------
// round122 审计（P1）收口：错题本「加入今日复习」与卡片页「提前巩固」此前各自在 .vue 里
//   直接写 db.cards（WrongBook.vue / Cards.vue），**只改 dueAt + reviewedAt、不 bump updatedAt**。
//   不 bump 是对的（内容字段按 updatedAt 合并决胜，推高它会让本机这份旧内容成为 winner，
//   把其他设备对卡面的文字编辑整段覆盖掉），但**漏了 invalidateDashboardCache()**：
//   快照 key = mode|cards数|reviews数|最大updatedAt|最大reviewedAt，四项全不变 → 命中陈旧快照。
//   后果两条：① 首页「今日待复习」不涨；② 卡片页遗忘预警（getForgetRisk 走同一份快照）
//   继续把已救的卡列在列表里，用户会以为没生效而重复点击。
//   收口到本函数后：写路径回到 repo.js（round57 契约⑥ 的门禁扫得到），失效与语义一并钉住。
// ---------- 排期调整：把某张卡拉进「今日复习」 ----------
// round122 审计（P1）收口：错题本「加入今日复习」与卡片页「提前巩固」此前各自在 .vue 里
//   直接写 db.cards（WrongBook.vue / Cards.vue），**只改 dueAt + reviewedAt、不 bump updatedAt**。
//   不 bump 是对的（内容字段按 updatedAt 合并决胜，推高它会让本机这份旧内容成为 winner，
//   把其他设备对卡面的文字编辑整段覆盖掉），但**漏了 invalidateDashboardCache()**：
//   快照 key = mode|cards数|reviews数|最大updatedAt|最大reviewedAt，四项全不变 → 命中陈旧快照。
//   后果两条：① 首页「今日待复习」不涨；② 卡片页遗忘预警（getForgetRisk 走同一份快照）
//   继续把已救的卡列在列表里，用户会以为没生效而重复点击。
//   收口到本函数后：写路径回到 repo.js（round57 契约⑥ 的门禁扫得到），失效与语义一并钉住。
export async function rescheduleCardToNow(cardId) {
  const t = Date.now();
  return db.transaction('rw', db.cards, async () => {
    const card = await db.cards.get(cardId);
    if (!card) return null;
    // 差量写：只动 SRS 调度字段，绝不回写整行（窗口期内的并发编辑会被旧快照覆盖）。
    await db.cards.update(cardId, { dueAt: t, reviewedAt: t });
    invalidateDashboardCache();
    return { ...card, dueAt: t, reviewedAt: t };
  });
}

// ---------- 错因 ----------
// WRONG_REASON_MAP / wrongReasonToCode / WRONG_REASONS 已抽至 repo-core.js（上方 re-export 保持 API 不变）

// 取候选卡的复习历史（单条 anyOf 索引查询，非 N 查询），供 buildReviewSession 做检索分级。
// 返回 Map<cardId, review[]>，每条 review 含 { rating, guessed, responseMs, retrievalStrength }，
// 正好喂给 session.js 的 estimateRetrievalDifficulty。
// 取候选卡的复习历史（单条 anyOf 索引查询，非 N 查询），供 buildReviewSession 做检索分级。
// 返回 Map<cardId, review[]>，每条 review 含 { rating, guessed, responseMs, retrievalStrength }，
// 正好喂给 session.js 的 estimateRetrievalDifficulty。
async function buildReviewsByCard(cards) {
  const ids = (cards || []).map(c => c.id);
  const map = new Map();
  if (!ids.length) return map;
  const revs = await db.reviews.where('cardId').anyOf(ids).toArray();
  // 审计 P1-2（round32）：quickCheck 行不计入检索分级——统一口径 isRealReview
  for (const r of revs) {
    if (!isRealReview(r)) continue;
    if (!map.has(r.cardId)) map.set(r.cardId, []);
    map.get(r.cardId).push(r);
  }
  return map;
}

// ---------- 复习 ----------
// filter: { subjects:[], tags:[], logic:'AND'|'OR'|'NOT', wrongReasons:[], includeDueOnly:true }
// 自由组合背诵：按科目/标签/错因并集·交集·差集筛选到期队列（默认全量到期，遵循复习曲线）
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
      // 审计 P1-2（round33）：自适应节奏的近 10 次样本排除 quickCheck——自测不是真复习，
    // 否则快检失败会压低间隔（与检索分级/训练同口径）。
    const recent = realReviews(await db.reviews.where('cardId').equals(cardId).reverse().sortBy('reviewedAt'));
      // 审计 P2：过滤 quickCheck 行——快速检测不计入 SRS，混入 failRate 会触发 ×0.8 惩罚
      const last10 = recent.filter(r => r.type !== 'quick').slice(0, 10);
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
      ? Number(retrievability(card.fsrs.s, Math.max(0, (nowTs - card.fsrs.last) / 86400000)).toFixed(4))
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
    // round118 审计：复习时把快速校验窗口锚点重置回本次复习时刻——
    // 否则上一周期「跳过」写下的旧锚点（now-59min）会永久压制后续每轮复习的
    // 快速校验窗口（elapsed 恒大于 1h，新卡再也不会被校验）。随 fieldTs 独立
    // 记录，跨设备按字段级取新（不 bump 整行 updatedAt，不覆盖内容编辑）。
    cardUpdate.quickAnchorAt = nowTs;
    cardUpdate.fieldTs = { ...(card.fieldTs || {}), quickAnchorAt: nowTs };
    if (fsrsNext !== undefined) cardUpdate.fsrs = fsrsNext;
    // 卡片与复习记录同事务双写：任何一步失败整体回滚，不留半残状态
    await db.cards.update(cardId, cardUpdate);
    invalidateFailCountCache();
    invalidateDashboardCache();
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
// 自我解释钩子（学习科学：错题后一句话反思「为什么错 / 正确理解」），
// 落盘到对应复习记录。selfExplainAt 独立时间戳供跨设备按新取新。
export async function attachSelfExplanation(reviewId, text) {
  const r = await db.reviews.get(reviewId);
  if (!r) return null;
  const selfExplanation = String(text || '').trim().slice(0, 500);
  invalidateFailCountCache();
  invalidateDashboardCache();
  await db.reviews.put({ ...r, selfExplanation, selfExplainAt: Date.now() });
  return true;
}

// formatDue 已抽至 repo-core.js（上方 re-export 保持 API 不变）

// 学习行为回写 SRS：语音评测得分 / 费曼练习加成（不改 updatedAt，仅 ease/dueAt）
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
    // 审计：与 review() 同口径——排期/复习状态变了就失效今日待复习与错题计数缓存，
    // 否则语音/费曼加成改了 dueAt，首页数字最长 60s 仍显示旧值。
    invalidateFailCountCache();
    invalidateDashboardCache();
    return f;
  });
}

// ---------- 已背记录 ----------
// ---------- 已背记录 ----------
export async function reviewHistory(limit = 200) {
  const reviews = realReviews(await db.reviews.orderBy('reviewedAt').reverse().limit(limit).toArray());
  // round33 D-5：只 bulkGet 这 ≤200 条涉及的卡片——此前全表 allCards() 只为挂 front/back，
  // 万卡级每次翻「已背记录」都物化整表（reviews 页/历史查看的高频路径）。
  const ids = [...new Set(reviews.map(r => r.cardId).filter(Boolean))];
  // round34 C1：bulkGet 对库中已删的卡返回 undefined，直接 .map(c=>[c.id,c]) 会崩；
  // 先滤掉（下一行 card?.front 已预期卡片可能不存在）。
  const cardMap = new Map((ids.length ? await db.cards.bulkGet(ids) : []).filter(Boolean).map(c => [c.id, c]));
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
// ---------- 单卡复习历史 ----------
export async function getCardHistory(id) {
  const card = await db.cards.get(id);
  const reviews = realReviews(await db.reviews.where('cardId').equals(id).reverse().sortBy('reviewedAt'));
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
// ---------- 错题集 / 薄弱卡片 ----------
export async function weakCards(limit = 100, minFail = 2) {
  // 排名核心已抽至 repo-core.rankWeakCards（N9）
  const { cards, reviews } = await dashboardSnapshot();
  return rankWeakCards(cards, reviews, { limit, minFail });
}

// round33 C-2：Dashboard 首屏三个全表聚合（getStats / weakCards / getReviewSuggestion）
// 此前各自 allCards()+reviews.toArray()，万卡级每次进首页读 6 遍全表（主线程阻塞）。
// 共享一份「cards+reviews 快照」：读时用 count+最新时间戳组 key 校验，命中即零全表；
// 多个并发调用共享同一个进行中的加载 Promise（只物化一次）。
//
// ⚠️ round57 更正（此前此处写的是"写路径无需显式失效…天然无陈旧窗口"——**该结论不成立**）：
//   key 校验**不完备**。反例（round57 实测）：原地改写某张卡的字段而不 bump 其 updatedAt，
//   且该卡不是 updatedAt 最大的那一张 → count 与"最新时间戳"双双不变 → 命中陈旧快照。
//   且缓存键不看内容，污染/陈旧都不会自愈。故与 failCountMap 的结论一致：
//   **写路径必须显式调 invalidateDashboardCache()**（review() / 导入合并 sync.js / word-repo
//   等写路径均已如此调用；新增任何卡片或复习写路径时**不要漏掉这一步**）。
// round33 C-2：Dashboard 首屏三个全表聚合（getStats / weakCards / getReviewSuggestion）
// 此前各自 allCards()+reviews.toArray()，万卡级每次进首页读 6 遍全表（主线程阻塞）。
// 共享一份「cards+reviews 快照」：读时用 count+最新时间戳组 key 校验，命中即零全表；
// 多个并发调用共享同一个进行中的加载 Promise（只物化一次）。
//
// ⚠️ round57 更正（此前此处写的是"写路径无需显式失效…天然无陈旧窗口"——**该结论不成立**）：
//   key 校验**不完备**。反例（round57 实测）：原地改写某张卡的字段而不 bump 其 updatedAt，
//   且该卡不是 updatedAt 最大的那一张 → count 与"最新时间戳"双双不变 → 命中陈旧快照。
//   且缓存键不看内容，污染/陈旧都不会自愈。故与 failCountMap 的结论一致：
//   **写路径必须显式调 invalidateDashboardCache()**（review() / 导入合并 sync.js / word-repo
//   等写路径均已如此调用；新增任何卡片或复习写路径时**不要漏掉这一步**）。
let _dashSnap = null;
let _dashLoading = null;
// round57（P2 性能）：导出给 agent/analytics.js 复用同一份快照。
// 此前 getRecentMistakes / getForgetRisk / getLearningProfile 各自再 `db.reviews.toArray()`，
// 绕过了本快照 → 一次页面加载实际读 4 遍全表（实测 3000 卡/6 万复习下仅 reviews 全表扫就 436ms，
// 三函数串行 1591ms 全阻塞主线程）。复用后同页多调用只物化一次（实测降到 186ms）。
//
// ⚠️ **只读契约（新增消费方必读）**：返回的 cards/reviews 是**跨调用共享的同一份数组实例**，
//   任何消费方**不得原地修改**（`.sort()/.push()/.splice()/.reverse()` 都会污染其他消费者，
//   且因为缓存键只看 count+时间戳，污染不会被自动失效修好）。
//   需要有序/变形结果时用 `.filter()/.map()/.slice()` 产新数组再改（这三个天然复制）。
//   已按此纪律修正的两处陷阱：analytics.prepareFsrsTrainingData（原 `reviews.sort()`）、
//   analytics._getGraphDrivenReviewPlan（原 `let pool = cards` 后原地 sort）。
// round57（P2 性能）：导出给 agent/analytics.js 复用同一份快照。
// 此前 getRecentMistakes / getForgetRisk / getLearningProfile 各自再 `db.reviews.toArray()`，
// 绕过了本快照 → 一次页面加载实际读 4 遍全表（实测 3000 卡/6 万复习下仅 reviews 全表扫就 436ms，
// 三函数串行 1591ms 全阻塞主线程）。复用后同页多调用只物化一次（实测降到 186ms）。
//
// ⚠️ **只读契约（新增消费方必读）**：返回的 cards/reviews 是**跨调用共享的同一份数组实例**，
//   任何消费方**不得原地修改**（`.sort()/.push()/.splice()/.reverse()` 都会污染其他消费者，
//   且因为缓存键只看 count+时间戳，污染不会被自动失效修好）。
//   需要有序/变形结果时用 `.filter()/.map()/.slice()` 产新数组再改（这三个天然复制）。
//   已按此纪律修正的两处陷阱：analytics.prepareFsrsTrainingData（原 `reviews.sort()`）、
//   analytics._getGraphDrivenReviewPlan（原 `let pool = cards` 后原地 sort）。
export async function dashboardSnapshot() {
  const mkKey = async () => {
    try {
      const [cc, rc, cLast, rLast] = await Promise.all([
        db.cards.count(), db.reviews.count(),
        db.cards.orderBy('updatedAt').last().catch(() => undefined),
        db.reviews.orderBy('reviewedAt').last().catch(() => undefined),
      ]);
      // round34 H4：缓存键纳入当前 DB 模式（real/test=演示），防止切换演示库后
      // 撞到相同 count/时间戳键而返回另一模式的 cards+reviews 快照。
      return `${currentDbMode()}|${cc}|${rc}|${cLast ? cLast.updatedAt : 0}|${rLast ? rLast.reviewedAt : 0}`;
    } catch { return ''; } // 索引不可用时退化为每次都重建
  };
  if (_dashSnap && _dashSnap.key === (await mkKey())) return _dashSnap;
  if (!_dashLoading) {
    _dashLoading = (async () => {
      const [cards, reviews] = await Promise.all([db.cards.toArray(), db.reviews.toArray()]);
      _dashSnap = { key: await mkKey(), cards, reviews };
      return _dashSnap;
    })();
  }
  try { return await _dashLoading; } finally { _dashLoading = null; }
}

/**
 * round38 ③：显式失效首页统计快照（_dashSnap）。
 * 说明：缓存 key 已含 count + 最新 updatedAt/reviewedAt + DB 模式，任何常规增删改都会
 * 自动改变 key（天然无陈旧窗口）；此函数提供**显式入口**，供未来「不改变 count 与最大
 * 时间戳」的写路径兜底，避免那种场景下首页读到陈旧统计。
 */
export function invalidateDashboardCache() { _dashSnap = null; _dashLoading = null; }

// round29：全局「答错次数」映射（cardId -> rating===0 的次数），带缓存。
// 背景：failCount 不是卡片持久字段，而是 reviews 流水的聚合值（见 repo-core.rankWeakCards）。
// 此前只有「错题集」模式会算它，于是没开该开关的设备上永远看不到红标，用户误以为同步丢数据。
// 列表每次搜索都全表扫描 reviews 太贵（万级流水约百毫秒），故用「行数 + 最新 reviewedAt」
// 组成轻量 key 做缓存：复习/清理必然改变其一，命中时零扫描。
// round29：全局「答错次数」映射（cardId -> rating===0 的次数），带缓存。
// 背景：failCount 不是卡片持久字段，而是 reviews 流水的聚合值（见 repo-core.rankWeakCards）。
// 此前只有「错题集」模式会算它，于是没开该开关的设备上永远看不到红标，用户误以为同步丢数据。
// 列表每次搜索都全表扫描 reviews 太贵（万级流水约百毫秒），故用「行数 + 最新 reviewedAt」
// 组成轻量 key 做缓存：复习/清理必然改变其一，命中时零扫描。
let _failCountCache = { key: '', map: new Map() };
// round106：区分「自然 miss」与「显式失效」——
//   自然 miss（key 变了）说明变更**能被 key 感知**（行数 / 最新 reviewedAt / 该行 id 变了），可安全复用首页快照；
//   显式失效相反：调用方明确表示「我改了 key 检测不到的东西」（原地改写同一条复习、同 id 替换），
//   这时**必须真扫一遍**，绝不能复用快照——否则吃陈旧值（tests/failcount-map.test.mjs 钉的正是这条契约）。
// round106：区分「自然 miss」与「显式失效」——
//   自然 miss（key 变了）说明变更**能被 key 感知**（行数 / 最新 reviewedAt / 该行 id 变了），可安全复用首页快照；
//   显式失效相反：调用方明确表示「我改了 key 检测不到的东西」（原地改写同一条复习、同 id 替换），
//   这时**必须真扫一遍**，绝不能复用快照——否则吃陈旧值（tests/failcount-map.test.mjs 钉的正是这条契约）。
let _failCountForced = false;
/** 让答错次数缓存失效——任何写了 reviews 表的路径都必须调用（合并/改写/删除）。 */
export function invalidateFailCountCache() {
  _failCountCache = { key: '', map: new Map() };
  _failCountForced = true;
}
export async function failCountMap() {
  let cnt = 0, last = null;
  try {
    [cnt, last] = await Promise.all([
      db.reviews.count(),
      db.reviews.orderBy('reviewedAt').last(),
    ]);
  } catch { /* 索引不可用时退化为每次重算 */ }
  const key = `${currentDbMode()}|${cnt}|${last ? last.reviewedAt : 0}|${last ? last.id : ''}`;
  // round29 审查：去掉原先的 `cnt &&`（空表时永远绕过缓存、每次都全表扫描）；
  // 复合键本身不完备（原地改写/同 id 替换一条非最新复习时行数与最新 reviewedAt 都不变），
  // 故写路径必须调 invalidateFailCountCache() 显式失效，见下方各写入点。
  if (_failCountCache.key === key) return _failCountCache.map;
  // round105 性能：首屏（/cards）会同时要「统计快照」与「答错次数」，旧实现各自全表扫一次
  // （实测 3000 卡/6 万复习：快照 192ms + 这里 76ms）。改为**优先复用快照的行**。
  // 安全性两道闸：
  //   ① 刚被**显式失效**过 → 直接真扫（调用方说"我改了 key 看不见的东西"，快照此刻可能陈旧）；
  //   ② 否则用算 key 时已取得的 (cnt, last) 与快照内容对账，对不上就退回全表扫。
  const forced = _failCountForced;
  _failCountForced = false;
  let rows = null;
  if (!forced) {
    try {
      const snap = await dashboardSnapshot();
      const rs = snap.reviews || [];
      let maxR = null;
      for (const r of rs) if (!maxR || (Number(r.reviewedAt) || 0) > (Number(maxR.reviewedAt) || 0)) maxR = r;
      const same = rs.length === cnt
        && (maxR ? `${maxR.reviewedAt}|${maxR.id}` : '') === (last ? `${last.reviewedAt}|${last.id}` : '');
      if (same) rows = rs;
    } catch { /* 快照不可用 → 走下面的全表扫 */ }
  }
  const all = realReviews(rows || await db.reviews.toArray());
  const m = new Map();
  // 审计 P1-2（round33）：quickCheck 行不计入 failCount——统一口径 realReviews。
  // quick 答错直接推高计数会把卡误标红/送进错题本重点区。
  for (const r of all) if (r.rating === 0) m.set(r.cardId, (m.get(r.cardId) || 0) + 1);
  _failCountCache = { key, map: m };
  return m;
}

// round29：把「答错次数」批量附加到卡片行上（列表/分析入口统一用它，不要在各处直读 c.failCount）。
// 背景：failCount 是 reviews 流水的聚合派生值，db.cards 的原始行里没有这个字段——
// 凡是从 bulkGet/listCards/toArray 拿到卡片就直接读 c.failCount 的地方，值恒为 undefined
// （表现为「错 undefined 次」或薄弱判定静默失效）。语义同 repo-core.rankWeakCards。
// 无失败记录的卡保持原对象引用（零拷贝）；聚合失败时原样返回，绝不阻断调用方。
// round29：把「答错次数」批量附加到卡片行上（列表/分析入口统一用它，不要在各处直读 c.failCount）。
// 背景：failCount 是 reviews 流水的聚合派生值，db.cards 的原始行里没有这个字段——
// 凡是从 bulkGet/listCards/toArray 拿到卡片就直接读 c.failCount 的地方，值恒为 undefined
// （表现为「错 undefined 次」或薄弱判定静默失效）。语义同 repo-core.rankWeakCards。
// 无失败记录的卡保持原对象引用（零拷贝）；聚合失败时原样返回，绝不阻断调用方。
export async function attachFailCounts(cards) {
  if (!Array.isArray(cards) || !cards.length) return cards; // 非数组/空数组透明返回，由调用方兜底
  try {
    const fm = await failCountMap();
    if (!fm.size) return cards;
    return cards.map(c => (fm.has(c.id) ? { ...c, failCount: fm.get(c.id) } : c));
  } catch {
    return cards;
  }
}

// ---------- 复习提醒建议 ----------
// ---------- 复习提醒建议 ----------
export async function getReviewSuggestion() {
  // 建议核心已抽至 repo-core.buildReviewSuggestion（N9）
  // 审计 P1-2（round33）：复习建议基于真实复习，排除 quickCheck 自测行
  const { cards, reviews } = await dashboardSnapshot();
  return buildReviewSuggestion(cards, realReviews(reviews), now());
}

// ---------- 统计 ----------
// ---------- 统计 ----------
export async function getStats() {
  // 统计核心已抽至 repo-core.computeStats（N9）；computeStats 内部排除 quickCheck 行
  const { cards, reviews } = await dashboardSnapshot();
  return computeStats(cards, reviews, now());
}

// ---------- 备忘录（四象限：重要/紧急） ----------
// ---------- 备忘录（四象限：重要/紧急） ----------
export async function listMemos() {
  return db.memos.orderBy('at').reverse().toArray();
}
export async function addMemo(payload) {
  const text = String(payload?.text || '').trim();
  if (!text) return null;
  // round34 H1：fieldTs 初始化（备忘录可编辑字段 text/important/urgent）
  const m = { id: uid(), text, important: !!payload.important, urgent: !!payload.urgent, at: Date.now(), createdAt: Date.now(),
    fieldTs: { text: Date.now(), important: Date.now(), urgent: Date.now() } };
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
const localDateStr = (d) => createDateKey(d ? new Date(d).getTime() : undefined);

/** 列出某天的计划（默认今天），含任务明细；当天多份时取 updatedAt 最新的一份 */
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
  // round34 H1：字段级时间戳初始化（与卡片侧 createCard 同纪律）——跨设备并发改不同字段不丢一端。
  const note = { id: uid(), ...norm, createdAt: t, updatedAt: t,
    fieldTs: { content: t, title: t, tags: t, category: t, subject: t, linkedCardIds: t } };
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
    // round34 H1：只 bump 本次真正变化的字段时间戳，使合并侧逐字段取新（并发改不同字段不丢）。
    const fts = { ...(cur.fieldTs || {}) };
    for (const k of ['content', 'title', 'tags', 'category', 'subject', 'linkedCardIds']) {
      if (norm[k] !== cur[k]) fts[k] = t;
    }
    const out2 = { id, ...norm, fieldTs: fts };
    await db.notes.put(out2);
    fireHook('onNoteSaved', out2);
    return out2;
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
          const tNow = now();
          await db.cards.update(c.id, {
            linkedNoteIds: c.linkedNoteIds.filter(x => x !== id), updatedAt: tNow,
            fieldTs: { ...(c.fieldTs || {}), linkedNoteIds: tNow },
          });
        }
      }
    }
  });
  // round34 M6：笔记正文可能经 [[sxy-img://id]] 引用图片，删除笔记后若这些图不再被任何
  // 其它笔记/卡/资料引用，应作为孤儿清理并写墓碑（否则残留图随同步扩散，
  // 与 deleteCard / deleteWordCard 的孤儿图口径对齐）。
  // 注意：上面的事务已删除 note 行，故 findOrphanImages 不会再把它计入「在用」。
  const noteImgIds = extractImageIds(JSON.stringify(old || {}));
  if (noteImgIds.length) {
    const orphanImages = await findOrphanImages(noteImgIds);
    if (orphanImages.length) {
      await db.tombstones.bulkPut(orphanImages.map(id => ({ id, kind: 'image', deletedAt: now() })));
      await db.images.bulkDelete(orphanImages);
    }
  }
  // round75 审计：删笔记会级联清洗卡片侧的 linkedNoteIds（对 db.cards 做字段级 update），
  // 属「改字段」类写路径 → 显式失效共享快照（与 updateCard / setMarked 同口径）。
  invalidateDashboardCache();
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
// ---------- AI 文档（可持久化、随数据包同步） ----------
export async function listDocs() {
  return db.docs.orderBy('updatedAt').reverse().toArray();
}
export async function getDoc(id) {
  return (await db.docs.get(id)) || null;
}
// round38：文档/模考的「可编辑字段」清单——create（初始化 fieldTs）与 update（diff bump）
// 共用同一常量，避免两处各写一份、以后加字段漏改一处导致该字段无字段级保护。
// round38：文档/模考的「可编辑字段」清单——create（初始化 fieldTs）与 update（diff bump）
// 共用同一常量，避免两处各写一份、以后加字段漏改一处导致该字段无字段级保护。
const DOC_EDITABLE_FIELDS = ['title', 'content', 'type', 'tags', 'source'];
const EXAM_EDITABLE_FIELDS = ['title', 'subject', 'questions', 'score', 'total'];

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
    // round38：字段级时间戳——跨设备并发改不同字段不再整行覆盖丢一端
    fieldTs: Object.fromEntries(DOC_EDITABLE_FIELDS.map(k => [k, t])),
  };
  await db.docs.put(d);
  return d;
}
export async function updateDoc(id, patch) {
  return db.transaction('rw', db.docs, async () => {
    const old = await db.docs.get(id);
    if (!old) throw new Error('文档不存在');
    const t = now();
    const d = plain({ ...old, ...(patch || {}), updatedAt: t });
    // round38：只 bump 本次真正变化字段的 fieldTs（合并侧 mergeByFieldTs 据此逐字段取新）
    const fts = { ...(old.fieldTs || {}) };
    for (const k of DOC_EDITABLE_FIELDS) if (d[k] !== old[k]) fts[k] = t;
    d.fieldTs = fts;
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
  // round33 A-1：资料边的 from/to 存的是知识点 label（见 saveGraphEdge 用 e.docId 判重），
  // 原实现只按 from/to.equals(docId) 匹配 → 资料边永远匹配不到 → 幽灵边常驻并随同步回灌。
  // docId 无索引（db.js graphEdges 索引不含它），补一次 filter 全表兜住「资料型边」；
  // 删除为低频操作，图谱万级内全表 filter 一次可接受。
  const edgeMap = new Map();
  for (const e of await db.graphEdges.where('from').equals(id).toArray()) edgeMap.set(e.id, e);
  for (const e of await db.graphEdges.where('to').equals(id).toArray()) edgeMap.set(e.id, e);
  for (const e of await db.graphEdges.filter(e => e.docId === id).toArray()) edgeMap.set(e.id, e);
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
  const m = { id: uid(), title, root: plain(root), createdAt: t, updatedAt: t,
    // round34 H1：fieldTs 初始化（导图可编辑字段 title/root）
    fieldTs: { title: t, root: t } };
  await db.mindmaps.put(m);
  return m;
}
export async function updateMindmap(id, patch) {
  return db.transaction('rw', db.mindmaps, async () => {
    const old = await db.mindmaps.get(id);
    if (!old) throw new Error('导图不存在');
    const m = plain({ ...old, ...(patch || {}), updatedAt: now() });
    // round34 H1：字段级时间戳——只 bump 变化的字段
    const fts = { ...(old.fieldTs || {}) };
    for (const k of ['title', 'root']) if (m[k] !== old[k]) fts[k] = now();
    m.fieldTs = fts;
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
    // round38：字段级时间戳（跨设备并发改不同字段不再整行覆盖）——与 updateExam 共用同一字段清单
    fieldTs: Object.fromEntries(EXAM_EDITABLE_FIELDS.map(k => [k, t])),
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
    const t = now();
    const e = plain({ ...old, ...(patch || {}), updatedAt: t });
    // round38：字段级时间戳——只 bump 本次真正变化的字段（清单与 saveExam 共用）
    const fts = { ...(old.fieldTs || {}) };
    for (const k of EXAM_EDITABLE_FIELDS) if (e[k] !== old[k]) fts[k] = t;
    e.fieldTs = fts;
    await db.exams.put(e);
    return e;
  });
}

// ————————————————————————————————————————————————————————————
// 新增：资产体检 / 埋点 / 最佳最坏拍档 / 隐私数据（P1·8 八项接口）
// ————————————————————————————————————————————————————————————

// 1) 僵尸卡 ID 集合（90 天到期且从未复习）
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
    const reviews = realReviews(await db.reviews.where('reviewedAt').above(since - 1).toArray());
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
    const reviews = realReviews(await db.reviews.where('reviewedAt').above(since - 1).limit(200).reverse().toArray()).reverse();
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
    const reviews = realReviews(await db.reviews.where('reviewedAt').above(since - 1).toArray());
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
  // 审计 P2-2（round32）：删除 cards 全表扫描——parked 判定只依赖 links/groups 两张小表，
  // anyOf 已含全部分组卡的 id；未分组卡不停车（旧行为），根本不需要遍历 cards。
  // 此前万卡级时每次进复习队列都整表物化 cards，击穿了 reviewQueue 的 dueAt 索引收窄优化。
  const [links, groups] = await Promise.all([
    db.cardGroupLinks.toArray(),
    db.cardGroups.toArray(),
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
  for (const cardId of anyOf) {
    if (!activeOf.has(cardId)) parked.add(cardId);
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

// ---------- v34：通用卡 ↔ 通用卡链接（cardLinks，多对多「同一知识点」） ----------
// 与 cardWordLinks 同构，但两端都是 cards 行——纯记忆卡（线代/计网/政治…）之间
// 可以直接互相关联，不再只能挂英语词卡。
// 存储有向（from→to），展示层按「双向关联」处理（查询两侧取并集）；
// id = `${fromCardId}:${toCardId}` 确定性拼接 → 同一对重复 link 幂等、unlink 精确命中。

function cardLinkId(a, b) { return `${a}:${b}`; }

/** 建立关联（自动去重：同一对任意方向只保留一行，反向已存在时直接返回既有行） */
export async function linkCards(fromCardId, toCardId) {
  if (!fromCardId || !toCardId || fromCardId === toCardId) return null; // 禁止自环
  const reverse = cardLinkId(toCardId, fromCardId);
  const exists = (await db.cardLinks.get(reverse)) || (await db.cardLinks.get(cardLinkId(fromCardId, toCardId)));
  if (exists) return exists;
  const row = { id: cardLinkId(fromCardId, toCardId), fromCardId, toCardId, addedAt: Date.now() };
  await db.cardLinks.put(row);
  return row;
}

/** 解除关联（两个方向都尝试，前端不必关心当初是从哪端建立的） */
export async function unlinkCards(a, b) {
  const ids = [cardLinkId(a, b), cardLinkId(b, a)];
  const rows = (await db.cardLinks.bulkGet(ids)).filter(Boolean);
  if (!rows.length) return false;
  await db.transaction('rw', db.cardLinks, db.tombstones, async () => {
    await db.cardLinks.bulkDelete(rows.map(r => r.id));
    await db.tombstones.bulkPut(rows.map(r => ({ id: r.id, kind: 'cardLink', deletedAt: Date.now() })));
  });
  return true;
}

/** 取某张卡片关联的其它卡片（两个方向取并集，返回卡片实体；过滤已不存在的幽灵引用） */
export async function cardsOfCard(cardId) {
  if (!cardId) return [];
  const [out, inc] = await Promise.all([
    db.cardLinks.where('fromCardId').equals(cardId).sortBy('addedAt'),
    db.cardLinks.where('toCardId').equals(cardId).sortBy('addedAt'),
  ]);
  const seen = new Set();
  const ids = [];
  for (const l of [...out, ...inc]) {
    const other = l.fromCardId === cardId ? l.toCardId : l.fromCardId;
    if (other && other !== cardId && !seen.has(other)) { seen.add(other); ids.push(other); }
  }
  if (!ids.length) return [];
  const rows = await db.cards.bulkGet(ids);
  return ids.map((id, i) => rows[i]).filter(Boolean);
}

export async function allCardLinks() {
  return db.cardLinks.toArray();
}
