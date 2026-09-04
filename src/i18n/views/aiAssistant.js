// src/i18n/views/aiAssistant.js
// AI 智能助手视图（AIAssistant.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.aiAssistant / en.views.aiAssistant。
// 仅外置视图 CHROME；AI 系统提示词 / quickActions 的 prompt / 冷启动模板内容 /
// 卡片库数据标签等属于发给模型或数据内容，保持硬编码（见各文件对应规则）。
export const zh = {
  // ——— 顶部工具栏 ———
  headerTitle: 'AI 学习助手',
  newChatBtn: '＋ 新建对话',
  voiceBroadcast: '语音播报',
  memLabel: '记忆',
  settingsLabel: 'AI 设置',
  quickQuiz: '智能出题',
  quickWeekly: '学习周报',
  quickRelate: '知识关联',
  genDeckBtn: '智能组卡',
  coldDeckBtn: '冷启动卡组',

  // ——— 左栏：历史对话 ———
  historyTitle: '历史对话',
  emptyHistoryTitle: '暂无历史对话',
  emptyHistoryMsgPrefix: '开始一段新对话，或点「',
  emptyHistoryMsgSuffix: '」试试',
  newChatTitle: '新对话',
  msgCountSuffix: ' 条',
  delLink: '删',

  // ——— 右栏：提问节点 ———
  nodesTitle: '提问节点',
  emptyNodesTitle: '暂无提问',
  emptyNodesMsg: '对话中向助手提问，会在这里形成时间轴节点',

  // ——— 中间：消息流 ———
  chatEmpty: '你好，我是你的学习助手。问问我吧，例如「我最近哪些科目薄弱？」',
  aiThinking: '思考中…',

  // ——— 输入行 ———
  inputPlaceholder: '问我任何关于你学习的问题…',
  sendBtn: '发送',

  // ——— AI 设置弹窗 ———
  apiUrlLabel: 'API 地址（OpenAI 兼容）',
  apiUrlPlaceholder: 'https://api.deepseek.com',
  apiKeyLabel: 'API 密钥',
  apiKeyPlaceholder: 'sk-...',
  modelLabel: '模型名',
  modelPlaceholder: 'deepseek-v4-flash',
  apiHint: '推荐 deepseek-v4-flash（快、便宜、够用）；需要更强推理可换 deepseek-v4-pro。密钥只存你本地。',
  testConn: '测试连接',
  testing: '测试中…',
  cancel: '取消',
  save: '保存',

  // ——— 智能卡组弹窗 ———
  genTitle: '智能卡组生成',
  genHint: '粘贴学习内容（笔记/讲义/文章），AI 自动拆成高质量记忆卡组，含质量评分、多题型、重复检测、原文溯源。',
  genTextPlaceholder: '粘贴内容（可超长，自动分块拆解）…',
  genSubjectPlaceholder: '科目提示（可选，如 数据结构 / 高数 / 英语）',
  generating: '生成中…',
  genBtn: '生成卡组',
  genFromTemplate: '从模板冷启动',
  deckCandidate: '候选',
  deckDeduped: '去重后',
  deckSelected: '已勾选',
  deckSourceDoc: '源文档 ✓',
  deckSourceTooltip: '原文已存为 AI 文档',
  deckChunks: '分块',
  deckFilterAll: '全部',
  deckFilterDeduped: '去重后',
  deckFilterSelected: '已选',
  deckSelectAll: '全选可见',
  deckClear: '清空',
  typeCloze: '填空',
  typeChoice: '选择',
  typeBasic: '问答',
  deckQuality: '质量',
  deckDupWarnPrefix: '⚠ 疑似重复 (',
  deckDupWarnSuffix: ')',
  deckImportPrefix: '导入勾选的',
  deckImportSuffix: ' 张',

  // ——— 冷启动卡组弹窗 ———
  coldTitle: '冷启动卡组',
  coldHint: '卡片库空空如也？选一个学科模板，AI 一键生成入门卡包，立刻开始复习。',
  close: '关闭',

  // ——— Agent 记忆库弹窗 ———
  memTitle: 'Agent 记忆库',
  memHint: 'Agent 会跨对话记住这些信息，并自动按分层注入。',
  catCore: '核心',
  catPref: '偏好',
  catFact: '事实',
  memPlaceholder: '记住什么？如：我在备考考研计算机408',
  memAdd: '添加',
  emptyMemTitle: '暂无记忆',
  emptyMemMsg: '对话中 Agent 会自动提取，也可手动添加',

  // ——— <script> 中的 toast / confirmDialog / 消息 ———
  confirmDeleteChat: '删除这个对话？',
  chatSaveFail: '对话保存失败：{msg}',
  needKey: '请先配置 AI 密钥',
  memSaved: '已自动记下 {n} 条记忆',
  chatError: '（出错：{msg}）',
  noContent: '（当前回答为空，请检查 AI 密钥与网络后重试）',
  connOk: '连接成功',
  connOkWith: '连接成功：',
  connFail: '连接失败：{msg}',
  cfgSaved: 'AI 配置已保存',
  needPaste: '请先粘贴内容',
  genNoCards: '没解析出卡片，请检查内容',
  genDone: '生成 {cand} 张候选卡（去重后 {dedup} 张，已勾选 {sel} 张）',
  genPickOne: '请至少勾选一张卡',
  importDone: '已导入 {created} 张卡片',
  importFailed: '，{n} 张失败',
  coldDone: '冷启动生成 {cand} 张卡（去重后 {dedup} 张）',
};

