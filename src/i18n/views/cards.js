// src/i18n/views/cards.js
// 卡片管理视图（Cards.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.cards / en.views.cards。
// 仅外置静态 UI 文案；卡片正/背面、科目与标签名、来源、评级标签（gradeCard）、AI 提示词等数据不在此翻译。
export const zh = {
  // ---- 顶部工具条 ----
  title: '我的卡片',
  countHint: '共 {total} 张 · 今日待背 {due}',
  gotoReview: '专注背诵（{n}）→',
  weakSet: '错题集',
  bulkGroupBtn: '🎴 批量分组',
  batchCreate: '批量建卡',
  newCard: '＋ 新建卡',

  // ---- 导出格式说明 ----
  exportHintMd: '人类可读',
  exportHintCsv: 'Excel 可打开',
  exportHintJson: '可备份恢复',

  // ---- 打卡条 ----
  streakToday: '今日复习 {n} / {goal} 张',
  goalTitle: '每日目标（复习卡片数）',
  streakDays: '连续打卡 {n} 天',

  // ---- 遗忘预警 ----
  riskTitle: '⚠ 遗忘预警：这几张 3 天内将到期且历史表现不稳，趁没忘先巩固',
  riskMeta: '（错误率 {fail}% · 风险 {risk}%）',
  rescueBtn: '加入今日复习',
  rescueAllBtn: '全部加入今日复习',

  // ---- 今日复习提醒 ----
  suggestTitle: '今日复习提醒',
  suggestDue: '待背 {n} 张',
  suggestMarked: '· 错题 {n} 张',
  dueTop: '到期最多：',
  staleTop: '很久没复习：',
  staleDays: '{n}天',

  // ---- 筛选栏 ----
  viewLabel: '视图',
  viewScroll: '滚轮模式',
  viewPage: '分页模式',
  sortUpdated: '按更新时间',
  sortCreated: '按创建时间',
  sortDue: '按到期时间',
  sortSubject: '按科目',
  searchPlaceholder: '搜正面 / 背面内容…',
  saveCombo: '保存当前组合',
  subjectLabel: '科目',
  allSubjects: '全部科目',
  tagLabel: '标签',
  all: '全部',
  logicAnd: '交集 AND（同时含所选）',
  logicOr: '并集 OR（含任一）',
  logicNot: '差集 NOT（排除所选）',
  smartLabel: '智能卡组',
  smartNamePrompt: '给这个筛选组合起个名字：',
  smartDefaultName: '智能卡组',
  smartSaved: '已保存为智能卡组（本机偏好）',

  // ---- 批量建卡弹窗 ----
  modeManual: '手动分隔',
  modeAi: '🔬 AI 智能拆分',
  noAiKey: '⚠ 无 AI key，将降级段落拆分',
  manualHint1: '每行一张卡；用 |、→ 或 -> 分隔正面与背面。',
  manualHint2: '例：TCP 三次握手的过程？| 共 SYN / SYN-ACK / ACK 三步',
  aiHint1: '粘贴一段笔记/文档（无需分隔符），AI 自动识别知识点并生成问句式卡片。',
  aiHint2: '陈述句会被改写成提问，复习时检索强度更高。',
  batchSubjectLabel: '科目（可留空）',
  notSpecified: '不指定',
  parsedLabel: '内容（已解析 {n} 张）',
  batchPlaceholder: '粘贴知识点清单…',
  cancel: '取消',
  importing: '导入中…',
  importN: '导入 {n} 张',
  aiCountLabel: '目标卡片数',
  aiNoteLabel: '笔记内容',
  aiPlaceholder: '粘贴一段笔记或文档，AI 会自动拆成问句式卡片…',
  aiSplitting: 'AI 拆分中…',
  genPreview: '生成预览',

  // ---- 批量分组操作栏 ----
  selectAll: '全选',
  selectedN: '已选 {n} 张',
  noGroups: '（暂无卡组——到「卡组」页创建）',
  moveIn: '移入：',
  moveOut: '移出：',
  linkAnalysis: '🔗 联动分析',
  linkAnalysisTitle: '联动分析选中卡片（关系图谱/拓扑/关键路径/自由问答）',
  done: '完成',

  // ---- 卡片条目 ----
  typeCloze: '填空',
  typeChoice: '选择',
  typeWriting: '默写',
  forgotN: '遗忘{n}次',
  expandDetail: '展开详情',
  collapseDetail: '收起详情',
  expandDetailTitle: '展开完整详情',
  collapseDetailTitle: '收起完整详情',
  sourcePrefix: '来源：',
  frontLabel: '正面（问题）',
  backLabel: '背面（答案）',
  mnemonicPrefix: '助记：',
  empty: '（空）',
  mdCode: ' [代码] ',
  mdImage: ' [图片] ',
  mark: '标错题',
  unmark: '取消错题',
  edit: '编辑',
  generating: '生成中…',
  variant: '变式',
  diagnose: '诊断',
  history: '历史',
  del: '删除',

  // ---- 孤儿图片面板 ----
  orphanTitle: '孤儿图片（{n} 张）',
  orphanHint: '这些图片已无任何卡片 Markdown 引用，可直接删除释放本地空间。',
  cleanAll: '一键全部清理',
  noOrphan: '✅ 暂无需清理的孤儿图片。',

  // ---- 资产体检跳转 banner ----
  bannerUntagged: '🏷 显示「无标签卡」（从资产体检跳转而来）。可点卡片右上角的「编辑」补齐标签，或点「清理」回到资产体检。',
  bannerZombie: '🧟 显示「僵尸卡」共 {n} 张（90+ 天未复习且早已到期）。默认全展开详情，方便决定是否清理。',
  bannerDupAll: '♻ 显示「全部重复卡」共 {groups} 组 / {cards} 张（重复冗余 {dup} 张）。默认全展开详情对比后，可回到资产体检合并去重。',
  bannerDupGroup: '♻ 显示「重复卡组」共 {n} 张（正面：{front}…）。默认全展开详情对比后，可回到资产体检合并去重。',
  bannerOrphan: '🖼 显示「孤儿图片」共 {n} 张（已无卡片引用，可直接清理）。',
  backToHealth: '回到资产体检',
  clearFilter: '清空当前筛选',

  // ---- 空状态 ----
  emptyTitle: '还没有卡片',
  emptyMsg: '创建第一张记忆卡片，开始高效复习',
  newFirstCard: '＋ 新建第一张卡',

  // ---- 卡片预览层 ----
  previewTitle: '卡片预览（点击卡片翻面）',
  close: '关闭',
  linkedNotes: '关联笔记（{n}）',
  untitled: '（无标题）',
  copyRef: '📋 复制 [[c{id}]] 引用',

  // ---- 复习历史弹窗 ----
  historyTitle: '该卡复习历史',
  noHistoryTitle: '还没有复习记录',
  noHistoryMsg: '去「背诵」页复习后，这里会显示历史时间线',

  // ---- AI 诊断弹窗 ----
  diagTitle: 'AI 卡片诊断',
  diagLoading: 'AI 分析中…',
  diagFail: '（诊断失败：{msg}）',

  // ---- toast / confirm ----
  selectFirst: '请先勾选卡片',
  movedIn: '已移入卡组：{added} 张关联（{skipped} 跳过）',
  movedOut: '已移出卡组：解除 {n} 张关联',
  linkNeedTwo: '联动分析至少需要 2 张卡片',
  copied: '已复制 {text} 到剪贴板',
  copyFail: '复制失败，请手动选中',
  marked: '已加入错题集',
  unmarked: '已移出错题集',
  variantsDone: '已生成 {n} 张情境变式卡',
  variantsFail: '变式生成失败：{msg}',
  confirmDelete: '确定删除这张卡片？\n{front}',
  deleted: '已删除',
  orphanDeleted: '已删除 1 张孤儿图片',
  confirmCleanOrphans: '一次性清理 {n} 张孤儿图片？',
  orphansCleaned: '孤儿图片已全部清理',
  batchPasteFirst: '请先粘贴内容（每行一张卡）',
  batchCreated: '已批量创建 {n} 张卡片',
  aiPasteFirst: '请先粘贴笔记内容',
  aiTooShort: '内容太短（至少 20 字）',
  aiSplitDone: 'AI 已拆出 {n} 张卡片，预览后可导入',
  aiSplitFail: 'AI 拆分失败：{msg}',
  aiNoCards: '没有可导入的卡片',
  aiImported: '已导入 {n} 张 AI 生成的卡片',
  rescued: '已把「{front}…」加入今日复习',
  rescuedAll: '已把 {n} 张高危卡加入今日复习，去「背诵」页巩固',
};

