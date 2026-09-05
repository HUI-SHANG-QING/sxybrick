// src/i18n/views/cardLinkAnalysis.js
// 卡片联动分析视图（CardLinkAnalysis.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.cardLinkAnalysis / en.views.cardLinkAnalysis。
// 仅外置静态 UI 文案与用户可见分析标签；会话标题、卡组名、卡片内容、AI/引擎结果文本等
// DB 数据内容保留原样（见规则 9，不在此外置）。{n} 为动态计数占位符。
export const zh = {
  // ——— 页头 ———
  title: '🔗 卡片联动分析',
  subtitle: '预设一键分析 或 自由提问；本地模式离线可用，AI 模式失败自动降级。',
  modeAuto: '自动（有密钥用 AI）',
  modeLocal: '本地模式（离线）',
  modeAi: 'AI 模式',
  noAiKey: '未配置 AI 密钥',
  newSessionBtn: '＋ 新会话',

  // ——— 左侧：已选卡片 / 会话 ———
  selectedCards: '已选卡片（{n}）',
  addPlaceholder: '按内容搜卡加入…',
  removeTitle: '移除',
  emptyCardsHint: '从「卡片」页多选后点「联动分析」进入，或在上方搜索加入。',
  historySessions: '历史会话（同步）',
  deleteSessionTitle: '删除会话',
  noSessions: '暂无',

  // ——— 中间：对话 / 结果 ———
  busyHint: '分析中…（本地即时；AI 约 5-20s）',
  emptyHint: '点下方快捷按钮开始，或直接输入问题，例如：「这些卡片之间有什么联系？」「哪张是前置知识？」「帮我排个复习顺序」',
  roleYou: '🙋 你',
  roleAi: '🤖 AI',
  roleFallback: '🤖 本地(降级)',
  roleLocal: '🤖 本地',
  createGroupBtn: '🎴 按此顺序创建复习卡组',
  weak: '薄弱',
  cardsCount: '{n} 张卡',
  noContent: '(无内容)',

  // ——— 预设（key 与 PRESETS 的 key 对齐） ———
  presetPrefix: '预设：',
  preset: {
    graph: '🕸 关系图谱',
    topo: '🧭 拓扑排序',
    critical: '🎯 关键路径',
    common: '🔍 共同知识点',
    path: '📋 学习顺序',
    compare: '⚖️ 对比前两张',
  },

  // ——— 底部：输入 + 预设 ———
  askPlaceholder: '自由提问，例如：如果我要用这些卡片准备考试，应该先复习什么？',
  askBtn: '提问',

  // ——— toast / 提示 ———
  toastNoMatchCard: '未找到匹配卡片',
  toastInList: '已在列表中',
  toastNoOrder: '当前没有可建组的顺序结果',
  toastNoValidCards: '结果中没有可用卡片',
  toastGroupCreated: '已创建卡组并放入 {n} 张卡（按结果顺序）',

  // ——— 脚本内结果 / 错误 ———
  analysisFailed: '分析失败：',
  graphEdgeTopo: '学习顺序 →',
  // 结果归一化：空结果/异常结构降级为可读文本，避免前端空白行
  emptyResult: '本次分析没有产出可展示的结果（数据量不足或内容差异过大）。可换一个预设，或补充几张同科目卡片再试。',
  // 把分析结果顺序建成卡组时的默认名称（{date} 为当日日期）
  groupNameFromAnalysis: '分析顺序 · {date}',
  // ECharts 图谱空节点数据时的可读提示
  graphNoNodes: '本次分析没有可绘制的节点数据',
  // 图谱大图模式（全屏）标题
  graphFullscreenTitle: '图谱大图模式',
};

export const en = {
  // ——— Page header ———
  title: '🔗 Card Link Analysis',
  subtitle: 'One-tap preset analysis or free-form questions; local mode works offline, AI mode auto-falls back on failure.',
  modeAuto: 'Auto (use AI if key)',
  modeLocal: 'Local (offline)',
  modeAi: 'AI mode',
  noAiKey: 'No AI key configured',
  newSessionBtn: '+ New session',

  // ——— Side: selected cards / sessions ———
  selectedCards: 'Selected cards ({n})',
  addPlaceholder: 'Search by content to add…',
  removeTitle: 'Remove',
  emptyCardsHint: 'Select cards on the "Cards" page, then open "Link Analysis"; or search above to add.',
  historySessions: 'History sessions (synced)',
  deleteSessionTitle: 'Delete session',
  noSessions: 'None',

  // ——— Center: conversation / results ———
  busyHint: 'Analyzing… (local is instant; AI ~5-20s)',
  emptyHint: 'Tap a quick button below to start, or type a question directly, e.g.: "How are these cards connected?" "Which is the prerequisite?" "Help me order a review sequence"',
  roleYou: '🙋 You',
  roleAi: '🤖 AI',
  roleFallback: '🤖 Local (fallback)',
  roleLocal: '🤖 Local',
  createGroupBtn: '🎴 Create review group in this order',
  weak: 'Weak',
  cardsCount: '{n} cards',
  noContent: '(no content)',

  // ——— Presets (keys aligned with PRESETS) ———
  presetPrefix: 'Preset: ',
  preset: {
    graph: '🕸 Relation graph',
    topo: '🧭 Topological order',
    critical: '🎯 Critical path',
    common: '🔍 Common knowledge',
    path: '📋 Study order',
    compare: '⚖️ Compare first two',
  },

  // ——— Bottom: input + presets ———
  askPlaceholder: 'Ask freely, e.g.: if I use these cards to prep for an exam, what should I review first?',
  askBtn: 'Ask',

  // ——— Toasts / hints ———
  toastNoMatchCard: 'No matching card found',
  toastInList: 'Already in the list',
  toastNoOrder: 'No orderable result to group yet',
  toastNoValidCards: 'No usable cards in the result',
  toastGroupCreated: 'Created group with {n} cards (in result order)',

  // ——— Script results / errors ———
  analysisFailed: 'Analysis failed: ',
  graphEdgeTopo: 'Learning order →',
  // Result normalization: empty/abnormal results degrade to readable text instead of blank lines
  emptyResult: 'This analysis produced no displayable result (too little data or too large a difference). Try another preset, or add a few cards of the same subject.',
  // Default name when building a review group from analysis order ({date} = today)
  groupNameFromAnalysis: 'Analysis order · {date}',
  // Readable hint when ECharts graph has no node data
  graphNoNodes: 'No node data to draw for this analysis',
  graphFullscreenTitle: 'Graph large view',
};
