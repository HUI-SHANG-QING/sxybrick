// src/i18n/views/wordSettings.js
// 英语设置页（WordSettings.vue）的 zh/en 字典片段。
export const zh = {
  title: '设置',
  subtitle: '发音口音、复习节奏、AI 自动生成与默认例句难度等偏好。',

  accentLabel: '发音口音',
  accentUs: '美式 (en-US)',
  accentGb: '英式 (en-GB)',
  accentAuto: '自动',

  learnPaceLabel: '学习节奏',
  paceSlow: '慢',
  paceNormal: '标准',
  paceFast: '快',

  recallPaceLabel: '复习节奏',
  spellHintLabel: '拼写提示（默写显示首字母/长度）',

  exampleLevelsLabel: '默认生成例句难度',
  levelSimple: '简单句',
  levelLong: '长难句',

  aiEnabledLabel: 'AI 自动生成',
  aiEnabledHint: '只填单词即自动生成同义词 / 词组 / 短语 / 例句（简单句 + 长难句，仅大纲内单词）',

  aiKeyTitle: 'AI 生成密钥',
  providerLabel: '服务商',
  modelLabel: '模型',
  apiKeyLabel: 'API Key',
  apiKeyPlaceholder: '填入你的 Key（仅存本机，不同步）',
  baseLabel: 'API 地址（可选）',
  basePlaceholder: '留空用服务商默认地址',
  testBtn: '测试连通性',
  testing: '测试中…',
  testOk: '连接成功',
  testFail: '连接失败：{msg}',

  mnemonicOrderLabel: '助记顺序',
  orderAuto: '自动',
  orderPos: '词性优先',
  orderExample: '例句优先',

  splitMnemonicLabel: '拆分助记（按音节/词根）',
  confusionLabel: '混淆项辨析',
  aiFallbackLabel: 'AI 失败回退',
  fallbackTemplate: '本地模板占位',
  fallbackSilent: '静默跳过',

  dailyGoalLabel: '每日新学目标',
  dailyGoalUnit: '个 / 天',

  saveBtn: '保存',
  savedToast: '设置已保存',
  saveFailedToast: '保存失败：{msg}',
};

export const en = {
  title: 'Settings',
  subtitle: 'Accent, review pace, AI auto-generation and default example difficulty.',

  accentLabel: 'Pronunciation accent',
  accentUs: 'American (en-US)',
  accentGb: 'British (en-GB)',
  accentAuto: 'Auto',

  learnPaceLabel: 'Learning pace',
  paceSlow: 'Slow',
  paceNormal: 'Normal',
  paceFast: 'Fast',

  recallPaceLabel: 'Review pace',
  spellHintLabel: 'Spell hint (show first letter / length in dictation)',

  exampleLevelsLabel: 'Default example difficulty',
  levelSimple: 'Simple',
  levelLong: 'Long & hard',

  aiEnabledLabel: 'AI auto-generation',
  aiEnabledHint: 'Entering only a word auto-generates synonyms / collocations / phrases / examples (simple + long, syllabus words only)',

  aiKeyTitle: 'AI generation key',
  providerLabel: 'Provider',
  modelLabel: 'Model',
  apiKeyLabel: 'API Key',
  apiKeyPlaceholder: 'Your key (stored locally, not synced)',
  baseLabel: 'API base (optional)',
  basePlaceholder: 'Leave blank for provider default',
  testBtn: 'Test connection',
  testing: 'Testing…',
  testOk: 'Connected',
  testFail: 'Failed: {msg}',

  mnemonicOrderLabel: 'Mnemonic order',
  orderAuto: 'Auto',
  orderPos: 'Part-of-speech first',
  orderExample: 'Example first',

  splitMnemonicLabel: 'Split mnemonic (by syllable / root)',
  confusionLabel: 'Confusion analysis',
  aiFallbackLabel: 'AI failure fallback',
  fallbackTemplate: 'Local template placeholder',
  fallbackSilent: 'Skip silently',

  dailyGoalLabel: 'Daily new-word goal',
  dailyGoalUnit: 'per day',

  saveBtn: 'Save',
  savedToast: 'Settings saved',
  saveFailedToast: 'Save failed: {msg}',
};
