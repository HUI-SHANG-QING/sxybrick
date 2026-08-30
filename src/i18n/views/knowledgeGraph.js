// src/i18n/views/knowledgeGraph.js
// 知识图谱视图（KnowledgeGraph.vue）的 zh/en 字典片段。
// 仅外置视图 chrome（标题、控制按钮、布局风格名、图例分类、空态、状态文本、tooltip 文案）；
// 卡片内容（节点/边 label、subject、AI 生成/推荐结果、发给 AI 的 prompt）属数据，保留原样。
// 含 <b> 强调或动态插值（{n}/{label}/{q}）的文案，按前缀/后缀拆分或在模板/调用处插值，一律不用 v-html。
export const zh = {
  // ——— 顶部标题与操作区 ———
  title: '知识图谱',
  switchToGenerated: '切换到 AI 生成',
  viewSaved: '查看已保存图谱',
  recommendBtn: '🔗 智能推荐关联',
  recommendTitle: '基于卡片相似度的本地算法，零 LLM 开销，零延迟',
  agentBtn: '🤖 Agent 智能构建',
  agentTitle: '走 graph-builder agent 工具调用循环，更懂卡片库且自动去重',
  generating: '生成中…',
  aiGenerate: 'AI 生成图谱',
  introHint: 'AI/Agent 从卡片挖出知识点和关联；多风格可视化；可保存进知识库随数据包同步。「🔗 智能推荐」用本地相似度算法，免 Key 免流量。',

  // ——— 智能推荐区 ———
  analyzing: '分析卡片相似度中…',
  recTitle: '智能推荐 {n} 条关联',
  recHint: '基于卡片内容/标签/科目相似度，可一键保存',
  similarity: '相似度',
  saveAll: '💾 全部保存',
  save: '保存',
  ignore: '忽略',

  // ——— 布局风格切换 ———
  styleLabel: '风格：',
  layoutForce: '力导向',
  layoutCircular: '圆形',
  layoutConcentric: '同心圆',
  layoutTree: '树状',

  // ——— 空态 ———
  emptyTitle: '还没有知识图谱',
  emptyMsg: '点右上角「AI 生成图谱」或「🤖 Agent 智能构建」，自动分析你的卡片',

  // ——— 生成态保存 ———
  saveGenerated: '💾 保存这些关联到知识库',

  // ——— 失效关联提示 ———
  deadPrefix: '⚠️ 有 ',
  deadSuffix: ' 条关联的两端找不到对应卡片（卡片已删，或历史版本把卡片 ID 直接写进了关联里），已从图谱视图中排除，避免显示成一串无意义的 ID。',
  pruneBtn: '🧹 清理失效关联',

  // ——— 已保存图谱列表 ———
  savedTitle: '已保存的知识图谱（{edges} 条关联 · {clusters} 个章节，可跨设备同步）',
  exportLabel: '导出图谱',
  exportMdHint: '人类可读',
  exportJsonHint: '节点+边',
  exportGraphmlHint: '可导入 Gephi/Cytoscape',
  clusterCount: '{n} 条',
  deleteEdge: '删',
  deleteEdgeAria: '删除关联',

  // ——— 选中节点条 ———
  selectedNodePrefix: '选中节点：',
  selectedNodeSuffix: '，',
  currentNodePrefix: '当前节点：',
  currentNodeSuffix: '，',
  jumpHint: '可直接跳转到对应的知识卡片浏览。',
  selectedPrefix: '选中：',
  selectedSuffix: '，相关节点已高亮。',
  jumpCard: '🔗 跳转知识卡片',
  clearSelection: '清空选择',

  // ——— <script> 中的 toast / 状态 ———
  jumpedToMaterials: '已跳转到资料库「{label}」',
  notFoundCard: '没找到名为「{q}」的卡片，已跳转搜索结果',
  noRecommend: '暂无可推荐关联：卡片数量不足或已全部建立关联',
  recommendAnalyzed: '分析出 {n} 条候选关联（基于卡片相似度，可一键保存）',
  savedEdge: '已保存：{from} {rel} {to}',
  edgeExists: '该关联已存在，已从列表移除',
  batchSaved: '批量保存 {n} 条关联',
  batchSkipped: '，跳过 {skip} 条重复',
  catUncategorized: '未分类',
  treeEmptyNode: '（空）',
  treeRootName: '📚 知识图谱',
  treeSubject: '\n🎓 科目：{subj}',
  treeTip: '\n💡 单击展开/折叠子节点；点下方「跳转卡片」按钮查看关联卡片。',
  renderFail: '图谱渲染失败：',
  initFail: '初始化图谱失败：',
  noAiKey: '请先配置 AI 密钥',
  noCards: '还没有卡片，先去建几张吧',
  noNodes: '没解析出知识点',
  agentDone: 'Agent 智能构建完成',
  agentFail: 'Agent 构建失败：',
  prunedEdges: '已清理 {n} 条失效关联',
  prunedNone: '没有失效关联',
  pruneFail: '清理失败：',
  savedAll: '已保存 {n} 条关联到知识库（可跨设备同步）',
  savedSkip: '已保存 {n} 条关联，跳过 {skip} 条重复（可跨设备同步）',
};

