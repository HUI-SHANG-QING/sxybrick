<script setup>
import { ref, onMounted, onBeforeUnmount, defineAsyncComponent, watch } from 'vue';
import { toast } from './utils/toast.js';
import { degraded } from './utils/perf.js';
import { ensureNotifyPermission, sendNotify } from './utils/notify.js';
import { getGoal, getTodayCount, getDueCount, getLastReviewTs, getDueBySubject } from './utils/streak.js';
// FloatAssistant / NavBar 首屏必需，保留同步
import FloatAssistant from './components/FloatAssistant.vue';
import NavBar from './components/NavBar.vue';
// NotificationBell 首屏必需（通知铃铛），保留同步
import NotificationBell from './components/NotificationBell.vue';
import ErrorBoundary from './components/ErrorBoundary.vue';
// Intro/Guide 仅首次访问时显示、InkLandscape 仅国风主题激活时显示 → 异步加载以减小首屏 chunk
const Intro = defineAsyncComponent(() => import('./components/Intro.vue'));
const Guide = defineAsyncComponent(() => import('./components/Guide.vue'));
const InkLandscape = defineAsyncComponent(() => import('./components/InkLandscape.vue'));
import { useThemeStore, STYLES, MODES } from './stores/theme.js';
import { getProactiveScheduler } from './agent/proactive.js';
import { getAIConfig } from './ai.js';
// P1·7 埋点开关：在设置面板允许用户开/关 A/B 级
import { isAEnabled, isBEnabled, setAEnabled, setBEnabled } from './utils/telemetry.js';

const theme = useThemeStore();
const showSettings = ref(false);

const navItems = [
  { path: '/', label: '总览', icon: '📊' },
  { path: '/cards', label: '卡片', icon: '🗂️' },
  { path: '/review', label: '背诵', icon: '📖' },
  { path: '/stats', label: '数据', icon: '📊' },
  { path: '/export', label: '导出', icon: '🖨️' },
  { path: '/sync', label: '同步', icon: '🔄' },
  { path: '/ai', label: 'AI', icon: '🤖' },
  { path: '/agent', label: 'Agent', icon: '🧠' },
  { path: '/feynman', label: '费曼', icon: '👨‍🏫' },
  { path: '/memo', label: '备忘', icon: '📝' },
  { path: '/wrong', label: '错题', icon: '❌' },
  { path: '/pomodoro', label: '番茄', icon: '🍅' },
  { path: '/graph', label: '图谱', icon: '🕸️' },
  { path: '/mindmap', label: '导图', icon: '🗺️' },
  { path: '/plans', label: '计划', icon: '🎯' },
  { path: '/docs', label: '文档', icon: '📄' },
  { path: '/weekly', label: '周报', icon: '📈' },
  { path: '/exam', label: '模考', icon: '🧪' },
  { path: '/search', label: '搜索', icon: '🔍' },
  { path: '/health', label: '体检', icon: '🩺' },
  { path: '/library', label: '书房', icon: '📚' },
  { path: '/achievements', label: '成就', icon: '🏆' },
  // P2·10 + P3·11：用户仪表盘（恐怖监控图表）与隐私人生数据（超级监控）
  { path: '/user-dashboard', label: '仪表盘', icon: '🛰️' },
  { path: '/privacy', label: '隐私', icon: '🧾' },
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
  if (open) { telA.value = isAEnabled(); telB.value = isBEnabled(); }
});

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
  // 主动智能体：后台轮询学习数据，主动推送建议到通知中心
  getProactiveScheduler().start({ cfgGetter: () => getAIConfig() });
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  clearInterval(reminderTimer);
  getProactiveScheduler().stop();
});

// ---- C6 复习提醒（2026-08-26 速赢区升级）：3 条件独立触发 + 丰富通知内容 ----
// 触发器：① 到点（用户设置的时间） ② 长时间未复习（≥3h 未复习且未达标） ③ 待复习堆积（≥15 张未清且未达标）
// 每个条件当日只触发一次；当日达标也只发一次庆祝
const remindTime = ref(localStorage.getItem('sxy_remind_time') || '');
let reminderTimer = null;
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
    const d = new Date();
    const now = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const t = (localStorage.getItem('sxy_remind_time') || '').trim();
    const idleMs = Date.now() - lastTs;
    const idleEnough = lastTs === 0 || idleMs > IDLE_HOURS * 3600 * 1000;
    const pileEnough = due >= PILE_THRESHOLD;

    // 条件 1：到点提醒（需用户配置时间且未达标）
    if (!alreadyFired('time') && t && /^\d{1,2}:\d{2}$/.test(t) && now >= t && done < goal) {
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
    <Intro v-if="showIntro" @done="onIntroEnd" />
    <Guide v-if="showGuide" @done="onGuideEnd" />

    <!-- 设置面板：风格 + 配色模式 -->
    <teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal settings-modal">
          <h3 style="margin-top:0">界面风格与配色</h3>
          <div class="field-label">配色模式（全局通用，适用于每一种风格）</div>
          <div class="mode-row">
            <button v-for="m in MODES" :key="m.id" class="chip" :class="{ on: theme.mode === m.id }" @click="theme.setMode(m.id)">{{ m.name }}</button>
          </div>

          <div class="field-label">界面风格（布局 / 交互 / 质感差异）</div>
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
          <div v-if="theme.style === 'custom'" style="display:flex;align-items:center;gap:10px">
            <input type="range" min="0" max="360" :value="theme.customHue" class="hue-slider"
              @input="theme.setCustomHue($event.target.value)" />
            <span class="hue-dot" :style="{ background: `hsl(${theme.customHue} 72% 45%)` }"></span>
          </div>

          <div class="field-label">复习提醒（应用打开时生效，当日只提醒一次）</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input v-model="remindTime" class="input" style="width:110px" placeholder="如 21:30" />
            <button class="btn small primary" @click="enableReminder">开启提醒</button>
            <span class="hint">提醒时未达标会通知你差几张</span>
          </div>

          <div class="field-label" style="margin-top:16px">🛰️ 操作监控（恐怖级埋点）</div>
          <div class="hint" style="margin-bottom:8px">
            A 级 = 业务大事件（背诵评分、导出、同步、AI 调用、番茄、模考等）；B 级 = DOM 级点击/选择（按钮、chip、卡片、选择框）。<br/>
            数据仅存本地 IndexedDB，可跨设备同步；一键导出 / 一键清空都在「导出打印」页面的危险区。
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
            <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
              <input type="checkbox" :checked="telA" @change="onToggleTelA($event.target.checked)" />
              <span>启用 A 级业务埋点</span>
            </label>
            <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
              <input type="checkbox" :checked="telB" @change="onToggleTelB($event.target.checked)" />
              <span>启用 B 级 DOM 交互埋点</span>
            </label>
          </div>

          <div class="field-label" style="margin-top:16px">🧭 功能精简（自定义核心导航）</div>
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

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:8px">
            <button class="btn small" @click="replayOnboarding">新手指引</button>
            <button v-if="installEvt" class="btn small primary" @click="install">装到桌面</button>
            <button class="btn" @click="showSettings = false">关闭</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.settings-fab { position: fixed; top: 12px; right: 14px; z-index: 70; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); cursor: pointer; font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,.12); touch-action: none; -webkit-user-select: none; user-select: none; }
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
