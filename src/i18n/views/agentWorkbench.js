// src/i18n/views/agentWorkbench.js
// Agent 工作台视图（AgentWorkbench.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.agentWorkbench / en.views.agentWorkbench。
// 仅外置静态 UI 文案；Agent/工具的名称与描述来自 agentSystem 注册表（运行时数据），保留原样未翻译。
export const zh = {
  // —— 顶部标题与操作按钮 ——
  title: 'Agent 工作台',
  subtitle: '模块化 Agent · 自动意图路由 · 多步工具编排 · 运行时可扩展接口',
  newSession: '＋ 新会话',
  autoRoute: '自动路由',
  toolsBtn: '工具接口 ({n})',
  extendBtn: '＋运行时扩展',
  clearChatBtn: '清空对话',
  usageBtn: '📊 用量',

  // —— AI 用量面板 ——
  usageTitle: 'AI 用量（近 {n} 天）',
  usageClear: '清空',
  usageEmpty: '暂无记录。使用 AI 功能（对话/Agent/导图/建卡/向量化）后，这里会显示 token、耗时与估算费用。',
  usageCalls: '调用',
  usageToken: 'Token',
  usageDuration: '累计耗时',
  usageCost: '估算费用',
  usageTimes: '次',
  usageFeeHint: '费用按内置费率估算，实际以 API 服务商账单为准。',

  // —— 左侧 Agent 与工具 ——
  agentsTitle: '可用 Agent（{n}）',
  pureTalk: '纯对话',
  toolsTitle: '可扩展工具接口（{n}）',
  badgeWrite: '写',
  badgeRead: '读',

  // —— 中间空状态示例 ——
  emptyHintPrefix: '试试：',
  emptyHintEx1: '「分析我本周的薄弱科目」',
  emptyHintEx2: '「把这段笔记拆成卡片」',
  emptyHintEx3: '「出 3 道数据结构选择题考我」',

  // —— 对话区 ——
  thinking: '思考/编排中…',
  inputPlaceholder: '描述你的任务，Agent 会自动编排执行…',
  runBtn: '执行',

  // —— 右侧编排轨迹 ——
  traceTitle: '编排轨迹',
  tRoute: '路由',
  tThought: '思考',
  tToolCall: '调用工具',
  tToolResult: '工具返回',
  tFinal: '结论',
  tError: '异常',
  tPlan: '计划',
  tThoughtMini: '思考{n}',
  tToolMini: '工具{n}',
  traceClear: '清',
  traceEmpty: '提交任务后，这里实时展示 Agent 的「路由→思考→调用工具→观察→结论」。',

  // —— <script> 中的 confirm / toast / 默认值 ——
  confirmClearUsage: '清空全部 AI 用量记录？（不影响卡片等数据）',
  toastUsageCleared: '已清空用量记录',
  toastNeedKey: '请先在「AI 设置」里填入 API 密钥',
  errPrefix: '（出错：',
  errSuffix: '）',
  defaultSessionTitle: 'Agent 会话',
  confirmDeleteSession: '删除这个 Agent 会话？',
  demoToolDesc: '【演示扩展】把输入原样返回，证明工具可在运行时注册并被编排器识别。',
  toastToolRegistered: '已运行时注册工具 echo_demo（可在上方工具列表看到）',
};

export const en = {
  // —— Top title & action buttons ——
  title: 'Agent Workbench',
  subtitle: 'Modular Agents · automatic intent routing · multi-step tool orchestration · runtime-extensible interface',
  newSession: '＋ New session',
  autoRoute: 'Auto route',
  toolsBtn: 'Tools ({n})',
  extendBtn: '＋ Runtime extension',
  clearChatBtn: 'Clear chat',
  usageBtn: '📊 Usage',

  // —— AI usage panel ——
  usageTitle: 'AI Usage (last {n} days)',
  usageClear: 'Clear',
  usageEmpty: 'No records yet. After using AI features (chat/Agent/mindmap/card creation/vectorization), token usage, duration and estimated cost will show here.',
  usageCalls: 'Calls',
  usageToken: 'Token',
  usageDuration: 'Total time',
  usageCost: 'Est. cost',
  usageTimes: 'calls',
  usageFeeHint: 'Cost is estimated by built-in rates; actual charges follow your API provider’s bill.',

  // —— Left: Agents & tools ——
  agentsTitle: 'Available Agents ({n})',
  pureTalk: 'Chat only',
  toolsTitle: 'Extensible Tool Interface ({n})',
  badgeWrite: 'W',
  badgeRead: 'R',

  // —— Center empty-state examples ——
  emptyHintPrefix: 'Try:',
  emptyHintEx1: '「Analyze my weak subjects this week」',
  emptyHintEx2: '「Split this note into cards」',
  emptyHintEx3: '「Quiz me with 3 data-structure MCQs」',

  // —— Chat area ——
  thinking: 'Thinking/orchestrating…',
  inputPlaceholder: 'Describe your task; the Agent will orchestrate and execute automatically…',
  runBtn: 'Run',

  // —— Right: orchestration trace ——
  traceTitle: 'Orchestration Trace',
  tRoute: 'Route',
  tThought: 'Thought',
  tToolCall: 'Tool call',
  tToolResult: 'Tool result',
  tFinal: 'Conclusion',
  tError: 'Error',
  tPlan: 'Plan',
  tThoughtMini: 'Thought {n}',
  tToolMini: 'Tool {n}',
  traceClear: 'Clear',
  traceEmpty: 'After you submit a task, this shows the Agent’s "route → think → call tool → observe → conclude" in real time.',

  // —— <script> confirm / toast / defaults ——
  confirmClearUsage: 'Clear all AI usage records? (Cards and other data are unaffected)',
  toastUsageCleared: 'Usage records cleared',
  toastNeedKey: 'Please fill in your API key in AI Settings first',
  errPrefix: 'Error: ',
  errSuffix: '',
  defaultSessionTitle: 'Agent session',
  confirmDeleteSession: 'Delete this Agent session?',
  demoToolDesc: '[Demo extension] Echoes input as-is, proving tools can be registered at runtime and recognized by the orchestrator.',
  toastToolRegistered: 'Registered tool echo_demo at runtime (visible in the tool list above)',
};
