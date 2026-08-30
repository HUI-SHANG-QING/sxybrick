// src/i18n/views/search.js
// 全局搜索视图（Search.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.search / en.views.search。
// 仅外置静态 UI 文案；搜索结果本身（SCOPE_LABELS、用户数据）不在此翻译。
export const zh = {
  title: '全局搜索',
  hint: '按 / 快速聚焦 · 一次搜遍所有模块',
  scopeAll: '全部（全局搜索）',
  scopeAllName: '全部模块',
  placeholder: '输入关键词，例如：死锁 / 特征值 / 操作系统…',
  error: '搜索出错：{msg}',
  searching: '搜索中…',
  found: '找到 {n} 条结果',
  noResult: '在「{scope}」没有找到与「{q}」相关的资产',
};

export const en = {
  title: 'Global Search',
  hint: 'Press / to focus · search every module at once',
  scopeAll: 'All (global search)',
  scopeAllName: 'All modules',
  placeholder: 'Type a keyword, e.g. deadlock / eigenvalue / OS…',
  error: 'Search error: {msg}',
  searching: 'Searching…',
  found: 'Found {n} results',
  noResult: 'No assets matching "{q}" in "{scope}"',
};
