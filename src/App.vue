<script setup>
import { ref, onMounted, onBeforeUnmount, defineAsyncComponent, watch, nextTick } from 'vue';
import { toast } from './utils/toast.js';
import { confirmDialog } from './utils/confirm.js';
import { degraded } from './utils/perf.js';
import { ensureNotifyPermission, sendNotify } from './utils/notify.js';
import { getGoal, getTodayCount, getDueCount, getLastReviewTs, getDueBySubject } from './utils/streak.js';
// FloatAssistant / NavBar 首屏必需，保留同步
import FloatAssistant from './components/FloatAssistant.vue';
import NavBar from './components/NavBar.vue';
// NotificationBell 首屏必需（通知铃铛），保留同步
import NotificationBell from './components/NotificationBell.vue';
import ResetAllData from './components/ResetAllData.vue';
import ErrorBoundary from './components/ErrorBoundary.vue';
// Intro/Guide 仅首次访问时显示、InkLandscape 仅国风主题激活时显示 → 异步加载以减小首屏 chunk
const Intro = defineAsyncComponent(() => import('./components/Intro.vue'));
const Guide = defineAsyncComponent(() => import('./components/Guide.vue'));
const InkLandscape = defineAsyncComponent(() => import('./components/InkLandscape.vue'));
import { useThemeStore, STYLES, MODES, FONTS } from './stores/theme.js';
// M3 演示模式：顶部横幅 + 设置面板入口（real/test 双数据库物理隔离）
import { useAppModeStore } from './stores/appMode.js';
import { getProactiveScheduler } from './agent/proactive.js';
import { getAIConfig } from './ai.js';
// 日程表到点提醒：全局调度 + 视觉浮层（桌面/平板/手机同一逻辑，默认静音）
import PlanReminderLayer from './components/PlanReminderLayer.vue';
import { startReminderScheduler } from './utils/plan-reminder.js';
// P3-2 PWA 离线优化：离线指示 / 新版本提示 / 配额告警
import {
  isOnline, subscribeOnline, subscribeSwUpdate, subscribeOfflineReady,
  subscribeQuotaWarn, applyUpdate, requestPersistentStorage, getStorageEstimate,
} from './utils/pwa.js';
// P1·7 埋点开关：在设置面板允许用户开/关 A/B 级
import { isAEnabled, isBEnabled, setAEnabled, setBEnabled } from './utils/telemetry.js';
// P1-1 FSRS 调度器 opt-in：在设置面板切换 SM-2 ↔ FSRS，并允许用户用真实评分历史训练 19 权重
import { db } from './db.js';
import { refreshSchedConfig } from './repo.js';
import { trainFsrsModel } from './agent/analytics.js';
import { serializeUserWeights } from './fsrs.js';
import { parseHm, hasReached } from './utils/time.js';

const theme = useThemeStore();

const appMode = useAppModeStore();
const showSettings = ref(false);

// M3 演示模式：进入/退出走整页 reload（store 内已处理），确保所有视图重查对应库
function enterDemoMode() {
  appMode.enterTestMode();
}
function exitDemoMode() {
  appMode.exitTestMode();
}
async function resetDemoData() {
  if (!(await confirmDialog('清空演示数据并重新填充示例？（不影响真实数据）'))) return;
  try {
    await appMode.clearTestData();
    location.reload();
  } catch (e) { toast('重置失败：' + (e?.message || e), 'error'); }
}
// P2-29 / P1-15：设置弹窗无障碍 —— 焦点管理
const settingsModal = ref(null);
let lastFocusedEl = null;
// 设置面板标签页（外观 / 提醒与监控 / 学习引擎 / 导航 / 存储）
const settingsTab = ref('appearance');

// ---------- P3-2 PWA 离线优化：响应式状态 ----------
const online = ref(isOnline());           // 浏览器在线状态
const swNeedRefresh = ref(false);         // 有新版本待激活
const swOfflineReady = ref(false);       // 已可离线启动
const quotaWarn = ref(null);             // { usage, quota, usagePercent } 或 null
const storageEstimate = ref(null);       // 用于在设置面板展示当前存储占用
const storageUnsupported = ref(null);    // 'insecure' | 'no-api' | null（配额 API 不可用原因）
// 用户主动忽略本次新版本提示后，不再弹（直到下次出新版本）
const swUpdateDismissed = ref(false);
let unsubOnline, unsubSwUpdate, unsubOfflineReady, unsubQuotaWarn;

