<script setup>
// 番茄钟法：专注/短休/长休 循环；计时状态持久化，切页面或重开后继续走。
// 计时以 endTs（结束时刻）为准而非手数秒数：后台标签页/手机锁屏时浏览器会节流 setInterval，
// 手数会漂移，用 endTs 计算剩余时间才能保证到点准确。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { toast } from '../utils/toast.js';
import { speak } from '../utils/tts.js';
import { sendNotify } from '../utils/notify.js';
import { addPomoSession, countPomoToday } from '../repo.js';
import { makePomoRoundId, isRoundRecorded, markRoundRecorded } from '../utils/pomoDedup.js';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';

const MODES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const STATE_KEY = 'sxy_pomo_state';
// round18 R18-6：结算口径常量。
//   HEARTBEAT_CAP_MS —— 单次「心跳空档」最多计入的专注时长。页面被关闭/系统休眠时
//     setInterval 不执行，回来后若不设上限，整段空档会被当成专注时间（开 2 分钟关页、
//     数小时后回来即记满 25 分钟 → 专注数据可无限刷）。后台标签页的 setInterval 会被
//     节流到分钟级，90s 上限足以覆盖正常节流，又不会给「人已离开」的空档发工资。
//   FULL_FOCUS_MIN —— 净专注达到该分钟数才算「一个完整番茄」（计入今日番茄数/成就）；
//     不足则只按实际分钟记录专注时长，不冒充完成。
const HEARTBEAT_CAP_MS = 90_000;
const FULL_FOCUS_MIN = 20;
const mode = ref('focus');
const left = ref(MODES.focus);
const running = ref(false);
let timer = null;
let endTs = 0; // 本轮结束时间戳（计时事实来源；开始时刻另用 roundStartTs 持久化，见下）
// 本轮净专注时长（毫秒）与心跳锚点：
//   netMs    —— 已结算的净专注毫秒；只有真正在跑（未被节流成静默空档）的时间才计入
//   lastSeen —— 上一次结算的时刻；>0 表示「有正在计时的段」，暂停/结算后置 0
//   roundStartTs —— 本轮首次开始（或首次恢复）的时刻，暂停不推后，保证跨天归属正确
let netMs = 0;
let lastSeen = 0;
let roundStartTs = 0;
const doneToday = ref(0); // 今日完成番茄数，从 db 推导（跨天自动重置，跨设备同步）

// 多标签页协调：同一台设备的两个标签页都开着番茄钟时，防止重复计时/重复入账
let bc = null;
let lastPeerFinish = 0;

const total = computed(() => MODES[mode.value]);
const progress = computed(() => total.value ? 1 - left.value / total.value : 0);
const r = 90, C = 2 * Math.PI * r;
const dashOffset = computed(() => C * (1 - progress.value));
const ringColor = computed(() => mode.value === 'focus' ? 'var(--accent)' : 'var(--green)');
const modeLabel = computed(() => mode.value === 'focus' ? t('views.pomodoro.labelFocus') : mode.value === 'short' ? t('views.pomodoro.labelShort') : t('views.pomodoro.labelLong'));

function fmt(s) { const m = Math.floor(s / 60), sec = s % 60; return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; }

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({
    mode: mode.value, left: left.value, running: running.value,
    endTs: running.value ? endTs : 0,
    // R18-6：净专注与心跳必须跨刷新存活，否则「关页再回来」时无从判断实际专注了多久
    netMs, lastSeen, roundStartTs,
  }));
}

/** 重置本轮净专注账本（切模式 / 手动重置 / 一轮结算完毕时调用） */
function resetRoundLedger() {
  netMs = 0;
  lastSeen = 0;
  roundStartTs = 0;
}

/**
 * 把「上次心跳 → 现在」这段时间结算进 netMs。
 * 关键：空档以 endTs 为上限（到点之后的时间不算专注），且单次空档最多计 HEARTBEAT_CAP_MS。
 * @param {number} now
 * @param {boolean} ignoreCap 关页恢复时仍要按上限截断（默认 false），仅测试可放开
 */
function creditElapsed(now = Date.now(), ignoreCap = false) {
  if (!lastSeen) return; // 没有正在计时的段（已暂停或尚未开始）
  const capAt = endTs || now; // 到点后不再累积
  const ref = Math.min(lastSeen, capAt);
  const delta = Math.max(0, capAt - ref);
  netMs += ignoreCap ? delta : Math.min(delta, HEARTBEAT_CAP_MS);
  lastSeen = Math.min(now, capAt);
}

function stop() {
  creditElapsed(); // 结算当前段（暂停期间不再计时）
  lastSeen = 0;
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
  if (!roundStartTs) roundStartTs = Date.now(); // 首启才记开始时刻，暂停恢复不推后
  lastSeen = Date.now(); // 心跳锚点：从现在开始计时（关页期间的空档不予计入）
  saveState();
  timer = setInterval(tick, 1000);
}

function switchMode(m) {
  stop();
  resetRoundLedger();
  mode.value = m;
  left.value = MODES[m];
  endTs = 0;
  saveState();
}

function resetCur() {
  stop();
  resetRoundLedger();
  left.value = MODES[mode.value];
  saveState();
}

function tick() {
  if (!running.value) return;
  // 从 endTs 反推剩余时间：即使 setInterval 被后台节流/锁屏暂停，回来也是准的
  left.value = Math.max(0, Math.ceil((endTs - Date.now()) / 1000));
  // R18-6：每次心跳结算一次净专注（被节流时单次补时也有 90s 上限，不会把「人已离开」
  // 的整段空档记成专注；真正跑满的过程由连续心跳逐段累加，总额仍等于真实专注时长）
  creditElapsed();
  if (left.value <= 0) { stop(); finish(); } else saveState();
}

