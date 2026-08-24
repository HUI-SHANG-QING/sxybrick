// src/agent/tools/index.js
// 内置工具集：全部围绕“学习”场景，分为「数据感知」「卡片生产」「测评」三类。
// 每个工具都是纯函数式声明，通过 toolRegistry 注册；工具执行时由 ctx 提供 chat 能力。

import { toolRegistry } from '../registry.js';
import { extractJSON } from '../llm.js';
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
import { getCardAnalytics, getRecentMistakes, getCrossModuleInsight } from '../analytics.js';

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
    const e = await createGraphEdge({ from: args?.from, to: args?.to, label: args?.label, subject: args?.subject });
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

/** 注册内置工具（供 index.js 统一调用，保持幂等） */
export function registerDefaultTools() {
  // 工具已在模块加载时通过 toolRegistry.register 注册，这里仅作显式语义占位。
  return toolRegistry.list().length;
}
