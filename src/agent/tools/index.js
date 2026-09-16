// src/agent/tools/index.js
// 内置工具集：全部围绕“学习”场景，分为「数据感知」「卡片生产」「测评」三类。
// 每个工具都是纯函数式声明，通过 toolRegistry 注册；工具执行时由 ctx 提供 chat 能力。

import { toolRegistry } from '../registry.js';
import { extractJSON } from '../llm.js';
import { resolveAgentId } from '../attribution.js';
import {
  getStats,
  weakCards,
  getReviewSuggestion,
  getSubjects,
  getTags,
  listCards,
  createCard,
  updateCard,
  getCard,
  reviewHistory,
  addMemo,
  listMemos,
  createPlan,
  listPlans,
  updatePlan,
  createGraphEdge,
  listGraphEdges,
  listDocs,
  getDoc,
  createDoc,
  listNotes,
  getNote,
  createNote,
  updateNote,
  listDailyPlan,
  listDailyPlanSummary,
  createDailyPlan,
  addDailyTask,
  checkinDailyTask,
  // round85：工具层读/写 scheduledHour 一律走数据层这一份归一化——
  // 原先 4 处 `Number.isFinite(Number(v)) ? Number(v) : null` 会把 null 说成 0 点。
  clampScheduledHour,
  listPomoSessions,
} from '../../repo.js';
// round95：番茄钟逐次明细 / 历史 AI 对话内容——可直接读 db（基础模块，无环）
import { db } from '../../db.js';
import { getCardAnalytics, getRecentMistakes, getCrossModuleInsight, getLearningProfile, getConfusablePairs, getGapCards, getGraphDrivenReviewPlan, generateAutoPlan, getCalibration } from '../analytics.js';
import { generateDeck, generateColdStartDeck, bulkCreateCards, COLD_START_TEMPLATES } from '../../utils/genDeck.js';
import { hybridSearch, retrieveContext, ensureIndex, rebuildIndex, getIndexStatus } from '../retrieval.js';
import { listDocFiles, getDocText } from '../../docs-lib.js';
// round88：英语单词模块的工具接入。单词数据独立在 word-repo.js（与卡片域 db.cards 分表），
// 此前 tools 里一个单词工具都没有 → AI 对单词模块只能「看不到」。
import {
  listWordCards,
  getWordCard,
  wordStats,
  wordGroupStats,
  listWordGroups,
  dueWordCards,
  wordReviewedToday,
  wordReviewedTotal,
  WORD_KINDS,
} from '../../word-repo.js';
// round67：图片感知截断 + 引用检测。
// 卡片正文里的图片是 `![image](sxy-img://<36位uuid>)`（56 字符），朴素 slice 会把它切坏
// → 富集时查不到图 → AI 误以为「图没传过来」。这里统一走 clipText 保护引用完整性。
import { clipText, hasImageRef, stripImageRefs } from '../../utils/clip.js';
import { docKindOf, docContentProfile } from '../../services/doc-vision.js';
// round90：图片资产体检（悬空引用诊断现成于 statImageAssets，此前未注册成 AI 工具）
import { statImageAssets } from '../../services/image-analysis.js';

// round90：工具返回里的「明细引导 / 图片体检提示」是**发给模型的 prompt 契约**（永不翻译、不进 UI），
// 按项目约定用 *_PROMPT 顶层模板字面量承载（check-view-i18n.mjs 对 *_PROMPT 常量整段豁免）。
const STATS_DETAIL_HINT_PROMPT = `本统计只是汇总。各模块**明细**请调对应工具：单词 list_words/get_word_detail；知识图谱 list_graph_edges；计划 read_plan/list_daily_tasks；图片资产 get_image_assets；卡片全文 search_cards/get_card_detail；AI 文档 list_docs/read_doc；笔记 list_notes/read_note；备忘 list_memos；番茄钟逐次明细 get_pomodoro_sessions；历史 AI 对话 list_chats/read_chat。用户问「某模块具体内容」时务必调用对应工具拿真实数据，不要只凭本统计就说「只能看数量」。普通问答看不到这些节点时，请引导用户改用对应 Agent（如学习答疑导师）或到相应页面查看。`;
const IMAGE_ASSETS_HINT_OK_PROMPT = `图片资产健康：所有正文引用在本地图库均可读。`;
const IMAGE_ASSETS_HINT_DANGLING_PROMPT = `有悬空图片引用（数据缺失）：跨设备未同步 / 原图被删 / 导入备份未带图。请告诉用户在其他设备同步一次或重新上传；若前端仍显示图片，那是会话内缓存的旧图，刷新后即消失。`;
import { agentRegistry } from '../registry.js';
import { t } from '../../i18n/index.js';

// ---------- 列表类工具的统一分页（round74） ----------
// 用户反复反馈「AI 看不到我的内容」。卡片域上一轮已修（search_cards 补 back + 翻页），
// 本轮把同一套「**摘要 + id + 分页 + 详情引导**」四件套补齐到：笔记 / AI 文档 / 资料库 / 计划 / 每日任务 / 备忘。
//
// 为什么必须统一实现：这些列表工具此前各自 `slice(0, 30/50)` 且**没有翻页参数**——
// 模型想取全也取不了，只能如实回答「我只看到 N 条」（用户视角 = AI 瞎了）。
// 抽成一处后，「分页」只有一份实现；将来新增列表工具漏了分页，会在闸门里当场暴露。
//
// 命名族（读全文用 read_*，取结构化数据用 get_*）：
//   read_doc（AI 文档）/ read_note（笔记）/ read_lib_doc（资料库文件）/ read_plan（学习计划）
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

/**
 * 统一分页。返回必须同时给 `total` 与 `hasMore`：
 * 只给 items 时模型无法判断「这是全部还是被截断」，就会据此断言"只有这些"。
 */
function pageOf(rows, args, { defaultLimit = LIST_DEFAULT_LIMIT, maxLimit = LIST_MAX_LIMIT } = {}) {
  const arr = Array.isArray(rows) ? rows : [];
  const limit = Math.min(Math.max(Math.trunc(Number(args?.limit)) || defaultLimit, 1), maxLimit);
  const offset = Math.max(Math.trunc(Number(args?.offset)) || 0, 0);
  const items = arr.slice(offset, offset + limit);
  return { items, total: arr.length, offset, limit, hasMore: offset + items.length < arr.length };
}

/** 分页参数的统一说明（列表类工具共用；参数名与 pageOf 强绑定，改名要一起改） */
const PAGING_PARAMS = {
  limit: `number: 本次返回条数，默认 ${LIST_DEFAULT_LIMIT}，最大 ${LIST_MAX_LIMIT}`,
  offset: 'number: 跳过前 N 条（翻页用），默认 0',
};

/** 按 id 或标题片段在列表里定位一条记录（读全文类工具共用，省掉每个工具各写一份模糊匹配） */
function pickByIdOrTitle(rows, args, { idKey = 'id', titleKey = 'title' } = {}) {
  const id = args?.id != null ? String(args.id) : '';
  if (id) {
    const hit = rows.find((r) => String(r?.[idKey]) === id);
    if (hit) return hit;
  }
  const title = String(args?.title ?? args?.name ?? '').trim().toLowerCase();
  if (title) {
    return rows.find((r) => String(r?.[titleKey] || '').toLowerCase() === title)
      || rows.find((r) => String(r?.[titleKey] || '').toLowerCase().includes(title));
  }
  return null;
}

// ---------- 1. 数据感知类（只读） ----------

toolRegistry.register({
  name: 'get_stats',
  description: '获取用户整体学习统计：卡片总数、复习次数、今日待背、平均掌握度、能力四维、自评分布。',
  parameters: {},
  readsData: true,
  async execute() {
    const s = await getStats();
    return {
      ok: true,
      data: {
        totalCards: s.totalCards,
        totalReviews: s.totalReviews,
        todayReviews: s.todayReviews,
        dueToday: s.dueToday,
        avgMastery: s.avgMastery,
        ability: s.ability,
        ratingDist: s.ratingDist,
        subjectCards: s.subjectCards,
        hint: STATS_DETAIL_HINT_PROMPT,
      },
    };
  },
});

