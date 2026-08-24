import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', component: () => import('./views/Cards.vue') },
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
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});