async function reloadForUpdate() {
  swNeedRefresh.value = false;
  await applyUpdate();
}
function dismissSwUpdate() {
  swNeedRefresh.value = false;
  swUpdateDismissed.value = true;
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const navItems = [
  { path: '/', label: '总览', icon: '📊' },
  { path: '/workspace', label: '工作台', icon: '🧩' },
  { path: '/cards', label: '卡片', icon: '🗂️' },
  { path: '/groups', label: '卡组', icon: '🎴' },
  // M2 卡片智能联动分析工作台（预设快捷 + 自由问答，本地/AI 双引擎）
  { path: '/analysis/card-link', label: '联动分析', icon: '🔗' },
  { path: '/review', label: '背诵', icon: '📖' },
  { path: '/stats', label: '数据', icon: '📉' },
  { path: '/export', label: '导出', icon: '🖨️' },
  { path: '/sync', label: '同步', icon: '🔄' },
  { path: '/ai', label: 'AI', icon: '🤖' },
  { path: '/agent', label: 'Agent', icon: '🧠' },
  { path: '/feynman', label: '费曼', icon: '👨‍🏫' },
  { path: '/memo', label: '备忘', icon: '📝' },
  // D3.2 笔记（厚笔记 / 双向链接 / 富文本，区别于 /memo 短备忘）
  { path: '/notes', label: '笔记', icon: '📓' },
  // D4.2 自动分类
  { path: '/categories', label: '分类', icon: '🏷️' },
  // D8 每日规划/打卡
  { path: '/daily', label: '每日规划', icon: '📅' },
  { path: '/wrong', label: '错题', icon: '❌' },
  { path: '/pomodoro', label: '番茄', icon: '🍅' },
  { path: '/graph', label: '图谱', icon: '🕸️' },
  { path: '/mindmap', label: '导图', icon: '🗺️' },
  { path: '/plans', label: '计划', icon: '🎯' },
  { path: '/docs', label: '文档', icon: '📄' },
  { path: '/weekly', label: '周报', icon: '📈' },
  { path: '/exam', label: '模考', icon: '🧪' },
  // P2-1 生成式测验：LLM 自动出题（选择/填空/简答），测试效应
  { path: '/genquiz', label: '生成测验', icon: '🔬' },
  { path: '/search', label: '搜索', icon: '🔍' },
  { path: '/health', label: '体检', icon: '🩺' },
  // P2-22 回收站：被删内容 30 天内可恢复（本地 trash 表，不进同步/备份）
  { path: '/trash', label: '回收站', icon: '🗑️' },
  { path: '/library', label: '书房', icon: '📚' },
  // Phase 6 学习资料中枢：上传 → 全量解析 → 预览 → 问答 → 生成卡片（用户选择制）
  { path: '/materials', label: '资料库', icon: '🗃️' },
  { path: '/achievements', label: '成就', icon: '🏆' },
  // P2·10 + P3·11：用户仪表盘（恐怖监控图表）与隐私人生数据（超级监控）
  { path: '/user-dashboard', label: '仪表盘', icon: '🛰️' },
  { path: '/privacy', label: '超级监控', icon: '🧾' },
  // P3-4 插件 / MCP 接入：本地扩展机制（工具调用 + 事件钩子）
  { path: '/plugins', label: '插件', icon: '🔌' },
  { path: '/insight', label: '卡片洞察', icon: '💡' },
  // UI 组件库：Element Plus × 主题桥接活样本（风格 / 配色随主题联动）
  { path: '/uikit', label: '组件库', icon: '🧰' },
];

// 功能精简：用户自定义核心导航项（始终显示）；未勾选的折叠到 NavBar 的「更多 ▼」
// localStorage 'sxy_core_navs' 存 JSON 数组 of path；未设置时 NavBar 全部显示（向后兼容）
const CORE_KEY = 'sxy_core_navs';
const DEFAULT_CORE_NAVS = ['/cards', '/review']; // 卡片 + 复习（label 为"背诵"）
const coreNavs = ref([...DEFAULT_CORE_NAVS]);
const hasCoreSetting = ref(false);
function loadCoreNavs() {
  try {
    const raw = localStorage.getItem(CORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) { coreNavs.value = arr; hasCoreSetting.value = true; }
    }
  } catch {}
}
function isCoreNav(path) { return coreNavs.value.includes(path); }
function toggleCoreNav(path, checked) {
  if (checked) {
    if (!coreNavs.value.includes(path)) coreNavs.value.push(path);
  } else {
    coreNavs.value = coreNavs.value.filter(p => p !== path);
  }
  hasCoreSetting.value = true;
  localStorage.setItem(CORE_KEY, JSON.stringify(coreNavs.value));
}