toolRegistry.register({
  name: 'get_weak_cards',
  description: '获取当前最薄弱/最易错的卡片列表（按遗忘次数排序），用于定位复习重点。'
    + '返回项含 id、正面 60 字、背面 60 字、遗忘次数与 hasImage；'
    + '要看完整正/背面或看图，需再用 get_card_detail 传该项 id。'
    + '结果可能被截断，用 offset 翻页继续取，不要断言"只有这些"。',
  parameters: {
    limit: 'number: 返回数量，默认 10，最大 50',
    offset: 'number: 跳过前 N 条（翻页用），默认 0',
    minFail: 'number: 最小遗忘次数阈值，默认 2',
  },
  readsData: true,
  async execute(args) {
    const limit = Math.min(Math.max(Math.trunc(Number(args?.limit)) || 10, 1), 50);
    const offset = Math.max(Math.trunc(Number(args?.offset)) || 0, 0);
    const minFail = Number(args?.minFail) || 1;
    // 分页：weakCards 只支持「取前 N 条」（无 count-all 接口），故取 offset+limit 条后本页切片。
    // total 是**已知下界**（已取到的条数）；取满则视为"后面可能还有"——
    // 宁可让模型多翻一页拿到空列表，也不谎报"只有这些"（后者会让它给出以偏概全的结论）。
    const want = Math.min(offset + limit, 500);
    const rows = await weakCards(want, minFail);
    const cards = rows.slice(offset, offset + limit);
    return {
      ok: true,
      data: {
        total: rows.length,
        offset,
        hasMore: rows.length >= want && want < 500,
        items: cards.map((c) => ({
          id: c.id,
          subject: c.subject,
          // round91：摘要先 stripImageRefs 去掉全部图片引用再切片。
          // 旧写法 String(c.front).slice(0,60) 会把 sxy-img://<36位uuid>（52 字符）
          // 拦腰截断，产出半截 id 进上下文 → enrichForLlm 拿半截 id 查库查不到 →
          // 对库里明明存在的图报「本机没有这张图」（用户原话「明明在的图片它却说缺失了」）。
          // 摘要意图本就不含图（hasImage 已标，引导模型调 get_card_detail 取全文），去引用才对。
          front: stripImageRefs(c.front).slice(0, 60),
          // round71：补背面摘要（同 search_cards）——旧版只有正面，模型无法引用答案侧内容
          back: stripImageRefs(c.back || '').slice(0, 60),
          // 摘要只给前 60 字，但必须让模型知道「这张卡有图」——
          // 否则图在背面 / 标记被截断时，模型完全不知道有图可看。
          // 不在此保留完整图片引用：列表可能命中几十张卡，保留会把送图额度瞬间吃光。
          hasImage: hasImageRef(c.front) || hasImageRef(c.back),
          failCount: c.failCount,
          marked: !!c.marked,
          wrongReason: c.wrongReason || '',
          level: c.level,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'get_review_suggestion',
  description: '获取智能复习建议：今天该复习什么、哪些科目已很久没碰（staleSubjects）。',
  parameters: {},
  readsData: true,
  async execute() {
    const s = await getReviewSuggestion();
    return { ok: true, data: s };
  },
});

toolRegistry.register({
  name: 'list_subjects_and_tags',
  description: '列出所有科目及其卡片数量、所有标签及使用次数。',
  parameters: {},
  readsData: true,
  async execute() {
    const [subjects, tags] = await Promise.all([getSubjects(), getTags()]);
    return { ok: true, data: { subjects, tags } };
  },
});

toolRegistry.register({
  name: 'search_cards',
  description: '按关键词/科目/标签搜索卡片，支持 AND/OR/NOT 组合，返回命中卡片的**概要**'
    + '（每项含 id、科目、正面 80 字、背面 80 字、标签、level、hasImage）。'
    + '概要**不含完整正文与图片内容**：需要完整正面/背面或看图时，必须再用 get_card_detail 传入该项的 id 获取；'
    + 'hasImage 为 true 说明该卡带图，不看图会漏掉图上的内容。'
    + '结果可能被截断（total 大于返回条数），此时用 offset 翻页继续取，不要断言"只有这些"。',
  parameters: {
    q: 'string: 模糊搜索正/背面关键词',
    subject: 'string: 限定科目（可选）',
    tags: 'string: 逗号分隔的标签（可选）',
    logic: 'string: 标签组合逻辑 AND/OR/NOT，默认 AND',
    mode: 'string: all=全部, due=仅到期',
    limit: 'number: 本次返回条数，默认 20，最大 50',
    offset: 'number: 跳过前 N 条（翻页用），默认 0',
  },
  readsData: true,
  async execute(args) {
    const tags = args?.tags ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const r = await listCards({
      q: args?.q || '',
      subject: args?.subject || '',
      tags,
      logic: args?.logic || 'AND',
      mode: args?.mode || 'all',
    });
    const limit = Math.min(Math.max(Math.trunc(Number(args?.limit)) || 20, 1), 50);
    const offset = Math.max(Math.trunc(Number(args?.offset)) || 0, 0);
    const page = r.items.slice(offset, offset + limit);
    return {
      ok: true,
      data: {
        total: r.total,
        dueCount: r.dueCount,
        offset,
        hasMore: offset + page.length < r.total,
        items: page.map((c) => ({
          id: c.id,
          subject: c.subject,
          front: stripImageRefs(c.front).slice(0, 80),
          // round71【本次核心修复之一】此前**只返回 front**，back 一个字都没有，
          // 于是用户问「这张卡背面写了什么」时模型手上根本没有背面数据，
          // 只能回答「我看不到背面内容」——用户视角就是「AI 连卡片内容都看不到」。
          // 这里补上背面摘要（完整背面仍走 get_card_detail，避免几十张卡的全文撑爆上下文）。
          back: stripImageRefs(c.back || '').slice(0, 80),
          // 同 get_weak_cards：摘要不保留图片引用，但要让模型知道「这张卡有图可看」
          hasImage: hasImageRef(c.front) || hasImageRef(c.back),
          tags: c.tags,
          level: c.level,
        })),
      },
    };
  },
});

// ---------- 2. 卡片生产类（写） ----------

toolRegistry.register({
  name: 'generate_cards',
  description: '把一段学习内容（笔记/讲义/文章）拆解成结构化记忆卡片，返回候选数组（不直接入库）。',
  parameters: {
    text: 'string: 待拆解的学习内容',
    subject: 'string: 指定科目（可选，不填由模型判断）',
  },
  writesData: false,
  async execute(args, ctx) {
    const text = String(args?.text || '');
    if (!text.trim()) return { ok: false, error: '内容为空' };
    const sys = '你是学习内容拆解助手。把用户文字拆成记忆卡片，输出严格 JSON 数组，每项 {"front":"问题/提示","back":"答案","subject":"科目","tags":["标签"]}。只输出 JSON 数组，不要 markdown 代码块，不要多余文字。';
    const out = await ctx.chat([
      { role: 'system', content: sys },
      { role: 'user', content: text },
    ]);
    const arr = extractJSON(out);
    const cards = Array.isArray(arr) ? arr.filter((c) => c && c.front && c.back) : [];
    return { ok: true, data: { count: cards.length, cards } };
  },
});

// 高级卡组生成（Phase 2 杀手锏）：分块 + 多题型 + 质量评分 + 去重 + 源文档溯源
toolRegistry.register({
  name: 'generate_card_deck',
  description: '智能卡组生成：把长文/讲义拆成高质量记忆卡组，自动分块、多题型决策（basic/cloze/choice）、质量评分（0-100）、与已有库去重、原文存为 AI 文档溯源。返回候选卡（含 score/dupScore）+ 去重后子集。',
  parameters: {
    text: 'string: 学习内容（笔记/讲义/文章，可超长，自动分块）',
    subject: 'string: 指定科目（可选）',
    title: 'string: 源文档标题（可选）',
    saveSource: 'boolean: 是否持久化源文档，默认 true',
  },
  writesData: true, // 持久化源文档
  async execute(args) {
    try {
      const deck = await generateDeck(args?.text || '', {
        subject: args?.subject || '',
        title: args?.title || '',
        saveSource: args?.saveSource !== false,
      });
      return { ok: true, data: deck };
    } catch (e) { return { ok: false, error: e.message }; }
  },
});

// 批量入库（带源文档回链 + 失败收集）
toolRegistry.register({
  name: 'bulk_create_cards',
  description: '把候选卡数组批量入库，自动给每张打 source 标记（可回链源文档）。返回成功/失败计数。',
  parameters: {
    cards: 'array: 候选卡数组 [{front,back,subject,tags,type}]',
    sourceDocId: 'string: 源文档 id（可选，会写入 source 字段）',
    subject: 'string: 统一科目覆盖（可选）',
  },
  writesData: true,
  async execute(args) {
    const list = Array.isArray(args?.cards) ? args.cards : [];
    if (!list.length) return { ok: false, error: 'cards 为空' };
    const r = await bulkCreateCards(list, {
      sourceDocId: args?.sourceDocId || '',
      subject: args?.subject || '',
    });
    return { ok: true, data: r };
  },
});

// 冷启动卡组（0 卡新用户的杀手锏：一键生成入门卡包）
toolRegistry.register({
  name: 'cold_start_deck',
  description: '为 0 卡新用户基于预设学科模板生成入门卡组（解决空库冷启动）。可先调 list_cold_start_templates 查模板，再传 templateId 生成。',
  parameters: {
    templateId: 'string: 冷启动模板 id（如 cs-ds/cs-net/cs-os/math-gaoshu/en-vocab）',
  },
  writesData: false,
  async execute(args) {
    try {
      const r = await generateColdStartDeck(args?.templateId || '');
      return { ok: true, data: r };
    } catch (e) { return { ok: false, error: e.message }; }
  },
});

// 列出冷启动模板
toolRegistry.register({
  name: 'list_cold_start_templates',
  description: '列出全部冷启动卡组模板（学科 + 简介），供用户挑选后再调 cold_start_deck 生成。',
  parameters: {},
  readsData: false,
  async execute() {
    return {
      ok: true,
      data: {
        templates: COLD_START_TEMPLATES.map(x => ({
          id: x.id, name: x.name, subject: x.subject, description: x.description,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'create_card',
  description: '向用户卡片库新增一张记忆卡片。需提供 front/back，subject 与 tags 可选。',
  parameters: {
    front: 'string: 正面（问题/提示）',
    back: 'string: 背面（答案）',
    subject: 'string: 科目',
    tags: 'string: 逗号分隔标签',
  },
  writesData: true,
  async execute(args) {
    const tags = args?.tags ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const card = await createCard({
      front: String(args?.front || '').trim(),
      back: String(args?.back || '').trim(),
      subject: String(args?.subject || '').trim(),
      tags,
      type: 'basic',
    });
    return { ok: true, data: { id: card.id, front: card.front, subject: card.subject } };
  },
});

// ---------- 3. 测评类（依赖 LLM） ----------

toolRegistry.register({
  name: 'quiz_me',
  description: '基于用户薄弱点或指定科目，生成一份选择题测验（先不给答案），用于自测。',
  parameters: {
    subject: 'string: 限定科目（可选）',
    count: 'number: 题目数量，默认 3',
  },
  writesData: false,
  async execute(args, ctx) {
    const subject = args?.subject || '';
    const count = Number(args?.count) || 3;
    const ctxText = subject
      ? `请围绕「${subject}」科目`
      : '请基于用户整体学习情况';
    const sys = `你是出题老师。${ctxText}出 ${count} 道选择题考用户，每题给 A-D 选项。先只给题目与选项，不要给答案，等用户作答后再判对错。输出 JSON 数组：每项 {"question","options":["A...","B..."],"answer":"A","explain":"简短解析"}。只输出 JSON。`;
    const out = await ctx.chat([{ role: 'system', content: sys }, { role: 'user', content: '开始出题' }]);
    const arr = extractJSON(out);
    const quiz = Array.isArray(arr) ? arr : [];
    return { ok: true, data: { count: quiz.length, quiz } };
  },
});

// ---------- 4. 单卡 / 复习明细 / 编辑 ----------

toolRegistry.register({
  name: 'get_card_detail',
  description: '按卡片 id 获取一张卡片的完整内容（正/背面、科目、标签、掌握等级、口诀、错因）。'
    + '卡片带图时会返回完整正文与图片引用，图片将作为附图发送给你。'
    + '当列表类结果里 hasImage 为 true、或用户提到「图 / 截图 / 思维导图」时，必须调本工具才能看到图。',
  parameters: { id: 'string: 卡片 id' },
  readsData: true,
  async execute(args) {
    const card = await getCard(String(args?.id || ''));
    if (!card) return { ok: false, error: '卡片不存在' };
    return {
      ok: true,
      data: {
        id: card.id, front: card.front, back: card.back, subject: card.subject,
        tags: card.tags, level: card.level, ease: card.ease, marked: !!card.marked,
        mnemonic: card.mnemonic || '', wrongReason: card.wrongReason || '',
      },
    };
  },
});

toolRegistry.register({
  name: 'get_review_history',
  description: '获取最近若干条复习记录（含每张卡的评级文本），用于分析错因与复习节奏。',
  parameters: { limit: 'number: 条数，默认 20' },
  readsData: true,
  async execute(args) {
    const limit = Number(args?.limit) || 20;
    const hist = await reviewHistory(limit);
    return { ok: true, data: { count: hist.length, items: hist.slice(0, limit) } };
  },
});

// round95：补三类此前对 AI 完全不可见的数据——番茄钟逐次明细 / 历史 AI 对话（列表 + 内容）。
// 用户诉求：「要看到所有信息，尤其是图片」。卡片正文/图片由 get_card_detail 提供，这三者补齐其余缺口。
toolRegistry.register({
  name: 'get_pomodoro_sessions',
  description: '获取番茄钟专注会话逐次明细：开始时刻（本地时间）、时长（分钟）、标签、是否完整番茄。'
    + '用户问「我什么时候学的 / 每次专注多久 / 番茄钟细节」时必须调本工具——只报「共 N 次 / 累计 M 分钟」的汇总不够。',
  parameters: { limit: 'number: 条数，默认 30，最多 200' },
  readsData: true,
  async execute(args) {
    const limit = Math.min(200, Math.max(1, Number(args?.limit) || 30));
    const rows = await listPomoSessions(limit);
    const pad = (x) => String(x).padStart(2, '0');
    const local = (ts) => {
      const d = new Date(Number(ts) || 0);
      if (!Number.isFinite(d.getTime())) return '';
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return {
      ok: true,
      data: {
        count: rows.length,
        items: rows.map((r) => ({
          id: r.id,
          startedAt: r.startedAt,
          startedLocal: local(r.startedAt),
          minutes: r.duration || 0,
          tag: r.tag || '',
          complete: !r.partial,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'list_chats',
  description: '列出历史 AI 对话（标题、类型、更新时间、消息条数）。'
    + '普通问答、Agent 工作台会话、费曼练习的记录都存在这里（type 区分：qa/agent/feynman）。'
    + '用户问「我之前问过什么 / 上次聊了什么 / 费曼练了什么」时先用本工具定位，再用 read_chat 取完整内容。',
  parameters: { limit: 'number: 条数，默认 20，最多 50' },
  readsData: true,
  async execute(args) {
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
    const rows = await db.aiChats.orderBy('updatedAt').reverse().limit(limit).toArray();
    return {
      ok: true,
      data: {
        count: rows.length,
        items: rows.map((c) => ({
          id: c.id,
          title: c.title || '',
          type: c.type || 'chat',
          updatedAt: c.updatedAt,
          msgCount: (c.messages || []).length,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'read_chat',
  description: '读取某条 AI 对话的完整消息内容（用户与助手的往返文本）。参数 id 由 list_chats 返回；'
    + '用户追问「那次对话里具体说了什么」时用。',
  parameters: { id: 'string: 对话 id（来自 list_chats）', limit: 'number: 最多返回末尾几条消息，默认 20，最多 60' },
  readsData: true,
  async execute(args) {
    const id = String(args?.id || '');
    if (!id) return { ok: false, error: 'id required' };
    const chat = await db.aiChats.get(id);
    if (!chat) return { ok: false, error: 'chat not found' };
    const limit = Math.min(60, Math.max(1, Number(args?.limit) || 20));
    const all = Array.isArray(chat.messages) ? chat.messages : [];
    return {
      ok: true,
      data: {
        id: chat.id,
        title: chat.title || '',
        type: chat.type || 'chat',
        updatedAt: chat.updatedAt,
        totalMessages: all.length,
        messages: all.slice(-limit).map((m) => ({ role: m.role, content: clipText(String(m.content ?? ''), 2000) })),
      },
    };
  },
});

toolRegistry.register({
  name: 'update_card',
  description: '编辑一张已有卡片（正/背面、科目、标签、错因、口诀均可更新）。',
  parameters: {
    id: 'string: 卡片 id',
    front: 'string: 新正面（可选）',
    back: 'string: 新背面（可选）',
    subject: 'string: 新科目（可选）',
    tags: 'string: 逗号分隔新标签（可选）',
    wrongReason: 'string: 错因（可选）',
    mnemonic: 'string: 口诀（可选）',
  },
  writesData: true,
  async execute(args) {
    const id = String(args?.id || '');
    const old = await getCard(id);
    if (!old) return { ok: false, error: '卡片不存在' };
    const tags = args?.tags != null ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : old.tags;
    const card = await updateCard(id, {
      front: args?.front ?? old.front,
      back: args?.back ?? old.back,
      subject: args?.subject ?? old.subject,
      tags,
      type: old.type,
      source: old.source,
      marked: old.marked,
      mnemonic: args?.mnemonic ?? old.mnemonic,
      wrongReason: args?.wrongReason ?? old.wrongReason,
    });
    return { ok: true, data: { id: card.id, front: card.front, subject: card.subject } };
  },
});

toolRegistry.register({
  name: 'add_memo',
  description: '新增一条四象限备忘录（可选 important/urgent 标记）。',
  parameters: {
    text: 'string: 备忘内容',
    important: 'boolean: 是否重要',
    urgent: 'boolean: 是否紧急',
  },
  writesData: true,
  async execute(args) {
    const m = await addMemo({ text: args?.text, important: !!args?.important, urgent: !!args?.urgent });
    if (!m) return { ok: false, error: '内容为空' };
    return { ok: true, data: { id: m.id, text: m.text } };
  },
});

toolRegistry.register({
  name: 'list_memos',
  description: '列出用户全部四象限备忘录（内容 + 是否重要/紧急 + 记录时间）。'
    + '备忘是短句，列表里直接给全文，不需要再取详情。'
    + '结果可能被截断（total 大于返回条数），此时用 offset 翻页继续取，不要断言"只有这些"。',
  parameters: { ...PAGING_PARAMS },
  readsData: true,
  async execute(args) {
    const memos = await listMemos();
    const page = pageOf(memos, args);
    return {
      ok: true,
      data: {
        total: page.total, offset: page.offset, hasMore: page.hasMore,
        items: page.items.map((m) => ({
          id: m.id, text: String(m.text || ''),
          important: !!m.important, urgent: !!m.urgent,
          at: m.at || m.createdAt || 0,
        })),
      },
    };
  },
});

// ---------- 5. 写入类：笔记 / 每日规划（round76） ----------
//
// 为什么加：「AI 能读全部模块，但产出无处可落」——此前 12 个写工具里没有一个是写笔记或每日任务的，
// 于是「帮我把这段整理成笔记」只能落成 AI 文档（另一个模块）、「把这几张卡排进今天」根本做不到。
//
// 写入纪律（四个工具共用，改描述时别删这几条）：
//   ① **先确认再写**：必须先把「将要写入的内容」呈现给用户并得到同意，才调用写入工具；
//   ② 只写用户明确要写的内容，不擅自扩写/改写；
//   ③ 回传 id 供后续引用（update/打卡用 id，**不要凭记忆编 id**）；
//   ④ 会覆盖既有数据的操作（如重建当天计划）必须先明确告知用户。

toolRegistry.register({
  name: 'create_note',
  description: '新建一篇**笔记**（厚笔记：Markdown 正文 + 分类 + 标签，正文里可用 [[card-id]] 形成双向链接）。'
    + '⚠️ 写入前必须先把你打算写入的「标题 + 正文摘要 + 分类/标签」呈现给用户并得到确认，不要未经确认直接写库。'
    + '只写用户给的或已确认的内容，不要擅自扩写。返回 noteId，后续修改请用 update_note 传该 id。',
  parameters: {
    title: 'string: 笔记标题',
    content: 'string: Markdown 正文（必填）',
    category: 'string: 分类（可选，如「线性代数」）',
    tags: 'string: 逗号分隔标签（可选）',
  },
  writesData: true,
  async execute(args) {
    const content = String(args?.content ?? '').trim();
    if (!content) return { ok: false, error: t('agent.toolMsg.emptyContent') };
    const tags = args?.tags ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const n = await createNote({ title: args?.title || '', content, category: args?.category || '', tags });
    return {
      ok: true,
      data: { noteId: n.id, title: n.title, category: n.category || '', tags: n.tags || [], chars: content.length },
    };
  },
});

toolRegistry.register({
  name: 'update_note',
  description: '修改一篇**已有**笔记（只覆盖你传入的字段，未传字段保持原值）。参数二选一：id（来自 list_notes）或 title（模糊匹配）。'
    + '⚠️ 同样先确认：把「改哪一篇、改成什么」讲清楚并得到用户同意后再写。返回改了哪些字段。',
  parameters: {
    id: 'string: 笔记 id（来自 list_notes，最可靠）',
    title: 'string: 笔记标题或片段（用于定位，模糊匹配）',
    content: 'string: 新的 Markdown 正文（可选）',
    newTitle: 'string: 新的标题（可选；定位用 title，改名用 newTitle，别混）',
    category: 'string: 新分类（可选）',
    tags: 'string: 新的逗号分隔标签（可选）',
  },
  writesData: true,
  async execute(args) {
    const notes = await listNotes();
    if (!notes.length) return { ok: false, error: t('agent.toolMsg.noNotes') };
    const target = pickByIdOrTitle(notes, args);
    if (!target) {
      const titles = notes.slice(0, 20).map((x) => x.title).join('、');
      return { ok: false, error: `未找到匹配的笔记。现有笔记：${titles}。可先用 list_notes 查看完整列表。` };
    }
    const patch = {};
    if (args?.content != null) patch.content = String(args.content);
    if (args?.newTitle != null) patch.title = String(args.newTitle);
    if (args?.category != null) patch.category = String(args.category);
    if (args?.tags != null) patch.tags = String(args.tags).split(',').map((x) => x.trim()).filter(Boolean);
    if (!Object.keys(patch).length) return { ok: false, error: t('agent.toolMsg.emptyPatch') };
    const out = await updateNote(target.id, patch);
    if (!out) return { ok: false, error: t('agent.toolMsg.noteVanished') };
    return { ok: true, data: { noteId: out.id, title: out.title, changed: Object.keys(patch) } };
  },
});

toolRegistry.register({
  name: 'create_daily_plan',
  description: '为用户**某一天**创建「每日规划」：把要做的事写成一段自然语言（可含时间/时长/科目），系统会解析成任务清单。'
    + '⚠️ 两个必须确认的点：① 先把这段口述文本给用户看；② 那天**已有计划时本工具会覆盖重建**（旧计划进回收站），必须先明确告知用户。'
    + '返回 planId 与解析出的任务；之后可用 add_daily_task 追加单条任务。',
  parameters: {
    rawInput: 'string: 当天要做什么（自然语言，如「9点线代 45 分钟，下午做计网错题 30 分钟」）',
    date: 'string: 日期 YYYY-MM-DD（可选，默认今天）',
  },
  writesData: true,
  async execute(args) {
    const rawInput = String(args?.rawInput ?? '').trim();
    if (!rawInput) return { ok: false, error: t('agent.toolMsg.emptyContent') };
    const date = String(args?.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: t('agent.toolMsg.badDate', undefined, { value: date }) };
    }
    const r = await createDailyPlan({ rawInput, ...(date ? { date } : {}) });
    return {
      ok: true,
      data: {
        planId: r.plan.id,
        date: r.plan.date,
        taskCount: r.tasks.length,
        tasks: r.tasks.map((x) => ({
          id: x.id, title: x.title, type: x.type,
          estimatedMinutes: x.estimatedMinutes,
          // round85：**不得**写回 `Number.isFinite(Number(v)) ? Number(v) : null`——
          // `Number(null) === 0`，会把「没排时段」上报成「0 点」，模型据此回答用户「已安排 0 点」。
          scheduledHour: clampScheduledHour(x.scheduledHour),
          quadrant: x.quadrant,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'add_daily_task',
  description: '把**一条任务**加进某一天的规划里 —— 用户说「把这件事排进今天」时用它。'
    + '当天还没有规划时，本工具会**自动新建**当天计划再追加（以任务标题作为该计划的口述原文）。'
    + '⚠️ 写入前先确认任务标题、预估时长与开始时刻，用户同意后再调。返回 taskId。',
  parameters: {
    title: 'string: 任务标题（必填）',
    date: 'string: 日期 YYYY-MM-DD（可选，默认今天）',
    planId: 'string: 指定计划 id（可选，来自 create_daily_plan / list_daily_tasks）',
    type: 'string: 类型 review|pomodoro|doc|exam|note|other（默认 other）',
    quadrant: 'string: 四象限 Q1|Q2|Q3|Q4（默认 Q4）',
    estimatedMinutes: 'number: 预估分钟数（可选）',
    scheduledHour: 'number: 计划开始时刻 0-23（可选）',
    subject: 'string: 科目（可选）',
  },
  writesData: true,
  async execute(args) {
    const title = String(args?.title ?? '').trim();
    if (!title) return { ok: false, error: t('agent.toolMsg.emptyTaskTitle') };
    const date = String(args?.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: t('agent.toolMsg.badDate', undefined, { value: date }) };
    }
    const draft = {
      title,
      type: args?.type || 'other',
      quadrant: args?.quadrant || 'Q4',
      estimatedMinutes: Number.isFinite(Number(args?.estimatedMinutes)) ? Number(args.estimatedMinutes) : undefined,
      // round85：入口同样归一化（模型可能给 '9' / 25 / null；null 曾被 `Number(null)` 变成 0 点）。
      scheduledHour: clampScheduledHour(args?.scheduledHour),
      subject: args?.subject || '',
    };
    let planId = String(args?.planId || '').trim();
    let task;
    if (planId) {
      task = await addDailyTask(planId, draft);
    } else {
      const found = await listDailyPlan(date || undefined); // 缺省 = 今天
      if (found?.plan?.id) {
        planId = found.plan.id;
        task = await addDailyTask(planId, draft);
      } else {
        // 当天没有计划 → 直接建计划，并走「**调用方给任务**」路径（tasks 参数）。
        // 为什么不能只传 rawInput：那样口述原文会被再解析一遍，若解析出同名任务，
        // 就与随后的 addDailyTask 重复成两条（实测踩到）。
        const created = await createDailyPlan({ rawInput: title, ...(date ? { date } : {}), tasks: [draft] });
        planId = created.plan.id;
        task = created.tasks[0];
      }
    }
    if (!task) return { ok: false, error: t('agent.toolMsg.taskWriteFailed') };
    return {
      ok: true,
      data: {
        taskId: task.id, planId, date: task.date, title: task.title,
        estimatedMinutes: task.estimatedMinutes,
        scheduledHour: clampScheduledHour(task.scheduledHour),
        status: task.status,
      },
    };
  },
});

toolRegistry.register({
  name: 'checkin_daily_task',
  description: '给任务打卡：done 完成 / partial 部分完成 / skipped 跳过（可带一句完成备注）。'
    + '参数：taskId（来自 list_daily_tasks，最可靠）或 title（在指定日期/今天的任务里模糊匹配）。'
    + '⚠️ 打卡代表真实完成，务必先确认是哪一条任务、什么状态，不要替用户"猜着打勾"。',
  parameters: {
    taskId: 'string: 任务 id（来自 list_daily_tasks）',
    title: 'string: 任务标题或片段（模糊匹配；缺省在今天的任务里找）',
    date: 'string: 哪一天的任务 YYYY-MM-DD（可选，默认今天）',
    status: 'string: done|partial|skipped（默认 done）',
    note: 'string: 完成备注（可选）',
  },
  writesData: true,
  async execute(args) {
    const status = String(args?.status || 'done');
    if (!['done', 'partial', 'skipped'].includes(status)) {
      return { ok: false, error: t('agent.toolMsg.badCheckinStatus') };
    }
    const date = String(args?.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: t('agent.toolMsg.badDate', undefined, { value: date }) };
    }
    let taskId = String(args?.taskId || '').trim();
    if (!taskId) {
      const found = await listDailyPlan(date || undefined);
      const tasks = found?.tasks || [];
      const q = String(args?.title || '').trim().toLowerCase();
      const hit = tasks.find((x) => String(x.id) === String(args?.title || ''))
        || (q ? tasks.find((x) => String(x.title || '').toLowerCase() === q)
          || tasks.find((x) => String(x.title || '').toLowerCase().includes(q)) : null);
      if (!hit) return { ok: false, error: t('agent.toolMsg.taskNotFound') };
      taskId = hit.id;
    }
    const out = await checkinDailyTask(taskId, status, String(args?.note || ''));
    return {
      ok: true,
      data: { taskId: out.id, title: out.title, status: out.status, completionNote: out.completionNote || '' },
    };
  },
});

// ---------- 6. 学习计划（持久化） ----------

toolRegistry.register({
  name: 'create_plan',
  description: '创建一份学习计划并持久化（会随数据包同步）。返回计划 id。',
  parameters: {
    title: 'string: 计划标题',
    content: 'string: 计划内容（分阶段/每日任务/里程碑）',
  },
  writesData: true,
  async execute(args) {
    const p = await createPlan({ title: args?.title, content: args?.content });
    return { ok: true, data: { id: p.id, title: p.title, status: p.status } };
  },
});

toolRegistry.register({
  name: 'list_plans',
  description: '列出全部学习计划（标题 + 状态 active/done/archived + 正文摘要）。'
    + '**概要不含完整正文**：要看某份计划的完整内容（阶段划分/每日任务/里程碑），'
    + '必须再用 read_plan 传 id（或标题片段）获取；只看摘要会漏掉计划的具体安排。'
    + '结果可能被截断（total 大于返回条数），此时用 offset 翻页继续取。',
  parameters: { ...PAGING_PARAMS },
  readsData: true,
  async execute(args) {
    const plans = await listPlans();
    const page = pageOf(plans, args);
    return {
      ok: true,
      data: {
        total: page.total, offset: page.offset, hasMore: page.hasMore,
        items: page.items.map((p) => ({
          id: p.id, title: p.title, status: p.status,
          // 摘要让模型先判断"哪份计划与问题相关"，正文原长一并给出，
          // 它据此决定是否值得再调 read_plan 取全文（既不"看不到"，也不把上下文塞爆）。
          preview: clipText(String(p.content || '').replace(/\s+/g, ' '), 120),
          contentChars: String(p.content || '').length,
          updatedAt: p.updatedAt,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'read_plan',
  description: '读取一份学习计划的**完整正文**（Markdown：阶段划分 / 每日任务 / 里程碑）。'
    + '参数二选一：id（来自 list_plans，最可靠）或 title（按标题模糊匹配）。'
    + '用户问「我的计划具体是怎么安排的」时用它，不要只看摘要就作答。',
  parameters: {
    id: 'string: 计划 id（来自 list_plans）',
    title: 'string: 计划标题或片段（模糊匹配）',
    maxChars: 'number: 正文最多返回多少字，默认 3000',
  },
  readsData: true,
  async execute(args) {
    const plans = await listPlans();
    if (!plans.length) return { ok: false, error: '还没有任何学习计划。可先用 auto_generate_plan 生成、create_plan 持久化。' };
    const target = pickByIdOrTitle(plans, args);
    if (!target) {
      const titles = plans.slice(0, 20).map((p) => p.title).join('、');
      return { ok: false, error: `未找到匹配的计划。现有计划：${titles}。可先用 list_plans 查看完整列表。` };
    }
    const content = String(target.content || '');
    const maxChars = Math.min(Math.max(Math.trunc(Number(args?.maxChars)) || 3000, 200), 20000);
    return {
      ok: true,
      data: {
        id: target.id, title: target.title, status: target.status,
        contentChars: content.length,
        truncated: content.length > maxChars,
        content: clipText(content, maxChars),
      },
    };
  },
});

toolRegistry.register({
  name: 'list_daily_tasks',
  description: '查看用户的「每日规划」——这是每天**实际要做的事**，与 list_plans 的长期学习计划不同。'
    + '传 date（YYYY-MM-DD）看某一天：返回当天口述原文 + 任务明细（标题/类型/四象限/预估时长/开始时刻/状态/完成备注）。'
    + '不传 date 则返回最近 days 天（默认 7）的每日汇总（总任务数 / 已完成数），用于了解执行趋势。'
    + '用户问「我今天要做什么」「这周计划完成得怎么样」时必须用它，不要凭空推测。',
  parameters: {
    date: 'string: 日期 YYYY-MM-DD（可选；缺省返回最近 N 天的汇总）',
    days: 'number: 不带 date 时汇总最近多少天，默认 7，最大 60',
    status: 'string: 只看某状态的任务：pending|done|partial|skipped（可选）',
    ...PAGING_PARAMS,
  },
  readsData: true,
  async execute(args) {
    const date = String(args?.date || '').trim();
    if (!date) {
      const days = Math.min(Math.max(Math.trunc(Number(args?.days)) || 7, 1), 60);
      const rows = await listDailyPlanSummary(days);
      return { ok: true, data: { mode: 'summary', days, total: rows.length, hasMore: false, items: rows } };
    }
    // 日期格式必须先校验：脏值会让 where('date').equals() 静默返回空，
    // 模型会据此误报「那天没有任何计划」——比报错更糟（用户会以为记录丢了）。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: t('agent.toolMsg.badDate', undefined, { value: date }) };
    }
    const found = await listDailyPlan(date);
    if (!found) {
      return { ok: true, data: { mode: 'day', date, total: 0, items: [], note: t('agent.toolMsg.noPlanThatDay') } };
    }
    const all = (found.tasks || []).filter((task) => (args?.status ? task.status === args.status : true));
    const page = pageOf(all, args);
    return {
      ok: true,
      data: {
        mode: 'day', date,
        planId: found.plan?.id || '', planStatus: found.plan?.status || '',
        rawInput: clipText(String(found.plan?.rawInput || ''), 500),
        total: page.total, offset: page.offset, hasMore: page.hasMore,
        items: page.items.map((task) => ({
          id: task.id, title: task.title, type: task.type || '', subject: task.subject || '',
          important: !!task.important, urgent: !!task.urgent, quadrant: task.quadrant || '',
          estimatedMinutes: Number(task.estimatedMinutes) || 0,
          scheduledHour: clampScheduledHour(task.scheduledHour),
          status: task.status, completionNote: String(task.completionNote || ''),
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'update_plan_status',
  description: '更新学习计划状态（active/done/archived）。',
  parameters: { id: 'string: 计划 id', status: 'string: active|done|archived' },
  writesData: true,
  async execute(args) {
    const p = await updatePlan(String(args?.id || ''), { status: args?.status || 'active' });
    return { ok: true, data: { id: p.id, title: p.title, status: p.status } };
  },
});

// ---------- 6. 知识图谱关系（持久化） ----------

toolRegistry.register({
  name: 'link_cards',
  description: '在知识图谱中新建一条关联边（如 依赖/前置/对比），并持久化同步。',
  parameters: {
    from: 'string: 起点知识点/卡片名',
    to: 'string: 终点知识点/卡片名',
    label: 'string: 关系，默认 相关',
    subject: 'string: 所属科目（可选）',
  },
  writesData: true,
  async execute(args) {
    // R10：把 AI 给的 label 解析为真实卡片 id，避免文本匹配静默覆盖
    const all = await listCards();
    const lower = new Map();
    for (const c of all) {
      const f = String(c.front || '').replace(/[*_#>`~|-]/g, '').trim().toLowerCase();
      if (f && !lower.has(f)) lower.set(f, c.id);
    }
    const resolveId = (s) => lower.get(String(s || '').replace(/[*_#>`~|-]/g, '').trim().toLowerCase()) || '';
    const e = await createGraphEdge({
      from: args?.from, to: args?.to,
      fromCardId: resolveId(args?.from), toCardId: resolveId(args?.to),
      label: args?.label, subject: args?.subject,
    });
    // createGraphEdge 命中去重时返回 null——直接读 e.id 会抛 TypeError，
    // 整个工具调用以「未知错误」失败，Agent 只会回一句没头没尾的话。
    if (!e) {
      return {
        ok: true,
        data: { duplicate: true, from: args?.from, to: args?.to, label: args?.label },
        note: '这条关联已经存在，无需重复建立',
      };
    }
    return { ok: true, data: { id: e.id, from: e.from, to: e.to, label: e.label } };
  },
});

toolRegistry.register({
  name: 'list_graph_edges',
  description: '列出知识图谱中所有已持久化的关联边。',
  parameters: {},
  readsData: true,
  async execute() {
    const edges = await listGraphEdges();
    return { ok: true, data: { count: edges.length, items: edges } };
  },
});

// ---------- 7. 记忆/讲解增强（依赖 LLM） ----------

toolRegistry.register({
  name: 'suggest_mnemonic',
  description: '为一段知识点生成记忆口诀/联想记忆法。',
  parameters: { text: 'string: 需要记忆的知识点内容' },
  writesData: false,
  async execute(args, ctx) {
    const text = String(args?.text || '').trim();
    if (!text) return { ok: false, error: '内容为空' };
    const sys = '你是记忆大师。为下面知识点设计 1~3 条朗朗上口的中文记忆口诀/联想，说明记忆原理，并指出容易踩的坑。用简洁中文输出。';
    const out = await ctx.chat([{ role: 'system', content: sys }, { role: 'user', content: text }]);
    return { ok: true, data: { mnemonic: out } };
  },
});

toolRegistry.register({
  name: 'explain_concept',
  description: '讲解一个概念，优先结合用户已有卡片/笔记，做到针对性讲解。',
  parameters: { concept: 'string: 要讲解的概念' },
  writesData: false,
  async execute(args, ctx) {
    const concept = String(args?.concept || '').trim();
    if (!concept) return { ok: false, error: '概念为空' };
    const r = await listCards({ q: concept });
    // 「 [img]」为 ASCII 标记（不经 i18n 闸），提示模型该卡带图、可调 get_card_detail 看完整内容
    const related = r.items.slice(0, 8)
      .map((c) => `[${c.subject}] ${stripImageRefs(c.front).slice(0, 60)}${hasImageRef(c.front) || hasImageRef(c.back) ? ' [img]' : ''}`)
      .join('\n');
    const sys = `你是学习答疑导师。讲解「${concept}」时，如用户已有相关卡片请结合说明（已有卡片：\n${related || '无'}），其余用通俗中文+举例+公式（$...$）讲透。`;
    const out = await ctx.chat([{ role: 'system', content: sys }, { role: 'user', content: `请讲解：${concept}` }]);
    return { ok: true, data: { explanation: out, relatedCount: r.total } };
  },
});

// ---------- 8. 跨模块协同（AI文档 / 单卡画像 / 错题 / 全局洞察） ----------

toolRegistry.register({
  name: 'get_card_analytics',
  description: '获取一张卡片的复习画像：复习次数、答错次数、正确率、频率、标签、是否高频/错频、最近7天次数、到期时间。',
  parameters: { cardId: 'string: 卡片 id' },
  readsData: true,
  async execute(args) {
    const a = await getCardAnalytics(String(args?.cardId || ''));
    if (!a) return { ok: false, error: '卡片不存在' };
    return { ok: true, data: a };
  },
});

toolRegistry.register({
  name: 'get_recent_mistakes',
  description: '获取最近 N 天（默认昨天=1）答错的题，按错误次数排序，用于针对性复习。',
  parameters: { days: 'number: 最近几天，默认 1' },
  readsData: true,
  async execute(args) {
    const days = Number(args?.days) || 1;
    const list = await getRecentMistakes(days);
    return { ok: true, data: { count: list.length, items: list.slice(0, 30) } };
  },
});

toolRegistry.register({
  name: 'calibration_report',
  description: '校准回测：FSRS 预测的记忆概率 vs 实际正确率分桶对比（Brier/ECE/偏差/结论），检验调度器科学性与是否需要重新训练权重。',
  parameters: {},
  readsData: true,
  async execute() {
    const c = await getCalibration();
    return {
      ok: true,
      data: {
        n: c.n, brier: c.brier, ece: c.ece, bias: c.bias, verdict: c.verdict, note: c.note,
        buckets: c.buckets,
      },
    };
  },
});

toolRegistry.register({
  name: 'list_notes',
  description: '列出用户的**笔记**（区别于备忘：笔记是含标题/分类/标签/双向链接的厚笔记，Markdown 正文）。'
    + '支持按关键词 q、分类 category、标签 tags 过滤。返回标题 + 正文摘要 + 分类标签 + 是否带图。'
    + '**概要不含完整正文**：要读某一篇的完整内容，必须再用 read_note 传 id 获取。'
    + '结果可能被截断（total 大于返回条数），此时用 offset 翻页继续取，不要断言"只有这些"。',
  parameters: {
    q: 'string: 关键词（搜标题/正文/分类/标签）',
    category: 'string: 限定分类（可选）',
    tags: 'string: 逗号分隔标签（可选，命中任一即可）',
    ...PAGING_PARAMS,
  },
  readsData: true,
  async execute(args) {
    const tags = args?.tags ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const notes = await listNotes({ q: args?.q || '', category: args?.category || '', tags });
    const page = pageOf(notes, args);
    return {
      ok: true,
      data: {
        total: page.total, offset: page.offset, hasMore: page.hasMore,
        items: page.items.map((n) => ({
          id: n.id, title: n.title, category: n.category || '', tags: n.tags || [],
          preview: clipText(String(n.content || '').replace(/\s+/g, ' '), 100),
          contentChars: String(n.content || '').length,
          hasImage: hasImageRef(n.content),
          linkedCardIds: Array.isArray(n.linkedCardIds) ? n.linkedCardIds.length : 0,
          updatedAt: n.updatedAt,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'read_note',
  description: '读取一篇笔记的**完整正文**（Markdown，可能含 [[双向链接]] 与图片引用）。'
    + '参数二选一：id（来自 list_notes，最可靠）或 title（按标题模糊匹配）。'
    + '用户问「我笔记里是怎么写的」时用它，不要凭标题猜内容。',
  parameters: {
    id: 'string: 笔记 id（来自 list_notes）',
    title: 'string: 笔记标题或片段（模糊匹配）',
    maxChars: 'number: 正文最多返回多少字，默认 2000',
  },
  readsData: true,
  async execute(args) {
    const notes = await listNotes();
    if (!notes.length) return { ok: false, error: t('agent.toolMsg.noNotes') };
    const target = pickByIdOrTitle(notes, args);
    if (!target) {
      const titles = notes.slice(0, 20).map((n) => n.title).join('、');
      return { ok: false, error: `未找到匹配的笔记。现有笔记：${titles}。可先用 list_notes 查看完整列表。` };
    }
    // 同 read_doc：用 getNote 取当前行，保证读到的是最新正文与最新的双向链接
    const row = (await getNote(target.id).catch(() => null)) || target;
    const content = String(row.content || '');
    const maxChars = Math.min(Math.max(Math.trunc(Number(args?.maxChars)) || 2000, 200), 20000);
    return {
      ok: true,
      data: {
        id: row.id, title: row.title, category: row.category || '', tags: row.tags || [],
        linkedCardIds: row.linkedCardIds || [],
        contentChars: content.length,
        truncated: content.length > maxChars,
        content: clipText(content, maxChars),
      },
    };
  },
});

toolRegistry.register({
  name: 'list_docs',
  description: '列出全部 AI 文档（AI 生成的总结/笔记/计划稿等：标题 + 类型 + 正文摘要 + 标签 + 更新时间）。'
    + '**概要不含完整正文**：要读某一篇的完整内容，必须再用 read_doc 传 id（或标题片段）获取。'
    + '结果可能被截断（total 大于返回条数），此时用 offset 翻页继续取，不要断言"只有这些"。',
  parameters: { ...PAGING_PARAMS },
  readsData: true,
  async execute(args) {
    const docs = await listDocs();
    const page = pageOf(docs, args);
    return {
      ok: true,
      data: {
        total: page.total, offset: page.offset, hasMore: page.hasMore,
        items: page.items.map((d) => ({
          id: d.id, title: d.title, type: d.type, tags: d.tags || [],
          preview: clipText(String(d.content || '').replace(/\s+/g, ' '), 80),
          contentChars: String(d.content || '').length,
          hasImage: hasImageRef(d.content),
          updatedAt: d.updatedAt,
        })),
      },
    };
  },
});

toolRegistry.register({
  name: 'read_doc',
  description: '读取一篇 AI 文档的**完整正文**（Markdown，正文里可能含图片引用）。'
    + '参数二选一：id（来自 list_docs，最可靠）或 title（按标题模糊匹配）。'
    + '用户问「那篇文档写了什么」时用它，不要凭标题猜内容，也不要回答"我看不到"。',
  parameters: {
    id: 'string: 文档 id（来自 list_docs）',
    title: 'string: 文档标题或片段（模糊匹配）',
    maxChars: 'number: 正文最多返回多少字，默认 2000',
  },
  readsData: true,
  async execute(args) {
    const docs = await listDocs();
    if (!docs.length) return { ok: false, error: '还没有任何 AI 文档。可先用 create_doc 新建，或让用户到「AI 助手」页生成。' };
    const target = pickByIdOrTitle(docs, args);
    if (!target) {
      const titles = docs.slice(0, 20).map((d) => d.title).join('、');
      return { ok: false, error: `未找到匹配的文档。现有文档：${titles}。可先用 list_docs 查看完整列表。` };
    }
    // 定位到后用 getDoc 再取一次当前行：列表可能是稍早的快照，
    // 而「读全文」必须给最新内容（否则用户刚改了文档，AI 还在念旧版）。
    const row = (await getDoc(target.id).catch(() => null)) || target;
    const content = String(row.content || '');
    const maxChars = Math.min(Math.max(Math.trunc(Number(args?.maxChars)) || 2000, 200), 20000);
    return {
      ok: true,
      data: {
        id: row.id, title: row.title, type: row.type, tags: row.tags || [],
        contentChars: content.length,
        truncated: content.length > maxChars,
        content: clipText(content, maxChars),
        note: '以上是该文档正文。正文里形如 sxy-img:// 的图片引用会自动作为附图发送给多模态模型；若当前策略为「先 OCR」则已转成文字，未看到图不等于没有图。',
      },
    };
  },
});

toolRegistry.register({
  name: 'create_doc',
  description: '新建一篇 AI 文档并持久化（会随数据包同步）。type: summary/note/plan/other。',
  parameters: {
    title: 'string: 标题',
    content: 'string: 正文内容',
    type: 'string: 类型 summary|note|plan|other',
    tags: 'string: 逗号分隔标签（可选）',
  },
  writesData: true,
  async execute(args) {
    const tags = args?.tags ? String(args.tags).split(',').map(x => x.trim()).filter(Boolean) : [];
    const d = await createDoc({ title: args?.title, content: args?.content, type: args?.type, tags });
    return { ok: true, data: { id: d.id, title: d.title, type: d.type } };
  },
});

toolRegistry.register({
  name: 'get_cross_insight',
  description: '获取跨模块全局洞察：卡片/复习/薄弱/最近错题/计划/文档/图谱/备忘/费曼/番茄 等全部模块汇总。',
  parameters: {},
  readsData: true,
  async execute() {
    const insight = await getCrossModuleInsight();
    return { ok: true, data: insight };
  },
});

toolRegistry.register({
  name: 'smart_review_plan',
  description: '基于跨模块数据（薄弱卡+最近错题+到期卡+计划+费曼反馈）生成一份针对性智能复习清单。',
  parameters: { limit: 'number: 建议复习数量，默认 20' },
  writesData: false,
  async execute(args) {
    const limit = Number(args?.limit) || 20;
    const insight = await getCrossModuleInsight();
    const weak = await weakCards(limit, 1);
    return {
      ok: true,
      data: {
        recentMistakes: insight.recentMistakes.slice(0, limit),
        weakCards: weak.slice(0, limit).map(c => ({ id: c.id, subject: c.subject, front: stripImageRefs(c.front).slice(0, 50), hasImage: hasImageRef(c.front) || hasImageRef(c.back), failCount: c.failCount })),
        dueCount: insight.dueToday,
        activePlans: insight.plans.active,
        suggestion: `建议优先复习最近答错的 ${insight.recentMistakeCount} 题与 ${weak.length} 张薄弱卡，兼顾 ${insight.dueToday} 张到期卡。`,
      },
    };
  },
});

toolRegistry.register({
  name: 'get_learning_profile',
  description: '获取跨模块统一学习画像：综合分(0-100) + 六维（掌握度/正确率/稳定度/覆盖率/活跃度/纠正力）。',
  parameters: {},
  readsData: true,
  async execute() {
    const p = await getLearningProfile();
    return { ok: true, data: p };
  },
});

toolRegistry.register({
  name: 'get_confusable_pairs',
  description: '自动找出易混淆的卡片对（同科目且共享标签、双方都有答错记录），用于配对巩固复习。',
  parameters: { limit: 'number: 返回对数，默认 10' },
  readsData: true,
  async execute(args) {
    const limit = Number(args?.limit) || 10;
    const pairs = await getConfusablePairs(limit);
    return { ok: true, data: { count: pairs.length, items: pairs } };
  },
});

// 知识图谱驱动复习编排：基于持久化图谱边做 prereq 回溯 + contrast 配对
toolRegistry.register({
  name: 'graph_review_plan',
  description: '知识图谱驱动复习编排：基于用户已保存的图谱边（前置/依赖/对比），把到期/薄弱卡的前置知识点对应卡排在前面，易混卡挨着复习。返回有序 path + 额外加入的 prereqsAdded + 配对 contrastPairs。',
  parameters: {
    limit: 'number: 复习卡数上限，默认 50',
    includeDueOnly: 'boolean: 是否只含到期卡，默认 true（false 时会纳入薄弱卡作种子）',
  },
  readsData: true,
  async execute(args) {
    const plan = await getGraphDrivenReviewPlan({
      limit: Number(args?.limit) || 50,
      includeDueOnly: args?.includeDueOnly !== false,
    });
    return {
      ok: true,
      data: {
        path: plan.path.slice(0, 50).map(c => ({ id: c.id, subject: c.subject, front: stripImageRefs(c.front).slice(0, 60), hasImage: hasImageRef(c.front) || hasImageRef(c.back), graphReason: c.graphReason, level: c.level, dueAt: c.dueAt })),
        prereqsAdded: plan.prereqsAdded.slice(0, 15).map(c => ({ id: c.id, front: stripImageRefs(c.front).slice(0, 60), subject: c.subject, hasImage: hasImageRef(c.front) || hasImageRef(c.back) })),
        contrastPairs: plan.contrastPairs.slice(0, 15),
        unmapped: plan.unmapped,
        edgesUsed: plan.edgesUsed,
        fallback: plan.fallback,
      },
    };
  },
});

// 自动编排学习计划（数据驱动，零 LLM 也能用）
toolRegistry.register({
  name: 'auto_generate_plan',
  description: '基于跨模块真实数据（薄弱科目/到期分布/遗忘风险/易混对/图驱动路径）自动编排一份分阶段学习计划（抢救→巩固→收尾），返回 title+content（markdown）+meta。可直接交给 create_plan 持久化。',
  parameters: { days: 'number: 计划天数，默认 7，范围 1-30' },
  readsData: true,
  async execute(args) {
    const days = Number(args?.days) || 7;
    const r = await generateAutoPlan(days);
    return { ok: true, data: r };
  },
});

toolRegistry.register({
  name: 'get_gap_cards',
  description: '获取高频错题（知识缺口），是「费曼→错题→补卡」闭环的起点。',
  parameters: { limit: 'number: 数量，默认 15' },
  readsData: true,
  async execute(args) {
    const limit = Number(args?.limit) || 15;
    const cards = await getGapCards(limit);
    return { ok: true, data: { count: cards.length, items: cards } };
  },
});

toolRegistry.register({
  name: 'generate_variant_card',
  description: '基于一张易错卡，生成 1~2 道「变式题」巩固理解（换角度/换数字/换场景），返回候选卡，可再入库。',
  parameters: { front: 'string: 原卡正面', back: 'string: 原卡背面' },
  writesData: false,
  async execute(args, ctx) {
    const front = String(args?.front || '').trim();
    const back = String(args?.back || '').trim();
    if (!front || !back) return { ok: false, error: '需要原卡正反面' };
    const sys = '你是出题老师。基于下面的知识点生成 2 道变式题（换角度/换数字/换场景考察理解，而非原题）。输出严格 JSON 数组，每项 {"front":"变式问题","back":"答案","subject":"科目"}。只输出 JSON。';
    const out = await ctx.chat([
      { role: 'system', content: sys },
      { role: 'user', content: `原卡正面：${front}\n原卡背面：${back}` },
    ]);
    const arr = extractJSON(out);
    const cards = Array.isArray(arr) ? arr.filter(c => c && c.front && c.back) : [];
    return { ok: true, data: { count: cards.length, cards } };
  },
});

// ---------- 9. RAG 检索增强（Agent 的「眼睛」） ----------

toolRegistry.register({
  name: 'semantic_search',
  description: '语义+关键词混合检索：从用户卡片库/文档中找出与查询最相关的内容，返回 top-k 结果（含相似度分数、来源类型、卡片正反面/文档片段）。适合「我有没有学过X」「找一下关于Y的卡」类需求。',
  parameters: {
    query: 'string: 搜索内容',
    topK: 'number: 返回条数，默认 6',
    subject: 'string: 可选，限定科目（走索引，缩小检索范围、提速）',
  },
  readsData: true,
  async execute(args) {
    const query = String(args?.query || '').trim();
    if (!query) return { ok: false, error: '查询为空' };
    const opts = { topK: Number(args?.topK) || 6 };
    if (args?.subject && String(args.subject).trim()) opts.subject = String(args.subject).trim();
    try {
      const results = await hybridSearch(query, opts);
      return {
        ok: true,
        data: {
          count: results.length,
          items: results.map((r) => ({
            sourceType: r.row.sourceType,
            sourceId: r.row.sourceId,
            subject: r.row.subject,
            text: clipText(r.row.text, 120),
            fusedScore: Math.round(r.fused * 100),
            semScore: Math.round((r.semScore || 0) * 100),
            kwScore: Math.round((r.kwScore || 0) * 100),
          })),
        },
      };
    } catch (e) {
      // M10：全库超上限被拒时给出可操作反馈（建议带 subject 重试），不让错误静默吞掉
      return { ok: false, error: e?.message || '检索失败' };
    }
  },
});

toolRegistry.register({
  name: 'retrieve_context',
  description: '检索增强上下文：根据问题从卡片库/文档中检索最相关内容，格式化为可直接注入提示的文本。适合 Agent 自己在推理过程中按需补充上下文。',
  parameters: {
    query: 'string: 需要检索的问题/关键词',
    topK: 'number: 返回条数，默认 6',
    subject: 'string: 可选，限定科目（走索引，缩小检索范围、提速）',
  },
  readsData: true,
  async execute(args) {
    const query = String(args?.query || '').trim();
    if (!query) return { ok: false, error: '查询为空' };
    const opts = { topK: Number(args?.topK) || 6 };
    if (args?.subject && String(args.subject).trim()) opts.subject = String(args.subject).trim();
    try {
      const text = await retrieveContext(query, opts);
      return { ok: true, data: { context: text, hasResults: !!text } };
    } catch (e) {
      // M10：全库超上限被拒 → 明确反馈（Agent 可带 subject 缩小范围重试）
      return { ok: false, error: e?.message || '检索失败' };
    }
  },
});

toolRegistry.register({
  name: 'ensure_index',
  description: '增量更新向量索引：把新增/修改的卡片文档生成 embedding（轻量，最多处理 50 卡+10 文档）。适合用户问完问题后后台补索引。',
  parameters: {
    maxCards: 'number: 最多处理卡片数，默认 50',
    maxDocs: 'number: 最多处理文档数，默认 10',
  },
  writesData: true,
  async execute(args) {
    const r = await ensureIndex(Number(args?.maxCards) || 50, Number(args?.maxDocs) || 10);
    return { ok: true, data: r };
  },
});

toolRegistry.register({
  name: 'rebuild_index',
  description: '全量重建向量索引（耗时操作，适合 embedding 模型变更或索引损坏时使用）。',
  parameters: {},
  writesData: true,
  async execute() {
    const r = await rebuildIndex();
    return { ok: true, data: r };
  },
});

toolRegistry.register({
  name: 'get_index_status',
  description: '获取向量索引健康状态：卡片/文档的索引覆盖率、总 chunk 数、当前 embedding 模型签名。',
  parameters: {},
  readsData: true,
  async execute() {
    const s = await getIndexStatus();
    return { ok: true, data: s };
  },
});

// ---------- 10. 多智能体协作（Agent 间委托 + 黑板） ----------

toolRegistry.register({
  name: 'delegate_to_agent',
  description: '把一个子任务委托给另一个专业 Agent 执行（轻量咨询，不走完整 ReAct 循环）。适合「这个问题让分析师看看」「请出题官出一道题」类需求。',
  parameters: {
    agentId: 'string: 目标 Agent id（tutor/analyst/cardsmith/quizmaster/mnemonist/smart-reviewer/mistake-analyst/graph-builder/planner）',
    task: 'string: 委托的具体任务描述',
  },
  writesData: false,
  async execute(args, ctx) {
    const targetAgent = agentRegistry.get(String(args?.agentId || ''));
    if (!targetAgent) return { ok: false, error: `Agent 不存在：${args?.agentId}` };
    const task = String(args?.task || '').trim();
    if (!task) return { ok: false, error: '任务为空' };
    // 轻量委托：用目标 Agent 的 system prompt + 当前上下文，单轮调用 LLM
    let sys = targetAgent.systemPrompt || '';
    if (ctx.studyContext) sys = sys.replace(/\{context\}/g, ctx.studyContext);
    if (ctx.memoryText) sys = sys.replace(/\{memory\}/g, ctx.memoryText);
    // 黑板上下文（如果在流水线中）
    if (ctx.blackboard) {
      const bbText = ctx.blackboard.toContextText();
      if (bbText) sys += `\n\n【协作黑板】\n${bbText}`;
    }
    const reply = await ctx.chat([
      { role: 'system', content: sys },
      { role: 'user', content: task },
    ]);
    // 把委托结果写到黑板
    if (ctx.blackboard) {
      ctx.blackboard.addFinding(targetAgent.id, reply);
    }
    return { ok: true, data: { agent: targetAgent.id, agentName: targetAgent.name, reply: reply.slice(0, 500) } };
  },
});

toolRegistry.register({
  name: 'read_blackboard',
  description: '读取多智能体协作黑板上的已有发现和产出（仅在流水线模式中可用）。适合在协作中查看其他 Agent 已做了什么。',
  parameters: {},
  readsData: true,
  async execute(args, ctx) {
    if (!ctx.blackboard) return { ok: false, error: '当前不在多智能体协作模式（无黑板）' };
    return {
      ok: true,
      data: {
        query: ctx.blackboard.query,
        findings: ctx.blackboard.findings.slice(-10).map((f) => ({ agent: f.agent, text: f.text.slice(0, 200), ts: f.ts })),
        artifacts: Object.fromEntries(
          Object.entries(ctx.blackboard.artifacts).map(([k, v]) => [k, { agent: v.agent, preview: typeof v.value === 'string' ? v.value.slice(0, 150) : JSON.stringify(v.value).slice(0, 150) }]),
        ),
        pendingSubtasks: ctx.blackboard.subtasks.filter((s) => s.status === 'pending').map((s) => ({ agent: s.agent, description: s.description })),
      },
    };
  },
});

toolRegistry.register({
  name: 'write_blackboard',
  description: '向多智能体协作黑板写入一条发现或结构化产出（仅在流水线模式中可用）。让其他 Agent 能看到你的工作成果。',
  parameters: {
    finding: 'string: 发现/结论文本（可选，与 artifactKey 二选一）',
    artifactKey: 'string: 产出键名（可选，如 cards/plan/analysis）',
    artifactValue: 'string: 产出内容（可选，与 artifactKey 配对）',
  },
  writesData: false,
  async execute(args, ctx) {
    if (!ctx.blackboard) return { ok: false, error: '当前不在多智能体协作模式（无黑板）' };
    const agentId = resolveAgentId(ctx);
    if (args?.finding) ctx.blackboard.addFinding(agentId, args.finding);
    if (args?.artifactKey && args?.artifactValue !== undefined) {
      ctx.blackboard.setArtifact(args.artifactKey, args.artifactValue, agentId);
    }
    return { ok: true, data: { written: true, totalFindings: ctx.blackboard.findings.length } };
  },
});

/** 注册内置工具（供 index.js 统一调用，保持幂等） */
export function registerDefaultTools() {
  // 工具已在模块加载时通过 toolRegistry.register 注册，这里仅作显式语义占位。
  return toolRegistry.list().length;
}

// ---------- 智能层算法工具（2026-08-27）：本地错题归因 + 图谱自动构建 ----------
import { attributeMistakes } from '../../algorithms/mistakeAttribution.js';
import { autoBuildGraph, derivePrereqPlan } from '../../algorithms/graphAuto.js';
import { planMistakeQuiz } from '../../algorithms/session.js';

toolRegistry.register({
  name: 'attribute_mistakes',
  description: '本地离线错题归因：用 TF-IDF 把错题按概念聚类，找出用户反复错的薄弱知识点（不调用 LLM，零成本）。返回聚类概念、涉及卡片与簇内相似度。',
  parameters: {
    days: 'number: 只统计最近 N 天的错题，默认 30',
    limit: 'number: 最多取多少张错题卡，默认 50',
  },
  readsData: true,
  async execute(args) {
    const cards = await weakCards(Number(args?.limit) || 50, 1);
    if (!cards.length) return { ok: true, data: { clusters: [], note: '暂无错题' } };
    const clusters = attributeMistakes(cards);
    return {
      ok: true,
      data: {
        clusters: clusters.map(c => ({
          concept: c.concept, size: c.size, score: c.score,
          cards: c.cardIds.slice(0, 5),
        })),
        note: '按簇大小降序；建议从最大簇开始补练（先补前置再练当前）',
      },
    };
  },
});

toolRegistry.register({
  name: 'auto_build_graph',
  description: '自动构建知识图谱：从标签共现/学习顺序/错题同现/内容相似推导卡片间的前置依赖与关联边（写入 graphEdges，kind=auto）。可指定卡片查它的前置补练计划。',
  parameters: {
    cardId: 'string: 可选，指定卡片 ID 则返回该卡的前置依赖补练计划（不传则全量重建图谱）',
  },
  readsData: true,
  writesData: true,
  async execute(args) {
    if (args?.cardId) {
      const plan = await derivePrereqPlan(String(args.cardId));
      return { ok: true, data: plan };
    }
    const res = await autoBuildGraph();
    return { ok: true, data: { stats: res.stats, edgeCount: res.edges.length } };
  },
});

// 错题聚类反哺智能出题（2026-08-27 P1）：高频错因簇 → 先补前置 → 交错出题
// 零 LLM、确定性、离线可跑，smart-reviewer 用它生成「错题轰炸」测验序列
toolRegistry.register({
  name: 'build_quiz_from_mistakes',
  description: '错题聚类反哺出题（零 LLM，离线）：把高频错题按概念簇组织成一份「错题轰炸」测验序列——每个错因簇先补未掌握的前置卡（derivePrereqPlan），再练簇内错题卡，全程交错排序防相似题连排。返回按序作答的测验计划（sequence 直接用于逐卡引导）。',
  parameters: {
    limit: 'number: 取前几个错因簇，默认 5',
    count: 'number: 测验总卡数上限，默认 10',
    days: 'number: 只统计最近 N 天的错题（透传 weakCards），默认 30',
    interleave: 'boolean: 是否交错排序，默认 true',
  },
  readsData: true,
  async execute(args) {
    const limit = Number(args?.limit) || 5;
    const count = Number(args?.count) || 10;
    const interleave = args?.interleave !== false;
    // 错题池：近 N 天/全量中答过错的卡（failCount>=1 即纳入，聚类本身会归并同概念）
    const pool = await weakCards(Math.max(count * 3, 20), 1);
    if (!pool.length) {
      return { ok: true, data: { clusters: [], sequence: [], meta: { note: '暂无错题，先去复习积累数据' } } };
    }
    const clusters = attributeMistakes(pool);
    // 为每个簇的领衔错卡取未掌握前置（先补前置再练当前）；图谱未建时静默降级
    const prereq = new Map();
    for (const cl of clusters.slice(0, limit)) {
      const leadId = cl.cardIds[0];
      try {
        const plan = await derivePrereqPlan(leadId);
        if (plan.prereqCardIds.length) prereq.set(leadId, plan.prereqCardIds);
      } catch { /* 忽略：无图谱边时不出前置卡 */ }
    }
    const quiz = planMistakeQuiz(clusters, pool, { limit, count, prereq, interleave });
    return { ok: true, data: quiz };
  },
});

// ---------- 资料库文件（列表 / 读取；扫描件自动携带视觉引用） ----------
// 背景：卡片图片走 sxy-img:// 占位符能被富集，但**资料库文件**（docFiles/docBlobs）不在那条链路上。
// 用户上传的扫描 PDF / 图表资料没有文字层，Agent 若不看内容就只能答「查不到」。
// 方案：read_doc 在文本里留一个 sxy-doc://<docId>[#pages] 引用，由 chat() 出口的
// image-analysis.enrichForLlm 渲染成页面图送给多模态（与 sxy-img:// 同一套策略与护栏）。

toolRegistry.register({
  // 命名注意：既有 `list_docs` 是「列 AI 文档」（repo.docs），本工具是「列资料库文件」（docFiles）。
  // 二者曾是同名 → 后注册者覆盖前者，AI 文档列表功能被静默顶掉（2026-09-14 审计发现）。
  // 现统一加 `_lib_` 前缀（library = 资料库），并把 read 也改名成 read_lib_doc 成对，
  // 顺便把 `read_doc` 这个名字让给「读 AI 文档」工具——round74 已兑现（见上方 read_doc 注册）。
  name: 'list_lib_docs',
  description: '列出用户「资料库」里的文件（PDF/图片/文档）：名称、类型、页数、是否有可提取文字层、文字摘要。'
    + '用户提到「我上传的资料/课件/讲义」时先调它了解有什么，再用 **read_lib_doc** 读具体内容。'
    + '注意：读资料库文件用 read_lib_doc，读 AI 文档用 read_doc，别混。'
    + '结果可能被截断（total 大于返回条数），此时用 offset 翻页继续取，不要断言"只有这些"。',
  parameters: { ...PAGING_PARAMS },
  readsData: true,
  async execute(args) {
    const files = await listDocFiles();
    // 先分页、再取文字：保持「每次只读一页的文字」这个并发上界（原实现是 slice(0,50)）。
    const page = pageOf(files, args);
    // round48：并发取「是否有文字层」——此前 `for + await getDocText` 是串行 N+1，
    // 50 份资料 = 50 次顺序往返。这里只读 docTexts 的 text 字段，并发安全。
    const items = await Promise.all(page.items.map(async (f) => {
      const text = String((await getDocText(f.id).catch(() => '')) || '').trim();
      return {
        docId: f.id,
        name: f.name,
        kind: docKindOf(f),
        pageCount: Number(f.pageCount) || 0,
        hasTextLayer: !!text,
        // 文字摘要：让模型先判断「哪份资料与问题相关」，再决定要不要 read_lib_doc 取全文/看图。
        // 没有摘要时它只能凭文件名猜，很容易答"我看不到你的资料内容"。
        textPreview: clipText(text.replace(/\s+/g, ' '), 60),
        textChars: text.length,
      };
    }));
    return { ok: true, data: { total: page.total, offset: page.offset, hasMore: page.hasMore, items } };
  },
});

toolRegistry.register({
  name: 'read_lib_doc',
  description: '读取某份资料的内容用于分析。有文字层的直接返回文字摘录；'
    + '扫描件/图表型（无文字层）会自动把页面图作为附图交给多模态模型，请直接看图分析。'
    + '参数二选一：docId（来自 list_lib_docs，最可靠）或 name（按文件名模糊匹配）。',
  parameters: {
    docId: '资料 id（来自 list_lib_docs）',
    name: '资料名称或名称片段（模糊匹配）',
    pages: '要看的页码，如 "1,3-5"；仅扫描件/图表型有效，缺省看前 3 页',
  },
  readsData: true,
  async execute(args = {}) {
    const files = await listDocFiles();
    if (!files.length) {
      return { ok: false, error: '资料库里还没有文件。请先在「资料库」页上传，再让我分析。' };
    }
    const byId = args.docId ? files.find((f) => f.id === String(args.docId)) : null;
    let target = byId;
    if (!target && args.name) {
      const q = String(args.name).trim().toLowerCase();
      target = files.find((f) => String(f.name || '').toLowerCase() === q)
        || files.find((f) => String(f.name || '').toLowerCase().includes(q));
    }
    if (!target) {
      const names = files.slice(0, 20).map((f) => f.name).join('、');
      return { ok: false, error: `未找到匹配的资料。可用资料：${names}。可先用 list_lib_docs 查看完整列表。` };
    }

    const profile = await docContentProfile(target.id);
    const text = String((await getDocText(target.id).catch(() => '')) || '').trim();
    const base = {
      docId: target.id, name: target.name, kind: profile.kind, pageCount: profile.pageCount,
    };

    // ① 文字层可用 → 直接给文字（最省最准，不需要视觉）
    if (text && !profile.suspectedScan) {
      return {
        ok: true,
        data: {
          ...base, source: 'text', excerpt: clipText(text, 3000),
          note: '以下是该资料的可提取文字内容，请基于它回答；如需查看原版式/图表，可指定 pages 让我按页看图。',
        },
      };
    }

    // ② 无文字层 / 疑似扫描件 → 附视觉引用（由 chat 出口渲染成页面图送多模态）
    const pages = String(args.pages || '').trim();
    const visionRef = `sxy-doc://${target.id}${pages ? '#' + pages : ''}`;
    return {
      ok: true,
      data: {
        ...base,
        source: 'vision',
        visionRef,
        excerpt: clipText(text, 800),
        note: '该资料没有可提取的文字层（扫描件/图表型），页面图会作为附图一并发送给多模态模型。'
          + '请直接依据图片内容回答，不要凭文件名或标题猜测。'
          + '若你收到的内容里没有图片，说明当前图片分析策略为「先 OCR」或模型不支持视觉——'
          + '请如实告知用户去「设置 → 图片分析策略」改为「先多模态」，不要编造资料内容。',
      },
    };
  },
});


// ---------- round88：英语单词模块（list_words / get_word_detail / get_word_stats） ----------
// 用户反馈「单词模块只能看统计、看不到明细」，根因是**工具层完全没有单词工具**：
// 61 个内置工具里 0 个能读 db.wordCards。三个工具按「列表四件套」分工：
//   list_words（摘要 + id + 分页 + 引导）→ get_word_detail（全文）→ get_word_stats（统计概览）。

toolRegistry.register({
  name: 'list_words',
  description: '列出或检索我的英语单词卡（考研词库）。'
    + '支持按关键词（英文单词 / 中文释义 / 音标 / 笔记 / 例句 模糊匹配）、类别、'
    + '掌握状态（熟词）、词组过滤，并带分页（limit / offset）。'
    + '每项返回 id、单词、音标、释义摘要、类别与掌握度，**只是摘要**；'
    + '要看某张词卡的完整释义 / 例句 / 笔记，请再用 get_word_detail 按 id 或单词取全文。'
    + '用户问「我背了哪些单词」「我的词库里有没有某个词」「还剩多少没背」时先用它拿真实数据，'
    + '不要凭印象猜用户词库里的内容。若要知道总体进度与各组掌握率，用 get_word_stats。',
  parameters: {
    q: '关键词（英文单词 / 中文释义 / 音标 / 笔记 / 例句，模糊匹配）；留空表示不过滤',
    kind: '类别：word（单词）/ phrase（短语）/ sentence（句子）/ template（模板）；留空为全部',
    familiar: '掌握状态：1 = 已标熟词，0 = 未标熟词；留空为全部',
    groupId: '词组 id（来自 get_word_stats 的 groups[].groupId）；留空为全部',
    ...PAGING_PARAMS,
  },
  readsData: true,
  async execute(args = {}) {
    const kind = WORD_KINDS.includes(String(args.kind || '')) ? String(args.kind) : '';
    // 注意不能写成 `Number(args.familiar) || undefined`：显式传 0（只看未标熟词）会被吞成
    // 「不过滤」，而 0 正是最常用的取值（默认就是查还没背熟的词）。
    const rawFamiliar = args.familiar;
    const familiar = rawFamiliar === undefined || rawFamiliar === null || String(rawFamiliar).trim() === ''
      ? undefined
      : (Number(rawFamiliar) ? 1 : 0);
    const rows = await listWordCards({
      q: args.q,
      kind,
      familiar,
      groupId: args.groupId ? String(args.groupId) : '',
    });
    // 词库整体为空且未加任何过滤 → 显式报错并给可执行指引（对齐 read_lib_doc 的口径）。
    // 只说 total:0 的话，模型容易把「还没导入词库」说成「没有匹配的单词」，用户白排查一场。
    const filtered = Boolean(args.q) || Boolean(kind) || familiar !== undefined || Boolean(args.groupId);
    if (!rows.length && !filtered) return { ok: false, error: t('agent.toolMsg.noWords') };
    const page = pageOf(rows, args);
    return {
      ok: true,
      data: {
        ...page,
        items: page.items.map((c) => ({
          id: c.id,
          word: c.word || '',
          phonetic: c.phonetic || '',
          meaning: clipText(String(c.meaning || ''), 160),
          kind: c.kind || 'word',
          familiar: c.familiar ? 1 : 0,
          level: Number(c.level) || 0,
          dueAt: Number.isFinite(c.dueAt) ? c.dueAt : null,
        })),
        hint: t('agent.toolMsg.wordsHint'),
      },
    };
  },
});

toolRegistry.register({
  name: 'get_word_detail',
  description: '读取单张英语单词卡的**完整**内容：词形、音标、全部释义、例句与翻译、'
    + '我给它记的笔记、标签、类别、掌握度与到期时间。'
    + '参数二选一：id（来自 list_words，最可靠）或 word（按词形精确匹配，找不到再退化为包含匹配）。'
    + '用户问「这个词什么意思 / 怎么用 / 有哪些例句 / 我给它写了什么笔记」时，'
    + '必须先用它取到原文再作答，不要凭记忆编造用户词库里的内容。',
  parameters: {
    id: '单词卡 id（来自 list_words，最可靠）',
    word: '单词 / 词形（先精确匹配，再退化为包含匹配）',
  },
  readsData: true,
  async execute(args = {}) {
    const id = String(args.id || '').trim();
    const term = String(args.word || '').trim();
    let target = id ? await getWordCard(id) : null;
    if (!target && term) {
      // 词形没有独立索引，走既有的 q 过滤（只在命中行上做词库回填，成本可控）
      const hits = await listWordCards({ q: term });
      const lower = term.toLowerCase();
      target = hits.find((r) => String(r.word || '').toLowerCase() === lower) || hits[0] || null;
    }
    if (!target) return { ok: false, error: t('agent.toolMsg.wordNotFound') };
    return {
      ok: true,
      data: {
        id: target.id,
        word: target.word || '',
        phonetic: target.phonetic || '',
        meaning: target.meaning || '',
        example: target.example || '',
        exampleTrans: target.exampleTrans || '',
        note: target.note || '',
        tags: Array.isArray(target.tags) ? target.tags : [],
        subject: target.subject || '',
        kind: target.kind || 'word',
        familiar: target.familiar ? 1 : 0,
        level: Number(target.level) || 0,
        intervalDays: Number(target.intervalDays) || 0,
        dueAt: Number.isFinite(target.dueAt) ? target.dueAt : null,
        reviewedAt: Number(target.reviewedAt) || 0,
      },
    };
  },
});


toolRegistry.register({
  name: 'get_image_assets',
  description: '图片资产体检：正文（卡片/笔记/备忘/文档）里共引用了多少张图、其中多少在本地图库**可读**、'
    + '多少**悬空**（引用在但图片数据缺失——跨设备未同步 / 原图被删 / 导入备份未带图），并列出悬空样例。'
    + '用户问「图片能不能看到 / 为什么某张图读不出来」时先用它拿真实数字再作答，不要凭印象断言「图不存在」；'
    + '若悬空为 0，则图中本地可读，读不到是识别/策略问题，应说明图片**存在**。',
  parameters: { limit: 'number: 悬空清单最多列多少条，默认 10，最大 50' },
  readsData: true,
  async execute(args) {
    const s = await statImageAssets();
    const limit = Math.min(Math.max(Math.trunc(Number(args?.limit)) || 10, 1), 50);
    const dangling = (s.danglingIds || []).slice(0, limit);
    return {
      ok: true,
      data: {
        imgRefs: s.imgRefs,
        imgLive: s.imgUnique,
        imgDangling: s.imgDangling,
        bySource: s.bySource,
        danglingSample: dangling,
        truncated: s.imgDangling > dangling.length,
        hint: s.imgDangling > 0 ? IMAGE_ASSETS_HINT_DANGLING_PROMPT : IMAGE_ASSETS_HINT_OK_PROMPT,
      },
    };
  },
});
toolRegistry.register({
  name: 'get_word_stats',
  description: '英语单词模块的**统计概览**（不含具体单词内容）：总词数、参与复习的数量、'
    + '当前到期（待背）数量、实际复习队列长度、已标熟词数、模板数、今日新增，'
    + '以及今日已背次数 / 累计复习次数，外加各词组（单词书分组）的掌握率明细。'
    + '用户问「我背了多少单词」「还剩多少没背」「哪一组掌握得最差」时用它。'
    + '要看具体单词内容请用 list_words / get_word_detail（这两个才返回单词正文）。',
  parameters: {},
  readsData: true,
  async execute() {
    const [stats, perGroup, groups, due, reviewedToday, reviewedTotal] = await Promise.all([
      wordStats(),
      wordGroupStats(),
      listWordGroups(),
      dueWordCards(),
      wordReviewedToday(),
      wordReviewedTotal(),
    ]);
    const nameOf = new Map(groups.map((g) => [g.id, g.name]));
    return {
      ok: true,
      data: {
        total: stats.total,
        schedulable: stats.schedulable,
        due: stats.due,
        dueQueue: due.length,
        mastered: stats.mastered,
        familiar: stats.familiar,
        templates: stats.templates,
        newToday: stats.newToday,
        reviewedToday,
        reviewedTotal,
        groups: perGroup.map((g) => ({ ...g, name: nameOf.get(g.groupId) || '' })),
        hint: t('agent.toolMsg.wordStatsHint'),
      },
    };
  },
});
