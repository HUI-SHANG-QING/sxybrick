<script setup>
// 番茄钟法：专注/短休/长休 循环；计时状态持久化，切页面或重开后继续走。
// 计时以 endTs（结束时刻）为准而非手数秒数：后台标签页/手机锁屏时浏览器会节流 setInterval，
// 手数会漂移，用 endTs 计算剩余时间才能保证到点准确。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { toast } from '../utils/toast.js';
import { speak } from '../utils/tts.js';
import { addPomoSession, countPomoToday } from '../repo.js';

const MODES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const STATE_KEY = 'sxy_pomo_state';
const mode = ref('focus');
const left = ref(MODES.focus);
const running = ref(false);
let timer = null;
let endTs = 0; // 本轮结束时间戳（唯一计时事实来源；开始时刻 = endTs - 本轮时长）
const doneToday = ref(0); // 今日完成番茄数，从 db 推导（跨天自动重置，跨设备同步）

// 多标签页协调：同一台设备的两个标签页都开着番茄钟时，防止重复计时/重复入账
let bc = null;
let lastPeerFinish = 0;

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
    endTs: running.value ? endTs : 0,
  }));
}

function stop() {
  clearInterval(timer);
  timer = null;
  running.value = false;
  left.value = Math.max(0, Math.ceil((endTs - Date.now()) / 1000));
  saveState();
}

function start() {
  if (running.value) return;
  running.value = true;
  endTs = Date.now() + left.value * 1000; // 以当前剩余时间为本轮时长（暂停恢复后自动顺延）
  saveState();
  timer = setInterval(tick, 1000);
}

function switchMode(m) {
  stop();
  mode.value = m;
  left.value = MODES[m];
  endTs = 0;
  saveState();
}

function resetCur() {
  stop();
  left.value = MODES[mode.value];
  saveState();
}

function tick() {
  if (!running.value) return;
  // 从 endTs 反推剩余时间：即使 setInterval 被后台节流/锁屏暂停，回来也是准的
  left.value = Math.max(0, Math.ceil((endTs - Date.now()) / 1000));
  if (left.value <= 0) { stop(); finish(); } else saveState();
}

async function finish() {
  if (mode.value === 'focus') {
    const focusStartedAt = endTs - MODES.focus * 1000; // 真正开始时刻（跨天归属正确）
    if (Date.now() - lastPeerFinish < 5000) {
      // 另一标签页刚刚完成并已入账：本页不重复记
    } else {
      bc?.postMessage({ type: 'pomo-finish', at: Date.now() });
      await addPomoSession({ duration: 25, startedAt: focusStartedAt, tag: '' }); // 入库，随数据包同步
    }
    await refreshDone();
    toast('专注完成，休息一下！', 'success'); speak('专注完成，休息一下吧');
    // 每 4 个专注一个长休（用今日总数判断，跨页面/跨天一致）
    switchMode(doneToday.value % 4 === 0 ? 'long' : 'short');
  } else {
    toast('休息结束，继续加油！', 'success'); speak('休息结束，继续加油');
    switchMode('focus');
  }
}

async function refreshDone() {
  try { doneToday.value = await countPomoToday(); } catch {}
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) return;
    mode.value = s.mode || 'focus';
    if (s.running && s.endTs) {
      const remain = Math.ceil((s.endTs - Date.now()) / 1000);
      if (remain > 0) {
        left.value = remain;
        endTs = s.endTs;
        running.value = false; // 交给 start() 统一建计时器
        start();
      } else {
        // 离开期间已到点：结算
        endTs = s.endTs;
        left.value = 0;
        finish();
      }
    } else {
      left.value = (typeof s.left === 'number' ? s.left : MODES[mode.value]);
      if (left.value < 0 || left.value > MODES[mode.value]) left.value = MODES[mode.value];
    }
  } catch {}
}

// 回到前台时立即校准（应对标签页休眠期间的节流）
function onVisible() {
  if (document.visibilityState === 'visible' && running.value) tick();
}

onMounted(async () => {
  restore();
  await refreshDone();
  // 多标签协调：收到「别的标签页完成专注」→ 本页停掉自己的专注计时，只刷新计数
  if ('BroadcastChannel' in window) {
    bc = new BroadcastChannel('sxy_pomo');
    bc.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'pomo-finish') {
        lastPeerFinish = Date.now();
        if (running.value && mode.value === 'focus') switchMode('short');
        refreshDone();
      }
    };
  }
  document.addEventListener('visibilitychange', onVisible);
});

onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', onVisible);
  bc?.close();
});
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