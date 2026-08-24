<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { toasts, toast } from './utils/toast.js';
import { degraded } from './utils/perf.js';
import FloatAssistant from './components/FloatAssistant.vue';
import NavBar from './components/NavBar.vue';
import Intro from './components/Intro.vue';
import Guide from './components/Guide.vue';

// ---------- 风格（布局/交互/质感，结构差异大） ----------
const STYLES = [
  { id: 'classic', name: '经典', desc: '顶部导航 · 简洁扁平', icon: '☰' },
  { id: 'compass', name: '罗盘', desc: '环形罗盘 · 径向导航', icon: '◎' },
  { id: 'revolver', name: '左轮', desc: '转轮手枪 · 6 孔位射击', icon: '➳' },
  { id: 'cartoon', name: '萌系', desc: '卡通角色 · 点击互动+音效', icon: '♡' },
  { id: 'puzzle', name: '解密', desc: '解密游戏 · 线索卡菜单', icon: '✧' },
  { id: 'scifi', name: '科幻', desc: '霓虹玻璃 · 左侧轨道', icon: '◈' },
];
// ---------- 配色模式（全局通用，适用于每一种风格） ----------
const MODES = [
  { id: 'light', name: '白天' },
  { id: 'dark', name: '夜间' },
  { id: 'eye', name: '护眼' },
];

const style = ref(localStorage.getItem('sxy_style') || 'classic');
const mode = ref(localStorage.getItem('sxy_mode') || 'light');
const showSettings = ref(false);

function apply() {
  const el = document.documentElement;
  el.setAttribute('data-style', style.value);
  el.setAttribute('data-theme', mode.value);
}
const styleLabel = computed(() => STYLES.find(s => s.id === style.value)?.name || '经典');
const modeLabel = computed(() => MODES.find(m => m.id === mode.value)?.name || '白天');
watch([style, mode], () => { localStorage.setItem('sxy_style', style.value); localStorage.setItem('sxy_mode', mode.value); apply(); });

const navItems = [
  { path: '/', label: '卡片', icon: '🗂️' },
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
  { path: '/plans', label: '计划', icon: '🎯' },
  { path: '/docs', label: '文档', icon: '📄' },
];

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

onMounted(() => {
  apply();
  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  if (!localStorage.getItem('sxy_onboarding_done')) beginOnboarding();
});
onBeforeUnmount(() => window.removeEventListener('beforeinstallprompt', onBeforeInstall));
</script>

<template>
  <div class="app-shell" :class="{ 'no-anim': degraded, 'rail-style': style === 'scifi' }">
    <NavBar :variant="style" :navItems="navItems" />

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!-- 全局设置入口（所有风格下都在右上角） -->
    <button class="settings-fab no-print" @click="showSettings = !showSettings">🎨</button>

    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
    </div>
    <div v-if="degraded" class="hint" style="position:fixed;bottom:8px;right:12px;z-index:200">已启用性能优化模式</div>
    <FloatAssistant />
    <Intro v-if="showIntro" @done="onIntroEnd" />
    <Guide v-if="showGuide" @done="onGuideEnd" />

    <!-- 设置面板：风格 + 配色模式 -->
    <teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal settings-modal">
          <h3 style="margin-top:0">界面风格与配色</h3>
          <div class="field-label">配色模式（全局通用，适用于每一种风格）</div>
          <div class="mode-row">
            <button v-for="m in MODES" :key="m.id" class="chip" :class="{ on: mode === m.id }" @click="mode = m.id">{{ m.name }}</button>
          </div>

          <div class="field-label">界面风格（布局 / 交互 / 质感差异）</div>
          <div class="style-grid">
            <div v-for="s in STYLES" :key="s.id" class="style-card" :class="{ on: style === s.id }" @click="style = s.id">
              <div class="style-icon">{{ s.icon }}</div>
              <div class="style-name">{{ s.name }}</div>
              <div class="style-desc">{{ s.desc }}</div>
            </div>
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
.settings-fab { position: fixed; top: 12px; right: 14px; z-index: 70; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); cursor: pointer; font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,.12); }
.mode-row { display: flex; gap: 8px; flex-wrap: wrap; }
.style-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.style-card { border: 2px solid var(--line); border-radius: 12px; padding: 12px 8px; cursor: pointer; text-align: center; transition: .15s; }
.style-card:hover { border-color: var(--accent); }
.style-card.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--line); }
.style-icon { font-size: 26px; }
.style-name { font-weight: 600; font-size: 14px; margin-top: 6px; }
.style-desc { font-size: 11px; color: var(--ink-2); margin-top: 2px; line-height: 1.4; }
@media (max-width: 720px) { .style-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
