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
  fmtPdf: '不背风 A4 打印（PDF）',

  // PDF 三种版式（双栏 20 行 = 40 词/页）
  pdfTitle: '不背风 A4 打印',
  pdfA4Write: 'A4 默写',
  pdfA4WriteDesc: '左英文 → 右留空白线，用来默写中文释义',
  pdfZhList: '中文词表',
  pdfZhListDesc: '左中文释义 → 右留空白线，用来默写英文单词',
  pdfEnList: '英文词表',
  pdfEnListDesc: '英中对照全部填好，直接通读背诵',
  shuffleLabel: '乱序',
  shuffleOn: '已乱序',
  shuffleOff: '顺序',
  sheetTitleLabel: '页眉标题',
  sheetTitlePlaceholder: '如：考研核心词 · 第 3 轮',
  pagesInfo: '预计 {n} 页 · 每页 40 词（双栏 20 行）',

  // 输出通道
  channelLabel: '输出方式',
  channelPrint: '打印 / 另存为 PDF',
  channelPrintDesc: '弹出系统打印对话框，选「另存为 PDF」即得矢量 PDF。中文由系统字体渲染，排版最准，离线可用。',
  channelHtml: '下载 A4 网页文件',
  channelHtmlDesc: '把排好版的 A4 页面存成 .html，换台电脑用浏览器打开再打印也一样。',
  channelPdf: '直接下载 PDF（仅英文）',
  channelPdfDesc: '由 jsPDF 直接生成 .pdf 文件，无需打印对话框；但内置字体不含中文字形。',
  cjkWarn: '⚠️ 直接下载 PDF 用的内置字体不含中文字形，中文释义会打印成空白。需要中文请改用「打印 / 另存为 PDF」。',
  printBtn: '打开打印对话框',
  htmlBtn: '下载 A4 网页',
  pdfBtn: '直接下载 PDF',
  printOk: '已打开打印对话框（共 {n} 页）',
  printFailed: '导出失败：{reason}',

  // —— 更多选项 ——
  optionsTitle: '更多选项',
  includeNote: '包含批注',
  includeExample: '包含例句',
  includePhonetic: '包含音标',
  includeSource: '包含来源',

  // —— 导出历史 ——
  historyTitle: '导出历史',
  historyEmpty: '暂无导出记录',
  historyTime: '时间',
  historyScope: '范围',
  historyPages: '共 {n} 页',
  historyKeep: '仅本机保留，约一年',

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
  fmtPdfDesc: '不背风 A4 双栏版式：页眉含标题 + 二维码占位 + 模版效果图徽标，页脚含水印与页码，适合打印随身背。',

  // CSV 表头（跟随界面语言：英文 locale 导出的文件不应是中文表头）
  csvHeaderBoth: ['单词', '音标', '释义', '例句', '例句翻译', '批注', '来源', '考试类别', '类型', '标签'],
  csvHeaderEn: ['单词', '音标', '例句', '例句翻译', '批注', '来源', '考试类别', '类型'],
  csvHeaderZh: ['释义', '例句翻译', '批注', '来源', '考试类别', '类型'],
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
  fmtPdf: 'BuBei-style A4 print (PDF)',

  pdfTitle: 'BuBei-style A4 print',
  pdfA4Write: 'A4 dictation',
  pdfA4WriteDesc: 'English on the left, blank line on the right — write the Chinese meaning.',
  pdfZhList: 'Chinese list',
  pdfZhListDesc: 'Chinese meaning on the left, blank line on the right — write the English word.',
  pdfEnList: 'English list',
  pdfEnListDesc: 'Bilingual, fully filled in — read and memorise directly.',
  shuffleLabel: 'Shuffle',
  shuffleOn: 'Shuffled',
  shuffleOff: 'In order',
  sheetTitleLabel: 'Header title',
  sheetTitlePlaceholder: 'e.g. Core vocabulary · Round 3',
  pagesInfo: '{n} pages · 40 words per page (2 columns × 20 rows)',

  channelLabel: 'Output',
  channelPrint: 'Print / Save as PDF',
  channelPrintDesc: 'Opens the system print dialog; choose “Save as PDF” for a vector PDF. CJK is rendered with system fonts, works offline.',
  channelHtml: 'Download A4 HTML',
  channelHtmlDesc: 'Saves the laid-out A4 page as .html — open it in any browser on another machine and print.',
  channelPdf: 'Download PDF directly (English only)',
  channelPdfDesc: 'jsPDF generates the .pdf file directly, no print dialog — but its built-in fonts contain no CJK glyphs.',
  cjkWarn: '⚠️ Direct PDF download uses built-in fonts without CJK glyphs, so Chinese meanings print blank. Use “Print / Save as PDF” for Chinese.',
  printBtn: 'Open print dialog',
  htmlBtn: 'Download A4 HTML',
  pdfBtn: 'Download PDF',
  printOk: 'Print dialog opened ({n} pages)',
  printFailed: 'Export failed: {reason}',

  optionsTitle: 'More options',
  includeNote: 'Include notes',
  includeExample: 'Include examples',
  includePhonetic: 'Include phonetics',
  includeSource: 'Include source',

  historyTitle: 'Export history',
  historyEmpty: 'No export history',
  historyTime: 'Time',
  historyScope: 'Scope',
  historyPages: '{n} pages',
  historyKeep: 'Kept on this device, ~1 year',

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
  fmtPdfDesc: 'BuBei-style A4 two-column: header with title + QR placeholder + template badge, footer watermark + page number. Print-friendly.',

  // CSV 表头（跟随界面语言）
  csvHeaderBoth: ['Word', 'Phonetic', 'Meaning', 'Example', 'Example translation', 'Note', 'Source', 'Exam category', 'Type', 'Tags'],
  csvHeaderEn: ['Word', 'Phonetic', 'Example', 'Example translation', 'Note', 'Source', 'Exam category', 'Type'],
  csvHeaderZh: ['Meaning', 'Example translation', 'Note', 'Source', 'Exam category', 'Type'],
};
