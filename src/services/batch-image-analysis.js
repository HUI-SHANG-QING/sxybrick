// src/services/batch-image-analysis.js
// 批量图片分析引擎：把「正文里带图的卡片」逐批送给多模态 AI，产出
// 「图内容 + 考点 + 与卡片正文的校验」，最后汇总成一份笔记（总览 + 逐卡要点）。
//
// 为什么必须分批：单次请求的图片**总体积**有硬上限（VISION_BYTES_BUDGET = 24MB），
//   上千张图物理上不可能一次送出；而且 chat() 有 60s 超时，base64 体积一旦上百 MB
//   浏览器与网关都会直接拒绝。分批 + 断点续跑是唯一可行路径。
//
// 跨批的「全局关联」怎么来：**不靠一次看几千张图**（做不到），而靠最后一步的
//   **汇总**——那时所有结果已是纯文本，不受图片体积约束，可以一次喂给模型做横向对比。
//
// 四条设计纪律：
//   ① 断点续跑：状态存 db.meta（本机键值，不进同步），关掉页面再回来能接着跑；
//   ② 不重复花钱：按「图片版本签名」跳过已分析的卡（图/正文改了才重跑）；
//   ③ 可暂停：状态机 idle/running/paused/done/error，用户随时能停；
//   ④ 绝不静默丢卡：每张卡最终都有归宿（成功，或明确失败待重试）。

import { db } from '../db.js';
import { extractImageIds } from '../images.js';
import { chatAI } from '../ai.js';
import { extractJSON } from '../agent/llm.js';
import { dashboardSnapshot, invalidateDashboardCache, createNote, updateNote, getNote } from '../repo.js';
import { hasImageRef } from '../utils/clip.js';

export const BATCH_STATE_KEY = 'sxy_batch_img_analysis';
export const BATCH_NOTE_CATEGORY = '图片批量分析';

const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 10;
/** 每批要求的输出结构（与 parseBatchReply 一致） */
const JSON_SHAPE = '[{"cardId":"卡片id","content":"图内容描述","points":"考点","issues":"与卡片正文的校验结果"}]';

/** 空状态（首次运行 / 重置后） */
function emptyState() {
  return {
    status: 'idle',
    queue: [],        // [{ cardId, sig }] 待分析快照
    cursor: 0,        // queue 中已处理到的位置
    done: {},         // cardId → { sig, content, points, issues, analyzedAt }
    failed: {},       // cardId → 原因（用户可重跑）
    noteId: null,     // 汇总笔记 id（增量更新同一条）
    batchSize: DEFAULT_BATCH_SIZE,
    stats: { total: 0, finished: 0, failed: 0, calls: 0 },
    startedAt: null,
    updatedAt: null,
    error: null,
  };
}

/**
 * 图片版本签名：正文或图片集合变化 → 签名变化 → 需要重新分析。
 * 用 updatedAt 兜住「换了一张图但 id 列表长度不变」的情况。
 */
export function imgSigOf(card) {
  const ids = extractImageIds(`${card?.front || ''}\n${card?.back || ''}`);
  return `${card?.updatedAt ?? 0}#${ids.join(',')}`;
}

/** 读取任务状态（无则返回空状态；脏数据兜底） */
export async function getBatchState() {
  try {
    const row = await db.meta.get(BATCH_STATE_KEY);
    const v = row?.value;
    if (!v || typeof v !== 'object') return emptyState();
    return { ...emptyState(), ...v, done: { ...(v.done || {}) }, failed: { ...(v.failed || {}) } };
  } catch {
    return emptyState();
  }
}

/** 写状态（统一补 updatedAt） */
async function saveState(state) {
  const next = { ...state, updatedAt: Date.now() };
  await db.meta.put({ key: BATCH_STATE_KEY, value: next });
  return next;
}

/** 重置任务状态（不清已生成的笔记） */
export async function resetBatchState() {
  return saveState(emptyState());
}

/** 批大小归一化：1..MAX_BATCH_SIZE，脏值回退默认 */
export function normalizeBatchSize(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(n, MAX_BATCH_SIZE);
}

