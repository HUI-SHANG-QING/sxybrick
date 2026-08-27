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
  createDoc,
  updateDoc,
  deleteDoc,
} from '../../repo.js';
import { getCardAnalytics, getRecentMistakes, getCrossModuleInsight, getLearningProfile, getConfusablePairs, getGapCards, getGraphDrivenReviewPlan, generateAutoPlan } from '../analytics.js';
import { generateDeck, generateColdStartDeck, bulkCreateCards, COLD_START_TEMPLATES } from '../../utils/genDeck.js';
import { hybridSearch, retrieveContext, ensureIndex, rebuildIndex, getIndexStatus } from '../retrieval.js';
import { agentRegistry } from '../registry.js';

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
      },
    };
  },
});

toolRegistry.register({
  name: 'get_weak_cards',
  description: '获取当前最薄弱/最易错的卡片列表（按遗忘次数排序），用于定位复习重点。',
  parameters: {
    limit: 'number: 返回数量，默认 10',
    minFail: 'number: 最小遗忘次数阈值，默认 2',
  },
  readsData: true,
  async execute(args) {
    const limit = Number(args?.limit) || 10;
    const minFail = Number(args?.minFail) || 1;
    const cards = await weakCards(limit, minFail);
    return {
      ok: true,
      data: cards.map((c) => ({
        subject: c.subject,
        front: String(c.front).slice(0, 60),
        failCount: c.failCount,
        marked: !!c.marked,
        wrongReason: c.wrongReason || '',
        level: c.level,
      })),
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
  description: '按关键词/科目/标签搜索卡片，支持 AND/OR/NOT 组合，返回命中卡片的概要。',
  parameters: {
    q: 'string: 模糊搜索正/背面关键词',
    subject: 'string: 限定科目（可选）',
    tags: 'string: 逗号分隔的标签（可选）',
    logic: 'string: 标签组合逻辑 AND/OR/NOT，默认 AND',
    mode: 'string: all=全部, due=仅到期',
  },
  readsData: true,
  async execute(args) {
    const tags = args?.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
    const r = await listCards({
      q: args?.q || '',
      subject: args?.subject || '',
      tags,
      logic: args?.logic || 'AND',
      mode: args?.mode || 'all',
    });
    return {
      ok: true,
      data: {
        total: r.total,
        dueCount: r.dueCount,
        items: r.items.slice(0, 30).map((c) => ({
          id: c.id,
          subject: c.subject,
          front: String(c.front).slice(0, 80),
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
        templates: COLD_START_TEMPLATES.map(t => ({
          id: t.id, name: t.name, subject: t.subject, description: t.description,
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
    const tags = args?.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
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
  description: '按卡片 id 获取一张卡片的完整内容（正/背面、科目、标签、掌握等级、口诀、错因）。',
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
    const tags = args?.tags != null ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : old.tags;
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
  description: '列出用户全部备忘录。',
  parameters: {},
  readsData: true,
  async execute() {
    const memos = await listMemos();
    return { ok: true, data: { count: memos.length, items: memos.slice(0, 50) } };
  },
});

// ---------- 5. 学习计划（持久化） ----------

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
  description: '列出全部学习计划（含状态 active/done/archived）。',
  parameters: {},
  readsData: true,
  async execute() {
    const plans = await listPlans();
    return { ok: true, data: { count: plans.length, items: plans } };
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
    const related = r.items.slice(0, 8).map((c) => `[${c.subject}] ${String(c.front).slice(0, 60)}`).join('\n');
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
  name: 'list_docs',
  description: '列出全部 AI 文档（标题/类型/更新时间）。',
  parameters: {},
  readsData: true,
  async execute() {
    const docs = await listDocs();
    return { ok: true, data: { count: docs.length, items: docs.map(d => ({ id: d.id, title: d.title, type: d.type, updatedAt: d.updatedAt })) } };
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
    const tags = args?.tags ? String(args.tags).split(',').map(t => t.trim()).filter(Boolean) : [];
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
        weakCards: weak.slice(0, limit).map(c => ({ id: c.id, subject: c.subject, front: String(c.front).slice(0, 50), failCount: c.failCount })),
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
        path: plan.path.slice(0, 50).map(c => ({ id: c.id, subject: c.subject, front: String(c.front).slice(0, 60), graphReason: c.graphReason, level: c.level, dueAt: c.dueAt })),
        prereqsAdded: plan.prereqsAdded.slice(0, 15).map(c => ({ id: c.id, front: String(c.front).slice(0, 60), subject: c.subject })),
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
    const results = await hybridSearch(query, opts);
    return {
      ok: true,
      data: {
        count: results.length,
        items: results.map((r) => ({
          sourceType: r.row.sourceType,
          sourceId: r.row.sourceId,
          subject: r.row.subject,
          text: String(r.row.text).slice(0, 120),
          fusedScore: Math.round(r.fused * 100),
          semScore: Math.round((r.semScore || 0) * 100),
          kwScore: Math.round((r.kwScore || 0) * 100),
        })),
      },
    };
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
    const text = await retrieveContext(query, opts);
    return { ok: true, data: { context: text, hasResults: !!text } };
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
