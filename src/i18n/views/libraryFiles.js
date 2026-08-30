// src/i18n/views/libraryFiles.js
// 学习资料中枢视图（LibraryFiles.vue）的 zh/en 字典片段。
// 与 library.js（数字书房首页 Library.vue）相互独立，本字典只覆盖「资料/附件文件」视图的文案。
// 由 src/i18n/index.js 在启动时合并进 zh.views.libraryFiles / en.views.libraryFiles。
// 约定：
//   - 带动态值的文案用 {占位符} 占位，取词时以 t('...key', undefined, { 占位符 }) 的 3 参形式传入；
//   - 模板内 <b> 强调拆成前/中/后多段 t() 拼接（绝不使用 v-html）；
//   - 文件真实名称/内容/错误文本属数据，不在此外部化。
export const zh = {
  // ——— 页面骨架 / Hero ———
  title: '📚 学习资料中枢',
  exportLabel: '导出清单',
  heroHintPre: '上传真题 / 讲义 / 笔记 → 全量解析（几百 MB 大文件不切片）→ 在线预览 → 对资料提问 → 一键生成卡片（',
  heroHintBold: '需你确认后才入库',
  heroHintPost: '）。原文件存本机（OPFS 专属大仓库），元数据可跨设备同步；解析全文与问答索引本地保存。',

  // ——— 上传区 ———
  subjectPlaceholder: '选择科目（可选）',
  uploadBtn: '📤 上传资料',
  ocrSettingsBtn: '⚙️ OCR 设置',
  storageLabel: '存储：',
  storagePersisted: '已持久化',

  // ——— OCR 设置面板 ———
  ocrLangLabel: '识别语言',
  ocrLangHint: '本地 Tesseract（数据不出浏览器，离线可用）；首次识别自动下载语言包并缓存',
  ocrLangDirLabel: '语言数据目录',
  ocrLangDirPlaceholder: '留空 = jsdelivr CDN（可填本地/自建 tessdata 目录 URL）',
  ocrCloudLabel: '使用云端 OCR（OpenAI 兼容视觉，需 API Key）',
  ocrCloudEndpointLabel: '云端端点',
  ocrApiKeyLabel: 'API Key',
  ocrModelLabel: '模型',
  ocrSave: '保存设置',
  ocrCancel: '取消',
  ocrBusy: '🔍 OCR：{name}',
  ocrPages: '{page}/{pages} 页',

  // ——— 资料库列表 ———
  libTitle: '资料库',
  libCount: '（{n} 份）',
  emptyTitle: '还没有资料',
  emptyMsg: '上传第一份真题或讲义，它会成为你复习系统的知识源头',
  metaPages: '{n} 页',
  metaTextLen: '解析全文 {n} 字',

  // ——— 状态文本 ———
  statusUploading: '上传中…',
  statusParsing: '解析中…',
  statusReady: '✅ 就绪',
  statusFailed: '❌ 失败',

  // ——— 操作按钮 ———
  opPreview: '预览',
  opQA: '问答',
  opGenerate: '生成卡片',
  opLink: '🔗 关联卡片',
  opLinkTitle: '把资料与它覆盖的卡片建立知识图谱关联',
  opRetry: '重试',
  opOcr: '🔍 OCR 识别',
  opDelete: '删除',

  // ——— 预览面板 ———
  previewTitle: '预览：{name}',
  previewClose: '关闭',
  pdfPrev: '← 上一页',
  pdfNext: '下一页 →',
  docxWarn: '⚠ 近似预览（Word 复杂排版在纯前端有损）',

  // ——— 问答面板 ———
  qaTitle: '对资料提问',
  qaClose: '关闭',
  qaPlaceholder: '例如：请总结这份真题的第三章考点',
  qaAsk: '提问',
  qaThinking: '思考中…',
  qaCites: '📎 引用片段：',
  qaCite: '片段{n} · 相似 {score}%',

  // ——— 生成卡片弹窗（用户选择制） ———
  draftTitle: '🃏 生成卡片预览 — {name}',
  draftHintPre: '共 ',
  draftHintMid: ' 张草稿。可',
  draftEdit: '编辑',
  draftSep: ' / ',
  draftDelete: '删除',
  draftHintPost: '单张；点击「确认导入」后才进入复习队列（默认绝不自动建卡）。来源血缘会自动记录，卡片可反查原文。',
  draftBtnEdit: '编辑',
  draftBtnDone: '完成编辑',
  draftFrontPlaceholder: '正面（提示 / 问题）',
  draftBackPlaceholder: '背面（结论 / 答案）',
  draftCancel: '取消（不建卡）',
  draftImporting: '导入中…',
  draftConfirm: '✅ 确认导入 {n} 张卡片',

  // ——— 提示 / 确认 / 状态 Toast ———
  ocrSaved: 'OCR 设置已保存',
  ocrDone: 'OCR 完成：{name}（{len} 字）',
  ocrFailed: 'OCR 失败：',
  ocrError: 'OCR 出错：',
  linkSuccess: '已关联 {created} 张卡片（{skipped}），可在「知识图谱」查看',
  linkSkipped: '跳过 {n} 条重复',
  linkNone: '未找到可关联的卡片（需同科目且卡片内容出自该资料）',
  linkFailed: '关联失败：',
  uploadStarted: '已上传并开始解析：{name}',
  uploadFailed: '{name} 上传失败：{error}',
  deleteConfirmMsg: '「{name}」的解析全文与元数据会进入回收站，保留 30 天可恢复；但原文件会从本机存储中移除（需要时可重新上传）。确定删除？',
  deleteConfirmTitle: '删除资料',
  confirmDelete: '删除',
  cancel: '取消',
  deleted: '已删除',
  deleteFailed: '删除失败：',
  retryStart: '重新解析中…',
  previewNoFile: '本机无原文件（跨设备同步的元数据无法预览）',
  previewFailed: '预览失败：',
  pdfPageFailed: 'PDF 翻页失败：',
  qaFailed: '问答失败：',
  noText: '该资料尚未解析出文本',
  noDrafts: '未从文本中切分出可用卡片草稿',
  genDrafts: '生成 {n} 张草稿——请预览确认后再导入',
  noImportCards: '没有可导入的卡片',
  imported: '已导入 {n} 张卡片到复习队列（来源：{name}）',
  importFailed: '导入失败：',

  // ——— 导出格式提示 ———
  exportMdHint: '人类可读',
  exportJsonHint: '可备份恢复',
};