export const en = {
  // ——— Top toolbar ———
  headerTitle: 'AI Study Assistant',
  newChatBtn: '+ New Chat',
  voiceBroadcast: 'Voice',
  memLabel: 'Memory',
  settingsLabel: 'AI Settings',
  quickQuiz: 'Smart Quiz',
  quickWeekly: 'Weekly Report',
  quickRelate: 'Knowledge Links',
  genDeckBtn: 'Smart Deck',
  coldDeckBtn: 'Cold-start Deck',

  // ——— Left column: chat history ———
  historyTitle: 'History',
  emptyHistoryTitle: 'No chat history',
  emptyHistoryMsgPrefix: 'Start a new chat, or click "',
  emptyHistoryMsgSuffix: '" to try',
  newChatTitle: 'New Chat',
  msgCountSuffix: ' msgs',
  delLink: 'Del',

  // ——— Right column: question nodes ———
  nodesTitle: 'Question Nodes',
  emptyNodesTitle: 'No questions',
  emptyNodesMsg: 'Questions you ask the assistant appear here as a timeline.',

  // ——— Center: message stream ———
  chatEmpty: "Hi, I'm your study assistant. Ask me anything, e.g. \"Which subjects am I weak in lately?\"",
  aiThinking: 'Thinking…',

  // ——— Input row ———
  inputPlaceholder: 'Ask me anything about your studies…',
  sendBtn: 'Send',

  // ——— AI settings modal ———
  apiUrlLabel: 'API URL (OpenAI-compatible)',
  apiUrlPlaceholder: 'https://api.deepseek.com',
  apiKeyLabel: 'API Key',
  apiKeyPlaceholder: 'sk-...',
  modelLabel: 'Model name',
  modelPlaceholder: 'deepseek-v4-flash',
  apiHint: 'Recommended: deepseek-v4-flash (fast, cheap, good enough); switch to deepseek-v4-pro for stronger reasoning. Your key is stored only locally.',
  testConn: 'Test Connection',
  testing: 'Testing…',
  cancel: 'Cancel',
  save: 'Save',

  // ——— Smart deck modal ———
  genTitle: 'Smart Deck Generator',
  genHint: 'Paste study material (notes / lecture / article); AI splits it into high-quality cards with quality scoring, multiple question types, dedup, and source tracing.',
  genTextPlaceholder: 'Paste content (any length, auto-chunked)…',
  genSubjectPlaceholder: 'Subject hint (optional, e.g. Data Structures / Calculus / English)',
  generating: 'Generating…',
  genBtn: 'Generate Deck',
  genFromTemplate: 'Cold-start from template',
  deckCandidate: 'Candidates',
  deckDeduped: 'After dedup',
  deckSelected: 'Selected',
  deckSourceDoc: 'Source doc ✓',
  deckSourceTooltip: 'Source saved as AI doc',
  deckChunks: 'Chunks',
  deckFilterAll: 'All',
  deckFilterDeduped: 'Deduped',
  deckFilterSelected: 'Selected',
  deckSelectAll: 'Select visible',
  deckClear: 'Clear',
  typeCloze: 'Cloze',
  typeChoice: 'Choice',
  typeBasic: 'Q&A',
  deckQuality: 'Quality',
  deckDupWarnPrefix: '⚠ Possible duplicate (',
  deckDupWarnSuffix: ')',
  deckImportPrefix: 'Import selected',
  deckImportSuffix: ' cards',

  // ——— Cold-start deck modal ———
  coldTitle: 'Cold-start Deck',
  coldHint: 'Card library empty? Pick a subject template and AI generates a starter pack in one click to start reviewing immediately.',
  close: 'Close',

  // ——— Agent memory modal ———
  memTitle: 'Agent Memory',
  memHint: 'The Agent remembers this across chats and injects it hierarchically.',
  catCore: 'Core',
  catPref: 'Preference',
  catFact: 'Fact',
  memPlaceholder: 'Remember what? e.g. I am preparing for the CS 408 postgrad exam',
  memAdd: 'Add',
  emptyMemTitle: 'No memories',
  emptyMemMsg: 'The Agent auto-extracts during chats, or add manually',

  // ——— <script> toasts / confirmDialog / messages ———
  confirmDeleteChat: 'Delete this conversation?',
  chatSaveFail: 'Failed to save chat: {msg}',
  needKey: 'Please configure the AI key first',
  memSaved: 'Auto-saved {n} memories',
  chatError: '(error: {msg})',
  noContent: '(Empty response — please check your API key and network, then retry)',
  connOk: 'Connected',
  connOkWith: 'Connected: ',
  connFail: 'Connection failed: {msg}',
  cfgSaved: 'AI config saved',
  needPaste: 'Please paste content first',
  genNoCards: 'No cards parsed; please check the content',
  genDone: 'Generated {cand} candidate cards (after dedup: {dedup}, selected: {sel})',
  genPickOne: 'Please select at least one card',
  importDone: 'Imported {created} cards',
  importFailed: ', {n} failed',
  coldDone: 'Cold-start generated {cand} cards (after dedup: {dedup})',
};