/**
 * 扫描候选：所有「正文含图」的卡片，并按签名过滤出仍需分析的。
 * 注意用 dashboardSnapshot（唯一全表物化点），且**只读不改**返回的数组。
 * @param {{ force?: boolean }} [opts] force=true 时忽略签名，全部重跑
 * @returns {Promise<{ totalWithImg:number, pending:Array, skipped:number }>}
 */
export async function scanCandidates({ force = false } = {}) {
  // 共享快照的 key 不完备（原地改写字段而不 bump updatedAt 时会计中陈旧数据）。
  // 批量分析是「用户主动触发的全量读」，开跑前显式失效一次，确保扫到最新卡片集合。
  invalidateDashboardCache();
  const snap = await dashboardSnapshot();
  const cards = Array.isArray(snap?.cards) ? snap.cards : [];
  const withImg = cards.filter((c) => c && (hasImageRef(c.front) || hasImageRef(c.back)));
  const state = await getBatchState();
  const pending = withImg.filter((c) => force || state.done[c.id]?.sig !== imgSigOf(c));
  return { totalWithImg: withImg.length, pending, skipped: withImg.length - pending.length };
}

/** 组装一批的分析提示词 */
function buildBatchPrompt(items) {
  const blocks = items.map((c, i) => {
    const front = String(c.front || '');
    const back = String(c.back || '');
    return [
      `【卡片 ${i + 1}】cardId=${c.id}`,
      `科目：${c.subject || '未分类'}`,
      `正面：${front}`,
      `背面：${back}`,
    ].join('\n');
  }).join('\n\n');

  return [
    '你是学习分析助手。下面每张卡片的正面/背面正文里内嵌了图片（图片会作为附图一并发送）。',
    '请**逐张**分析，对每张卡输出三部分：',
    '1. content — 客观描述图里有什么（图表类型、关键结构/公式/标注、能看出的数值或步骤）；',
    '2. points — 这张图对应的知识点/考点（用于复习时快速定位）；',
    '3. issues — 卡片正文与图是否一致？有无矛盾、遗漏或明显错误？没问题就写「一致」。',
    '若某张卡的图你实际没有收到，issues 里如实说明「未收到图片」，不要凭空猜测图的内容。',
    '',
    `只输出 JSON 数组，不要 markdown 代码块，不要多余文字。结构：${JSON_SHAPE}`,
    '',
    blocks,
  ].join('\n');
}

/**
 * 解析模型回复为结果数组。
 * 容错：模型可能返回裸数组、被 ```json 包裹、或单个对象。
 * @returns {Array<{cardId,content,points,issues}>}
 */
export function parseBatchReply(reply, expectedIds = []) {
  let arr = null;
  try {
    const json = extractJSON(String(reply || ''));
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && typeof parsed === 'object') arr = [parsed];
  } catch { /* 解析失败 → 下方按空处理 */ }
  if (!Array.isArray(arr)) return [];
  const allowed = new Set(expectedIds);
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      cardId: String(x.cardId ?? x.id ?? ''),
      content: String(x.content ?? '').trim(),
      points: String(x.points ?? '').trim(),
      issues: String(x.issues ?? '').trim(),
    }))
    // 只接受本批内的 cardId，防止模型串号把结果写到别的卡上
    .filter((x) => x.cardId && (!allowed.size || allowed.has(x.cardId)));
}

/**
 * 跑一批（不递归；由调用方循环，便于 UI 逐批刷新进度）。
 *
 * @param {object} [opts]
 * @param {number} [opts.batchSize] 覆盖批大小
 * @param {boolean} [opts.offline] 测试注入：跳过真实 LLM，用 opts.fakeReply
 * @param {(s:object)=>void} [opts.onProgress] 状态变化回调
 * @returns {Promise<{ state:object, processed:number, remaining:number }>}
 */
