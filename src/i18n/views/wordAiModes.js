// src/i18n/views/wordAiModes.js
// 英语 AI 智能模块（WordAIModes.vue）的 zh/en 字典片段。
export const zh = {
  title: 'AI 智能模块',
  subtitle: '复用 AI 助手，为 13 种背诵模式自动出题，并补齐大纲词的中文释义。',

  // 通道状态
  channelReady: 'AI 通道已就绪',
  channelMissing: '未配置 AI：请先在「设置 → AI 生成」填入 provider/key/model，或到「AI 助手」配置全局密钥。',
  channelCheck: '检查通道',

  // Tab
  tabModes: '智能出题',
  tabMeanings: '释义补齐',

  // ---- 智能出题 ----
  modesHint: '选一张单词卡，AI 会按 13 种背诵模式的判分口径自动生成题目与答案；不合规的会被丢弃并列出原因。',
  modesSelectCard: '选择单词卡',
  modesSearch: '搜索单词',
  modesNoCards: '暂无单词卡，先去单词本加入生词。',
  modesGenerate: '为这张卡生成 13 模式题目',
  modesRegenerate: '重新生成',
  modesGenerating: '生成中…',
  modesSave: '保存到卡片',
  modesSaving: '保存中…',
  modesSaved: '已保存 {n} 个模式题目',
  modesSaveFailed: '保存失败',
  modesPreview: '生成结果预览',
  modesDropped: '被丢弃 {n} 条（不合规）',
  modesEmpty: '尚未生成，选卡后点击生成。',
  modesGenFailed: '生成失败',
  modesNoChannel: '未配置 AI 通道，无法生成。',
  modesAnswer: '答案',
  modesOptions: '选项',
  modesTip: '提示',
  modesViaAgent: '经全局 AI 助手',
  modesViaKey: '经英语模块 LLM Key',

  // ---- 释义补齐 ----
  meaningsHint: '为大纲词表中缺失的中文释义批量补齐（每批 40 词，AI 生成后落库，可随时中断）。',
  meaningsCoverage: '当前释义覆盖',
  meaningsMissing: '缺失',
  meaningsRefresh: '刷新覆盖率',
  meaningsStart: '开始补齐缺失释义',
  meaningsStop: '停止',
  meaningsRunning: '补齐中… 第 {done}/{total} 批',
  meaningsProgress: '已生成 {generated} · 失败 {failed}',
  meaningsDone: '补齐完成：新增 {generated} 条，失败 {failed} 条',
  meaningsEmpty: '大纲词已全部覆盖，无需补齐。',
  meaningsNoChannel: '未配置 AI 通道，无法补齐。',
};

export const en = {
  title: 'AI Smart Module',
  subtitle: 'Reuse the AI assistant to auto-generate questions for all 13 review modes and fill in Chinese meanings for syllabus words.',

  channelReady: 'AI channel ready',
  channelMissing: 'AI not configured: fill in provider/key/model under Settings → AI Generation, or set a global key in the AI assistant.',
  channelCheck: 'Check channel',

  tabModes: 'Auto Questions',
  tabMeanings: 'Fill Meanings',

  modesHint: 'Pick a word card and AI will generate questions & answers aligned with the 13 review modes; invalid ones are dropped with reasons.',
  modesSelectCard: 'Select a word card',
  modesSearch: 'Search words',
  modesNoCards: 'No word cards yet — add some in the Word Book first.',
  modesGenerate: 'Generate 13-mode questions for this card',
  modesRegenerate: 'Regenerate',
  modesGenerating: 'Generating…',
  modesSave: 'Save to card',
  modesSaving: 'Saving…',
  modesSaved: 'Saved {n} mode questions',
  modesSaveFailed: 'Save failed',
  modesPreview: 'Preview',
  modesDropped: '{n} dropped (invalid)',
  modesEmpty: 'Nothing generated yet — pick a card and generate.',
  modesGenFailed: 'Generation failed',
  modesNoChannel: 'AI channel not configured.',
  modesAnswer: 'Answer',
  modesOptions: 'Options',
  modesTip: 'Tip',
  modesViaAgent: 'via global AI assistant',
  modesViaKey: 'via English module LLM key',

  meaningsHint: 'Batch-fill missing Chinese meanings for syllabus words (40 words/batch, saved as generated, can be interrupted).',
  meaningsCoverage: 'Coverage',
  meaningsMissing: 'Missing',
  meaningsRefresh: 'Refresh',
  meaningsStart: 'Start filling missing meanings',
  meaningsStop: 'Stop',
  meaningsRunning: 'Filling… batch {done}/{total}',
  meaningsProgress: '{generated} generated · {failed} failed',
  meaningsDone: 'Done: {generated} added, {failed} failed',
  meaningsEmpty: 'All syllabus words covered — nothing to fill.',
  meaningsNoChannel: 'AI channel not configured.',
};
