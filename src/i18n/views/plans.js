// src/i18n/views/plans.js
// 学习计划视图（Plans.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.plans / en.views.plans。
// 模板中的 <b> 强调与动态计数（{n}/{name}/{count}/{reviewed}/{total}/{pct}/{pomo}/{tag}/{title}/{msg}）保留占位符，字典只存纯文本。
export const zh = {
  // ——— 顶部栏 / 加载 ———
  loading: '加载中…',
  title: '学习计划',
  autoGenerate: '一键自动编排',
  genLoading: '生成中…',
  autoGenTitle: '基于你的复习数据自动生成阶段化计划草稿',
  newPlanBtn: '＋ 新建计划',

  // ——— 自动编排元信息 ———
  focusPrefix: '重点：',
  focusAll: '综合',
  dailyLoad: '每日负载：约 {n} 张',
  riskCount: '遗忘风险：{n} 张',
  weakCount: '高频错题：{n} 张',
  graphEdges: '图驱动：用 {n} 条边',

  // ——— 空态 ———
  emptyTitle: '还没有计划',
  emptyMsg: '可在此手动创建，或在「Agent 工作台」让「复习计划编排师」帮你生成并保存',
  selectPlanTitle: '选择左侧计划',
  selectPlanMsg: '查看详情，或点「＋ 新建计划」开始制定',

  // ——— 状态徽标 / 按钮 ———
  statusActive: '进行中',
  statusDone: '已完成',
  statusArchived: '已归档',
  chipDone: '完成',
  chipArchived: '归档',
  linkBtn: '🔗 联动',
  linkBtnTitle: '关联卡片/番茄，开启自动进度',
  editBtn: '编辑',
  deleteBtn: '删除',

  // ——— 详情区进度 ———
  reviewProgress: '复习进度',
  progressCount: '{reviewed} / {total} 张 · {pct}%',
  pomoMinutes: '· 番茄 {n} 分钟',
  noContent: '（无内容）',

  // ——— 新建/编辑弹窗 ———
  modalNewTitle: '新建计划',
  modalEditTitle: '编辑计划',
  fieldTitle: '标题',
  titlePlaceholder: '如：408 冲刺复习计划',
  fieldContent: '内容（支持 Markdown）',
  contentPlaceholder: '分阶段目标 / 每日任务 / 里程碑…',
  fieldStatus: '状态',
  cancelBtn: '取消',
  saveBtn: '保存',

  // ——— 联动弹窗 ———
  linkTitle: '🔗 计划联动设置',
  linkHint: '关联卡片后，复习该卡片时自动更新计划进度；关联番茄后，番茄会话也计入计划。',
  linkOn: '联动已开启',
  linkOnProgress: '· 复习 {reviewed}/{total} 张 · 番茄 {pomo} 分钟',
  linkSubjectLabel: '按科目关联卡片',
  selectSubject: '选择科目',
  subjectCount: '{name}（{count} 张）',
  linkBtn2: '关联',
  quickLinkLabel: '快捷关联',
  linkDueBtn: '关联今日到期卡',
  linkDueTitle: '把当前所有到期卡片关联到这个计划',
  pomoLinkBtn: '🔗 番茄联动',
  pomoLinkTitle: '开启番茄联动，在番茄页选此 tag 即可',
  closeBtn: '关闭',
  refreshBtn: '🔄 刷新进度',

  // ——— 天数选项（optDays） ———
  optDays: '{n} 天',

  // ——— <script> toast / confirm ———
  pleaseSelectSubject: '请选择科目',
  noCardsInSubject: '该科目下没有卡片',
  linkedCards: '已关联 {n} 张卡片（{subject}）',
  linkFail: '关联失败：{msg}',
  noDueCards: '当前没有到期卡片',
  linkedDueCards: '已关联 {n} 张到期卡片（复习联动已开启）',
  pomoLinkOn: '已开启番茄联动，tag: {tag}（在番茄页选此 tag 即可联动）',
  refreshProgress: '进度刷新：复习 {reviewed}/{total} 张{pomo}',
  titleOrContentEmpty: '标题或内容不能都为空',
  planUpdated: '计划已更新',
  planCreated: '计划已创建',
  saveFail: '保存失败：{msg}',
  confirmDelete: '删除这个计划？',
  autoPlanSaved: '已生成并保存「{title}」',
  genFail: '生成失败：{msg}',
};

