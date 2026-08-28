/**
 * 日程表到点提醒（纯前端，桌面/平板/手机同一套逻辑）
 *
 * 原理：页面打开期间轮询今天的 dailyTasks，到 scheduledHour 时触发提醒。
 * 提醒通道（按用户设置）：
 *   1) 视觉浮层 —— 页面顶部大号提醒卡（PlanReminderLayer 监听 sxy-plan-due 事件）
 *   2) 系统通知 —— Web Notification（需用户授权，HTTPS 下可用）
 *   3) 提示音   —— Web Audio 短音（**默认关**，图书馆场景）
 *   4) 语音播报 —— SpeechSynthesis（**默认关**，用户允许才开）
 *
 * 设计：
 *   - 纯函数（dueTasksOf / 去重 / 设置）可 Node 单测；
 *   - 浏览器 API 全部在函数内守卫（typeof window），Node 环境安全；
 *   - 每个任务到期后 15 分钟内只提醒一次（localStorage 按日期+任务去重，次日自动失效）。
 */

// ──────────────── 设置 ────────────────

const SETTINGS_KEY = 'sxy_plan_reminder_settings';
const DEFAULT_SETTINGS = {
  enabled: true,      // 总开关：默认开（到点提醒）
  sound: false,       // 提示音：默认关（图书馆）
  voice: false,       // 语音播报：默认关（用户允许才开）
  advanceMin: 0,      // 提前量（分钟）：0=到点 / 5 / 10
};

export function getReminderSettings() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...s };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveReminderSettings(patch) {
  const next = { ...getReminderSettings(), ...patch };
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }
  return next;
}

// ──────────────── 到期判定（纯函数） ────────────────

/** 当天日期 YYYY-MM-DD（本地时区） */
export function dateStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 到期检查：返回「该提醒」的任务列表。
 * 规则：
 *   - 必须有 scheduledHour（未排程不提醒）；
 *   - 状态 pending / partial 才提醒（done/skipped 跳过）；
 *   - 当前时刻落在 [计划时刻-提前量, +15 分钟) 窗口内才算到期（错过不补）。
 * @param {Array} tasks 任务数组（含 scheduledHour/status）
 * @param {Date} [now]
 * @param {number} [advanceMin=0] 提前量（分钟）
 * @returns {Array}
 */
export function dueTasksOf(tasks = [], now = new Date(), advanceMin = 0) {
  const curMin = now.getHours() * 60 + now.getMinutes();
  const WINDOW = 15;
  return (tasks || []).filter(t => {
    if (t.status === 'done' || t.status === 'skipped') return false;
    if (t.scheduledHour == null) return false;
    const due = t.scheduledHour * 60 - (advanceMin || 0);
    return curMin >= due && curMin < due + WINDOW;
  });
}

// ──────────────── 去重（localStorage，按日期+任务） ────────────────

const REMINDED_PREFIX = 'sxy_plan_reminded';

export function isReminded(date, taskId) {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(`${REMINDED_PREFIX}_${date}_${taskId}`) === '1';
}

export function markReminded(date, taskId) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`${REMINDED_PREFIX}_${date}_${taskId}`, '1');
}

// ──────────────── 媒体通道（浏览器 API，Node 安全） ────────────────

/** 短提示音（Web Audio，双音"叮咚"，音量克制） */
export function playChime() {
  if (typeof window === 'undefined') return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const notes = [[880, 0, 0.18], [1320, 0.22, 0.22]];
    for (const [freq, delay, dur] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + dur + 0.05);
    }
  } catch { /* 音频被拦截则忽略 */ }
}

/** 语音播报（SpeechSynthesis，中文） */
export function speakTask(title) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(`到点了，${title}`);
    u.lang = 'zh-CN';
    u.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* 忽略 */ }
}

/** 系统通知（Web Notification，需 granted） */
export function sendSystemNotify(title, body) {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    new Notification(String(title), { body: String(body || ''), tag: 'sxybrick-plan' });
    return true;
  } catch {
    return false;
  }
}

/** 请求系统通知权限（必须由用户手势触发，如点击按钮） */
export async function requestNotifyPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  let p = Notification.permission;
  if (p === 'default') {
    try { p = await Notification.requestPermission(); } catch { p = 'denied'; }
  }
  return p;
}

// ──────────────── 触发编排 ────────────────

/**
 * 触发一次提醒：视觉浮层事件 + 系统通知 + 按设置播放声音/语音。
 * @param {object} task
 * @param {object} [settings]
 */
export function triggerReminder(task, settings = getReminderSettings()) {
  // 1) 视觉浮层（所有设备统一，最显眼）
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sxy-plan-due', { detail: task }));
  }
  // 2) 系统通知（已授权时）
  sendSystemNotify('⏰ 日程提醒', `${task.title}${task.scheduledHour != null ? `（${task.scheduledHour}:00）` : ''}`);
  // 3) 提示音 / 语音（默认关闭）
  if (settings.sound) playChime();
  if (settings.voice) speakTask(task.title);
}

// ──────────────── 全局调度循环 ────────────────

/**
 * 启动日程提醒轮询（应用任意页面打开即生效）。
 * 每次 tick：读今天的 dailyPlans/dailyTasks → 到期且未提醒 → 触发 + 标记。
 * @param {(tasks: Array) => void} [onDue] 回调（供浮层展示）
 * @param {number} [intervalMs=20000] 轮询间隔
 * @returns {() => void} stop 函数
 */
export function startReminderScheduler(onDue, intervalMs = 20000) {
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const settings = getReminderSettings();
    if (!settings.enabled) return;
    try {
      const { db } = await import('../db.js');
      const today = dateStr();
      const plans = await db.dailyPlans.where('date').equals(today).toArray();
      if (!plans.length) return;
      const tasks = await db.dailyTasks.where('planId').anyOf(plans.map(p => p.id)).toArray();
      const due = dueTasksOf(tasks, new Date(), settings.advanceMin);
      const fresh = due.filter(t => !isReminded(today, t.id));
      for (const t of fresh) {
        markReminded(today, t.id);
        triggerReminder(t, settings);
      }
      if (fresh.length) onDue?.(fresh);
    } catch { /* 静默，下次再查 */ }
  };

  // 立即查一次 + 周期轮询
  tick();
  timer = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  };
}
