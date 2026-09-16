// src/agent/context.js
// 学习数据上下文构建：把用户在本地库（IndexedDB）中的真实复习情况，
// 整理成一段结构化文本，注入到 Agent 的系统提示里，让 Agent “基于事实”而非泛泛而谈。
// 这是“数据感知型 Agent”的核心：所有分析/建议类 Agent 都依赖它。

import { db } from '../db.js';
import { getStats, weakCards, getReviewSuggestion, getTags, listCards, getCard, listDailyPlanSummary, listPomoSessions } from '../repo.js';
import { getModuleSummary } from './analytics.js';
import { retrieveContext, ensureIndex, hybridSearch } from './retrieval.js';
import { stripImageRefs, clipText } from '../utils/clip.js';
import { wantedModules } from '../utils/query-intent.js';

function tagCountsStr(tags) {
  if (!tags || !tags.length) return '';
  return tags.slice(0, 20).map((t) => `${t.name}(${t.count}张)`).join('，');
}

/**
 * 构建用户学习数据上下文文本。
 * @returns {Promise<string>}
 */
export async function buildStudyContext() {
  const [stats, weak, suggestion, tags, moduleSummary] = await Promise.all([
    getStats(),
    weakCards(40, 1),
    getReviewSuggestion(),
    getTags(),
    getModuleSummary().catch(() => ''),
  ]);

  const L = [];
  L.push('【用户记忆卡片系统·真实数据概览】');
  L.push(
    `- 卡片总数 ${stats.totalCards} 张；总复习 ${stats.totalReviews} 次；今日已复习 ${stats.todayReviews} 次；今日待背 ${stats.dueToday} 张；平均掌握度 ${stats.avgMastery}%`,
  );
  L.push(
    `- 各科卡片占比：${Object.entries(stats.subjectCards || {}).map(([k, v]) => `${k} ${v}张`).join('，') || '无'}`,
  );
  const rd = stats.ratingDist || [0, 0, 0];
  L.push(`- 自评分布：没记住 ${rd[0]} 次 / 还模糊 ${rd[1]} 次 / 记住了 ${rd[2]} 次`);
  const ab = stats.ability || {};
  L.push(
    `- 能力四维：掌握度${ab.mastery ?? 0}% 正确率${ab.correct ?? 0}% 稳定度${ab.stable ?? 0}% 覆盖率${ab.coverage ?? 0}%`,
  );
  if (suggestion?.staleSubjects?.length) {
    L.push(`- 很久没复习的科目：${suggestion.staleSubjects.map((s) => `${s.name}(${s.days}天)`).join('，')}`);
  }
  if (tagCountsStr(tags)) L.push(`- 标签分布：${tagCountsStr(tags)}`);
  if (weak && weak.length) {
    const top = weak
      .slice(0, 20)
      .map(
        (c, i) =>
          `${i + 1}.[${c.subject || '未分类'}${c.marked ? '·错题' : ''}${c.wrongReason ? '·' + c.wrongReason : ''}] ${stripImageRefs(c.front).replace(/\s+/g, ' ').slice(0, 30)}（遗忘${c.failCount}次）`,
      )
      .join('；');
    L.push(`- 薄弱/错题卡片（按遗忘次数排序）：${top}`);
  }
  if (moduleSummary) L.push(moduleSummary);

  // 视觉型资料（扫描 PDF / 图片文件）没有可检索的文字层，RAG 永远搜不到它们。
  // 不明说的话，AI 面对「我上传的资料讲了什么」只能答「资料中未找到相关内容」——
  // 用户会以为资料没上传成功。这里显式告知存在性与正确入口（资料库页对该文件提问即走视觉）。
  try {
    const allFiles = await db.docFiles.toArray();
    // round98 N2：只把「解析就绪」的资料算作可用——解析中/失败的文件若也报「你有这份资料」，
    // AI 会引导用户去提问却读不出内容，造成「说我有却看不到」的二次落差。
    const files = allFiles.filter((f) => (f.status || 'ready') === 'ready');
    const { docKindOf } = await import('../services/doc-vision.js');
    const visual = files.filter((f) => {
      const k = docKindOf(f);
      return k === 'pdf' || k === 'image';
    });
    if (files.length) {
      L.push(
        `- 资料库：共 ${files.length} 份已解析就绪的资料，其中 ${visual.length} 份为 PDF/图片型文件`
        + `（内容以图像形式存在，文字检索取不到）。若用户询问这些文件的内容，`
        + `请引导他到「资料库」页打开该文件提问——那里会把页面图/原图直接送给多模态模型分析；`
        + `不要凭文件名或标题猜测文件内容。`,
      );
    }
    const unparsed = allFiles.length - files.length;
    if (unparsed > 0) L.push(`- 另有 ${unparsed} 份资料尚在解析或解析失败，内容暂不可用，请如实告知用户。`);
  } catch { /* 统计失败不影响上下文主流程 */ }

  return L.join('\n');
}