export const en = {
  // ——— top bar / loading ———
  loading: 'Loading…',
  title: 'Study Plans',
  autoGenerate: 'Auto-schedule',
  genLoading: 'Generating…',
  autoGenTitle: 'Auto-generate a phased plan draft from your review data',
  newPlanBtn: '＋ New Plan',

  // ——— auto-schedule meta ———
  focusPrefix: 'Focus: ',
  focusAll: 'Overall',
  dailyLoad: 'Daily load: ~{n} cards',
  riskCount: 'Forgetting risk: {n} cards',
  weakCount: 'Frequent mistakes: {n} cards',
  graphEdges: 'Graph-driven: {n} edges',

  // ——— empty states ———
  emptyTitle: 'No plans yet',
  emptyMsg: 'Create one manually here, or let the "Plan Scheduler" agent in the Agent Workbench generate and save one for you.',
  selectPlanTitle: 'Select a plan on the left',
  selectPlanMsg: 'View details, or click "＋ New Plan" to start.',

  // ——— status badges / buttons ———
  statusActive: 'Active',
  statusDone: 'Done',
  statusArchived: 'Archived',
  chipDone: 'Done',
  chipArchived: 'Archived',
  linkBtn: '🔗 Link',
  linkBtnTitle: 'Link cards/pomodoro to enable auto progress',
  editBtn: 'Edit',
  deleteBtn: 'Delete',

  // ——— detail progress ———
  reviewProgress: 'Review progress',
  progressCount: '{reviewed} / {total} cards · {pct}%',
  pomoMinutes: '· Pomodoro {n} min',
  noContent: '(No content)',

  // ——— new/edit modal ———
  modalNewTitle: 'New Plan',
  modalEditTitle: 'Edit Plan',
  fieldTitle: 'Title',
  titlePlaceholder: 'e.g. 408 sprint review plan',
  fieldContent: 'Content (Markdown supported)',
  contentPlaceholder: 'Phase goals / daily tasks / milestones…',
  fieldStatus: 'Status',
  cancelBtn: 'Cancel',
  saveBtn: 'Save',

  // ——— linking modal ———
  linkTitle: '🔗 Plan linking',
  linkHint: 'After linking cards, reviewing them auto-updates plan progress; linked pomodoros also count toward the plan.',
  linkOn: 'Linking enabled',
  linkOnProgress: '· Reviewed {reviewed}/{total} cards · Pomodoro {pomo} min',
  linkSubjectLabel: 'Link cards by subject',
  selectSubject: 'Select subject',
  subjectCount: '{name} ({count} cards)',
  linkBtn2: 'Link',
  quickLinkLabel: 'Quick link',
  linkDueBtn: "Link today's due cards",
  linkDueTitle: 'Link all currently due cards to this plan',
  pomoLinkBtn: '🔗 Pomodoro link',
  pomoLinkTitle: 'Enable pomodoro linking; pick this tag on the Pomodoro page',
  closeBtn: 'Close',
  refreshBtn: '🔄 Refresh progress',

  // ——— day options (optDays) ———
  optDays: '{n} days',

  // ——— <script> toast / confirm ———
  pleaseSelectSubject: 'Please select a subject',
  noCardsInSubject: 'No cards under this subject',
  linkedCards: 'Linked {n} cards ({subject})',
  linkFail: 'Linking failed: {msg}',
  noDueCards: 'No due cards right now',
  linkedDueCards: 'Linked {n} due cards (review linking on)',
  pomoLinkOn: 'Pomodoro linking on, tag: {tag} (pick this tag on the Pomodoro page to link)',
  refreshProgress: 'Progress refreshed: reviewed {reviewed}/{total} cards{pomo}',
  titleOrContentEmpty: 'Title and content cannot both be empty',
  planUpdated: 'Plan updated',
  planCreated: 'Plan created',
  saveFail: 'Save failed: {msg}',
  confirmDelete: 'Delete this plan?',
  autoPlanSaved: 'Generated and saved "{title}"',
  genFail: 'Generation failed: {msg}',
};