export const en = {
  // ——— Page shell / Hero ———
  title: '📚 Study Materials Hub',
  exportLabel: 'Export list',
  heroHintPre: 'Upload past papers / lecture notes / notes → full parsing (large files of hundreds of MB, no chunking) → preview online → ask the document → generate cards in one click (',
  heroHintBold: 'only added after your confirmation',
  heroHintPost: '). Original files stay on this device (dedicated OPFS blob store); metadata can sync across devices; parsed full text and Q&A index are stored locally.',

  // ——— Upload area ———
  subjectPlaceholder: 'Select subject (optional)',
  uploadBtn: '📤 Upload',
  ocrSettingsBtn: '⚙️ OCR settings',
  storageLabel: 'Storage: ',
  storagePersisted: 'persisted',

  // ——— OCR settings panel ———
  ocrLangLabel: 'Recognition language',
  ocrLangHint: 'Local Tesseract (data never leaves the browser, works offline); language pack auto-downloads and caches on first recognition',
  ocrLangDirLabel: 'Language data directory',
  ocrLangDirPlaceholder: 'Blank = jsdelivr CDN (or a local/self-hosted tessdata directory URL)',
  ocrCloudLabel: 'Use cloud OCR (OpenAI-compatible vision, needs API Key)',
  ocrCloudEndpointLabel: 'Cloud endpoint',
  ocrApiKeyLabel: 'API Key',
  ocrModelLabel: 'Model',
  ocrSave: 'Save settings',
  ocrCancel: 'Cancel',
  ocrBusy: '🔍 OCR: {name}',
  ocrPages: '{page}/{pages} pages',

  // ——— Library list ———
  libTitle: 'Library',
  libCount: '({n} items)',
  emptyTitle: 'No materials yet',
  emptyMsg: 'Upload your first past paper or lecture note — it becomes the knowledge source of your review system',
  metaPages: '{n} pages',
  metaTextLen: 'parsed text {n} chars',

  // ——— Status text ———
  statusUploading: 'Uploading…',
  statusParsing: 'Parsing…',
  statusReady: '✅ Ready',
  statusFailed: '❌ Failed',

  // ——— Operation buttons ———
  opPreview: 'Preview',
  opQA: 'Ask',
  opGenerate: 'Generate cards',
  opLink: '🔗 Link cards',
  opLinkTitle: 'Link this material to the cards it covers in the knowledge graph',
  opRetry: 'Retry',
  opOcr: '🔍 OCR',
  opDelete: 'Delete',

  // ——— Preview panel ———
  previewTitle: 'Preview: {name}',
  previewClose: 'Close',
  pdfPrev: '← Prev',
  pdfNext: 'Next →',
  docxWarn: '⚠ Approximate preview (complex Word layout may be lossy in pure frontend)',

  // ——— Q&A panel ———
  qaTitle: 'Ask about this material',
  qaClose: 'Close',
  qaPlaceholder: 'e.g. summarize the key points of chapter 3 of this past paper',
  qaAsk: 'Ask',
  qaThinking: 'Thinking…',
  qaCites: '📎 Citations:',
  qaCite: 'Snippet {n} · similarity {score}%',

  // ——— Card draft modal (user-confirmed) ———
  draftTitle: '🃏 Card draft preview — {name}',
  draftHintPre: 'Total ',
  draftHintMid: ' drafts. You can ',
  draftEdit: 'edit',
  draftSep: ' / ',
  draftDelete: 'delete',
  draftHintPost: ' individual ones; they enter the review queue only after you click "Confirm import" (never auto-created by default). Source lineage is recorded automatically, and cards can link back to the original text.',
  draftBtnEdit: 'Edit',
  draftBtnDone: 'Done editing',
  draftFrontPlaceholder: 'Front (prompt / question)',
  draftBackPlaceholder: 'Back (conclusion / answer)',
  draftCancel: 'Cancel (no cards created)',
  draftImporting: 'Importing…',
  draftConfirm: '✅ Confirm import {n} cards',

  // ——— Toasts / confirm / status ———
  ocrSaved: 'OCR settings saved',
  ocrDone: 'OCR done: {name} ({len} chars)',
  ocrFailed: 'OCR failed: ',
  ocrError: 'OCR error: ',
  linkSuccess: 'Linked {created} cards ({skipped}), view in "Knowledge Graph"',
  linkSkipped: 'skipped {n} duplicates',
  linkNone: 'No linkable cards found (same subject and card content must come from this material)',
  linkFailed: 'Link failed: ',
  uploadStarted: 'Uploaded and parsing started: {name}',
  uploadFailed: '{name} upload failed: {error}',
  deleteConfirmMsg: 'The parsed full text and metadata of "{name}" will go to the recycle bin, recoverable for 30 days; but the original file will be removed from local storage (re-upload if needed). Confirm delete?',
  deleteConfirmTitle: 'Delete material',
  confirmDelete: 'Delete',
  cancel: 'Cancel',
  deleted: 'Deleted',
  deleteFailed: 'Delete failed: ',
  retryStart: 'Re-parsing…',
  previewNoFile: 'No original file on this device (metadata synced across devices cannot be previewed)',
  previewFailed: 'Preview failed: ',
  pdfPageFailed: 'PDF page turn failed: ',
  qaFailed: 'Q&A failed: ',
  noText: 'This material has no parsed text yet',
  noDrafts: 'No usable card drafts split from the text',
  genDrafts: 'Generated {n} drafts — preview and confirm before importing',
  noImportCards: 'No cards to import',
  imported: 'Imported {n} cards into the review queue (source: {name})',
  importFailed: 'Import failed: ',

  // ——— Export format hints ———
  exportMdHint: 'Human-readable',
  exportJsonHint: 'Back up & restore',
};
