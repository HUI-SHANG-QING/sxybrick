// src/i18n/views/weeklyReport.js
// 每周报告视图（WeeklyReport.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.weeklyReport / en.views.weeklyReport。
// 仅外置静态 UI 文案；动态计数（{n}）与报告标题/分类名等动态值通过 {title}/{msg} 占位。
export const zh = {
  loading: '加载中…',
  title: '每周报告',
  prevWeek: '← 上一周',
  nextWeek: '下一周 →',
  hint: '自动汇总本周学习数据；点「AI 生成总结」让 AI 点评并给建议，保存后可随时回看。',
  emptyHistoryTitle: '还没有周报存档',
  emptyHistoryMsg: '选好周、点「保存周报」即可归档',
  deleteLink: '删',
  statReviews: '本周复习次数',
  statReviewedCards: '涉及卡片',
  statCorrectRate: '正确率',
  statNewCards: '新建卡片',
  statPomo: '番茄（{n} 分钟）',
  statDocs: '新文档',
  statPlansDone: '完成计划',
  statFeynman: '费曼练习',
  topSubjectsPrefix: '复习最多：',
  aiSummaryLabel: 'AI 总结（可手动编辑）',
  aiGenerating: 'AI 生成中…',
  aiGenerate: 'AI 生成总结',
  saveReport: '保存周报',
  summaryPlaceholder: '点「AI 生成总结」，或自己写一段本周复盘…',
  emptyWeekTitle: '这一周还没有学习记录',
  emptyWeekMsg: '前后翻周看看，或开始今天的学习',

  // ——— <script> 中的 toast / confirmDialog 消息 ———
  aiKeyMissing: '请先在「AI 设置」里填入密钥',
  aiSummaryGenerated: 'AI 总结已生成，可编辑后再保存',
  aiGenerateFail: '生成失败：{msg}',
  savedToast: '周报已保存（可跨设备同步）',
  confirmDelete: '删除「{title}」？',

  // ——— 数据中出现的可见文案（聚合兜底分类名 / 报告标题后缀） ———
  uncategorized: '未分类',
  reportTitleSuffix: '学习周报',
};

export const en = {
  loading: 'Loading…',
  title: 'Weekly Report',
  prevWeek: '← Previous week',
  nextWeek: 'Next week →',
  hint: 'Auto-summarizes this week’s study data; click "AI Generate Summary" to let AI comment and suggest, then save to review anytime.',
  emptyHistoryTitle: 'No weekly reports archived yet',
  emptyHistoryMsg: 'Pick a week and click "Save Report" to archive it.',
  deleteLink: 'Del',
  statReviews: 'Reviews this week',
  statReviewedCards: 'Cards involved',
  statCorrectRate: 'Accuracy',
  statNewCards: 'New cards',
  statPomo: 'Pomodoro ({n} min)',
  statDocs: 'New docs',
  statPlansDone: 'Plans done',
  statFeynman: 'Feynman practices',
  topSubjectsPrefix: 'Most reviewed: ',
  aiSummaryLabel: 'AI Summary (editable)',
  aiGenerating: 'AI generating…',
  aiGenerate: 'AI Generate Summary',
  saveReport: 'Save Report',
  summaryPlaceholder: 'Click "AI Generate Summary", or write your own weekly review…',
  emptyWeekTitle: 'No study records this week',
  emptyWeekMsg: 'Flip through nearby weeks, or start today’s study.',

  aiKeyMissing: 'Please fill in the API key in "AI Settings" first.',
  aiSummaryGenerated: 'AI summary generated; you can edit before saving.',
  aiGenerateFail: 'Generation failed: {msg}',
  savedToast: 'Weekly report saved (syncs across devices)',
  confirmDelete: 'Delete "{title}"?',

  uncategorized: 'Uncategorized',
  reportTitleSuffix: 'Study Weekly Report',
};