// P1·7：设置面板埋点开关（响应式）
const telA = ref(isAEnabled());
const telB = ref(isBEnabled());
function onToggleTelA(v) {
  setAEnabled(v); telA.value = v;
  toast(v ? '已启用 A 级业务埋点（背诵 / 导出 / 同步 等大事件）' : '已关闭 A 级埋点，不再记录业务操作', 'success');
}
function onToggleTelB(v) {
  setBEnabled(v); telB.value = v;
  toast(v ? '已启用 B 级 DOM 交互埋点（按钮 / 卡片点击，不记录隐私内容）' : '已关闭 B 级 DOM 监听，点击不再采集', 'success');
}
watch(showSettings, (open) => {
  if (open) {
    lastFocusedEl = document.activeElement;
    telA.value = isAEnabled(); telB.value = isBEnabled(); loadScheduler();
    // P3-2 打开设置面板时刷新存储占用，让用户看到实时数据
    getStorageEstimate().then(e => { storageEstimate.value = e; storageUnsupported.value = e && e.unsupported || null; });
    // 焦点移入弹窗（键盘 / 读屏用户可达），关闭时还原到触发元素
    nextTick(() => settingsModal.value?.focus());
  } else if (lastFocusedEl && lastFocusedEl.focus) {
    lastFocusedEl.focus();
  }
});

