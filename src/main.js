import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.js';
import { startPerfMonitor } from './utils/perf.js';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// 说明：Element Plus 只在 toast.js 中使用 ElMessage，采用「组件级样式导入」按需引入，
// 不再整包注册 Element Plus 与全部图标（打包体积与首屏开销大幅下降）。

app.config.errorHandler = (err) => {
  console.error('[vue error]', err);
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason);
});

startPerfMonitor();
app.mount('#app');
