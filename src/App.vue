<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { toasts, toast } from './utils/toast.js';
import { degraded } from './utils/perf.js';
import FloatAssistant from './components/FloatAssistant.vue';
import Intro from './components/Intro.vue';
import Guide from './components/Guide.vue';

const THEMES = ['light', 'dark', 'eye'];
const theme = ref(localStorage.getItem('sxy_theme') || 'light');

function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme.value);
}
function toggleTheme() {
  const i = THEMES.indexOf(theme.value);
  theme.value = THEMES[(i + 1) % THEMES.length];
}
const themeLabel = computed(() => theme.value === 'light' ? '亮色' : theme.value === 'dark' ? '暗色' : '护眼');

const installEvt = ref(null);
function onBeforeInstall(e) {
  e.preventDefault();
  installEvt.value = e;
}
async function install() {
  const e = installEvt.value;
  if (!e) { toast('请在浏览器菜单里点「安装应用 / 添加到主屏幕」', 'info'); return; }
  e.prompt();
  const r = await e.userChoice;
  if (r.outcome === 'accepted') installEvt.value = null;
}

watch(theme, (v) => { localStorage.setItem('sxy_theme', v); applyTheme(); });

const showIntro = ref(false);
const showGuide = ref(false);
function beginOnboarding() { showGuide.value = false; showIntro.value = true; }
function onIntroEnd() { showIntro.value = false; showGuide.value = true; }
function onGuideEnd() { showGuide.value = false; localStorage.setItem('sxy_onboarding_done', '1'); }
function replayOnboarding() { beginOnboarding(); }

onMounted(() => {
  applyTheme();
  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  if (!localStorage.getItem('sxy_onboarding_done')) beginOnboarding();
});
onBeforeUnmount(() => window.removeEventListener('beforeinstallprompt', onBeforeInstall));
</script>

<template>
  <div class="app-shell" :class="{ 'no-anim': degraded }">
    <nav class="app-nav no-print">
      <span class="brand">SxyBrick 记忆卡片</span>
      <router-link to="/">我的卡片</router-link>
      <router-link to="/review">背诵</router-link>
      <router-link to="/stats">数据</router-link>
      <router-link to="/export">导出打印</router-link>
      <router-link to="/sync">同步</router-link>
      <router-link to="/ai">AI助手</router-link>
      <router-link to="/agent">Agent工作台</router-link>
      <router-link to="/feynman">费曼</router-link>
      <router-link to="/memo">备忘</router-link>
      <router-link to="/wrong">错题集</router-link>
      <router-link to="/pomodoro">番茄钟</router-link>
      <router-link to="/graph">图谱</router-link>
      <button class="btn small" style="margin-left:auto" @click="toggleTheme">{{ themeLabel }}</button>
      <button class="btn small" @click="replayOnboarding">引导</button>
      <button v-if="installEvt" class="btn small primary" @click="install">装到桌面</button>
    </nav>
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
    </div>
    <div v-if="degraded" class="hint" style="position:fixed;bottom:8px;right:12px;z-index:200">
      已启用性能优化模式
    </div>
    <FloatAssistant />
    <Intro v-if="showIntro" @done="onIntroEnd" />
    <Guide v-if="showGuide" @done="onGuideEnd" />
  </div>
</template>