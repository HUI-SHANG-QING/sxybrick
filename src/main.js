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

// —— Element Plus（2026-08-29 起作为主力 UI 库全量接入）——
// 组件全量注册：本项目界面风格/视图众多，按需引入会拖累开发效率；
// 构建时由 vite manualChunks 拆成独立 chunk 做长期缓存，首屏只加载用到的分包。
import ElementPlus from 'element-plus';
// 图标按需显式导入（不用 import *，保证 rollup 能 tree-shake 掉未使用的图标）
import {
  Aim, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Calendar, ChatDotRound, Check,
  CircleCheck, CircleClose, Clock, Close, Coin, Collection, Connection, DataAnalysis, DataLine,
  Delete, Document, DocumentCopy, Download, Edit, EditPen, Files, Filter, Flag, Folder,
  FolderOpened, Grid, Histogram, InfoFilled, Key, Lightning, Link, List, Loading, Lock, MagicStick,
  Medal, Menu, Message, Minus, Monitor, Moon, More, MoreFilled, Notebook, Operation, Picture,
  PieChart, Plus, Position, Present, Promotion, QuestionFilled, Rank, Reading, Refresh, RefreshLeft,
  Search, Select, Setting, Share, Sort, Star, StarFilled, SuccessFilled, Sunny, Timer, Tools, Top,
  Trophy, TrendCharts, Unlock, Upload, UploadFilled, User, UserFilled, VideoPlay, View, Warning,
  WarningFilled, ZoomIn,
} from '@element-plus/icons-vue';

import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
// Inter Variable 本地化字体（@fontsource-variable/inter，woff2 随构建打包，
// progress 主题消费；@font-face 仅在使用 Inter 的元素上触发下载，其他主题零开销）
import '@fontsource-variable/inter';
// 样式引入顺序不可调换：EP 官方样式 → 项目样式 → 主题桥接。
// 桥接层必须最后，否则 --el-* 会被 EP 自身的变量声明覆盖回默认蓝。
import 'element-plus/dist/index.css';
import './styles.css';
import './styles/element-bridge.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(ElementPlus);

// 图标全局注册：模板里可直接写 <el-icon><Search /></el-icon>
const EL_ICONS = {
  Aim, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Calendar, ChatDotRound, Check,
  CircleCheck, CircleClose, Clock, Close, Coin, Collection, Connection, DataAnalysis, DataLine,
  Delete, Document, DocumentCopy, Download, Edit, EditPen, Files, Filter, Flag, Folder,
  FolderOpened, Grid, Histogram, InfoFilled, Key, Lightning, Link, List, Loading, Lock, MagicStick,
  Medal, Menu, Message, Minus, Monitor, Moon, More, MoreFilled, Notebook, Operation, Picture,
  PieChart, Plus, Position, Present, Promotion, QuestionFilled, Rank, Reading, Refresh, RefreshLeft,
  Search, Select, Setting, Share, Sort, Star, StarFilled, SuccessFilled, Sunny, Timer, Tools, Top,
  Trophy, TrendCharts, Unlock, Upload, UploadFilled, User, UserFilled, VideoPlay, View, Warning,
  WarningFilled, ZoomIn,
};
for (const [name, comp] of Object.entries(EL_ICONS)) {
  if (comp) app.component(name, comp);
}

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