// P2-29 / P1-15：设置弹窗键盘可达 —— Esc 关闭 + Tab 焦点陷阱
function onSettingsKeydown(e) {
  if (e.key === 'Escape') { e.stopPropagation(); showSettings.value = false; return; }
  if (e.key !== 'Tab') return;
  const m = settingsModal.value;
  if (!m) return;
  const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const list = Array.from(m.querySelectorAll(sel)).filter(el => el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---------- P1-1 FSRS 调度器 opt-in ----------
// scheduler: 'sm2'(默认，类 SM-2 变体，含短巩固/错因惩罚) | 'fsrs'(FSRS-4.5，ML 拟合每用户遗忘曲线)
// fsrsWeights: 训练出的 19 权重；fsrsInfo: 上次训练摘要（样本数/损失），用于在面板向用户展示
const scheduler = ref('sm2');
const fsrsTraining = ref(false);
const fsrsInfo = ref(null); // { samples, loss, weights }
async function loadScheduler() {
  try {
    const [s, w, info] = await Promise.all([
      db.meta.get('scheduler'), db.meta.get('fsrsWeights'), db.meta.get('fsrsInfo'),
    ]);
    scheduler.value = s?.value === 'fsrs' ? 'fsrs' : 'sm2';
    fsrsInfo.value = info?.value || null;
  } catch { /* db 未就绪时静默 */ }
}
async function onToggleScheduler(v) {
  const next = v ? 'fsrs' : 'sm2';
  scheduler.value = next;
  try {
    await db.meta.put({ key: 'scheduler', value: next });
    refreshSchedConfig(); // 清缓存，下次复习读到新调度器
    toast(next === 'fsrs'
      ? '已切换到 FSRS 调度（ML 遗忘曲线，需训练权重后效果最佳）'
      : '已切回 SM-2 调度（含短期巩固与错因惩罚）', 'success');
  } catch (e) { toast('调度器切换失败：' + (e?.message || e), 'error'); }
}
async function trainFsrs() {
  if (fsrsTraining.value) return;
  fsrsTraining.value = true;
  try {
    const r = await trainFsrsModel();
    if (!r || r.samples === 0) {
      toast('复习样本不足（需 ≥8 次），暂未训练。多复习几次再来。', 'info');
      return;
    }
    await Promise.all([
      db.meta.put({ key: 'fsrsWeights', value: serializeUserWeights(r.weights) }),
      db.meta.put({ key: 'fsrsInfo', value: { samples: r.samples, loss: r.loss, trainedAt: Date.now() } }),
    ]);
    fsrsInfo.value = { samples: r.samples, loss: r.loss, trainedAt: Date.now() };
    refreshSchedConfig();
    const lossTxt = r.loss != null ? ` 平均对数损失 ${(+r.loss).toFixed(3)}` : '';
    toast(`FSRS 训练完成：基于 ${r.samples} 次复习样本${lossTxt}。已应用新权重。`, 'success');
  } catch (e) {
    toast('FSRS 训练失败：' + (e?.message || e), 'error');
  } finally {
    fsrsTraining.value = false;
  }
}

const installEvt = ref(null);
function onBeforeInstall(e) { e.preventDefault(); installEvt.value = e; }
async function install() {
  const e = installEvt.value;
  if (!e) { toast('请在浏览器菜单里点「安装应用 / 添加到主屏幕」', 'info'); return; }
  e.prompt();
  const r = await e.userChoice;
  if (r.outcome === 'accepted') installEvt.value = null;
}

const showIntro = ref(false);
const showGuide = ref(false);
function beginOnboarding() { showGuide.value = false; showIntro.value = true; }
function onIntroEnd() { showIntro.value = false; showGuide.value = true; }
function onGuideEnd() { showGuide.value = false; localStorage.setItem('sxy_onboarding_done', '1'); }
function replayOnboarding() { showSettings.value = false; beginOnboarding(); }

// 设置按钮拖拽（pointer 事件，统一鼠标/触摸，与 AI 助手一致）
const fabEl = ref(null);
const fabPos = ref(null);
let fDrag = false, fMoved = false, fSx = 0, fSy = 0, fOx = 0, fOy = 0, fDownAt = 0;
const FAB_CLICK_DIST = 14; // 移动端手指点按天然抖动：曼哈顿距离放宽到 14（≈ 欧式 ~10px）
const FAB_CLICK_MS = 250;   // 按下-抬起在 250ms 内无条件当点击（避免抖动误判）
function fabDown(e) {
  fDrag = true; fMoved = false; fSx = e.clientX; fSy = e.clientY; fDownAt = Date.now();
  const r = fabEl.value.getBoundingClientRect(); fOx = r.left; fOy = r.top;
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
}
function fabMove(e) {
  if (!fDrag) return;
  const dx = e.clientX - fSx, dy = e.clientY - fSy;
  // 仅当超过判定阈值 + 超出点击短按时窗 才认为是真的拖动
  const dist = Math.abs(dx) + Math.abs(dy);
  const elapsed = Date.now() - fDownAt;
  if (dist > FAB_CLICK_DIST && elapsed > 80) fMoved = true;
  if (fMoved) {
    e.preventDefault?.();
    fabPos.value = { left: fOx + dx, top: fOy + dy };
  }
}
function fabUp() {
  const elapsed = Date.now() - fDownAt;
  fDrag = false;
  // 250ms 内的短按，或者没有超过距离阈值 → 视为点击
  if (elapsed <= FAB_CLICK_MS || !fMoved) showSettings.value = !showSettings.value;
}

onMounted(() => {
  theme.apply();
  loadCoreNavs();
  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  if (!localStorage.getItem('sxy_onboarding_done')) beginOnboarding();
  startReminderLoop();
  // 日程表到点提醒（全局调度，任何路由打开都生效）
  stopPlanReminder = startReminderScheduler();
  // 主动智能体：后台轮询学习数据，主动推送建议到通知中心
  getProactiveScheduler().start({ cfgGetter: () => getAIConfig() });

  // P3-2 PWA：订阅在线/离线变化、SW 新版本、配额告警
  //   initPwa 已在 main.js 启动，这里仅订阅 UI 事件
  unsubOnline = subscribeOnline((isOn) => {
    online.value = isOn;
    if (!isOn) toast('已切换到离线模式，数据将保存在本地，联网后自动同步', 'info');
  });
  unsubSwUpdate = subscribeSwUpdate((need) => {
    if (need && !swUpdateDismissed.value) swNeedRefresh.value = true;
  });
  unsubOfflineReady = subscribeOfflineReady(() => {
    swOfflineReady.value = true;
    // 离线就绪一次性提示，仅在非打扰时段（不打断首次启动 onboarding）
    if (localStorage.getItem('sxy_onboarding_done')) {
      toast('应用已可离线使用，断网也能复习卡片', 'success');
    }
  });
  unsubQuotaWarn = subscribeQuotaWarn((info) => {
    quotaWarn.value = info;
    toast(`本地存储已用 ${info.usagePercent}%，建议导出备份后清理旧数据`, 'warn');
  });
  // 启动时尝试申请持久化存储（避免浏览器在 quota 紧张时回收 IndexedDB）
  requestPersistentStorage().then(() => { getStorageEstimate().then(e => { storageEstimate.value = e; storageUnsupported.value = e && e.unsupported || null; }); });
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  clearInterval(reminderTimer);
  stopPlanReminder?.();
  getProactiveScheduler().stop();
  unsubOnline?.(); unsubSwUpdate?.(); unsubOfflineReady?.(); unsubQuotaWarn?.();
});

// ---- C6 复习提醒（2026-08-26 速赢区升级）：3 条件独立触发 + 丰富通知内容 ----
// 触发器：① 到点（用户设置的时间） ② 长时间未复习（≥3h 未复习且未达标） ③ 待复习堆积（≥15 张未清且未达标）
// 每个条件当日只触发一次；当日达标也只发一次庆祝
const remindTime = ref(localStorage.getItem('sxy_remind_time') || '');
let reminderTimer = null;
let stopPlanReminder = null;   // 日程表到点提醒调度器的 stop 函数
const REMINDER_KEYS = { time: 'sxy_remind_today_time', idle: 'sxy_remind_today_idle', pile: 'sxy_remind_today_pile' };
const IDLE_HOURS = 3;
const PILE_THRESHOLD = 15;
const todayKey = () => new Date().toDateString();
const alreadyFired = (k) => localStorage.getItem(REMINDER_KEYS[k]) === todayKey();
const markFired = (k) => localStorage.setItem(REMINDER_KEYS[k], todayKey());
function pickNudge(diff) {
  if (diff <= 3) return '就差几颗草莓啦，再坚持一下！';
  if (diff <= 10) return '趁热打铁，复习一两张就能赶上进度。';
  return '别让进度落后太多，先来背 5 张暖个身？';
}
function startReminderLoop() {
  clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminder, 60 * 1000);
}
async function checkReminder() {
  if (['time', 'idle', 'pile'].every(alreadyFired)) return;
  try {
    const [goal, done, due, lastTs, bySubj] = await Promise.all([
      getGoal(), getTodayCount(), getDueCount(), getLastReviewTs(), getDueBySubject(5),
    ]);
    const t = (localStorage.getItem('sxy_remind_time') || '').trim();
    const idleMs = Date.now() - lastTs;
    const idleEnough = lastTs === 0 || idleMs > IDLE_HOURS * 3600 * 1000;
    const pileEnough = due >= PILE_THRESHOLD;

    // 条件 1：到点提醒（需用户配置时间且未达标）
    // 时刻比较必须走分钟级数值比较：原实现用字符串比较且小时未补零，
    // 导致 "9:05" >= "21:30" 恒真 —— 21:30 的提醒早上 9 点就触发并占掉当日名额。
    if (!alreadyFired('time') && hasReached(t) && done < goal) {
      sendNotify('SxyBrick 复习提醒', `今日 ${done}/${goal} 张，还差 ${goal - done} 张。${pickNudge(goal - done)}`);
      markFired('time');
      return;
    }
    // 条件 2：长时间未复习（且未达标）
    if (!alreadyFired('idle') && idleEnough && done < goal) {
      const hours = lastTs ? Math.max(1, Math.floor(idleMs / 3600000)) : 24;
      sendNotify('SxyBrick · 该回来啦', `已 ${hours} 小时没复习了，今日还差 ${goal - done} 张。${pickNudge(goal - done)}`);
      markFired('idle');
      return;
    }
    // 条件 3：待复习堆积（通知正文含科目明细）
    if (!alreadyFired('pile') && pileEnough && done < goal) {
      const subjList = bySubj.map(([k, n]) => `${k} ${n} 张`).slice(0, 3).join(' · ');
      sendNotify('SxyBrick · 待复习堆积', `待复习 ${due} 张${subjList ? '（' + subjList + '）' : ''}，趁早清一清。`);
      markFired('pile');
      return;
    }
    // 已达标：当日只发一次庆祝（复用 time 槽位）
    if (done >= goal && !alreadyFired('time')) {
      sendNotify('SxyBrick', '今日目标已达成，继续保持！');
      markFired('time');
    }
  } catch { /* db 未就绪时静默 */ }
}
async function enableReminder() {
  const t = (remindTime.value || '').trim();
  if (!t) { toast('请先填写提醒时间（如 21:30）', 'error'); return; }
  if (parseHm(t) == null) { toast('时间格式不正确，请填 24 小时制的 时:分（如 21:30）', 'error'); return; }
  const perm = await ensureNotifyPermission();
  if (perm !== 'granted') { toast('浏览器通知权限被拒绝，请在浏览器设置里允许本网站通知', 'error'); return; }
  localStorage.setItem('sxy_remind_time', t);
  Object.values(REMINDER_KEYS).forEach(k => localStorage.removeItem(k));
  toast(`已开启每日 ${t} 复习提醒（应用打开时生效，另含"未复习 3h"与"待复习堆积"自动提醒）`, 'success');
}
</script>

<template>
  <div class="app-shell" :class="{ 'no-anim': degraded }">
    <InkLandscape v-if="theme.style === 'guofeng'" :active="theme.style === 'guofeng'" :reduced="degraded" />
    <!-- P3-2 PWA 状态条：离线指示 + 新版本可用 + 配额告警（顶部非遮挡式横条） -->
    <div class="pwa-bar no-print">
      <div v-if="!online" class="pwa-chip pwa-offline" title="当前离线，数据保存在本地，联网后自动同步">
        <span>📵</span><span>离线模式</span>
      </div>
      <div v-if="swNeedRefresh" class="pwa-chip pwa-update" title="应用新版本已下载完毕，点击立即更新">
        <span>🆕</span><span>有新版本可用</span>
        <button class="pwa-act" @click="reloadForUpdate">立即更新</button>
        <button class="pwa-dismiss" @click="dismissSwUpdate" title="本次忽略">×</button>
      </div>
      <div v-else-if="quotaWarn" class="pwa-chip pwa-quota" :title="`已用 ${quotaWarn.usagePercent}%（${fmtBytes(quotaWarn.usage)} / ${fmtBytes(quotaWarn.quota)}），建议导出备份后清理旧数据`">
        <span>💾</span><span>本地存储已用 {{ quotaWarn.usagePercent }}%</span>
      </div>
    </div>
    <!-- M3 演示模式横幅：测试数据与真实数据完全隔离，退出后回到真实数据 -->
    <div v-if="appMode.isTest" class="demo-banner no-print" role="status">
      <span>🧪 演示模式：当前操作的是示例测试数据，与真实数据完全隔离</span>
      <button class="pwa-act" @click="resetDemoData">重置示例数据</button>
      <button class="pwa-act pwa-act-primary" @click="exitDemoMode">退出演示模式</button>
    </div>
    <div v-else class="demo-banner demo-banner-off no-print" role="status">
      <span>🧪 想试试功能？</span>
      <button class="pwa-act" @click="enterDemoMode">进入演示模式（加载示例数据，不影响真实数据）</button>
    </div>
    <NavBar :variant="theme.style === 'custom' ? 'focus' : theme.style" :navItems="navItems" :coreNavs="coreNavs" :hasCoreSetting="hasCoreSetting" />

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <ErrorBoundary><component :is="Component" /></ErrorBoundary>
        </transition>
      </router-view>
    </main>

    <!-- 全局设置入口（可拖动） -->
    <button ref="fabEl" class="settings-fab no-print" :style="fabPos ? { left: fabPos.left + 'px', top: fabPos.top + 'px', right: 'auto' } : {}"
      @pointerdown="fabDown" @pointermove="fabMove" @pointerup="fabUp" @pointercancel="fabUp">🎨</button>

    <div v-if="degraded" class="hint" style="position:fixed;bottom:8px;right:12px;z-index:200">已启用性能优化模式</div>
    <FloatAssistant />
    <NotificationBell />
    <!-- 日程表到点提醒视觉浮层（全局，任何路由生效） -->
    <PlanReminderLayer />
    <Intro v-if="showIntro" @done="onIntroEnd" />
    <Guide v-if="showGuide" @done="onGuideEnd" />

    <!-- 设置面板：标签页组织（外观 / 提醒与监控 / 学习引擎 / 导航 / 存储） -->
    <teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1" ref="settingsModal" @keydown="onSettingsKeydown">
          <h3 id="settings-title" style="margin-top:0">设置中心</h3>
          <el-tabs v-model="settingsTab">
            <el-tab-pane label="🎨 外观" name="appearance">
              <div class="field-label">配色模式（全局通用，适用于每一种风格）</div>
              <div class="mode-row">
                <button v-for="m in MODES" :key="m.id" class="chip" :class="{ on: theme.mode === m.id }" @click="theme.setMode(m.id)">{{ m.name }}</button>
              </div>
              <div class="field-label" style="margin-top:12px">界面风格（布局 / 交互 / 质感差异）</div>
              <div class="style-grid">
                <div v-for="s in STYLES" :key="s.id" class="style-card" :class="{ on: theme.style === s.id }" @click="theme.setStyle(s.id)">
                  <div class="style-icon">{{ s.icon }}</div>
                  <div class="style-name">{{ s.name }}</div>
                  <div class="style-desc">{{ s.desc }}</div>
                </div>
                <div class="style-card" :class="{ on: theme.style === 'custom' }" @click="theme.setStyle('custom')">
                  <div class="style-icon">🎨</div>
                  <div class="style-name">自定义</div>
                  <div class="style-desc">选个专属色，生成我的主题</div>
                </div>
              </div>
              <div v-if="theme.style === 'custom'" class="field-label" style="margin-top:12px">
                专属色相（{{ theme.customHue }}°）· 三个配色模式都可用
              </div>
              <div v-if="theme.style === 'custom'" style="display:flex;align-items:center;gap:14px">
                <el-slider :model-value="theme.customHue" :min="0" :max="360" style="flex:1" @input="theme.setCustomHue($event)" />
                <span class="hue-dot" :style="{ background: `hsl(${theme.customHue} 72% 45%)` }"></span>
              </div>
              <div class="field-label" style="margin-top:16px">界面字体</div>
              <div class="mode-row">
                <button v-for="f in FONTS" :key="f.id" class="chip" :class="{ on: theme.font === f.id }" @click="theme.setFont(f.id)">{{ f.name }}</button>
              </div>
            </el-tab-pane>

            <el-tab-pane label="⏰ 提醒与监控" name="remind">
              <div class="field-label">复习提醒（应用打开时生效，当日只提醒一次）</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <el-input v-model="remindTime" style="width:130px" placeholder="如 21:30" clearable />
                <el-button type="primary" size="small" @click="enableReminder">开启提醒</el-button>
                <span class="hint">提醒时未达标会通知你差几张</span>
              </div>
              <div class="field-label" style="margin-top:16px">🛰️ 操作监控（恐怖级埋点）</div>
              <div class="hint" style="margin-bottom:8px">
                A 级 = 业务大事件（背诵评分、导出、同步、AI 调用、番茄、模考等）；B 级 = DOM 级点击/选择（按钮、chip、卡片、选择框）。<br/>
                数据仅存本地 IndexedDB，可跨设备同步；一键导出 / 一键清空都在「导出打印」页面的危险区。
              </div>
              <div style="display:flex;flex-direction:column;gap:12px;padding:4px 2px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                  <span>启用 A 级业务埋点</span>
                  <el-switch :model-value="telA" @change="onToggleTelA" />
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                  <span>启用 B 级 DOM 交互埋点</span>
                  <el-switch :model-value="telB" @change="onToggleTelB" />
                </div>
              </div>
            </el-tab-pane>

            <el-tab-pane label="🧠 学习引擎" name="engine">
              <div class="field-label">复习调度器（记忆曲线算法）</div>
              <div class="hint" style="margin-bottom:8px">
                SM-2（默认）= 含短期巩固与错因惩罚的变体；FSRS = 基于机器学习的遗忘曲线，实测可省 20~30% 复习时间达到同等保持率。<br/>
                切到 FSRS 后建议点「训练权重」用你的真实评分历史拟合 19 个参数（样本 ≥8 次可用，越多越准）。
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
                <span>启用 FSRS 调度（opt-in，默认 SM-2）</span>
                <el-switch :model-value="scheduler === 'fsrs'" @change="onToggleScheduler" />
              </div>
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <el-button size="small" :loading="fsrsTraining" @click="trainFsrs">
                  {{ fsrsTraining ? '训练中…' : '训练权重' }}
                </el-button>
                <span v-if="fsrsInfo" class="hint">
                  上次：{{ fsrsInfo.samples }} 样本{{ fsrsInfo.loss != null ? ' · 损失 ' + (+fsrsInfo.loss).toFixed(3) : '' }}
                </span>
              </div>
            </el-tab-pane>

            <el-tab-pane label="🧭 导航" name="nav">
              <div class="field-label">功能精简（自定义核心导航）</div>
              <div class="hint" style="margin-bottom:8px">
                勾选的项常驻导航栏；未勾选的折叠到「更多 ▼」展开菜单。<br/>
                首次勾选后即生效并保存到本地；未设置时默认全部显示（向后兼容）。
              </div>
              <div class="core-nav-grid">
                <label v-for="item in navItems" :key="item.path" class="core-nav-item" :class="{ on: isCoreNav(item.path) }">
                  <input type="checkbox" :checked="isCoreNav(item.path)" @change="toggleCoreNav(item.path, $event.target.checked)" />
                  <span class="core-nav-icon">{{ item.icon }}</span>
                  <span>{{ item.label }}</span>
                </label>
              </div>
            </el-tab-pane>

            <el-tab-pane label="💾 存储" name="storage">
              <div class="field-label">离线与存储</div>
              <div class="hint" style="margin-bottom:8px">应用已注册为 PWA，可「装到桌面」断网使用。本地数据保存在浏览器 IndexedDB。</div>
              <div v-if="storageEstimate && !storageEstimate.unsupported" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <el-progress
                  :percentage="Math.round(storageEstimate.usagePercent)"
                  :stroke-width="14"
                  :status="storageEstimate.usagePercent >= 85 ? 'exception' : undefined"
                  style="flex:1;min-width:180px"
                />
                <span class="storage-text" style="white-space:nowrap">{{ fmtBytes(storageEstimate.usage) }} / {{ fmtBytes(storageEstimate.quota) }} · {{ storageEstimate.usagePercent }}%</span>
              </div>
              <div v-else-if="storageUnsupported === 'insecure'" class="hint">
                当前通过<strong>局域网 / 非 HTTPS</strong>地址访问，浏览器禁用了存储配额 API，故无法显示精确占用。<br/>
                本地数据仍正常保存（不受影响）；用 <code>localhost</code> 或 <code>https://</code> 打开即可查看精确配额。
              </div>
              <div v-else class="hint">当前浏览器不支持存储配额查询。</div>
              <div class="hint" v-if="swOfflineReady" style="color:var(--accent)">✓ 离线缓存已就绪，断网可正常打开与复习</div>

              <ResetAllData />
            </el-tab-pane>
          </el-tabs>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:8px">
            <el-button size="small" @click="replayOnboarding">新手指引</el-button>
            <el-button v-if="installEvt" size="small" type="primary" @click="install">装到桌面</el-button>
            <el-button @click="showSettings = false">关闭</el-button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.settings-fab { position: fixed; top: 12px; right: 14px; z-index: 70; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); cursor: pointer; font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,.12); touch-action: none; -webkit-user-select: none; user-select: none; }
