// src/agent/proactive.js
// 主动智能体（Proactive Agent）：从「被动应答」升级到「主动关怀」。
// Agent 不再等用户提问，而是基于用户本地学习数据主动发现问题、给出建议、推送提醒。
//
// 三大能力：
//   1) 后台调度器（Scheduler）：应用打开时按节拍轮询，页面可见才工作，后台/息屏自动降频
//   2) 通知系统（NotificationStore）：持久化到 IndexedDB，未读小红点、已读/已清、跨设备同步
//   3) 主动建议引擎（SuggestionEngine）：规则优先（免费、零延迟），AI 增强可选（每日一次）
//
// 设计原则：
//   - 不打扰：同一建议冷却窗口内不重复推送；夜间静默；尊重 Notification.permission
//   - 零服务器：纯本地数据 + 本地规则；AI 增强仅在用户配置了 Key 时触发
//   - 渐进增强：规则建议不依赖 LLM；有 Key 时叠加每日 AI 智能总结

import { db, uid } from '../db.js';
import { getStats, getReviewSuggestion, weakCards, countPomoToday } from '../repo.js';
import { sendNotify } from '../utils/notify.js';
import { chat as llmChat } from './llm.js';
import { buildStudyContext } from './context.js';

// ---------- 配置 ----------

const SCHEDULER = {
  lightIntervalMs: 10 * 60 * 1000,   // 轻量规则检查：10 分钟
  heavyIntervalMs: 6 * 60 * 60 * 1000, // AI 智能总结：6 小时一次（实际每日只产一次）
  quietStart: 23,                    // 静默时段：23:00 ~ 07:00 不弹通知（仍写入列表）
  quietEnd: 7,
  dedupWindowMs: 6 * 60 * 60 * 1000, // 同一 key 6 小时内不重复推送
  highPriorityDedupMs: 2 * 60 * 60 * 1000, // 高优先级 2 小时内不重复
  maxNotifications: 50,              // 列表上限，超出按时间裁剪
};

const STORAGE_KEY = 'sxybrick.proactive.dedup';
const AI_SUMMARY_KEY = 'sxybrick.proactive.aiSummaryDate';

// ---------- 通知持久化（IndexedDB：db.notifications）----------

export async function pushNotification(n) {
  const item = {
    id: n.id || uid(),
    key: n.key || '',
    type: n.type || 'info',
    priority: n.priority || 'medium',
    title: String(n.title || '').slice(0, 120),
    body: String(n.body || '').slice(0, 600),
    action: n.action || null,
    createdAt: Date.now(),
    read: 0, // 0=未读 1=已读（整数以支持 IndexedDB 索引）
  };
  await db.notifications?.put(item);
  try {
    const all = await db.notifications?.orderBy('createdAt').reverse().toArray();
    if (all && all.length > SCHEDULER.maxNotifications) {
      const stale = all.slice(SCHEDULER.maxNotifications);
      await db.notifications?.bulkDelete(stale.map((x) => x.id));
    }
  } catch { /* noop */ }
  return item;
}

export async function listNotifications(limit = 50) {
  if (!db.notifications) return [];
  return db.notifications.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function unreadCount() {
  if (!db.notifications) return 0;
  return db.notifications.where('read').equals(0).count().catch(() => 0);
}

export async function markRead(id) {
  await db.notifications?.update(id, { read: 1 });
}

export async function markAllRead() {
  if (!db.notifications) return;
  const unread = await db.notifications.where('read').equals(0).toArray();
  if (unread.length) await db.notifications.bulkPut(unread.map((u) => ({ ...u, read: 1 })));
}

export async function clearAllNotifications() {
  await db.notifications?.clear();
}

export async function deleteNotification(id) {
  await db.notifications?.delete(id);
}

// ---------- 去重冷却（localStorage）----------

function loadDedup() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveDedup(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* noop */ }
}

function canPush(key, priority = 'medium') {
  if (!key) return true;
  const map = loadDedup();
  const last = map[key] || 0;
  const cooldown = priority === 'high' ? SCHEDULER.highPriorityDedupMs : SCHEDULER.dedupWindowMs;
  return Date.now() - last >= cooldown;
}

function markPushed(key) {
  if (!key) return;
  const map = loadDedup();
  map[key] = Date.now();
  for (const k of Object.keys(map)) {
    if (Date.now() - map[k] > SCHEDULER.dedupWindowMs * 2) delete map[k];
  }
  saveDedup(map);
}

