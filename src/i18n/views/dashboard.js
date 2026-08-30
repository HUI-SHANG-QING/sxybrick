// src/i18n/views/dashboard.js
// 仪表盘视图（Dashboard.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.dashboard / en.views.dashboard。
// 模板中的动态计数（{v}/{count}/{n}/{key}/{subject}）保留在模板里，字典只存含占位符的纯文本。
export const zh = {
  // ——— Hero：今日聚焦 ———
  dueLabel: '今日待复习',
  startReview: '开始复习',
  startReviewNone: '今日无到期，去复习',
  doneLabel: '今日已复习',
  masteryLabel: '平均掌握度',
  pomoLabel: '今日番茄',

  // ——— AI 教练 ———
  coachBadge: '🤖 AI 教练',
  coachAnalyzing: '分析中…',
  coachGet: '点此获取今日建议',

  // ——— 数字资产网格 ———
  assetsTitle: '数字资产总览',
  assetCards: '🗂️ 卡片',
  assetWeak: '⚠️ 薄弱',
  assetPlans: '📋 计划',
  assetMindmap: '🗺️ 导图',
  assetGraph: '🔗 图谱边',
  assetDocs: '📄 文档',
  assetExam: '📝 模考',
  assetAch: '🏆 成就',

  // ——— 能力四维 ———
  abilityTitle: '能力四维',
  abilityMastery: '掌握度',
  abilityCorrect: '正确率',
  abilityStable: '稳定度',
  abilityCoverage: '覆盖率',

  // ——— 近 14 天趋势 ———
  trendTitle: '近 14 天复习趋势',
  trendTip: '复习 {v} 张',

  // ——— 365 天热力图 ———
  heatTitle: '复习热力图（近一年）',
  heatCellTitle: '{key}：复习 {count} 张',
  heatLess: '少',
  heatMore: '多',

  // ——— 各科掌握度 ———
  masteryBySubject: '各科掌握度',
  subjectTitle: '查看该科目所有卡片：{subject}',
  reviewsUnit: '次',

  // ——— 薄弱点 ———
  emptyMasteryTitle: '还没有复习数据',
  emptyMasteryMsg: '开始复习后这里会显示各科掌握度',
  weakTitle: '薄弱点 TOP3',
  weakTitleTip: '查看并编辑该卡',
  weakFail: '错 {n} 次',
  emptyWeakTitle: '暂无薄弱点',
  emptyWeakMsg: '保持节奏，薄弱点会自动出现在这里',

  // ——— 进行中计划 ———
  plansTitle: '进行中计划',
  planTitleTip: '打开该计划',
  emptyPlanTitle: '无进行中计划',
  emptyPlanMsg: '去「计划」页制定今日学习目标',

  // ——— <script> 中的 toast 消息 ———
  toastFillKey: '请先在「AI 设置」填密钥',
  coachFail: '教练建议获取失败：',
};

export const en = {
  // ——— Hero：今日聚焦 ———
  dueLabel: 'Due today',
  startReview: 'Start review',
  startReviewNone: 'Nothing due — review anyway',
  doneLabel: 'Reviewed today',
  masteryLabel: 'Avg mastery',
  pomoLabel: 'Pomodoros today',

  // ——— AI 教练 ———
  coachBadge: '🤖 AI Coach',
  coachAnalyzing: 'Analyzing…',
  coachGet: 'Get today’s tips',

  // ——— 数字资产网格 ———
  assetsTitle: 'Digital assets overview',
  assetCards: '🗂️ Cards',
  assetWeak: '⚠️ Weak',
  assetPlans: '📋 Plans',
  assetMindmap: '🗺️ Mindmaps',
  assetGraph: '🔗 Graph edges',
  assetDocs: '📄 Docs',
  assetExam: '📝 Exams',
  assetAch: '🏆 Awards',

  // ——— 能力四维 ———
  abilityTitle: 'Ability (4 dimensions)',
  abilityMastery: 'Mastery',
  abilityCorrect: 'Correct rate',
  abilityStable: 'Stability',
  abilityCoverage: 'Coverage',

  // ——— 近 14 天趋势 ———
  trendTitle: 'Review trend (last 14 days)',
  trendTip: 'reviewed {v} cards',

  // ——— 365 天热力图 ———
  heatTitle: 'Review heatmap (last year)',
  heatCellTitle: '{key}: reviewed {count} cards',
  heatLess: 'Less',
  heatMore: 'More',

  // ——— 各科掌握度 ———
  masteryBySubject: 'Mastery by subject',
  subjectTitle: 'View all cards in {subject}',
  reviewsUnit: 'reviews',

  // ——— 薄弱点 ———
  emptyMasteryTitle: 'No review data yet',
  emptyMasteryMsg: 'Subject mastery shows here after you review',
  weakTitle: 'Top 3 weak points',
  weakTitleTip: 'View & edit this card',
  weakFail: '{n} wrong',
  emptyWeakTitle: 'No weak points yet',
  emptyWeakMsg: 'Keep the pace; weak points appear here automatically',

  // ——— 进行中计划 ———
  plansTitle: 'Active plans',
  planTitleTip: 'Open this plan',
  emptyPlanTitle: 'No active plans',
  emptyPlanMsg: 'Go to Plans to set today’s goals',

  // ——— <script> 中的 toast 消息 ———
  toastFillKey: 'Please fill in your AI key in AI Settings first',
  coachFail: 'Failed to get coach advice: ',
};
