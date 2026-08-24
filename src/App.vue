<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { toasts, toast } from './utils/toast.js';
import { degraded } from './utils/perf.js';
import FloatAssistant from './components/FloatAssistant.vue';
import Intro from './components/Intro.vue';
import Guide from './components/Guide.vue';

// ---------- 全局风格系统（结构差异大，非仅换色） ----------
const STYLES = [
  { id: 'classic', name: '经典', desc: '简洁顶部导航 · 浅色扁平', icon: '☰', swatch: ['#f5f6f8', '#16202c'] },
  { id: 'compass', name: '罗盘', desc: '环形径向导航 · 暖色古铜', icon: '◎', swatch: ['#f6efe4', '#8a5a2b'] },
  { id: 'astro', name: '星盘', desc: '星空星座导航 · 深空紫蓝', icon: '✦', swatch: ['#0b1020', '#7c8cff'] },
  { id: 'scifi', name: '科幻', desc: '霓虹玻璃 · 左侧轨道', icon: '◈', swatch: ['#05070d', '#00e5ff'] },
];
const style = ref(localStorage.getItem('sxy_style') || 'classic');
const showStylePicker = ref(false);
const styleLabel = computed(() => STYLES.find(s => s.id === style.value)?.name || '经典');

function applyStyle() {
  const el = document.documentElement;
  el.setAttribute('data-style', style.value);
  const map = { classic: 'light', compass: 'light', astro: 'dark', scifi: 'dark' };
  el.setAttribute('data-theme', map[style.value] || 'light');
}
function chooseStyle(id) { style.value = id; showStylePicker.value = false; }
watch(style, (v) => { localStorage.setItem('sxy_style', v); applyStyle(); });

const navItems = [
  { path: '/', label: '我的卡片' },
  { path: '/review', label: '背诵' },
  { path: '/stats', label: '数据' },
  { path: '/export', label: '导出' },
  { path: '/sync', label: '同步' },
  { path: '/ai', label: 'AI助手' },
  { path: '/agent', label: 'Agent' },
  { path: '/feynman', label: '费曼' },
  { path: '/memo', label: '备忘' },
  { path: '/wrong', label: '错题' },
  { path: '/pomodoro', label: '番茄' },
  { path: '/graph', label: '图谱' },
  { path: '/plans', label: '计划' },
  { path: '/docs', label: '文档' },
];

// 罗盘/星盘：径向定位（围绕中心 hub 排成环形）
function navRingStyle(i) {
  if (style.value !== 'compass' && style.value !== 'astro') return {};
  const n = navItems.length;
  const angle = (i / n) * 2 * Math.PI - Math.PI / 2; // 从正上方开始
  const radius = style.value === 'compass' ? 158 : 172;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;
  return { '--x': `${x.toFixed(1)}px`, '--y': `${y.toFixed(1)}px` };
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
function replayOnboarding() { beginOnboarding(); }

onMounted(() => {
  applyStyle();
  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  if (!localStorage.getItem('sxy_onboarding_done')) beginOnboarding();
});
onBeforeUnmount(() => window.removeEventListener('beforeinstallprompt', onBeforeInstall));
</script>

<template>
  <div class="app-shell" :class="{ 'no-anim': degraded, 'ring-nav': style === 'compass' || style === 'astro' }">
    <nav class="app-nav no-print">
      <span class="brand">SxyBrick</span>
      <router-link v-for="(item, i) in navItems" :key="item.path" :to="item.path" :style="navRingStyle(i)">{{ item.label }}</router-link>
      <div class="nav-tools">
        <button class="btn small" @click="showStylePicker = true">风格·{{ styleLabel }}</button>
        <button class="btn small" @click="replayOnboarding">引导</button>
        <button v-if="installEvt" class="btn small primary" @click="install">装到桌面</button>
      </div>
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

    <!-- 风格选择 -->
    <teleport to="body">
      <div v-if="showStylePicker" class="modal-mask" @click.self="showStylePicker = false">
        <div class="modal style-modal">
          <h3 style="margin-top:0">选择界面风格</h3>
          <p class="hint" style="margin-top:0">四种风格结构差异明显（导航布局 + 配色 + 质感），不只是换颜色。</p>
          <div class="style-grid">
            <div v-for="s in STYLES" :key="s.id" class="style-card" :class="{ on: style === s.id }" @click="chooseStyle(s.id)">
              <div class="style-preview" :style="{ background: 'linear-gradient(135deg,' + s.swatch[0] + ',' + s.swatch[1] + ')' }">
                <span class="style-icon">{{ s.icon }}</span>
              </div>
              <div class="style-name">{{ s.name }}</div>
              <div class="style-desc">{{ s.desc }}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:16px">
            <button class="btn" @click="showStylePicker = false">关闭</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.nav-tools { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.style-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 12px; }
.style-card { border: 2px solid var(--line); border-radius: 12px; padding: 10px; cursor: pointer; text-align: center; transition: .15s; }
.style-card:hover { border-color: var(--accent); }
.style-card.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--line); }
.style-preview { height: 64px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 26px; }
.style-name { font-weight: 600; margin-top: 8px; font-size: 14px; }
.style-desc { font-size: 11px; color: var(--ink-2); margin-top: 2px; line-height: 1.4; }
@media (max-width: 720px) { .style-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
