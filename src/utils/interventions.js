/**
 * 监督力干预策略（配置中心 + 工具函数）
 *
 * 设计原则（来自 Kirchner-Krath 2025 / Lee 2024 研究）：
 *  1. **默认关闭**：所有监督功能（损失条/紧迫感弹窗/承诺）全部默认关闭，Settings 主动开启
 *  2. **量化损失**：损失条 + 弹窗不允许「温馨提示」语气，必须给真实数字
 *  3. **自我承诺**：强制反思写一句话（≥10 字）后才能关闭（对标社会问责——let the past self see）
 *  4. **不打扰节奏**：阈值不能太小（防推送疲劳）
 *
 * 配置存在 localStorage 'sx_intervention_cfg' 中，结构：
 *  {
 *    enabled: false,             // 总开关
 *    lossBar: true,              // 顶部损失条
 *    hardModal: false,           // 紧迫感弹窗（不可关闭 + 强制反思）
 *    requireReflection: true,    // 弹窗是否强制写承诺
 *    dormantDaysTrigger: 2,      // 连续 N 天未启动触发
 *    dueCountTrigger: 30,        // 累计 due 超 N 触发
 *    daysToExam: 90,             // 距考试天数
 *    weekGoal: 100,              // 本周复习目标
 *  }
 */

const STORAGE_KEY = 'sx_intervention_cfg';
export const DEFAULT_CFG = Object.freeze({
  enabled: false,
  lossBar: true,
  hardModal: false,
  requireReflection: true,
  dormantDaysTrigger: 2,
  dueCountTrigger: 30,
  daysToExam: 90,
  weekGoal: 100,
});

/** 读取配置（返回深拷贝防止外部污染） */
export function getInterventionCfg() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CFG };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CFG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CFG, ...parsed };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

/** 持久化配置 */
export function setInterventionCfg(cfg) {
  if (typeof localStorage === 'undefined') return cfg;
  const merged = { ...DEFAULT_CFG, ...cfg };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * 综合 stats 收集入口：把 cards/reviews 等原始数据归一为 stats 对象
 * 调用方必须在浏览器侧（依赖 db）—— 这是上层 UI 工具，不是纯函数。
 *
 * 输入数据：
 *  - cards: listCards() 结果
 *  - lastReviewMs: 最近一次 review 时间戳
 *  - nowMs: 当前时间戳（可注入，便于测试）
 */
export async function aggregateInterventionStats({ listCards, listReviews, lastStudyMs = 0, daysToExam = 90, weekGoal = 100, nowMs = Date.now() }) {
  // 默认统计：累计 due / overdue / 距离上次 / 本周复习数
  const cards = listCards ? await listCards() : [];
  // dueCount / overdueCount —— 调用方通常会传解析好的；这里默认行为：
  const dueCount = cards.filter(c => c?.dueAt && c.dueAt <= nowMs).length;
  const overdueCount = cards.filter(c => c?.dueAt && c.dueAt <= nowMs - 86400000).length;

  const daysSinceStudy = lastStudyMs
    ? Math.max(0, Math.floor((nowMs - lastStudyMs) / 86400000))
    : Infinity;

  // 本周复习数（reviews 表 / last 7 days）
  const reviews = listReviews ? await listReviews() : [];
  const weekAgo = nowMs - 7 * 86400000;
  const weekReviews = reviews.filter(r => r?.reviewedAt && r.reviewedAt >= weekAgo).length;

  return {
    dueCount,
    overdueCount,
    daysSinceStudy,
    weekReviews,
    weekGoal,
    daysToExam,
    subject: '',
  };
}
