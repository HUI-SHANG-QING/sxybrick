// src/i18n/views/cardGroups.js
// 卡组管理视图（CardGroups.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.cardGroups / en.views.cardGroups。
// 仅外置静态 UI 文案；带动态值（卡组名 {name}）的用占位符，调用端传 params 插值。
export const zh = {
  // —— 模板：标题 / 说明 / 按钮 ——
  title: '卡组',
  hint: '把卡片分到不同卡组（可多组）；「备用」卡组暂停背诵，随时恢复。卡片学习数据全局共享，分组不影响复习进度。',
  addGroup: '＋ 新建卡组',

  // —— 模板：新建/编辑表单 ——
  nameLabel: '名称 *',
  namePlaceholder: '如：数二 · 高数',
  descLabel: '描述（可选）',
  descPlaceholder: '如：2027 考研数二',
  colorLabel: '颜色',
  statusLabel: '状态',
  statusActive: '背诵中',
  statusArchived: '备用（暂停）',
  create: '创建',
  save: '保存',
  cancel: '取消',

  // —— 模板：列表 / 空状态 ——
  loading: '加载中…',
  emptyTitle: '还没有卡组。创建一个卡组，把卡片按「科目/模块/考试」分组管理。',
  archivedChip: '备用',
  collapse: '收起 ▲',
  cardsToggle: '卡片 ▼',
  edit: '编辑',
  toArchivedBtn: '转备用',
  restoreBtn: '恢复',
  delete: '删除',
  emptyCards: '组内还没有卡片——到「卡片」页多选后移入此组，或编辑卡片时添加。',
  editTip: '点击编辑',
  moveOut: '移出',

  // —— <script> 中的 toast / confirmDialog 文案 ——
  created: '卡组已创建',
  updated: '卡组已更新',
  saveFailed: '保存失败',
  toArchivedToast: '「{name}」已转备用（组内卡不进默认复习）',
  restoreToast: '「{name}」已恢复背诵',
  confirmDelete: '删除卡组「{name}」？组内卡片本身不会被删除，仅解除关联。',
  deleted: '卡组已删除',
  movedOut: '已从「{name}」移出',
};

export const en = {
  title: 'Decks',
  hint: 'Group cards into different decks (multi-group); "standby" decks pause review and can be resumed anytime. Card learning data is shared globally — grouping does not affect review progress.',
  addGroup: '+ New deck',

  nameLabel: 'Name *',
  namePlaceholder: 'e.g. Math II · Advanced Math',
  descLabel: 'Description (optional)',
  descPlaceholder: 'e.g. 2027 Grad-entry Math II',
  colorLabel: 'Color',
  statusLabel: 'Status',
  statusActive: 'Studying',
  statusArchived: 'Standby (paused)',
  create: 'Create',
  save: 'Save',
  cancel: 'Cancel',

  loading: 'Loading…',
  emptyTitle: 'No decks yet. Create a deck and group cards by subject / module / exam.',
  archivedChip: 'Standby',
  collapse: 'Collapse ▲',
  cardsToggle: 'Cards ▼',
  edit: 'Edit',
  toArchivedBtn: 'To standby',
  restoreBtn: 'Resume',
  delete: 'Delete',
  emptyCards: 'No cards in this deck yet — multi-select cards in the Cards page and move them in, or add them when editing a card.',
  editTip: 'Click to edit',
  moveOut: 'Move out',

  created: 'Deck created',
  updated: 'Deck updated',
  saveFailed: 'Save failed',
  toArchivedToast: '"{name}" moved to standby (its cards skip the default review queue)',
  restoreToast: '"{name}" resumed for review',
  confirmDelete: 'Delete deck "{name}"? The cards themselves are not deleted, only unlinked.',
  deleted: 'Deck deleted',
  movedOut: 'Moved out of "{name}"',
};
