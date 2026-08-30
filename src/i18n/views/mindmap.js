// src/i18n/views/mindmap.js
// 思维导图视图（Mindmap.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.mindmap / en.views.mindmap。
// 说明：
//   - 占位符（{q}/{skipped}/{title}）用 3-arg 形式取词：t('views.mindmap.x', undefined, { ... })
//   - 节点标签（rootLabel / 默认 '主题' / '中心主题' / '📚 知识图谱' / '新节点'）属导图数据，不在此外部化
//   - 新建导图默认「标题」属视图默认文案，外部化；默认「根节点标签」属数据，留硬编码
export const zh = {
  // ——— 页面标题与顶部操作 ———
  heading: '思维导图',
  new: '＋ 新建',
  fromGraph: '从知识图谱',
  genLoading: '生成中…',
  aiFromCards: 'AI 从卡片',
  agentGen: '🤖 Agent 生成',
  agentTooltip: '走专业 agent 的工具调用循环，更懂你的卡片库',
  textGen: '📝 文字生成',
  hint: '把知识点画成多风格导图：横向树/放射树/竖向树/桑基图/力导向；可手动编辑，也可一键从知识图谱、AI、Agent 或输入文字生成。',

  // ——— 风格切换 ———
  styleLabel: '风格：',
  layoutTreeLr: '横向树',
  layoutTreeRadial: '放射树',
  layoutTreeTb: '竖向树',
  layoutSankey: '桑基图',
  layoutForce: '力导向',

  // ——— 列表 ———
  emptyTitle: '还没有导图',
  emptyMsg: '点右上角「＋ 新建」开始',
  delAria: '删除导图',
  delText: '删',

  // ——— 编辑工具条 ———
  titlePlaceholder: '导图标题',
  selected: '选中：',
  addChild: '＋ 子节点',
  rename: '重命名',
  removeNode: '删除节点',
  save: '保存',
  saved: '已保存',
  currentNode: '当前节点：',
  nodeHint: '· 树状单击=展开子节点；点下面按钮才跳转到知识卡片（桑基/力导向同理）',
  jumpCard: '🔗 跳转关联卡片',
  editHint: '提示：点节点选中后可编辑；切换上方风格按钮看不同呈现；修改后记得点「保存」。',

  // ——— 空状态（未选导图）———
  pickTitle: '从左侧选择导图',
  pickMsg: '或新建一张开始绘制',

  // ——— 文字生成弹窗 ———
  textModalTitle: '📝 文字 → 思维导图',
  textModalHint: '粘贴一段文字（笔记/讲义/文章），AI 会自动提取层次结构生成导图。',
  textPlaceholder: '在此粘贴文字内容，例如：\n第一章 绪论\n1.1 研究背景：……\n1.2 研究意义：……',
  cancel: '取消',
  genMap: '生成导图',

  // ——— 提示与状态（toast / confirm）———
  jumpNotFound: '卡片库里没找到「{q}」，已跳转搜索结果',
  jumpFailed: '跳转失败：',
  graphNoEdges: '知识图谱还没有保存关联，先去「图谱」页生成并保存',
  graphNoUsable: '知识图谱里没有可用的关联',
  genFromGraph: '已从知识图谱生成导图',
  genFromGraphSkipped: '已从知识图谱生成导图（跳过 {skipped} 条失效关联）',
  needKey: '请先在「AI 设置」里填入密钥',
  noCards: '还没有卡片',
  aiDone: 'AI 已生成导图',
  genFailed: '生成失败：',
  agentDone: 'Agent 已智能生成导图',
  agentFailed: 'Agent 生成失败：',
  textEmpty: '请先输入文字内容',
  textDone: '已从文字生成导图',
  renamePrompt: '修改节点文字：',
  rootCantDelete: '根节点不能删除',
  savedToast: '导图已保存（可跨设备同步）',
  saveFailed: '保存失败：',
  confirmDelete: '删除导图「{title}」？',

  // ——— 新建导图默认标题 ———
  defaultTitle: '新导图',
  defaultFromGraph: '知识图谱导图',
  defaultFromAI: 'AI 生成导图',
  defaultFromAgent: 'Agent 智能导图',
  defaultFromText: '文本导图',
};