export async function runOneBatch(opts = {}) {
  let state = await getBatchState();
  if (state.status !== 'running') return { state, processed: 0, remaining: 0 };

  const size = normalizeBatchSize(opts.batchSize ?? state.batchSize);
  const slice = state.queue.slice(state.cursor, state.cursor + size);
  if (!slice.length) {
    // 队列已空 → 收尾
    state = await saveState({ ...state, status: 'done', error: null });
    opts.onProgress?.(state);
    return { state, processed: 0, remaining: 0 };
  }

  // 取这批卡的完整正文（按快照顺序）
  const cards = await db.cards.bulkGet(slice.map((x) => x.cardId));
  const items = cards.filter(Boolean);

  let results = [];
  try {
    // chatFn 注入点：测试可模拟「模型只答了一部分」「返回垃圾」等真实故障
    const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatAI;
    const msgs = [{ role: 'user', content: buildBatchPrompt(items) }];
    const reply = opts.offline
      ? JSON.stringify(items.map((c) => ({
        cardId: c.id, content: '（离线桩）图内容', points: '（离线桩）考点', issues: '一致',
      })))
      : await chatFn(msgs, { source: 'batchImage' });
    results = parseBatchReply(reply, items.map((c) => c.id));
  } catch (e) {
    // 整批失败：不推进 cursor（下轮重试同一批），把原因记下来供 UI 展示
    state = await saveState({ ...state, status: 'error', error: String(e?.message || e) });
    opts.onProgress?.(state);
    return { state, processed: 0, remaining: state.queue.length - state.cursor };
  }

  const byId = new Map(results.map((r) => [r.cardId, r]));
  const done = { ...state.done };
  const failed = { ...state.failed };
  const now = Date.now();
  for (const x of slice) {
    const r = byId.get(x.cardId);
    if (r) {
      done[x.cardId] = { sig: x.sig, ...r, analyzedAt: now };
      delete failed[x.cardId];
    } else {
      // 模型没返回这张卡 → 明确记为失败（绝不静默丢），用户可重跑
      failed[x.cardId] = '模型未返回该卡结果';
    }
  }

  const nextCursor = state.cursor + slice.length;
  const finishedIds = Object.keys(done).length;
  state = await saveState({
    ...state,
    cursor: nextCursor,
    done,
    failed,
    noteId: state.noteId,
    status: nextCursor >= state.queue.length ? 'done' : 'running',
    error: null,
    stats: {
      ...state.stats,
      finished: finishedIds,
      failed: Object.keys(failed).length,
      calls: (state.stats?.calls || 0) + (opts.offline ? 0 : 1),
    },
  });
  opts.onProgress?.(state);
  return { state, processed: slice.length, remaining: state.queue.length - nextCursor };
}

/**
 * 启动一次批量分析：扫描 → 建队列 → 置为 running。
 * @param {{ force?:boolean, batchSize?:number }} [opts]
 * @returns {Promise<{ started:boolean, total:number, skipped:number, state:object }>}
 */
export async function startBatch(opts = {}) {
  const prev = await getBatchState();
  if (prev.status === 'running') return { started: false, total: 0, skipped: 0, state: prev };

  const { pending, skipped } = await scanCandidates({ force: !!opts.force });
  if (!pending.length) {
    const state = await saveState({ ...prev, status: 'idle', error: null });
    return { started: false, total: 0, skipped, state };
  }
  const queue = pending.map((c) => ({ cardId: c.id, sig: imgSigOf(c) }));
  const state = await saveState({
    ...emptyState(),
    batchSize: normalizeBatchSize(opts.batchSize),
    queue,
    cursor: 0,
    // 保留已分析结果：force=false 时它们本就不在 pending 里；force=true 时全部重算
    done: opts.force ? {} : prev.done,
    noteId: opts.force ? null : prev.noteId,
    status: 'running',
    startedAt: Date.now(),
    stats: { total: queue.length, finished: 0, failed: 0, calls: 0 },
  });
  return { started: true, total: queue.length, skipped, state };
}

/** 暂停（保留进度，可再继续） */
export async function pauseBatch() {
  const s = await getBatchState();
  if (s.status !== 'running') return s;
  return saveState({ ...s, status: 'paused' });
}

