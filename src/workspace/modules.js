// src/workspace/modules.js
// 工作台模块注册表（单点登记，纯数据、零 IO）。
// 覆盖 SxyBrick 全部 30 个模块：分组 + 图标 + 描述 + 路由。
// 新增模块只需在此登记；指标由 overview.js 按 key 聚合，Workspace.vue 按 key 渲染。
// 图标沿用项目全站 emoji 惯例（与 App.vue navItems / 各视图一致），零外链。
// i18nKey 用于全局语言切换（label / desc 经 t() 实时翻译，见 Workspace.vue）。

export const MODULE_GROUPS = [
  {
    id: 'study',
    label: '学习',
    i18nKey: 'workspace.group.study',
    modules: [
      { key: 'cards', path: '/cards', icon: '🗂️', label: '卡片', desc: '创建与编辑卡片' },
      { key: 'review', path: '/review', icon: '📖', label: '背诵', desc: '到期卡复习' },
      { key: 'wrong', path: '/wrong', icon: '❌', label: '错题', desc: '错题本重做' },
      { key: 'stats', path: '/stats', icon: '📊', label: '数据', desc: '统计与趋势' },
      { key: 'exam', path: '/exam', icon: '🧪', label: '模考', desc: '组卷自测' },
      { key: 'genquiz', path: '/genquiz', icon: '🔬', label: '生成测验', desc: 'AI 出题' },
    ],
  },
  {
    id: 'plan',
    label: '规划',
    i18nKey: 'workspace.group.plan',
    modules: [
      { key: 'daily', path: '/daily', icon: '📅', label: '每日规划', desc: '口述→任务→打卡' },
      { key: 'plans', path: '/plans', icon: '🎯', label: '计划', desc: '学习计划管理' },
      { key: 'pomodoro', path: '/pomodoro', icon: '🍅', label: '番茄', desc: '专注计时' },
      { key: 'weekly', path: '/weekly', icon: '📈', label: '周报', desc: '每周复盘' },
      { key: 'achievements', path: '/achievements', icon: '🏆', label: '成就', desc: '解锁徽章' },
    ],
  },
  {
    id: 'knowledge',
    label: '知识',
    i18nKey: 'workspace.group.knowledge',
    modules: [
      { key: 'notes', path: '/notes', icon: '📓', label: '笔记', desc: '厚笔记·双向链接' },
      { key: 'memo', path: '/memo', icon: '📝', label: '备忘', desc: '四象限短备忘' },
      { key: 'docs', path: '/docs', icon: '📄', label: '文档', desc: 'AI 文档问答' },
      { key: 'mindmap', path: '/mindmap', icon: '🗺️', label: '导图', desc: '思维导图' },
      { key: 'graph', path: '/graph', icon: '🕸️', label: '图谱', desc: '知识图谱' },
      { key: 'categories', path: '/categories', icon: '🏷️', label: '分类', desc: '自动归类' },
      { key: 'search', path: '/search', icon: '🔍', label: '搜索', desc: '全局检索' },
      { key: 'library', path: '/library', icon: '📚', label: '书房', desc: '阅读书目' },
      { key: 'materials', path: '/materials', icon: '🗃️', label: '资料库', desc: '上传解析问答' },
    ],
  },
  {
    id: 'smart',
    label: '智能',
    i18nKey: 'workspace.group.smart',
    modules: [
      { key: 'ai', path: '/ai', icon: '🤖', label: 'AI', desc: '智能问答' },
      { key: 'agent', path: '/agent', icon: '🧠', label: 'Agent', desc: 'Agent 工作台' },
      { key: 'feynman', path: '/feynman', icon: '👨‍🏫', label: '费曼', desc: '费曼练习' },
      { key: 'insight', path: '/insight', icon: '💡', label: '卡片洞察', desc: '遗忘曲线' },
      { key: 'health', path: '/health', icon: '🩺', label: '体检', desc: '资产健康检查' },
    ],
  },
  {
    id: 'system',
    label: '系统',
    i18nKey: 'workspace.group.system',
    modules: [
      { key: 'sync', path: '/sync', icon: '🔄', label: '同步', desc: '局域网/备份' },
      { key: 'export', path: '/export', icon: '📤', label: '导出', desc: '备份与导出' },
      { key: 'user-dashboard', path: '/user-dashboard', icon: '🛰️', label: '仪表盘', desc: '行为监控' },
      { key: 'privacy', path: '/privacy', icon: '🧾', label: '超级监控', desc: '人生数据监控' },
      { key: 'plugins', path: '/plugins', icon: '🔌', label: '插件', desc: '扩展管理' },
    ],
  },
];

export const ALL_MODULES = MODULE_GROUPS.flatMap(g => g.modules);