export const en = {
  // ——— Page title & top actions ———
  heading: 'Mind Map',
  new: '＋ New',
  fromGraph: 'From knowledge graph',
  genLoading: 'Generating…',
  aiFromCards: 'AI from cards',
  agentGen: '🤖 Agent',
  agentTooltip: 'Uses the pro agent tool-calling loop — knows your card library better',
  textGen: '📝 From text',
  hint: 'Turn knowledge points into a multi-style mindmap: horizontal tree / radial tree / vertical tree / sankey / force-directed. Edit by hand, or generate in one click from the knowledge graph, AI, Agent, or pasted text.',

  // ——— Style switcher ———
  styleLabel: 'Style: ',
  layoutTreeLr: 'Horizontal tree',
  layoutTreeRadial: 'Radial tree',
  layoutTreeTb: 'Vertical tree',
  layoutSankey: 'Sankey',
  layoutForce: 'Force-directed',

  // ——— List ———
  emptyTitle: 'No mindmaps yet',
  emptyMsg: 'Click "＋ New" at the top-right to start',
  delAria: 'Delete mindmap',
  delText: 'Del',

  // ——— Edit toolbar ———
  titlePlaceholder: 'Mindmap title',
  selected: 'Selected: ',
  addChild: '＋ Child',
  rename: 'Rename',
  removeNode: 'Delete node',
  save: 'Save',
  saved: 'Saved',
  currentNode: 'Current node: ',
  nodeHint: '· Single-click on a tree node expands children; use the button below to jump to the knowledge card (same for sankey / force).',
  jumpCard: '🔗 Jump to linked card',
  editHint: 'Tip: click a node to select and edit it; switch the style buttons above for different views; remember to click "Save" after changes.',

  // ——— Empty state (no map selected) ———
  pickTitle: 'Pick a mindmap on the left',
  pickMsg: 'Or create a new one to start drawing',

  // ——— Text generation modal ———
  textModalTitle: '📝 Text → Mindmap',
  textModalHint: 'Paste a passage (notes / lecture / article) and the AI extracts its hierarchy into a mindmap.',
  textPlaceholder: 'Paste text here, e.g.:\nChapter 1 Introduction\n1.1 Background: …\n1.2 Significance: …',
  cancel: 'Cancel',
  genMap: 'Generate mindmap',

  // ——— Toasts & confirm ———
  jumpNotFound: 'Card "{q}" not found in the library — jumping to search results',
  jumpFailed: 'Jump failed: ',
  graphNoEdges: 'The knowledge graph has no saved links yet — generate and save them on the Graph page first',
  graphNoUsable: 'The knowledge graph has no usable links',
  genFromGraph: 'Mindmap generated from knowledge graph',
  genFromGraphSkipped: 'Mindmap generated from knowledge graph (skipped {skipped} invalid links)',
  needKey: 'Add your API key in AI Settings first',
  noCards: 'No cards yet',
  aiDone: 'AI generated a mindmap',
  genFailed: 'Generation failed: ',
  agentDone: 'Agent intelligently generated a mindmap',
  agentFailed: 'Agent generation failed: ',
  textEmpty: 'Enter some text first',
  textDone: 'Mindmap generated from text',
  renamePrompt: 'Edit node text: ',
  rootCantDelete: 'Root node cannot be deleted',
  savedToast: 'Mindmap saved (syncs across devices)',
  saveFailed: 'Save failed: ',
  confirmDelete: 'Delete mindmap "{title}"?',

  // ——— Default titles for new mindmaps ———
  defaultTitle: 'New mindmap',
  defaultFromGraph: 'Knowledge graph mindmap',
  defaultFromAI: 'AI mindmap',
  defaultFromAgent: 'Agent mindmap',
  defaultFromText: 'Text mindmap',
};
