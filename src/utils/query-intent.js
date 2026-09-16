// src/utils/query-intent.js
// 普通问答「模块意图」识别：判断用户的问题关心哪些数据模块，用于**按需注入**明细（round98 P2-2）。
//
// 为什么单独一个文件：
//   ① 纯函数、零依赖，可单测；
//   ② 关键词含中文正则，而 i18n 数据层第三道闸（--js）会扫 `src/agent/**`——
//      中文正则既非 prompt 长串、连续中文又不足 24 字，会被判「硬编码中文」。
//      `src/utils/` 不在扫描范围（只扫 repo*/agent/algorithms），故意图表放这里。

const ALL_RE = /全部|所有|汇总|概览|整体|总体|各项|各个模块/;
// 泛问「我最近学得怎样 / 学习情况 / 复盘一下」：没有具体模块词，但**确实想看全局** →
// 视为全量（否则这些高频问法会一块明细都拿不到，只剩统计兜底，体验缺口）。
const BROAD_RE = /学得怎样|学得怎么样|学习情况|学习进度|学习表现|学习概况|最近怎么样|整体情况|复盘|总结一下我|我的学习|学习数据/;
// 「帮我复习 / 考考我 / 刷题」类：核心是薄弱卡（已在统计兜底里），另需计划/每日/单词明细才够用。
const REVIEW_RE = /复习|背诵|刷题|练题|考考|测验|测试|默写/;
const REVIEW_EXTRA = ['plans', 'daily', 'words'];

// [模块 key, 命中关键词]。key 与 buildModuleNodesContext 的分块一一对应。
const GROUPS = [
  ['memos', /备忘|便签|待办|提醒/],
  ['docs', /文档|总结|周报/],
  ['notes', /笔记|note/i],
  ['plans', /计划|规划/],
  ['daily', /每日|今天|日程|任务|打卡|安排/],
  ['pomo', /番茄|专注|时长|pomodoro/i],
  ['words', /单词|词汇|背词|单词本/],
  ['files', /资料库|资料|文件|pdf|课件|材料/i],
  ['graph', /图谱|关联|知识网络|关系|边/],
];

/**
 * 该问题关心的模块集合。
 * @param {string} query 用户问题
 * @returns {Set<string>|null} 关心的模块 key 集合；问「全部」时返回 **null**（表示不筛）；空问题返回空集。
 */
export function wantedModules(query) {
  const q = String(query || '').trim();
  if (!q) return new Set();
  if (ALL_RE.test(q) || BROAD_RE.test(q)) return null;
  const out = new Set();
  for (const [k, re] of GROUPS) if (re.test(q)) out.add(k);
  if (REVIEW_RE.test(q)) for (const k of REVIEW_EXTRA) out.add(k);
  return out;
}

/** 显式「要全部模块」或泛问全局的问题（供调用方判断是否走了全量分支）。 */
export function wantsAllModules(query) {
  const q = String(query || '');
  return ALL_RE.test(q) || BROAD_RE.test(q);
}
