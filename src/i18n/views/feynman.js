// src/i18n/views/feynman.js
// 费曼学习法视图（Feynman.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.feynman / en.views.feynman。
// 仅外置用户可见的界面文案；发给模型的 FEYN_PROMPT / 复习数据上下文、
// 以及写入 IndexedDB 的会话 title 与 '未分类' 科目兜底值保留原样，未外置。
export const zh = {
  // ——— 页头 ———
  title: '费曼学习法',
  voiceBtn: '语音播报',
  hint: '以教代学：AI 出题考你，你用自己的话讲出来，讲不出的就是薄弱点。',

  // ——— 历史练习列表 ———
  historyLabel: '历史练习（{n} 条）',
  historyHint: '按时间倒序，点「继续」载入该会话的范围并接着练',
  newPractice: '＋ 新练习',
  rounds: '{n} 轮',
  currentSession: '当前会话',
  noConversationYet: '（尚未开始对话）',
  loaded: '已载入',
  continueSession: '继续此会话',
  deleteBtn: '删除',

  // ——— 范围筛选面板 ———
  scopeAll: '全量',
  scopeCustom: '自定义范围',
  subjectsLabel: '科目（多选 = 并集）',
  tagsLabel: '标签',
  optAnd: '交集（同时含）',
  optOr: '并集（含任一）',
  optNot: '差集（排除）',
  startBtn: '开始费曼练习',

  // ——— 对话区 ———
  thinking: '思考中…',
  answerPlaceholder: '用你自己的话回答…',
  answerBtn: '回答',

  // ——— 范围摘要（scopeSummary）———
  scopeAllCards: '📚 范围：全量卡片',
  scopePrefix: '📚 范围：',
  scopeCustomEmpty: '📚 范围：自定义（未选条件）',
  scopeSubjects: '科目[{list}]',
  scopeTags: '{logic}标签[{list}]',
  logicAnd: '∩',
  logicOr: '∪',
  logicNot: '差集',

  // ——— 时间格式 ———
  todayAt: '今天 {time}',

  // ——— toast / confirm 消息 ———
  needKey: '请先在「AI 设置」里填入密钥',
  noCardsInScope: '该范围内没有卡片',
  errorBubble: '（出错了：{msg}）',
  saveSessionFail: '会话保存失败：{msg}',
  confirmDeleteSession: '删除这个费曼会话？',
  topicPrefill: '请用费曼学习法讲解：「{topic}」',
  topicLoaded: '已载入错题补救的费曼建议：{topic}',
  needKeyThenStart: '请先在「AI 设置」里填入密钥，再点「开始费曼练习」',
};

export const en = {
  title: 'Feynman Technique',
  voiceBtn: 'Read aloud',
  hint: 'Learn by teaching: the AI quizzes you, you explain it in your own words — whatever you cannot explain is a weak point.',

  historyLabel: 'Past sessions ({n})',
  historyHint: 'Newest first; click "Continue" to load that session’s scope and keep practicing',
  newPractice: '＋ New session',
  rounds: '{n} rounds',
  currentSession: 'Current session',
  noConversationYet: '(no conversation yet)',
  loaded: 'Loaded',
  continueSession: 'Continue this session',
  deleteBtn: 'Delete',

  scopeAll: 'All cards',
  scopeCustom: 'Custom scope',
  subjectsLabel: 'Subjects (multi-select = union)',
  tagsLabel: 'Tags',
  optAnd: 'Intersection (has all)',
  optOr: 'Union (has any)',
  optNot: 'Difference (exclude)',
  startBtn: 'Start Feynman practice',

  thinking: 'Thinking…',
  answerPlaceholder: 'Answer in your own words…',
  answerBtn: 'Answer',

  scopeAllCards: '📚 Scope: all cards',
  scopePrefix: '📚 Scope: ',
  scopeCustomEmpty: '📚 Scope: custom (no filters selected)',
  scopeSubjects: 'Subjects[{list}]',
  scopeTags: '{logic} Tags[{list}]',
  logicAnd: '∩',
  logicOr: '∪',
  logicNot: 'diff',

  todayAt: 'Today {time}',

  needKey: 'Please add your API key in "AI Settings" first',
  noCardsInScope: 'No cards in this scope',
  errorBubble: '(Something went wrong: {msg})',
  saveSessionFail: 'Failed to save session: {msg}',
  confirmDeleteSession: 'Delete this Feynman session?',
  topicPrefill: 'Please explain with the Feynman technique: "{topic}"',
  topicLoaded: 'Loaded the Feynman suggestion for this mistake: {topic}',
  needKeyThenStart: 'Please add your API key in "AI Settings" first, then click "Start Feynman practice"',
};
