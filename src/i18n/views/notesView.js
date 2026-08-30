// src/i18n/views/notesView.js
// 笔记视图（NotesView.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.notesView / en.views.notesView。
// 仅外置静态 UI 文案；笔记的标题/内容/分类/标签属于用户数据，保留原样不翻译。
export const zh = {
  // ——— 列表栏 ———
  loading: '加载中…',
  searchPlaceholder: '搜索标题/正文/标签…',
  allCategories: '全部分类',
  newNote: '+ 新建笔记',
  emptyTitle: '还没有笔记',
  emptyMessage: '点「＋ 新建笔记」开始记录',
  untitled: '（无标题）',
  exportAll: '导出全部',

  // ——— 标题/分类/标签 输入占位 ———
  titlePlaceholder: '笔记标题…',

  // ——— 导出格式选项（noteExportFormats） ———
  fmtMarkdown: 'Markdown',
  fmtMarkdownHint: '人类可读',
  fmtJson: 'JSON',
  fmtJsonHint: '可备份恢复',

  // ——— 详情/编辑栏 ———
  selectTitle: '选择一篇笔记',
  selectMessage: '或点 + 新建笔记 开始写',
  save: '💾 保存',
  delete: '🗑 删除',
  categoryPlaceholder: '分类（例：线代 / 计组 / 算法）',
  tagPlaceholder: '+ 加标签（回车）',
  contentPlaceholder: '写点什么…用 [[c-card-id]] 双向链接卡片，[[d-doc-id]] 关联资料，#标签 自动归类',
  preview: '预览',
  noContent: '（无内容）',
  charCount: '字数 {n}',
  linkCount: '双向链接 {n}',
  unsaved: '● 未保存',
  synced: '✓ 已同步',
  referenced: '被引用：',

  // ——— <script> 中的 toast / confirmDialog 消息 ———
  titleEmpty: '标题不能为空',
  toastSaved: '已保存',
  toastCreated: '已新建',
  saveFailed: '保存失败：{msg}',
  confirmDelete: '删除笔记不可撤销（其他笔记的双向链接会变红），确定？',
  toastDeleted: '已删除',
};

export const en = {
  // ——— list column ———
  loading: 'Loading…',
  searchPlaceholder: 'Search title / content / tags…',
  allCategories: 'All categories',
  newNote: '+ New note',
  emptyTitle: 'No notes yet',
  emptyMessage: 'Click "+ New note" to start writing',
  untitled: '(untitled)',
  exportAll: 'Export all',

  // ——— title/category/tag input placeholders ———
  titlePlaceholder: 'Note title…',

  // ——— export format options (noteExportFormats) ———
  fmtMarkdown: 'Markdown',
  fmtMarkdownHint: 'human-readable',
  fmtJson: 'JSON',
  fmtJsonHint: 'backup & restore',

  // ——— detail/edit column ———
  selectTitle: 'Select a note',
  selectMessage: 'Or click + New note to start writing',
  save: '💾 Save',
  delete: '🗑 Delete',
  categoryPlaceholder: 'Category (e.g. Linear Algebra / Comp Org / Algorithms)',
  tagPlaceholder: '+ Add tag (Enter)',
  contentPlaceholder: 'Write something… use [[c-card-id]] to link a card, [[d-doc-id]] for materials, #tag for auto-grouping',
  preview: 'Preview',
  noContent: '(no content)',
  charCount: 'Chars {n}',
  linkCount: 'Links {n}',
  unsaved: '● Unsaved',
  synced: '✓ Synced',
  referenced: 'Referenced by: ',

  // ——— toast / confirmDialog messages from <script> ———
  titleEmpty: 'Title cannot be empty',
  toastSaved: 'Saved',
  toastCreated: 'Created',
  saveFailed: 'Save failed: {msg}',
  confirmDelete: 'Deleting this note cannot be undone (bi-links from other notes will turn red). Continue?',
  toastDeleted: 'Deleted',
};