function isQuietHour(d = new Date()) {
  const h = d.getHours();
  if (SCHEDULER.quietStart <= SCHEDULER.quietEnd) {
    return h >= SCHEDULER.quietStart && h < SCHEDULER.quietEnd;
  }
  return h >= SCHEDULER.quietStart || h < SCHEDULER.quietEnd;
}

// ---------- 规则建议引擎（免费、零延迟）----------

export async function generateRuleSuggestions() {
  const [stats, suggestion, weak, pomoToday] = await Promise.all([
    getStats().catch(() => null),
    getReviewSuggestion().catch(() => null),
    weakCards(100, 2).catch(() => []),
    countPomoToday().catch(() => 0),
  ]);
  const out = [];
  if (!stats) return out;

  const hour = new Date().getHours();
  const isMorning = hour >= 6 && hour < 11;
  const isEvening = hour >= 19 && hour < 23;
  const isNight = !isMorning && !isEvening;
  const due = stats.dueToday || 0;

  if (due >= 5 && (isMorning || isEvening)) {
    out.push({
      key: `review-due-${new Date().toDateString()}`,
      type: 'review',
      priority: due >= 20 ? 'high' : 'medium',
      title: `今日待背 ${due} 张`,
      body: suggestion?.dueBySubject?.length
        ? `科目分布：${suggestion.dueBySubject.map((s) => `${s.name} ${s.count}张`).join('，')}。趁记忆黄金期先过一遍。`
        : '趁记忆黄金期先过一遍，效果最好。',
      action: { label: '去复习', target: 'review' },
    });
  }

  if (suggestion?.staleSubjects?.length) {
    const top = suggestion.staleSubjects[0];
    if (top.days >= 7) {
      out.push({
        key: `stale-${top.name}-${top.days}d`,
        type: 'stale',
        priority: top.days >= 14 ? 'high' : 'medium',
        title: `${top.name} 已 ${top.days} 天没复习`,
        body: `科目遗忘曲线进入陡降区，建议今天至少刷几张${top.name}的卡片抢救记忆。`,
        action: { label: '去复习', target: 'review' },
      });
    }
  }

  const serious = (weak || []).filter((c) => (c.failCount || 0) >= 4);
  if (serious.length >= 5) {
    out.push({
      key: `weak-serious-${new Date().toDateString()}`,
      type: 'weak',
      priority: 'medium',
      title: `高频遗忘卡片 ${serious.length} 张`,
      body: '这些卡片反复记不住，可能是底座概念没打通。可以让 AI 重新拆解或补几张铺垫卡。',
      action: { label: 'AI 补卡', target: 'ai' },
    });
  }

  const marked = stats.markedCount ?? suggestion?.markedCount ?? 0;
  if (marked >= 20) {
    out.push({
      key: `marked-backlog-${Math.floor(marked / 10)}`,
      type: 'marked',
      priority: 'low',
      title: `错题本累计 ${marked} 张`,
      body: '错题积压过多会降低复盘效率。建议本周抽出半小时集中清理一批。',
      action: { label: '查看错题', target: 'wrong' },
    });
  }

  if (pomoToday === 0 && isEvening) {
    out.push({
      key: `streak-risk-${new Date().toDateString()}`,
      type: 'streak',
      priority: 'low',
      title: '今天还没开始专注',
      body: '哪怕只开一个 25 分钟番茄，也比不开始强。打开番茄钟，立刻进入状态。',
      action: { label: '开番茄', target: 'pomodoro' },
    });
  }

  const total = stats.totalCards || 0;
  if (total > 0 && total % 100 === 0 && total >= 100) {
    out.push({
      key: `milestone-${total}`,
      type: 'milestone',
      priority: 'low',
      title: `卡片数突破 ${total} 张`,
      body: '知识库达到新里程碑！坚持的力量正在显现。',
    });
  }

  if (isMorning && due > 0 && (stats.todayReviews || 0) === 0) {
    out.push({
      key: `morning-kickoff-${new Date().toDateString()}`,
      type: 'review',
      priority: 'medium',
      title: '早安，今日记忆任务已就绪',
      body: `今天有 ${due} 张卡片到期，趁早晨头脑清醒先攻克一部分。`,
      action: { label: '去复习', target: 'review' },
    });
  }

  const day = new Date().getDay();
  if ((day === 0 || day === 6) && isMorning) {
    out.push({
      key: `weekend-review-${new Date().toDateString()}`,
      type: 'review',
      priority: 'low',
      title: '周末复盘时间',
      body: '利用周末整块时间做一次系统性复盘，比平时碎片复习更深入。',
    });
  }

  if (isNight) out.forEach((s) => (s._silent = true));

  return out;
}

