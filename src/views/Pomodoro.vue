<script setup>
// 番茄钟法：专注/短休/长休 循环；计时状态持久化，切页面或重开后继续走
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { toast } from '../utils/toast.js';
import { speak } from '../utils/tts.js';

const MODES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const STATE_KEY = 'sxy_pomo_state';
const mode = ref('focus');
const left = ref(MODES.focus);
const running = ref(false);
let timer = null;
const doneToday = ref(parseInt(localStorage.getItem('sxy_pomo') || '0'));
const focusStreak = ref(0);

const total = computed(() => MODES[mode.value]);
const progress = computed(() => total.value ? 1 - left.value / total.value : 0);
const r = 90, C = 2 * Math.PI * r;
const dashOffset = computed(() => C * (1 - progress.value));
const ringColor = computed(() => mode.value === 'focus' ? 'var(--accent)' : 'var(--green)');
const modeLabel = computed(() => mode.value === 'focus' ? '专注' : mode.value === 'short' ? '短休息' : '长休息');

function fmt(s) { const m = Math.floor(s / 60), sec = s % 60; return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; }
function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({
    mode: mode.value, left: left.value, running: running.value,
    endTs: running.value ? Date.now() + left.value * 1000 : 0,
  }));
}
function stop() { clearInterval(timer); running.value = false; saveState(); }
function switchMode(m) { stop(); mode.value = m; left.value = MODES[m]; saveState(); }
function start() { if (running.value) return; running.value = true; saveState(); timer = setInterval(tick, 1000); }
function resetCur() { stop(); left.value = MODES[mode.value]; saveState(); }

function tick() {
  left.value--;
  if (left.value <= 0) { stop(); finish(); } else saveState();
}

function finish() {
  if (mode.value === 'focus') {
    doneToday.value++; localStorage.setItem('sxy_pomo', doneToday.value);
    focusStreak.value++;
    toast('专注完成，休息一下！', 'success'); speak('专注完成，休息一下吧');
    switchMode(focusStreak.value % 4 === 0 ? 'long' : 'short');
  } else {
    toast('休息结束，继续加油！', 'success'); speak('休息结束，继续加油');
    switchMode('focus');
  }
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) return;
    mode.value = s.mode || 'focus';
    if (s.running && s.endTs) {
      const remain = Math.floor((s.endTs - Date.now()) / 1000);
      if (remain > 0) { left.value = remain; running.value = false; start(); }
      else { left.value = 0; finish(); }
    } else {
      left.value = (typeof s.left === 'number' ? s.left : MODES[mode.value]);
    }
  } catch {}
}

onMounted(restore);
onBeforeUnmount(() => { clearInterval(timer); });
</script>

<template>
  <div class="pomo-wrap">
    <h2 style="margin:0 0 4px">番茄钟</h2>
    <p class="hint" style="margin:0 0 16px">25 分钟专注 + 5 分钟休息，每 4 轮一个长休息。到点自动语音提醒。</p>

    <div class="mode-row">
      <button class="chip" :class="{ on: mode === 'focus' }" @click="switchMode('focus')">专注 25′</button>
      <button class="chip" :class="{ on: mode === 'short' }" @click="switchMode('short')">短休 5′</button>
      <button class="chip" :class="{ on: mode === 'long' }" @click="switchMode('long')">长休 15′</button>
    </div>

    <div class="ring">
      <svg viewBox="0 0 200 200" width="220" height="220">
        <circle cx="100" cy="100" :r="r" fill="none" stroke="var(--line)" stroke-width="10" />
        <circle cx="100" cy="100" :r="r" fill="none" :stroke="ringColor" stroke-width="10" stroke-linecap="round"
          :stroke-dasharray="C" :stroke-dashoffset="dashOffset" transform="rotate(-90 100 100)" />
        <text x="100" y="96" text-anchor="middle" dominant-baseline="central" class="time-text">{{ fmt(left) }}</text>
        <text x="100" y="128" text-anchor="middle" class="mode-text">{{ modeLabel }}</text>
      </svg>
    </div>

    <div class="ctrl">
      <button class="btn primary" v-if="!running" @click="start">开始</button>
      <button class="btn" v-else @click="stop">暂停</button>
      <button class="btn" @click="resetCur">重置</button>
    </div>

    <div class="hint" style="text-align:center;margin-top:12px">今日已完成 {{ doneToday }} 个番茄钟</div>
  </div>
</template>

<style scoped>
.pomo-wrap { max-width: 420px; margin: 0 auto; text-align: center; }
.mode-row { display: flex; gap: 8px; justify-content: center; margin-bottom: 20px; }
.ring { display: flex; justify-content: center; }
.time-text { font-size: 40px; font-weight: 700; fill: var(--ink); }
.mode-text { font-size: 14px; fill: var(--ink-2); }
.ctrl { display: flex; gap: 10px; justify-content: center; margin-top: 16px; }
</style>