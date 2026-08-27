import { createRouter, createWebHashHistory } from 'vue-router';
import { pageView } from './utils/telemetry.js';

const routes = [
  { path: '/', component: () => import('./views/Dashboard.vue') },
  { path: '/cards', component: () => import('./views/Cards.vue') },
  { path: '/review', component: () => import('./views/Review.vue') },
  { path: '/stats', component: () => import('./views/Stats.vue') },
  { path: '/export', component: () => import('./views/Export.vue') },
  { path: '/sync', component: () => import('./views/Sync.vue') },
  { path: '/ai', component: () => import('./views/AIAssistant.vue') },
  { path: '/agent', component: () => import('./views/AgentWorkbench.vue') },
  { path: '/feynman', component: () => import('./views/Feynman.vue') },
  { path: '/memo', component: () => import('./views/Memo.vue') },
  { path: '/wrong', component: () => import('./views/WrongBook.vue') },
  { path: '/pomodoro', component: () => import('./views/Pomodoro.vue') },
  { path: '/graph', component: () => import('./views/KnowledgeGraph.vue') },
  { path: '/plans', component: () => import('./views/Plans.vue') },
  { path: '/docs', component: () => import('./views/Docs.vue') },
  { path: '/mindmap', component: () => import('./views/Mindmap.vue') },
  { path: '/achievements', component: () => import('./views/Achievements.vue') },
  { path: '/weekly', component: () => import('./views/WeeklyReport.vue') },
  { path: '/exam', component: () => import('./views/Exam.vue') },
  // P2-1 生成式测验：从卡片/知识点用 LLM 自动生成选择/填空/简答题（测试效应）
  { path: '/genquiz', component: () => import('./views/GenQuiz.vue') },
  { path: '/health', component: () => import('./views/Health.vue') },
  { path: '/search', component: () => import('./views/Search.vue') },
  { path: '/library', component: () => import('./views/Library.vue') },
  // P2·10 + P3·11 新增：用户仪表盘（恐怖监控图表）+ 隐私人生数据模块
  { path: '/user-dashboard', component: () => import('./views/UserDashboard.vue') },
  { path: '/privacy', component: () => import('./views/PrivacyData.vue') },
  // P3-4 插件 / MCP 接入：本地插件管理与工具调用（MCP 兼容 schema）
  { path: '/plugins', component: () => import('./views/Plugins.vue') },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// P1·9：路由切换后自动埋点 page_view（恐怖监控的页面级基础来源）
router.afterEach((to) => {
  try { pageView(to.path || '/'); } catch { /* 不阻塞主流程 */ }
});
