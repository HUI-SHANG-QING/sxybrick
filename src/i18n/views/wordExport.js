// src/i18n/views/wordExport.js
// 单词导出页（WordExport.vue）的 zh/en 字典片段。重点实现：原数据标注 + 多风格/多语言/多顺序/多格式。
export const zh = {
  title: '导出单词',
  subtitle: '把单词本导出成复习卡、Anki 包、CSV 或可打印 A4 单词本。顶部「原数据标注」记录本次导出的完整上下文。',

  // —— 原数据标注（首页头）——
  metaTitle: '原数据标注',
  metaApp: '来源应用',
  metaVersion: '数据版本',
  metaExportedAt: '导出时间',
  metaScope: '数据域',
  metaRange: '导出范围',
  metaLang: '语言',
  metaOrder: '顺序',
  metaKind: '类型',
  metaGroup: '词组',
  metaSubject: '考试类别',
  metaTotal: '条目数',
  metaIncremental: '增量',

  // —— 语言 ——
  langLabel: '语言',
  langBoth: '中英对照',
  langEn: '仅英文',
  langZh: '仅中文',

  // —— 顺序 ——
  orderLabel: '顺序',
  orderSeq: '顺序',
  orderShuffle: '乱序',

  // —— 范围 ——
  rangeLabel: '范围',
  rangeAll: '全量',
  rangeIncremental: '增量（上次导出后新增/修改）',
  rangeByKind: '按类型',
  rangeByGroup: '按词组',
  rangeBySubject: '按考试类别',
  lastExportAt: '上次导出：{time}',
  neverExported: '从未导出过（首次增量等同全量）',
  incrementalHint: '增量基于本机记录的上次导出时间，仅导出其后变动的条目。',

  // —— 格式 ——
  formatLabel: '格式',
  fmtMarkdown: 'Markdown 复习卡',
  fmtAnki: 'Anki 导入包（.txt）',
  fmtCsv: 'CSV / Excel',
  fmtA4: '可打印 A4 单词本（HTML）',

  // —— 更多选项 ——
  optionsTitle: '更多选项',
  includeNote: '包含批注',
  includeExample: '包含例句',
  includePhonetic: '包含音标',
  includeSource: '包含来源',

  // —— 操作 ——
  exportBtn: '生成并下载',
  copyBtn: '复制文本',
  copied: '已复制',
  previewLabel: '预览',
  download: '下载',
  backHome: '返回单词本',

  empty: '没有可导出的单词。',
  emptyHint: '先去单词本添加一些单词，或调整导出范围。',
  exportedToast: '已生成导出文件',

  // 格式说明（预览区副标题）
  fmtMarkdownDesc: '每行一张复习卡，正面英文、背面中文，适合 Markdown 笔记 / Obsidian / 导入 Anki（问答格式）。',
  fmtAnkiDesc: '标准制表符分隔，可直接导入 Anki（文件→导入→字段映射 正面/背面）。',
  fmtCsvDesc: '逗号分隔，Excel / Numbers / WPS 直接打开，含全部字段。',
  fmtA4Desc: '适合打印的 A4 版式，每页多列，中英文可分栏，便于随身背诵。',
};

export const en = {
  title: 'Export Words',
  subtitle: 'Export the word book as review cards, Anki deck, CSV or printable A4 booklet. The “Source metadata” header records the full context of this export.',

  metaTitle: 'Source metadata',
  metaApp: 'Source app',
  metaVersion: 'Data version',
  metaExportedAt: 'Exported at',
  metaScope: 'Scope',
  metaRange: 'Range',
  metaLang: 'Language',
  metaOrder: 'Order',
  metaKind: 'Type',
  metaGroup: 'Group',
  metaSubject: 'Exam',
  metaTotal: 'Items',
  metaIncremental: 'Incremental',

  langLabel: 'Language',
  langBoth: 'Bilingual',
  langEn: 'English only',
  langZh: 'Chinese only',

  orderLabel: 'Order',
  orderSeq: 'Sequential',
  orderShuffle: 'Shuffled',

  rangeLabel: 'Range',
  rangeAll: 'All',
  rangeIncremental: 'Incremental (since last export)',
  rangeByKind: 'By type',
  rangeByGroup: 'By group',
  rangeBySubject: 'By exam',
  lastExportAt: 'Last export: {time}',
  neverExported: 'Never exported (first incremental = all)',
  incrementalHint: 'Incremental is based on this device’s last-export time; only changed items since then are exported.',

  formatLabel: 'Format',
  fmtMarkdown: 'Markdown review cards',
  fmtAnki: 'Anki deck (.txt)',
  fmtCsv: 'CSV / Excel',
  fmtA4: 'Printable A4 booklet (HTML)',

  optionsTitle: 'More options',
  includeNote: 'Include notes',
  includeExample: 'Include examples',
  includePhonetic: 'Include phonetics',
  includeSource: 'Include source',

  exportBtn: 'Generate & download',
  copyBtn: 'Copy text',
  copied: 'Copied',
  previewLabel: 'Preview',
  download: 'Download',
  backHome: 'Back to Word Book',

  empty: 'Nothing to export.',
  emptyHint: 'Add some words first, or adjust the export range.',
  exportedToast: 'Export file generated',

  fmtMarkdownDesc: 'One review card per line: English front, Chinese back. Good for Markdown notes / Obsidian / Anki (Q&A).',
  fmtAnkiDesc: 'Tab-separated, import directly into Anki (File → Import → map fields Front/Back).',
  fmtCsvDesc: 'Comma-separated, opens in Excel / Numbers / WPS with all fields.',
  fmtA4Desc: 'Print-friendly A4 layout, multiple columns per page, bilingual or split.',
};