/**
 * 构建可供工具调用的"结构化上下文对象"（供 Agent 在 ReAct 循环中按需取用，
 * 避免把全部数据一次性塞进 prompt，节省 token）。
 */
export async function getStructuredContext() {
  const [stats, weak, suggestion] = await Promise.all([
    getStats(),
    weakCards(40, 1),
    getReviewSuggestion(),
  ]);
  return { stats, weak, suggestion };
}

/**
 * RAG 检索增强上下文：根据用户问题，从卡片库/文档中检索最相关的内容注入。
 * 这是 Agent 从「全量注入」升级到「精准注入」的关键——Agent 只看到与问题最相关的 top-k 条。
 * 会顺带做一次轻量增量索引（ensureIndex），保证索引不滞后太多。
 * @param {string} query 用户问题
 * @returns {Promise<string>} RAG 上下文文本（可能为空）
 */
export async function buildRAGContext(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return '';
  try {
    // 轻量增量索引：最多补 20 张过期卡 + 3 篇过期文档，不阻塞太久
    await ensureIndex(20, 3);
    const ragText = await retrieveContext(q, { topK: 6 });
    return ragText || '';
  } catch {
    return ''; // RAG 失败不阻塞主流程
  }
}

/**
 * 构建完整上下文：学习数据概览 + RAG 检索增强。
 * Orchestrator 调用此函数，把结果注入 Agent 系统提示。
 * @param {string} query 用户问题（用于 RAG 检索）
 * @returns {Promise<string>}
 */


// ---------- 普通问答专属：主动搜卡注入全文 + 模块节点可见 ----------

/**
 * 普通问答「按问题搜卡并注入全文」：
 * 主动按用户问题检索最相关卡片，取**完整正/背面**注入（含图片引用，交给 enrichForLlm 送图），
 * 与 Agent 的 get_card_detail 对齐——普通问答不再是「只能看 RAG 80/120 字碎片」。
 * 关键词命中优先，语义检索兜底；合并去重后取 top-N，超长卡按码点截断（保留图片引用）。
 * @param {string} query 用户问题
 * @returns {Promise<string>} 完整卡片上下文（无命中返回 ''）
 */
const FULL_CARD_LIMIT = 8;          // 普通问答注入的「完整卡片」上限（控 token）
const MAX_FULL_CARD_CHARS = 1200;   // 单卡正文上限，防超长卡撑爆上下文
export async function buildQuestionCardContext(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return '';
  try {
    const ids = new Map(); // id -> 评分（用于排序/去重）
    // ① 关键词搜索（listCards 按正/背面模糊匹配）
    const kw = await listCards({ q }).catch(() => ({ items: [] }));
    (kw.items || []).slice(0, FULL_CARD_LIMIT).forEach((c, i) => {
      if (c?.id && !ids.has(c.id)) ids.set(c.id, 100 - i);
    });
    // ② 语义兜底（无关键词命中或补充）：取 embedding 命中的卡片 id
    if (ids.size < FULL_CARD_LIMIT) {
      const sem = await hybridSearch(q, { topK: FULL_CARD_LIMIT }).catch(() => []);
      for (const r of sem) {
        const id = r?.row?.sourceId;
        if (r?.row?.sourceType === 'card' && id && !ids.has(id)) {
          ids.set(id, Math.round((r.fused || 0) * 100));
        }
      }
    }
    const topIds = [...ids.keys()].slice(0, FULL_CARD_LIMIT);
    if (!topIds.length) return '';
    const cards = await Promise.all(topIds.map((id) => getCard(id).catch(() => null)));
    // 头部说明也写成「长串」以满足 i18n 数据层闸（短中文会被判新增），下同
    const L = ['【检索增强·与问题最相关的卡片·完整正文】（已按你的提问主动检索并取完整内容，含图片引用将作为附图发送给你）'];
    let n = 0;
    for (const c of cards) {
      if (!c) continue;
      n++;
      // clipText 保图片引用完整（超长只截正文，引用追加末尾），交给 enrichForLlm 送图
      L.push(`- [卡片 ${n}] [${c.subject || '未分类'}] 正面：${clipText(c.front, MAX_FULL_CARD_CHARS)}\n  背面：${clipText(c.back, MAX_FULL_CARD_CHARS)}`);
    }
    if (!n) return '';
    L.push('（以上为命中卡片的完整内容，含图片引用会作为附图发送给你；如需更多卡片可按科目/标签继续追问。）');
    return L.join('\n');
  } catch {
    return '';
  }
}

