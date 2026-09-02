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
  // P2-B：单词模块维度（wordCards / wordReviews / wordCheckins 接入成就体系）
  { key: 'words_20', icon: '🔤', name: '词海拾贝', desc: '单词本累计 20 个词条', goal: 20, value: s => s.words, category: '单词' },
  { key: 'words_100', icon: '📚', name: '百词斩', desc: '单词本累计 100 个词条', goal: 100, value: s => s.words, category: '单词' },
  { key: 'word_reviews_50', icon: '✏️', name: '勤记单词', desc: '累计背单词 50 次', goal: 50, value: s => s.wordReviews, category: '单词' },
  { key: 'word_streak_7', icon: '🗓️', name: '单词七日连击', desc: '单词连续打卡 7 天', goal: 7, value: s => s.wordStreak, category: '单词' },
];

// 汇总成就判定所需的全部本地数据（只读）
export async function collectAchievementStats() {
  const reviews = await db.reviews.toArray();
  const total = reviews.length || 1;
  const correct = reviews.filter(r => r.rating === 2).length;
  const earlyCount = reviews.filter(r => { const h = new Date(r.reviewedAt).getHours(); return h >= 5 && h < 9; }).length;
  const [cards, pomo, docs, plans, graphEdges, aiMemories, aiChats, mindmaps, reports] = await Promise.all([
    db.cards.count(),
    // round18 R18-6：番茄成就只认「完整番茄」——未跑满的 partial 会话不入数，
    // 否则开 2 分钟关页也能刷出 pomo_1/pomo_50。
    db.pomoSessions.toArray().then((arr) => arr.filter((s) => !s.partial).length),
    db.docs.count(), db.plans.toArray(),
    db.graphEdges.count(), db.aiMemories.count(), db.aiChats.toArray(),
    db.mindmaps.count(), db.weeklyReports.count(),
  ]);
  // P2-B：单词模块维度（表缺失/异常时按 0 处理，不阻断成就页——旧库升级过渡期安全）
  let words = 0; let wordReviews = 0; let wordCheckins = [];
  try {
    [words, wordReviews, wordCheckins] = await Promise.all([
      db.wordCards.count(), db.wordReviews.count(), db.wordCheckins.toArray(),
    ]);
  } catch { /* 单词表不可用：跳过单词成就 */ }
  // P2-B：单词连续签到天数（与 word-repo 的 wordCheckinStreak 同逻辑，避免重依赖）
  let wordStreak = 0;
  try {
    const set = new Set(wordCheckins.map(r => r.date));
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!set.has(today)) d.setDate(d.getDate() - 1);
    while (set.has(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)) {
      wordStreak++;
      d.setDate(d.getDate() - 1);
    }
  } catch { wordStreak = 0; }
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
    words, wordReviews, wordStreak,
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