async function finish() {
  if (mode.value === 'focus') {
    // R18-6：按**净专注时长**结算，而不是「到点即满记 25 分钟」。
    // 状态里现在持久化了 netMs（逐心跳累加、关页空档不计），
    // 所以「开了 2 分钟就关页、几小时后才回来」只会记到 2 分钟，且不计为完整番茄。
    const netMin = Math.max(0, Math.floor(netMs / 60000));
    const complete = netMin >= FULL_FOCUS_MIN;
    const focusStartedAt = roundStartTs || (endTs - MODES.focus * 1000); // 真正开始时刻（跨天归属正确）
    // round19 R19-1：以 roundStartTs 派生稳定 roundId，跨标签页幂等——同一轮专注只入账一次，
    // 不再依赖 lastPeerFinish 的 5s 墙钟窗口（后台节流会击穿它导致双写）。
    const rid = makePomoRoundId(focusStartedAt);
    const peerJustFinished = Date.now() - lastPeerFinish < 5000;
    if (peerJustFinished || isRoundRecorded(rid)) {
      // 已入账（同标签页重复触发，或另一标签页刚完成并已标记）：跳过，避免双写
    } else {
      bc?.postMessage({ type: 'pomo-finish', at: Date.now(), rid });
      // 少于 1 分钟不入库（避免误触产生噪声行）；不足 FULL_FOCUS_MIN 标 partial，
      // 只贡献「专注分钟」统计，不计入今日番茄数/成就（countPomoToday 会排除）。
      if (netMin >= 1) {
        // round26 M-2：先本地标记再入库——标记与 postMessage 之间被 kill 是常态窗口，
        // 标记丢失比 session 丢失更危险（对端会判 isRoundRecorded=false → 双写）。
        markRoundRecorded(rid);
        await addPomoSession({
          duration: Math.min(25, netMin), startedAt: focusStartedAt, tag: '',
          partial: complete ? 0 : 1,
          roundId: rid, // 数据库层幂等键：即便 localStorage 被清，同 roundId 拒绝二次入账
        }); // 入库，随数据包同步
      }
      try { T.pomodoroEnd(Math.min(25, netMin), 'focus'); } catch {}
    }
    await refreshDone();
    if (complete) {
      toast(t('views.pomodoro.focusDone'), 'success'); speak(t('views.pomodoro.focusDoneSpeech'));
      sendNotify(t('views.pomodoro.notifyTitle'), t('views.pomodoro.notifyMsg'));
    } else {
      // 中断/提前结束：如实告诉用户记了多少，不假装完成了一个番茄
      toast(t('views.pomodoro.focusPartial', '本轮只专注了 {min} 分钟，未计为完整番茄（已按实际时长记录）', { min: netMin }), 'warning');
    }
    // 每 4 个专注一个长休（用今日总数判断，跨页面/跨天一致）
    switchMode(doneToday.value % 4 === 0 ? 'long' : 'short');
  } else {
    try { T.pomodoroEnd(mode.value === 'short' ? 5 : 15, mode.value); } catch {}
    toast(t('views.pomodoro.restDone'), 'success'); speak(t('views.pomodoro.restDoneSpeech'));
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
    netMs = Number.isFinite(s.netMs) ? Math.max(0, s.netMs) : 0;
    roundStartTs = Number.isFinite(s.roundStartTs) ? s.roundStartTs : 0;
    if (s.running && s.endTs) {
      const remain = Math.ceil((s.endTs - Date.now()) / 1000);
      if (remain > 0) {
        left.value = remain;
        endTs = s.endTs;
        running.value = false; // 交给 start() 统一建计时器
        // start() 会把心跳锚点重置为「现在」：关页/重载期间的空档不予计入专注，
        // 用户回来后从剩余时间继续跑，跑多久记多久。
        start();
      } else {
        // 离开期间已到点：先把「最后一次心跳 → 到点」这段按上限结算，再按净时长入账。
        // lastSeen 为空（旧版本状态没有该字段）时退化为「从现在起算」，宁少记不多记。
        endTs = s.endTs;
        lastSeen = Number.isFinite(s.lastSeen) ? s.lastSeen : 0;
        creditElapsed();
        lastSeen = 0;
        left.value = 0;
        finish();
      }
    } else {
      lastSeen = 0;
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
        if (d.rid) markRoundRecorded(d.rid); // 跨标签页即时标记，防本页晚于 5s 双写同一轮
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
    <h2 style="margin:0 0 4px">{{ t('views.pomodoro.title') }}</h2>
    <p class="hint" style="margin:0 0 16px">{{ t('views.pomodoro.hint') }}</p>

    <div class="mode-row">
      <button class="chip" :class="{ on: mode === 'focus' }" @click="switchMode('focus')">{{ t('views.pomodoro.modeFocus') }}</button>
      <button class="chip" :class="{ on: mode === 'short' }" @click="switchMode('short')">{{ t('views.pomodoro.modeShort') }}</button>
      <button class="chip" :class="{ on: mode === 'long' }" @click="switchMode('long')">{{ t('views.pomodoro.modeLong') }}</button>
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
      <button class="btn primary" v-if="!running" @click="start">{{ t('views.pomodoro.start') }}</button>
      <button class="btn" v-else @click="stop">{{ t('views.pomodoro.pause') }}</button>
      <button class="btn" @click="resetCur">{{ t('views.pomodoro.reset') }}</button>
    </div>

    <div class="hint" style="text-align:center;margin-top:12px">{{ t('views.pomodoro.doneToday', '今日已完成 {n} 个番茄钟', { n: doneToday }) }}</div>
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