export const en = {
  // ——— Top title & actions ———
  title: 'Knowledge Graph',
  switchToGenerated: 'Switch to AI-generated',
  viewSaved: 'View saved graph',
  recommendBtn: '🔗 Smart recommend',
  recommendTitle: 'Local similarity algorithm — zero LLM cost, zero latency',
  agentBtn: '🤖 Agent build',
  agentTitle: 'Uses the graph-builder agent tool loop — knows your card library better and auto-dedupes',
  generating: 'Generating…',
  aiGenerate: 'AI generate graph',
  introHint: 'AI/Agent mines concepts and links from your cards; multi-style visualization; save into the knowledge base and sync via data package. "🔗 Smart recommend" uses a local similarity algorithm — no key, no traffic.',

  // ——— Recommendation panel ———
  analyzing: 'Analyzing card similarity…',
  recTitle: 'Smart recommend {n} links',
  recHint: 'Based on card content / tags / subject similarity; one-tap save',
  similarity: 'Similarity',
  saveAll: '💾 Save all',
  save: 'Save',
  ignore: 'Ignore',

  // ——— Layout style switcher ———
  styleLabel: 'Style: ',
  layoutForce: 'Force',
  layoutCircular: 'Circular',
  layoutConcentric: 'Concentric',
  layoutTree: 'Tree',

  // ——— Empty state ———
  emptyTitle: 'No knowledge graph yet',
  emptyMsg: 'Tap "AI generate graph" (top right) or "🤖 Agent build" to auto-analyze your cards',

  // ——— Generated save ———
  saveGenerated: '💾 Save these links to knowledge base',

  // ——— Dead-edge notice ———
  deadPrefix: '⚠️ ',
  deadSuffix: ' links have both ends missing their cards (card deleted, or an old version wrote the card ID straight into the link). They are excluded from the graph view to avoid showing meaningless IDs.',
  pruneBtn: '🧹 Clean dead links',

  // ——— Saved graph list ———
  savedTitle: 'Saved knowledge graph ({edges} links · {clusters} sections, syncs across devices)',
  exportLabel: 'Export graph',
  exportMdHint: 'Human-readable',
  exportJsonHint: 'Nodes + edges',
  exportGraphmlHint: 'Importable into Gephi/Cytoscape',
  clusterCount: '{n} links',
  deleteEdge: 'del',
  deleteEdgeAria: 'Delete link',

  // ——— Selected-node bar ———
  selectedNodePrefix: 'Selected node: ',
  selectedNodeSuffix: ',',
  currentNodePrefix: 'Current node: ',
  currentNodeSuffix: ',',
  jumpHint: 'Jump straight to the related knowledge card.',
  selectedPrefix: 'Selected: ',
  selectedSuffix: ', related nodes highlighted.',
  jumpCard: '🔗 Jump to card',
  clearSelection: 'Clear selection',

  // ——— <script> toasts / status ———
  jumpedToMaterials: 'Jumped to materials library "{label}"',
  notFoundCard: 'No card named "{q}" found; jumped to search results',
  noRecommend: 'Nothing to recommend: too few cards, or all links already exist',
  recommendAnalyzed: 'Found {n} candidate links (by card similarity; one-tap save)',
  savedEdge: 'Saved: {from} {rel} {to}',
  edgeExists: 'This link already exists; removed from the list',
  batchSaved: 'Batch saved {n} links',
  batchSkipped: ', skipped {skip} duplicates',
  catUncategorized: 'Uncategorized',
  treeEmptyNode: '(empty)',
  treeRootName: '📚 Knowledge Graph',
  treeSubject: '\n🎓 Subject: {subj}',
  treeTip: '\n💡 Click to expand/collapse child nodes; use the "Jump to card" button below to view related cards.',
  renderFail: 'Graph render failed: ',
  initFail: 'Graph init failed: ',
  noAiKey: 'Please configure an AI key first',
  noCards: 'No cards yet — create a few first',
  noNodes: 'No concepts parsed',
  agentDone: 'Agent build complete',
  agentFail: 'Agent build failed: ',
  prunedEdges: 'Cleaned {n} dead links',
  prunedNone: 'No dead links',
  pruneFail: 'Cleanup failed: ',
  savedAll: 'Saved {n} links to knowledge base (syncs across devices)',
  savedSkip: 'Saved {n} links, skipped {skip} duplicates (syncs across devices)',
};