/* P3-2 PWA 状态条：顶部非遮挡式横条，离线 / 新版本 / 配额告警 */
.pwa-bar { position: sticky; top: 0; z-index: 90; display: flex; gap: 8px; padding: 0 12px; background: var(--panel); border-bottom: 1px solid var(--line); pointer-events: none; min-height: 0; }
.pwa-bar:empty { display: none; }
.pwa-chip { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; margin: 4px 0; padding: 4px 10px; border-radius: 12px; font-size: 12px; color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
.pwa-offline { background: #6b7280; }
.pwa-update { background: #16a34a; }
.pwa-quota { background: #d97706; }
.pwa-act { margin-left: 4px; padding: 1px 8px; border: none; border-radius: 8px; background: rgba(255,255,255,.22); color: #fff; font-size: 12px; cursor: pointer; }
.pwa-act:hover { background: rgba(255,255,255,.34); }
.pwa-dismiss { margin-left: 2px; width: 18px; height: 18px; border: none; border-radius: 50%; background: rgba(255,255,255,.22); color: #fff; font-size: 14px; line-height: 1; cursor: pointer; }
.pwa-dismiss:hover { background: rgba(255,255,255,.4); }
/* M3 演示模式横幅：醒目但轻量，移动端单行可换行 */
.demo-banner { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 5px 12px; font-size: 13px; }
.demo-banner span { flex: 1; min-width: 0; }
.demo-banner:not(.demo-banner-off) { background: #fff7e6; color: #874d00; border-bottom: 1px solid #ffd591; }
.demo-banner-off { background: var(--panel); color: var(--ink-2); border-bottom: 1px solid var(--line); font-size: 12px; }
.demo-banner .pwa-act { margin-left: 0; background: rgba(0,0,0,.06); color: inherit; }
.demo-banner .pwa-act:hover { background: rgba(0,0,0,.12); }
.demo-banner .pwa-act-primary { background: #1677ff; color: #fff; }
.demo-banner .pwa-act-primary:hover { background: #0958d9; }
/* 设置面板：存储占用条 */
.storage-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.storage-bar { flex: 1; height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
.storage-bar-fill { height: 100%; background: var(--accent); transition: width .3s; }
.storage-bar-fill.warn { background: #d97706; }
.storage-text { font-size: 12px; color: var(--ink-2); white-space: nowrap; }
.mode-row { display: flex; gap: 8px; flex-wrap: wrap; }
.style-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.style-card { border: 2px solid var(--line); border-radius: 12px; padding: 12px 8px; cursor: pointer; text-align: center; transition: .15s; }
.style-card:hover { border-color: var(--accent); }
.style-card.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--line); }
.style-icon { font-size: 26px; transition: transform .25s cubic-bezier(.34, 1.56, .64, 1); }
.style-card.on .style-icon { animation: icon-pop .4s cubic-bezier(.34, 1.56, .64, 1); }
@keyframes icon-pop {
  0% { transform: scale(1); }
  40% { transform: scale(1.28) rotate(-6deg); }
  70% { transform: scale(.94) rotate(2deg); }
  100% { transform: scale(1); }
}
.style-name { font-weight: 600; font-size: 14px; margin-top: 6px; }
.style-desc { font-size: 11px; color: var(--ink-2); margin-top: 2px; line-height: 1.4; }
.hue-slider { flex: 1; max-width: 240px; accent-color: var(--accent); }
.hue-dot { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px var(--line); flex: none; }
@media (max-width: 720px) { .style-grid { grid-template-columns: repeat(2, 1fr); } }

/* 功能精简：核心导航勾选网格 */
.core-nav-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 10px; margin-top: 8px; }
.core-nav-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; border: 1px solid var(--line); transition: .15s; }
.core-nav-item:hover { border-color: var(--accent); }
.core-nav-item.on { border-color: var(--accent); background: var(--code-inline); }
.core-nav-icon { font-size: 16px; }
@media (max-width: 720px) { .core-nav-grid { grid-template-columns: repeat(3, 1fr); } }
</style>
