// src/agent/context.js
// 学习数据上下文构建：把用户在本地库（IndexedDB）中的真实复习情况，
// 整理成一段结构化文本，注入到 Agent 的系统提示里，让 Agent “基于事实”而非泛泛而谈。
// 这是“数据感知型 Agent”的核心：所有分析/建议类 Agent 都依赖它。

import { getStats, weakCards, getReviewSuggestion, getTags } from '../repo.js';

function tagCountsStr(tags) {
  if (!tags || !tags.length) return '';
  return tags.slice(0, 20).map((t) => `${t.name}(${t.count}张)`).join('，');
}

/**
 * 构建用户学习数据上下文文本。
 * @returns {Promise<string>}
 */
export async function buildStudyContext() {
  const [stats, weak, suggestion, tags] = await Promise.all([
    getStats(),
    weakCards(40, 1),
    getReviewSuggestion(),
    getTags(),
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
          `${i + 1}.[${c.subject || '未分类'}${c.marked ? '·错题' : ''}${c.wrongReason ? '·' + c.wrongReason : ''}] ${String(c.front).replace(/\s+/g, ' ').slice(0, 30)}（遗忘${c.failCount}次）`,
      )
      .join('；');
    L.push(`- 薄弱/错题卡片（按遗忘次数排序）：${top}`);
  }
  return L.join('\n');
}

/**
 * 构建可供工具调用的“结构化上下文对象”（供 Agent 在 ReAct 循环中按需取用，
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