export const en = {
  // ---- Top toolbar ----
  title: 'My Cards',
  countHint: '{total} cards · {due} due today',
  gotoReview: 'Focus review ({n}) →',
  weakSet: 'Mistakes',
  bulkGroupBtn: '🎴 Bulk deck',
  batchCreate: 'Bulk create',
  newCard: '＋ New card',

  // ---- Export format hints ----
  exportHintMd: 'Human readable',
  exportHintCsv: 'Opens in Excel',
  exportHintJson: 'Restorable backup',

  // ---- Streak bar ----
  streakToday: 'Reviewed today {n} / {goal}',
  goalTitle: 'Daily goal (cards reviewed)',
  streakDays: '{n}-day streak',

  // ---- Forget alert ----
  riskTitle: '⚠ Forget alert: these are due within 3 days and historically unstable — reinforce now',
  riskMeta: ' (error rate {fail}% · risk {risk}%)',
  rescueBtn: 'Add to today',
  rescueAllBtn: 'Add all to today',

  // ---- Today reminder ----
  suggestTitle: "Today's review reminder",
  suggestDue: '{n} due',
  suggestMarked: '· {n} mistakes',
  dueTop: 'Most due: ',
  staleTop: 'Not reviewed for long: ',
  staleDays: '{n}d',

  // ---- Filter bar ----
  viewLabel: 'View',
  viewScroll: 'Scroll',
  viewPage: 'Paged',
  sortUpdated: 'By updated time',
  sortCreated: 'By created time',
  sortDue: 'By due time',
  sortSubject: 'By subject',
  searchPlaceholder: 'Search front / back content…',
  saveCombo: 'Save current combo',
  subjectLabel: 'Subject',
  allSubjects: 'All subjects',
  tagLabel: 'Tags',
  all: 'All',
  logicAnd: 'AND (has all selected)',
  logicOr: 'OR (has any)',
  logicNot: 'NOT (exclude selected)',
  smartLabel: 'Smart decks',
  smartNamePrompt: 'Name this filter combo:',
  smartDefaultName: 'Smart deck',
  smartSaved: 'Saved as a smart deck (local preference)',

  // ---- Bulk-create modal ----
  modeManual: 'Manual split',
  modeAi: '🔬 AI split',
  noAiKey: '⚠ No AI key — falling back to paragraph split',
  manualHint1: 'One card per line; separate front and back with |, → or ->.',
  manualHint2: 'e.g. What are the steps of the TCP three-way handshake? | SYN / SYN-ACK / ACK',
  aiHint1: 'Paste notes or a document (no separators needed); AI extracts key points and writes question-style cards.',
  aiHint2: 'Statements are rewritten as questions, so retrieval is stronger during review.',
  batchSubjectLabel: 'Subject (optional)',
  notSpecified: 'Unspecified',
  parsedLabel: 'Content ({n} parsed)',
  batchPlaceholder: 'Paste a list of key points…',
  cancel: 'Cancel',
  importing: 'Importing…',
  importN: 'Import {n}',
  aiCountLabel: 'Target card count',
  aiNoteLabel: 'Note content',
  aiPlaceholder: 'Paste notes or a document; AI will split it into question-style cards…',
  aiSplitting: 'AI splitting…',
  genPreview: 'Generate preview',

  // ---- Bulk-deck action bar ----
  selectAll: 'Select all',
  selectedN: '{n} selected',
  noGroups: '(No decks yet — create one on the Decks page)',
  moveIn: 'Add to:',
  moveOut: 'Remove from:',
  linkAnalysis: '🔗 Link analysis',
  linkAnalysisTitle: 'Link-analyze the selected cards (graph / topology / critical path / free Q&A)',
  done: 'Done',

  // ---- Card item ----
  typeCloze: 'Cloze',
  typeChoice: 'Choice',
  typeWriting: 'Recite',
  forgotN: 'Forgot {n}×',
  expandDetail: 'Expand details',
  collapseDetail: 'Collapse details',
  expandDetailTitle: 'Expand full details',
  collapseDetailTitle: 'Collapse full details',
  sourcePrefix: 'Source: ',
  frontLabel: 'Front (question)',
  backLabel: 'Back (answer)',
  mnemonicPrefix: 'Mnemonic: ',
  empty: '(empty)',
  mdCode: ' [code] ',
  mdImage: ' [image] ',
  mark: 'Mark mistake',
  unmark: 'Unmark mistake',
  edit: 'Edit',
  generating: 'Generating…',
  variant: 'Variants',
  diagnose: 'Diagnose',
  history: 'History',
  del: 'Delete',

  // ---- Orphan images panel ----
  orphanTitle: 'Orphan images ({n})',
  orphanHint: 'These images are no longer referenced by any card Markdown — delete them to free local space.',
  cleanAll: 'Clean all',
  noOrphan: '✅ No orphan images to clean.',

  // ---- Asset-health jump banner ----
  bannerUntagged: '🏷 Showing untagged cards (jumped from the asset health check). Use "Edit" on a card to add tags, or go back to the health check to clean up.',
  bannerZombie: '🧟 Showing {n} zombie cards (not reviewed for 90+ days and long overdue). Details are expanded by default so you can decide what to clean.',
  bannerDupAll: '♻ Showing all duplicate cards: {groups} groups / {cards} cards ({dup} redundant). Details are expanded for comparison; go back to the health check to merge.',
  bannerDupGroup: '♻ Showing a duplicate group of {n} cards (front: {front}…). Details are expanded for comparison; go back to the health check to merge.',
  bannerOrphan: '🖼 Showing {n} orphan images (no card references them — safe to clean).',
  backToHealth: 'Back to health check',
  clearFilter: 'Clear current filters',

  // ---- Empty state ----
  emptyTitle: 'No cards yet',
  emptyMsg: 'Create your first memory card and start reviewing efficiently',
  newFirstCard: '＋ Create first card',

  // ---- Card preview layer ----
  previewTitle: 'Card preview (click the card to flip)',
  close: 'Close',
  linkedNotes: 'Linked notes ({n})',
  untitled: '(untitled)',
  copyRef: '📋 Copy [[c{id}]] reference',

  // ---- Review-history modal ----
  historyTitle: 'Review history of this card',
  noHistoryTitle: 'No review records yet',
  noHistoryMsg: 'After reviewing on the Review page, the timeline shows up here',

  // ---- AI diagnosis modal ----
  diagTitle: 'AI card diagnosis',
  diagLoading: 'AI analyzing…',
  diagFail: '(Diagnosis failed: {msg})',

  // ---- toast / confirm ----
  selectFirst: 'Select some cards first',
  movedIn: 'Added to deck: {added} links ({skipped} skipped)',
  movedOut: 'Removed from deck: {n} links dropped',
  linkNeedTwo: 'Link analysis needs at least 2 cards',
  copied: 'Copied {text} to clipboard',
  copyFail: 'Copy failed — please select manually',
  marked: 'Added to mistakes',
  unmarked: 'Removed from mistakes',
  variantsDone: 'Generated {n} contextual variant cards',
  variantsFail: 'Variant generation failed: {msg}',
  confirmDelete: 'Delete this card?\n{front}',
  deleted: 'Deleted',
  orphanDeleted: 'Deleted 1 orphan image',
  confirmCleanOrphans: 'Clean all {n} orphan images at once?',
  orphansCleaned: 'All orphan images cleaned',
  batchPasteFirst: 'Paste content first (one card per line)',
  batchCreated: 'Created {n} cards in bulk',
  aiPasteFirst: 'Paste note content first',
  aiTooShort: 'Content too short (at least 20 characters)',
  aiSplitDone: 'AI produced {n} cards — preview then import',
  aiSplitFail: 'AI split failed: {msg}',
  aiNoCards: 'No cards to import',
  aiImported: 'Imported {n} AI-generated cards',
  rescued: 'Added "{front}…" to today\'s review',
  rescuedAll: "Added {n} high-risk cards to today's review — reinforce on the Review page",
};
