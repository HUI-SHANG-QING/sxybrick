// 成就体系（借鉴 Progress AI 的本地化实现）
// 全部基于本地数据即时判定：无后端、无定时任务，进入成就页时评估一次，
// 把新解锁的成就落库（id 确定性 ach-<key>，随数据包同步，跨设备幂等）。
import { db } from './db.js';
import { getStreak } from './utils/streak.js';

// 成就目录：value(input) 返回当前数值，>= goal 即解锁
// category：用于"学习成长树"按枝分组（P4 可视化）
export const ACHIEVEMENTS = [
  { key: 'first_card', icon: '🗂️', name: '初次建卡', desc: '创建第一张记忆卡片', goal: 1, value: s => s.cards, category: '建卡' },
  { key: 'cards_100', icon: '🃏', name: '百卡斩', desc: '卡片数量达到 100 张', goal: 100, value: s => s.cards, category: '建卡' },
  { key: 'cards_1000', icon: '👑', name: '千卡之王', desc: '卡片数量达到 1000 张', goal: 1000, value: s => s.cards, category: '建卡' },
  { key: 'first_review', icon: '📖', name: '开卷有益', desc: '完成第一次复习', goal: 1, value: s => s.reviews, category: '复习' },
  { key: 'reviews_100', icon: '⚡', name: '百练成钢', desc: '累计复习 100 次', goal: 100, value: s => s.reviews, category: '复习' },
  { key: 'reviews_1000', icon: '🔥', name: '千锤百炼', desc: '累计复习 1000 次', goal: 1000, value: s => s.reviews, category: '复习' },
  { key: 'streak_7', icon: '💪', name: '七日连击', desc: '连续打卡 7 天', goal: 7, value: s => s.streak, category: '打卡' },
  { key: 'accuracy_90', icon: '🎯', name: '精准记忆', desc: '复习正确率达到 90%（至少复习 20 次）', goal: 90, value: s => s.correctRate, category: '复习' },
  { key: 'pomo_1', icon: '🍅', name: '番茄初体验', desc: '完成第一个番茄钟', goal: 1, value: s => s.pomo, category: '专注' },
  { key: 'pomo_50', icon: '⏱️', name: '番茄农场主', desc: '累计完成 50 个番茄钟', goal: 50, value: s => s.pomo, category: '专注' },
  { key: 'graph_10', icon: '🕸️', name: '连线达人', desc: '知识图谱保存 10 条关联', goal: 10, value: s => s.graphEdges, category: '图谱' },
  { key: 'docs_5', icon: '✍️', name: '笔耕不辍', desc: '创建 5 篇 AI 文档', goal: 5, value: s => s.docs, category: '文档' },
  { key: 'plan_done_3', icon: '✅', name: '说到做到', desc: '完成 3 个学习计划', goal: 3, value: s => s.plansDone, category: '计划' },
  { key: 'memory_10', icon: '🧠', name: '记忆之库', desc: 'Agent 记住你的 10 条信息', goal: 10, value: s => s.aiMemories, category: '记忆' },
  { key: 'feynman_1', icon: '👨‍🏫', name: '费曼学徒', desc: '完成一次费曼练习', goal: 1, value: s => s.feynman, category: '费曼' },
  { key: 'mindmap_1', icon: '🗺️', name: '导图师', desc: '创建第一张思维导图', goal: 1, value: s => s.mindmaps, category: '导图' },
  { key: 'report_1', icon: '📈', name: '复盘者', desc: '生成第一份每周学习报告', goal: 1, value: s => s.reports, category: '复盘' },
];

// 汇总成就判定所需的全部本地数据（只读）
export async function collectAchievementStats() {
  const reviews = await db.reviews.toArray();
  const total = reviews.length || 1;
  const correct = reviews.filter(r => r.rating === 2).length;
  const earlyCount = reviews.filter(r => { const h = new Date(r.reviewedAt).getHours(); return h >= 5 && h < 9; }).length;
  const [cards, pomo, docs, plans, graphEdges, aiMemories, aiChats, mindmaps, reports] = await Promise.all([
    db.cards.count(), db.pomoSessions.count(), db.docs.count(), db.plans.toArray(),
    db.graphEdges.count(), db.aiMemories.count(), db.aiChats.toArray(),
    db.mindmaps.count(), db.weeklyReports.count(),
  ]);
  return {
    cards,
    reviews: reviews.length,
    correctRate: reviews.length >= 20 ? Math.round((correct / total) * 100) : 0, // 复习不足 20 次不给正确率成就
    streak: await getStreak(),
    pomo,
    pomoMinutes: 0,
    docs,
    plansDone: plans.filter(p => p.status === 'done').length,
    graphEdges,
    aiMemories,
    feynman: aiChats.filter(c => c.type === 'feynman').length,
    mindmaps,
    reports,
    earlyBird: earlyCount,
  };
}

// 评估全部成就：返回含进度与解锁状态
export async function evaluateAchievements() {
  const stats = await collectAchievementStats();
  const rows = await db.achievements.toArray();
  const unlockedMap = new Map(rows.map(r => [r.key, r.unlockedAt]));
  return ACHIEVEMENTS.map(a => {
    const value = a.value(stats);
    return {
      ...a,
      value: typeof value === 'number' ? Math.round(value * 100) / 100 : 0,
      progress: Math.min(1, value / a.goal),
      unlocked: unlockedMap.has(a.key),
      unlockedAt: unlockedMap.get(a.key) || 0,
    };
  });
}