/** 从暂停处继续 */
export async function resumeBatch() {
  const s = await getBatchState();
  if (s.status !== 'paused') return s;
  return saveState({ ...s, status: 'running', error: null });
}

/** 汇总用的总览提示词 */
function buildSummaryPrompt(entries) {
  const body = entries
    .map((e, i) => `【${i + 1}】[${e.subject || '未分类'}] ${e.title}\n图内容：${e.content}\n考点：${e.points}\n校验：${e.issues}`)
    .join('\n\n');
  return [
    '下面是若干张复习卡片的图片分析结果（按卡片逐条列出）。请**横向汇总**，输出：',
    '1. 这些图的考点分布（集中在哪些知识点上，哪几类反复出现）；',
    '2. 发现的共性问题（例如多张卡正文与图矛盾、图信息缺失、同一考点重复建卡）；',
    '3. 建议的复习重点（按优先级）。',
    '只输出 Markdown 正文，不要重复逐条罗列（逐卡明细我会另附）。',
    '',
    body,
  ].join('\n');
}

/**
 * 把当前结果汇总成一份笔记（总览 + 逐卡要点）。
 * 已存在则更新同一条（增量重跑不会产生一堆重复笔记）。
 * @param {{ offline?:boolean, subjectOf?:(cardId:string)=>string, titleOf?:(cardId:string)=>string }} [opts]
 * @returns {Promise<{ noteId:string, overview:string, entries:number }>}
 */
export async function flushBatchNote(opts = {}) {
  const state = await getBatchState();
  const doneIds = Object.keys(state.done);
  if (!doneIds.length) return { noteId: state.noteId, overview: '', entries: 0 };

  const cards = await db.cards.bulkGet(doneIds);
  const cardMap = new Map(cards.filter(Boolean).map((c) => [c.id, c]));

  const entries = doneIds.map((id) => {
    const d = state.done[id];
    const card = cardMap.get(id);
    return {
      cardId: id,
      subject: card?.subject || opts.subjectOf?.(id) || '未分类',
      title: String(card?.front || opts.titleOf?.(id) || '（卡片已删除）').replace(/\s+/g, ' ').slice(0, 60),
      content: d.content, points: d.points, issues: d.issues,
    };
  });

  // ① 总览（一次纯文本调用，不受图片体积限制 —— 这正是「跨批汇总」的实现方式）
  let overview = '';
  try {
    const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatAI;
    if (opts.offline) overview = '（离线桩）总览';
    else overview = String(await chatFn([{ role: 'user', content: buildSummaryPrompt(entries) }], { source: 'batchImage' }) || '').trim();
  } catch (e) {
    overview = `（汇总失败：${String(e?.message || e)}）`;
  }

  // ② 逐卡要点
  const detail = entries
    .map((e, i) => [
      `### ${i + 1}. [${e.subject}] ${e.title}`,
      `- **图内容**：${e.content || '（无）'}`,
      `- **考点**：${e.points || '（无）'}`,
      `- **校验**：${e.issues || '（无）'}`,
    ].join('\n'))
    .join('\n\n');

  const content = [
    `# 卡片图片分析报告`, '',
    `> 共 ${entries.length} 张带图卡片 · 生成于 ${new Date().toLocaleString()}`, '',
    '## 一、总览', '', overview || '（无）', '',
    '## 二、逐卡要点', '', detail,
  ].join('\n');

  let noteId = state.noteId;
  const existing = noteId ? await getNote(noteId).catch(() => null) : null;
  if (existing) {
    await updateNote(noteId, { content });
  } else {
    const title = `卡片图片分析报告（${new Date().toLocaleDateString()}）`;
    const note = await createNote({ title, content, category: BATCH_NOTE_CATEGORY, tags: ['图片分析', 'AI'] });
    noteId = note.id;
  }
  const next = await saveState({ ...state, noteId });
  return { noteId, overview, entries: entries.length, state: next };
}
