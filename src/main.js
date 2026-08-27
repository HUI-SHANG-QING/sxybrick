import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.js';
import { startPerfMonitor } from './utils/perf.js';
import { logError } from './utils/errorLog.js';
// P3-2 PWA 离线优化：SW 注册 / 在线状态 / 配额监控
import { initPwa } from './utils/pwa.js';
// P3-4 插件 / MCP 接入：启动时预热已启用插件
import { warmupPlugins } from './plugins/registry.js';
// P1·7 + P2·10：启动恐怖级埋点采集器（A 级业务事件 + B 级 DOM 点击）
import { startTelemetry, pageView } from './utils/telemetry.js';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// 说明：Element Plus 只在 toast.js 中使用 ElMessage，采用「组件级样式导入」按需引入，
// 不再整包注册 Element Plus 与全部图标（打包体积与首屏开销大幅下降）。

app.config.errorHandler = (err, instance, info) => {
  logError(err, { component: instance?.$options?.__name || instance?.type?.name, info });
};
window.addEventListener('unhandledrejection', (e) => {
  logError(e.reason || e, { severity: 'warn' });
  e.preventDefault?.();
});

startTelemetry({
  onReady: () => {
    // 首屏 page_view（router.afterEach 会接住后续切换）
    if (typeof location !== 'undefined') {
      // hash 路由：取 #/xx 作为 path，否则兜底 /
      const hash = location.hash || '#/';
      const p = hash.replace(/^#/, '') || '/';
      pageView(p);
    }
  },
});
startPerfMonitor();
// PWA：注册 SW + 监听 online/offline + 周期检查 IndexedDB 配额
initPwa();
// 插件：异步预热已启用插件，不阻塞挂载
warmupPlugins();
app.mount('#app');
