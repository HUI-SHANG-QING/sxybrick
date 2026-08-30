// src/i18n/views/achievements.js
// 成就视图（Achievements.vue）的 zh/en 字典片段。
// 成就名称/描述/分类（a.name/a.desc/a.category）来自 achievements.js 数据，不在此翻译。
export const zh = {
  title: '成就',
  checking: '评估中…',
  unlockedN: '已解锁 {n} / {total}',
  reevaluate: '重新评估',
  hint: '跟着你的学习足迹自动解锁：建卡、复习、打卡、专注、图谱、文档、计划……成就数据保存在本机并跨设备同步。',
  treeTitle: '🌳 学习成长树',
  trunkHint: '主干高度 = 总解锁进度 {n}%',
  collapse: '收起',
  expand: '展开',
  treeHint: '每条枝代表一个学习维度，结出果实 = 该类已有成就解锁；主干越高 = 整体成长越深。',
  unlockedAt: '解锁于 {date}',
  unlockedToast: '🎉 解锁新成就：{names}',
};

export const en = {
  title: 'Achievements',
  checking: 'Evaluating…',
  unlockedN: 'Unlocked {n} / {total}',
  reevaluate: 'Re-evaluate',
  hint: 'Unlocks automatically as you study: creating cards, reviewing, check-ins, focus, graphs, docs, plans… Achievement data lives locally and syncs across devices.',
  treeTitle: '🌳 Learning Growth Tree',
  trunkHint: 'Trunk height = overall unlock progress {n}%',
  collapse: 'Collapse',
  expand: 'Expand',
  treeHint: 'Each branch is a learning dimension; fruit means that category has unlocked achievements. Taller trunk = deeper overall growth.',
  unlockedAt: 'Unlocked at {date}',
  unlockedToast: '🎉 New achievement unlocked: {names}',
};
