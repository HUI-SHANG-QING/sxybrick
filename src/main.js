import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';
import { startPerfMonitor } from './utils/perf.js';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './styles.css';

const app = createApp(App);
app.use(router);

app.config.errorHandler = (err) => {
  console.error('[vue error]', err);
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason);
});

startPerfMonitor();
app.mount('#app');