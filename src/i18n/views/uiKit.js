// src/i18n/views/uiKit.js
// 组件库视图（UIKit.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.uiKit / en.views.uiKit。
// 仅外置「结构性 UI 文案」（区块标题、表单字段标签、占位符、表头、触发型按钮、
// 弹层标题/页脚、脚本中的 toast/ElMessage/ElNotification）。
// 本页为组件展示页，纯演示用的样例文案（如按钮上的"默认/主要"、单选"简单/困难"、
// 表格里的科目数据、标签/徽标/告警/步骤/头像浮层里的示例文本）刻意保留硬编码，
// 因其只是演示组件的占位内容，翻译无意义 —— 见迁移报告说明。
export const zh = {
  // —— 页头 ——
  title: '🧩 UI 组件库',
  titleHint: 'Element Plus × 主题桥接的活样本 —— 所有组件颜色均来自当前主题 token，切换到任意「风格 × 配色模式」会自动跟随。本页也用于验证桥接层是否"出戏"。',

  // —— 区块标题 ——
  secButton: '按钮 Button',
  secForm: '表单 Form',
  secFeedback: '反馈 Feedback',
  secData: '数据 Data',
  secNav: '导航与浮层 Navigation / Overlay',

  // —— 表单字段标签 ——
  fldInput: '输入框',
  fldInputIcon: '带图标',
  fldNumber: '数字',
  fldSelect: '下拉选择',
  fldDate: '日期',
  fldTime: '时间',
  fldSwitch: '开关',
  fldSlider: '滑杆',
  fldRadio: '单选',
  fldCheckbox: '多选',
  fldRate: '评分',
  fldTag: '标签输入',

  // —— 占位符 ——
  phInput: '请输入内容',
  phSearch: '搜索卡片',
  phSelect: '选择科目',
  phDate: '选择日期',
  phTime: '选择时间',
  phAddTag: '添加标签',

  // —— 表格 ——
  colSubject: '科目',
  colCards: '卡片数',
  colDue: '待复习',
  colRetention: '保持率',
  colAction: '操作',
  actReview: '复习',
  actArchive: '归档',

  // —— 反馈区触发按钮 ——
  btnSuccess: '成功提示',
  btnWarning: '警告提示',
  btnError: '错误提示',
  btnNotify: '系统通知',

  // —— 导航与浮层触发 ——
  btnTooltip: '悬浮提示',
  btnPopover: '点击弹出',
  btnDialog: '对话框',
  btnDrawer: '抽屉',
  btnAvatar: '头像弹出层',
  popoverOk: '知道了',

  // —— 对话框 ——
  dialogTitle: '主题桥接验证',
  dialogContent: '这个对话框的背景、文字、按钮颜色都来自当前主题 token。试试把风格切到「卡牌 / 王者 / 星际」，或切到「夜间 / 护眼」，再打开一次。',
  tagAuto: '自动跟随',
  tagNoHardcode: '无硬编码',
  btnCancel: '取消',
  btnConfirm: '确认',

  // —— 抽屉 ——
  drawerTitle: '复习抽屉',
  drawerContent: '抽屉同样跟随主题。里面可以放：今日待复习、错题 TOP、快捷入口。',
  emptyDone: '今日已完成全部复习 🎉',

  // —— a11y ——
  ariaSearch: '搜索',
  ariaRefresh: '刷新',

  // —— 脚本中的反馈消息（ElMessage / ElNotification） ——
  msgSuccessTitle: '操作成功',
  msgSuccessBody: '卡片已保存，下次复习已排期',
  msgWarningTitle: '注意',
  msgWarningBody: '今日还有 8 张卡片待复习',
  msgErrorTitle: '操作失败',
  msgErrorBody: '同步中断，请检查网络后重试',
  notifyTitle: '监督力提醒',
  notifyBody: '你已连续 3 天未达复习目标，损失进度：+8 张累积待复习。',

  // —— 动态 toast（含 {subject} 占位符） ——
  toastReview: '开始复习「{subject}」',
  toastArchive: '已归档「{subject}」',
};

export const en = {
  // —— Page head ——
  title: '🧩 UI Kit',
  titleHint: 'A live sample of the Element Plus × theme bridge — every component color comes from the current theme token and auto-follows any "style × color mode". This page also checks that the bridge layer stays "in character".',

  // —— Section titles ——
  secButton: 'Button',
  secForm: 'Form',
  secFeedback: 'Feedback',
  secData: 'Data',
  secNav: 'Navigation / Overlay',

  // —— Form field labels ——
  fldInput: 'Input',
  fldInputIcon: 'With icon',
  fldNumber: 'Number',
  fldSelect: 'Select',
  fldDate: 'Date',
  fldTime: 'Time',
  fldSwitch: 'Switch',
  fldSlider: 'Slider',
  fldRadio: 'Radio',
  fldCheckbox: 'Checkbox',
  fldRate: 'Rate',
  fldTag: 'Tag input',

  // —— Placeholders ——
  phInput: 'Please enter content',
  phSearch: 'Search cards',
  phSelect: 'Select subject',
  phDate: 'Select date',
  phTime: 'Select time',
  phAddTag: 'Add tag',

  // —— Table ——
  colSubject: 'Subject',
  colCards: 'Cards',
  colDue: 'Due',
  colRetention: 'Retention',
  colAction: 'Action',
  actReview: 'Review',
  actArchive: 'Archive',

  // —— Feedback trigger buttons ——
  btnSuccess: 'Success',
  btnWarning: 'Warning',
  btnError: 'Error',
  btnNotify: 'System notification',

  // —— Nav & overlay triggers ——
  btnTooltip: 'Hover tip',
  btnPopover: 'Click popover',
  btnDialog: 'Dialog',
  btnDrawer: 'Drawer',
  btnAvatar: 'Avatar popover',
  popoverOk: 'Got it',

  // —— Dialog ——
  dialogTitle: 'Theme bridge check',
  dialogContent: 'This dialog’s background, text, and button colors all come from the current theme token. Try switching the style to "Cards / King / Stellar", or to "Night / Eye-care", then open it again.',
  tagAuto: 'Auto-follow',
  tagNoHardcode: 'No hardcode',
  btnCancel: 'Cancel',
  btnConfirm: 'Confirm',

  // —— Drawer ——
  drawerTitle: 'Review drawer',
  drawerContent: 'The drawer also follows the theme. It can hold: today’s due, mistake TOP, quick entries.',
  emptyDone: 'All reviews done today 🎉',

  // —— a11y ——
  ariaSearch: 'Search',
  ariaRefresh: 'Refresh',

  // —— Script feedback messages (ElMessage / ElNotification) ——
  msgSuccessTitle: 'Success',
  msgSuccessBody: 'Card saved; next review scheduled',
  msgWarningTitle: 'Notice',
  msgWarningBody: '8 cards still due for review today',
  msgErrorTitle: 'Failed',
  msgErrorBody: 'Sync interrupted; please check the network and retry',
  notifyTitle: 'Supervision reminder',
  notifyBody: 'You’ve missed the review goal 3 days in a row; progress lost: +8 accumulated due cards.',

  // —— Dynamic toast (with {subject} placeholder) ——
  toastReview: 'Start review for "{subject}"',
  toastArchive: 'Archived "{subject}"',
};