export async function commitSuggestions(suggestions, opt = {}) {
  if (!suggestions || !suggestions.length) return [];
  const pushed = [];
  for (const s of suggestions) {
    if (!canPush(s.key, s.priority)) continue;
    const item = await pushNotification(s);
    markPushed(s.key);
    pushed.push(item);
    if (!s._silent) {
      // 仅当用户已主动授予通知权限时才弹系统通知（sendNotify 内部检查 permission，
      // 未授予则静默跳过；不在此处自动 requestPermission，避免打扰用户）
      sendNotify(s.title, s.body);
    }
    opt.onPush?.(item);
  }
  return pushed;
}

// ---------- AI 智能总结（可选，每日一次）----------

const AI_SUMMARY_PROMPT = `你是用户的专属学习教练。基于以下真实学习数据，生成一条简洁的「今日智能建议」：
- 一句话点出最关键的问题或机会
- 给出 1 条可立即执行的具体行动
- 控制在 80 字以内，语气亲切专业，不啰嗦
只输出建议正文，不要前缀。`;

export async function maybeGenerateAISummary(cfg) {
  if (!cfg?.apiKey) return null;
  try {
    const today = new Date().toDateString();
    const last = localStorage.getItem(AI_SUMMARY_KEY);
    if (last === today) return null;
    const ctx = await buildStudyContext().catch(() => '');
    if (!ctx) return null;
    const reply = await llmChat(
      [
        { role: 'system', content: AI_SUMMARY_PROMPT },
        { role: 'user', content: ctx },
      ],
      cfg,
    );
    const body = String(reply || '').trim();
    if (!body) return null;
    localStorage.setItem(AI_SUMMARY_KEY, today);
    const item = await pushNotification({
      key: `ai-summary-${today}`,
      type: 'ai',
      priority: 'medium',
      title: 'AI 教练今日建议',
      body,
      action: { label: '问问 AI', target: 'ai' },
    });
    return item;
  } catch {
    return null;
  }
}

// ---------- 后台调度器 ----------

export class ProactiveScheduler {
  constructor() {
    this.lightTimer = null;
    this.heavyTimer = null;
    this.running = false;
    this.cfg = null;
    this.cfgGetter = null; // 函数：返回最新 AI 配置（用户改 Key 后无需重启）
    this.lastRunAt = 0;
    this.onPush = null;
  }

  async start(opt = {}) {
    if (this.running) return;
    this.running = true;
    this.cfg = opt.cfg || null;
    this.cfgGetter = opt.cfgGetter || null;
    this.onPush = opt.onPush || null;
    await this._tickLight();
    this._scheduleLight();
    this._scheduleHeavy();
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  stop() {
    this.running = false;
    if (this.lightTimer) clearTimeout(this.lightTimer);
    if (this.heavyTimer) clearTimeout(this.heavyTimer);
    this.lightTimer = null;
    this.heavyTimer = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  setConfig(cfg) {
    this.cfg = cfg || null;
  }

  _scheduleLight() {
    if (!this.running) return;
    const delay = document.hidden ? 30 * 60 * 1000 : SCHEDULER.lightIntervalMs;
    this.lightTimer = setTimeout(() => this._tickLight().finally(() => this._scheduleLight()), delay);
  }

  _scheduleHeavy() {
    if (!this.running) return;
    this.heavyTimer = setTimeout(() => {
      if (!this.running) return;
      if (!document.hidden) {
        this._tickHeavy().catch(() => {});
      }
      this._scheduleHeavy();
    }, SCHEDULER.heavyIntervalMs);
  }

  async _tickLight() {
    try {
      const suggestions = await generateRuleSuggestions();
      await commitSuggestions(suggestions, { onPush: this.onPush });
      this.lastRunAt = Date.now();
    } catch (e) {
      console.warn('[proactive] 轻量检查失败：', e?.message || e);
    }
  }

  async _tickHeavy() {
    try {
      const cfg = this.cfgGetter ? this.cfgGetter() : this.cfg;
      await maybeGenerateAISummary(cfg);
    } catch (e) {
      console.warn('[proactive] AI 总结失败：', e?.message || e);
    }
  }

  _onVisibility = () => {
    if (!document.hidden && this.running) {
      this._tickLight().catch(() => {});
    }
  };

  async tickNow() {
    await this._tickLight();
    await this._tickHeavy();
  }
}

let _scheduler = null;
export function getProactiveScheduler() {
  if (!_scheduler) _scheduler = new ProactiveScheduler();
  return _scheduler;
}

export default { ProactiveScheduler, getProactiveScheduler };