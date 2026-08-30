// src/i18n/views/genQuiz.js
// 生成式测验视图（GenQuiz.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.genQuiz / en.views.genQuiz。
// 仅外置静态 UI 文案；quizTitle 中的「生成式测验」标记、错题补卡 tag/source、
// 以及 QUIZ_TYPES 内置题型 label 属数据/跨模块标记，保留原样未翻译（见 GenQuiz.vue 注释）。
export const zh = {
  // ——— 顶部说明 ———
  title: '🧪 生成式测验',
  hint1: '与模考不同：这里用 AI 从你的卡片库',
  hintBold: '重新出题',
  hint2: '（选择/填空/简答），题干和情境都是新的，避免背题而非学知识。认知科学：测试效应 + 生成效应，主动检索比被动复习强 2~3 倍。',
  noKeyWarn: '⚠ 未配置 AI 密钥，将降级为本地模板出题（质量较低）',

  // ——— 阶段 1：出题设置 ———
  subjectRange: '科目范围（不选=全部）',
  typeLabel: '题型',
  mixedName: '混合',
  mixedDesc: '三种题型各 1/3，综合训练',
  countLabel: '题目数量',
  generating: '生成中…（LLM 出题）',
  genBtn: '生成测验',
  historyLabel: '历史成绩',

  // ——— 阶段 2：作答 ———
  submitBtn: '交卷',
  typeChoice: '选择',
  typeCloze: '填空',
  typeShort: '简答',
  ansPlaceholder: '请输入你的答案…',

  // ——— 阶段 3：批改结果 ———
  supplementBusy: '补卡中…',
  supplementBtn: '把 {n} 道错题生成卡片入复习队列',
  loopHint: '闭环：错题 → 卡片 → 复习队列（P2-2）',
  tagCorrect: '正确答案',
  tagWrong: '你的选择',
  ansYour: '你的答案：',
  ansNotPicked: '未选',
  ansNotAnswered: '未作答',
  ansRef: '参考答案：',
  covLine: '关键词覆盖：{cov}% · {reason}',
  explain: '解析：',
  retryBtn: '再来一次',

  // ——— <script> 中的 toast / confirmDialog 消息 ———
  fillCount: '请填写题目数量',
  noCards: '该范围内没有卡片',
  notEnoughCards: '卡片不足 4 张，无法生成测验（至少需要 4 张以构造干扰项）',
  mixedTypes: '混合题型',
  generated: '已生成 {n} 道题（{typeLabel}）',
  genFail: '生成失败：{msg}',
  unansweredConfirm: '还有 {n} 题未作答，确定交卷？',
  submitToast: '交卷：{score}/{total} 分（已存档）',
  noWrong: '没有错题需要补卡',
  supplementDone: '已将 {n} 道错题补卡入复习队列',
  supplementFailSuffix: '（{failed} 道失败）',
  supplementFail: '补卡失败：{detail}',
  supplementFailCount: '{n} 道无法生成',
  unknownError: '未知错误',
  wrongCardFail: '错题补卡失败：{msg}',
};

export const en = {
  // ——— Top intro ———
  title: '🧪 Generative Quiz',
  hint1: 'Unlike the mock exam, here the AI re-generates questions from your card library:',
  hintBold: 'brand-new questions',
  hint2: ' (multiple choice / cloze / short answer) with fresh stems and contexts, so you learn knowledge instead of memorizing questions. Cognitive science: testing effect + generation effect — active recall is 2~3× stronger than passive review.',
  noKeyWarn: '⚠ No AI key configured; falling back to local template questions (lower quality)',

  // ——— Stage 1: setup ———
  subjectRange: 'Subject scope (none = all)',
  typeLabel: 'Question type',
  mixedName: 'Mixed',
  mixedDesc: 'One third of each type, comprehensive training',
  countLabel: 'Number of questions',
  generating: 'Generating… (LLM)',
  genBtn: 'Generate quiz',
  historyLabel: 'History scores',

  // ——— Stage 2: answering ———
  submitBtn: 'Submit',
  typeChoice: 'Choice',
  typeCloze: 'Cloze',
  typeShort: 'Short answer',
  ansPlaceholder: 'Type your answer…',

  // ——— Stage 3: result ———
  supplementBusy: 'Adding cards…',
  supplementBtn: 'Turn {n} wrong answers into cards for the review queue',
  loopHint: 'Loop: wrong → card → review queue (P2-2)',
  tagCorrect: 'Correct',
  tagWrong: 'Your choice',
  ansYour: 'Your answer: ',
  ansNotPicked: 'Not picked',
  ansNotAnswered: 'Not answered',
  ansRef: 'Reference answer: ',
  covLine: 'Keyword coverage: {cov}% · {reason}',
  explain: 'Explanation: ',
  retryBtn: 'Try again',

  // ——— <script> toast / confirmDialog messages ———
  fillCount: 'Please enter the number of questions',
  noCards: 'No cards in this scope',
  notEnoughCards: 'Need at least 4 cards to generate a quiz (4+ required to build distractors)',
  mixedTypes: 'Mixed types',
  generated: 'Generated {n} questions ({typeLabel})',
  genFail: 'Generation failed: {msg}',
  unansweredConfirm: 'Still {n} unanswered. Submit anyway?',
  submitToast: 'Submitted: {score}/{total} (saved)',
  noWrong: 'No wrong answers to turn into cards',
  supplementDone: 'Added {n} wrong answers to the review queue',
  supplementFailSuffix: ' ({failed} failed)',
  supplementFail: 'Failed to add cards: {detail}',
  supplementFailCount: '{n} could not be generated',
  unknownError: 'Unknown error',
  wrongCardFail: 'Failed to add wrong-answer cards: {msg}',
};