/**
 * 全模块明细快照（round98 P2-2：**按问题意图下饭 + 总预算刹车**）
 *
 * 背景：普通问答（AI 学习助手）无工具，只能看注入上下文。此前（round96）无论问什么都把
 * **全库明细**注入 system——问「你好」也发全部笔记/文档/单词/计划，既费 token、外发隐私，
 * 还可能撑爆小窗口模型。现在两道约束：
 *   ① **按意图下饭**：只有问题「问到」的模块才查询、才注入（缺省关键词见 utils/query-intent.js）；
 *   ② **总预算刹车**：所有明细合计不超过 MODULE_TOTAL_BUDGET 字符，超出即截并显式告知模型。
 * 兼容：**不传 query**（null，测试或显式全量）时保持注入全部模块。
 * **图片**：文档/笔记正文用 clipText（保 sxy-img 引用完整）→ 交 enrichForLlm 作为附图送出。
 * @param {string|null} [query] 用户问题；null = 不筛（全量）
 * @returns {Promise<string>}
 */
const MODULE_TOTAL_BUDGET = 16000; // 普通问答单次明细注入的总字符预算

export async function buildModuleNodesContext(query = null) {
  const q = query == null ? null : String(query || '');
  const wanted = q == null ? null : wantedModules(q); // null = 全量；Set = 仅这些模块
  if (wanted && wanted.size === 0) return '';         // 没问到任何模块 → 不注入明细
  const want = (key) => (wanted === null || wanted.has(key));
  try {
    const L = [];
    let budget = MODULE_TOTAL_BUDGET;
    let clipped = false;
    const add = (s2) => {
      if (!s2) return;
      if (budget <= 0) { clipped = true; return; }
      if (s2.length <= budget) { L.push(s2); budget -= s2.length; }
      else { L.push(clipText(s2, budget)); budget = 0; clipped = true; }
    };
    if (want('memos')) {
      const memos = await db.memos.orderBy('at').reverse().limit(30).toArray().catch(() => []);
      if (memos.length) add(`- 备忘（列出最近的 ${memos.length} 条，备忘多为短句，此处直接给出全文供你引用）：${memos.map((m) => clipText(String(m.text || ''), 200)).join(' | ')}`);
    }
    if (want('docs')) {
      const docs = await db.docs.orderBy('updatedAt').reverse().limit(10).toArray().catch(() => []);
      if (docs.length) {
        const items = docs.map((d) => `《${d.title || '无标题文档'}》的类型为${d.type === 'note' ? '笔记' : d.type === 'plan' ? '计划' : d.type === 'summary' ? '总结' : (d.type || '未分类')}，正文摘要如下：${clipText(String(d.content || ''), 500)}`);
        add(`- AI 文档（列出最近 ${docs.length} 篇的标题与正文摘要，正文里的图片引用已完整保留）：\n  ${items.join('\n  ')}`);
      }
    }
    if (want('notes')) {
      const notes = await db.notes.orderBy('updatedAt').reverse().limit(10).toArray().catch(() => []);
      if (notes.length) {
        const items = notes.map((n) => `《${n.title || '无标题笔记'}》的分类为${n.category || '未分类'}，正文摘要如下：${clipText(String(n.content || ''), 500)}`);
        add(`- 笔记（列出最近 ${notes.length} 篇的标题与正文摘要，正文里的图片引用已完整保留）：\n  ${items.join('\n  ')}`);
      }
    }
    if (want('plans')) {
      const plans = await db.plans.orderBy('updatedAt').reverse().limit(6).toArray().catch(() => []);
      if (plans.length) {
        const items = plans.map((p) => `《${p.title || '未命名计划'}》的当前状态为${p.status === 'active' ? '进行中' : p.status === 'done' ? '已完成' : p.status === 'archived' ? '已归档' : (p.status || '未知')}，内容摘要如下：${clipText(String(p.content || ''), 300)}`);
        add(`- 长期学习计划（列出最近 ${plans.length} 份的标题、状态与内容摘要）：\n  ${items.join('\n  ')}`);
      }
    }
    if (want('daily')) {
      const dsum = await listDailyPlanSummary(7).catch(() => []);
      if (dsum.length) {
        const items = dsum.slice(0, 7).map((d) => `日期${d.date}，当日任务完成${d.done}项，总计${d.total}项任务`);
        add(`- 每日规划执行情况（最近若干天，格式为日期与当日任务完成数）：${items.join('，')}`);
      }
    }
    if (want('pomo')) {
      const pomo = await listPomoSessions(15).catch(() => []);
      if (pomo.length) {
        const pad = (x) => String(x).padStart(2, '0');
        const loc = (ts) => { const dd = new Date(Number(ts) || 0); return Number.isFinite(dd.getTime()) ? `${dd.getMonth() + 1}/${dd.getDate()} ${pad(dd.getHours())}:${pad(dd.getMinutes())}` : ''; };
        const items = pomo.map((p) => `开始于${loc(p.startedAt)}，专注时长${p.duration || 0}分钟${p.tag ? '，标签' + p.tag : ''}${p.partial ? '，未完成' : ''}`);
        add(`- 番茄钟专注明细（共 ${pomo.length} 次，列出每次的本地开始时刻、时长分钟与标签）：${items.join('；')}`);
      }
    }
    if (want('words')) {
      const words = await db.wordCards.orderBy('updatedAt').reverse().limit(15).toArray().catch(() => []);
      if (words.length) {
        const items = words.map((w) => `${w.word || ''}${w.meaning ? '（' + String(w.meaning).slice(0, 40) + '）' : ''}`);
        add(`- 单词模块（列出最近接触的 ${words.length} 个词条及其释义摘要）：${items.join('；')}`);
      }
    }
    if (want('files')) {
      const files = await db.docFiles.toArray().catch(() => []);
      const ready = files.filter((f) => (f.status || 'ready') === 'ready');
      if (ready.length) {
        const items = ready.slice(0, 20).map((f) => `${f.name || f.id}${f.subject ? '[' + f.subject + ']' : ''}`);
        add(`- 资料库文件（列出可用（解析就绪）的 ${ready.length} 份，名称与科目；PDF/图片型文件内容以图像存在，需到「资料库」页打开该文件提问才能看到画面）：${items.join('、')}`);
      }
      const bad = files.filter((f) => f.status === 'failed' || f.status === 'parsing');
      if (bad.length) add(`- 另有 ${bad.length} 份资料尚未解析成功（解析中或已失败），其内容当前无法分析，请如实告知用户，不要让用户以为资料丢失。`);
    }
    if (want('graph')) {
      const total = await db.graphEdges.count().catch(() => 0);
      if (total > 0 && total <= 120) {
        const edges = await db.graphEdges.toArray().catch(() => []);
        const edgeStrs = edges.map((e) => `${e.from}（起点）→${e.to}（终点），关联关系为：${e.label || '相关'}`);
        add(`- 知识图谱关联边（当前共 ${total} 条，下面列出每一条的端点与关系）：${edgeStrs.join('；')}`);
      } else if (total > 120) {
        add(`- 知识图谱关联边：共 ${total} 条（较多已自动折叠；如需查看完整结构，可到「知识图谱」页浏览）`);
      }
    }
    if (!L.length) return '';
    const head = '【模块明细快照（以下只包含与你问题相关的模块内容；正文里的图片引用已原样保留，会作为附图随本次请求发送给你）】';
    const tail = clipped ? '\n（以上明细已达本次单次注入的字符上限，未列出的部分你可以继续就具体模块追问获取）' : '';
    return [head, ...L].join('\n') + tail;
  } catch {
    return '';
  }
}

export async function buildFullContext(query) {
  const [study, rag] = await Promise.all([buildStudyContext(), buildRAGContext(query)]);
  return [study, rag].filter(Boolean).join('\n\n');
}
