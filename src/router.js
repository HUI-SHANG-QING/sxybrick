import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', component: () => import('./views/Cards.vue') },
  { path: '/review', component: () => import('./views/Review.vue') },
  { path: '/stats', component: () => import('./views/Stats.vue') },
  { path: '/export', component: () => import('./views/Export.vue') },
  { path: '/sync', component: () => import('./views/Sync.vue') },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});