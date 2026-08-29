// src/search/search-service.js
// M4 统一搜索服务：search(scope, keyword) 返回结构化结果。
// scope: 'all'（全量聚合）| 'cards' | 'docs' | 'mindmaps' | 'memos' | 'exams' | 'notes' | 'plans' | 'analysis'
// 数据源全部走当前 db 实例（import { db } live binding）→ 演示模式下自动搜测试数据，真实模式搜真实数据。
// 性能：IndexedDB 无全文索引，采用内存过滤 + 防抖（UI 层）；大字段截断匹配窗口控制成本。
// 纯函数部分（match/highlight）可 Node 单测；db 读取部分由集成测试覆盖。

import { db } from '../db.js';

/** 去除 Markdown 语法取纯文本（摘要展示用，与 Search.vue 原实现一致） */
export function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const norm = s => String(s || '').toLowerCase();

/**
 * 多字段匹配：任意一个字段命中即匹配。
 * @param {object} row 数据行
 * @param {string} kw 小写关键词
 * @param {string[]} fields 要匹配的字段名（数组字段自动展开）
 */
export function rowMatches(row, kw, fields) {
  if (!row || !kw) return false;
  return fields.some(f => {
    let v = row[f];
    if (v == null) return false;
    // 数组元素可能是对象（考题 questions / 导图 children）：对象须序列化，否则 String() 得 [object Object]
    if (Array.isArray(v)) return v.some(x => norm(typeof x === 'object' && x !== null ? JSON.stringify(x) : x).includes(kw));
    if (typeof v === 'object') v = JSON.stringify(v);
    return norm(v).includes(kw);
  });
}

/**
 * 关键词高亮：转义 HTML 后包裹 <mark>（大小写不敏感）。
 * 输入先做 HTML 转义，杜绝 XSS（搜索结果可能含用户输入）。
 */
export function highlight(text, keyword) {
  const esc = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const kw = String(keyword ?? '').trim();
  if (!kw) return esc;
  const kEsc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc.replace(new RegExp(`(${kEsc})`, 'gi'), '<mark>$1</mark>');
}

// ---------- 各模块数据源适配器 ----------
// 每个适配器：{ key, label, icon, go(基础跳转路径), load(): Promise<rows>, fields: 匹配字段,
//              map(row, kw): 结果行 { id, title, sub, go } , cap: 每模块结果上限 }

function makeAdapter(cfg) {
  return {
    key: cfg.key, label: cfg.label, icon: cfg.icon, cap: cfg.cap || 20,
    async search(kw) {
      let rows;
      try {
        rows = await cfg.load();
      } catch {
        rows = []; // 表不存在/未迁移：该模块视为无结果，不阻断其它模块
      }
      const hits = [];
      for (const r of rows) {
        if (rowMatches(r, kw, cfg.fields)) {
          hits.push(cfg.map(r, kw));
          if (hits.length >= cfg.cap || cfg.cap === 0) break;
        }
      }
      return { key: cfg.key, label: cfg.label, icon: cfg.icon, items: hits };
    },
  };
}

export const CARD_FIELDS = ['front', 'back', 'subject', 'tags', 'source', 'mnemonic', 'type'];

export const SEARCH_ADAPTERS = {
  cards: makeAdapter({
    key: 'cards', label: '卡片', icon: '🗂️', cap: 30,
    load: () => db.cards.toArray(),
    fields: CARD_FIELDS,
    map: c => ({
      id: c.id,
      title: plain(c.front).slice(0, 60) || '（空题）',
      sub: `[${c.subject || '未分类'}] ${plain(c.back).slice(0, 60)}`,
      go: '/cards',
    }),
  }),
  docs: makeAdapter({
    key: 'docs', label: 'AI 文档', icon: '📄', cap: 20,
    load: () => db.docs.toArray(),
    fields: ['title', 'content', 'type'],
    map: d => ({ id: d.id, title: d.title || '未命名文档', sub: plain(d.content).slice(0, 60), go: '/docs' }),
  }),
  mindmaps: makeAdapter({
    key: 'mindmaps', label: '思维导图', icon: '🗺️', cap: 20,
    load: () => db.mindmaps.toArray(),
    fields: ['title', 'root'],
    map: m => ({ id: m.id, title: m.title || '未命名导图', sub: '思维导图', go: '/mindmap' }),
  }),
  memos: makeAdapter({
    key: 'memos', label: '备忘录', icon: '📝', cap: 20,
    load: () => db.memos.toArray(),
    fields: ['text'],
    map: m => ({ id: m.id, title: String(m.text || '').slice(0, 60), sub: '备忘录', go: '/memo' }),
  }),
  exams: makeAdapter({
    key: 'exams', label: '模考成绩', icon: '🧪', cap: 20,
    load: () => db.exams.toArray(),
    fields: ['title', 'questions'],
    map: e => ({ id: e.id, title: `${e.title || '模考'}（${e.score ?? '?'}/${e.total ?? '?'}）`, sub: '模考成绩', go: '/exam' }),
  }),
  notes: makeAdapter({
    key: 'notes', label: '笔记', icon: '📓', cap: 20,
    load: () => db.notes.toArray(),
    fields: ['title', 'content', 'category', 'tags'],
    map: n => ({ id: n.id, title: n.title || '未命名笔记', sub: `[${n.category || '笔记'}] ${plain(n.content).slice(0, 60)}`, go: '/notes' }),
  }),
  plans: makeAdapter({
    key: 'plans', label: '学习计划', icon: '📅', cap: 20,
    load: async () => (await db.plans.toArray()).flatMap(p => {
      // 计划标题 + 任务文本一起匹配：plans 表存任务明细，标题字段兜底
      return [{ id: p.id, title: p.title || p.task || p.name || p.date || '计划', content: JSON.stringify(p) }];
    }),
    fields: ['title', 'content'],
    map: p => ({ id: p.id, title: String(p.title || '计划').slice(0, 60), sub: '学习计划', go: '/plan' }),
  }),
  analysis: makeAdapter({
    key: 'analysis', label: '联动分析', icon: '🔗', cap: 20,
    load: () => db.analysisSessions.toArray(),
    fields: ['title', 'cardIds'],
    map: s => ({ id: s.id, title: s.title || '分析会话', sub: '联动分析会话', go: '/analysis/card-link' }),
  }),
};

/** 全量聚合顺序（搜索页分组展示顺序） */
export const SCOPE_ORDER = ['cards', 'docs', 'mindmaps', 'memos', 'exams', 'notes', 'plans', 'analysis'];

export const SCOPE_LABELS = Object.fromEntries(SCOPE_ORDER.map(k => [k, SEARCH_ADAPTERS[k].label]));

/**
 * 统一搜索入口。
 * @param {string} scope 'all' | 模块 key
 * @param {string} keyword 原始关键词（内部归一化小写）
 * @returns {Promise<{scope, keyword, modules: [{key,label,icon,items}], total}>}
 */
export async function search(scope, keyword) {
  const kw = norm(keyword.trim());
  if (!kw) return { scope, keyword, modules: [], total: 0 };
  const keys = scope === 'all' ? SCOPE_ORDER : [scope];
  const valid = keys.filter(k => SEARCH_ADAPTERS[k]);
  const modules = await Promise.all(valid.map(k => SEARCH_ADAPTERS[k].search(kw)));
  const total = modules.reduce((a, m) => a + m.items.length, 0);
  return { scope, keyword: keyword.trim(), modules, total };
}
