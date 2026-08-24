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
} from '../../repo.js';

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

/** 注册内置工具（供 index.js 统一调用，保持幂等） */
export function registerDefaultTools() {
  // 工具已在模块加载时通过 toolRegistry.register 注册，这里仅作显式语义占位。
  return toolRegistry.list().length;
}
