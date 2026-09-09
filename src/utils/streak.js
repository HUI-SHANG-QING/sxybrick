// 每日目标 + 连续打卡（streak）
// 数据源统一到 IndexedDB（db.reviews / db.meta），随同步链路跨设备同步：
//   - 今日去重卡片数、连续打卡天数：从 db.reviews 推导（reviews 已同步）
//   - 每日目标 goal：存 db.meta(key='goal')，纳入同步
import { db } from '../db.js';
// round17 R17-11：日期 key 统一走 time.dateKey（补零）——本地自实现的无补零格式
// （2026-9-1）与 word-repo.todayStr（2026-09-01）漂移，任何跨模块合并统计都会错位
import { dateKey } from './time.js';
// 审计 P1-2（round33）：连击/今日完成属「真实复习」口径，统一排除 quickCheck 自测行
import { isRealReview } from '../repo-core.js';

const GOAL_KEY = 'goal';
// 连击/日统计的回溯上限（天）：避免全表 toArray（万级 reviews 常驻内存）。
// 超过该窗口的连击按 0 计——连击本就是近端行为指标，截断可接受且可解释。
const MAX_LOOKBACK_DAYS = 400;

export async function getGoal() {
  const row = await db.meta.get(GOAL_KEY);
  return Number(row?.value) || 20;
}

// 连续打卡天数：从今天（或昨天）往前数连续有复习记录的天数
export async function getStreak() {
  // 审计 P1-2 + D-4（round33）：① quickCheck 不计入连击（自测当天不算「学习活跃」，
  // 否则只做快检就白拿连击）；② 用 reviewedAt 索引把扫描限定在最近 MAX_LOOKBACK_DAYS 天，
  // 替代全表 toArray（万级 reviews 每次进首页全量物化）。
  // round34 L5：因扫描窗口硬封 MAX_LOOKBACK_DAYS(400) 天，连续打卡 >400 天的超长连击会被
  // 静默截断为 ≤400（窗口外的早期复习记录不在扫描范围内）。属可接受的行为变化，但 UI 应在
  // 连击显示处注明「近 400 天连续打卡」，避免长连击用户误以为计数归零。返回值为实际窗口内连击数。
  const since = Date.now() - MAX_LOOKBACK_DAYS * 86400000;
  const reviews = (await db.reviews.where('reviewedAt').above(since).toArray()).filter(isRealReview);
  const days = new Set(reviews.map(r => dateKey(r.reviewedAt)));
  const d = new Date();
  if (!days.has(dateKey(d.getTime()))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days.has(dateKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}
export async function setGoal(n) {
  await db.meta.put({ key: GOAL_KEY, value: Math.max(1, Math.round(n || 20)), updatedAt: Date.now() });
}

// 今日已复习的去重卡片数（从 reviews 推导，跨设备同步）
export async function getTodayCount() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  // 审计 P1-2（round33）：今日完成只计真实复习（Review 页「今日完成」直接取本函数）
  const reviews = (await db.reviews.where('reviewedAt').aboveOrEqual(dayStart.getTime()).toArray()).filter(isRealReview);
  return new Set(reviews.map(r => r.cardId)).size;
}

// 今日已复习的卡片 id 集合
export async function getTodayIds() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const reviews = (await db.reviews.where('reviewedAt').aboveOrEqual(dayStart.getTime()).toArray()).filter(isRealReview);
  return new Set(reviews.map(r => r.cardId));
}

// —— 2026-08-26 速赢区：智能复习提醒增强所需辅助查询 ——

// 待复习卡片数（dueAt <= 现在）
export async function getDueCount() {
  const now = Date.now();
  return await db.cards.where('dueAt').belowOrEqual(now).count();
}

// 各科目待复习数（前 5 科，用于通知正文展示）
export async function getDueBySubject(topN = 5) {
  const now = Date.now();
  const due = await db.cards.where('dueAt').belowOrEqual(now).toArray();
  const m = new Map();
  for (const c of due) {
    const k = c.subject || '未分类';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
}

// 上次复习时间戳（毫秒），无记录返回 0
export async function getLastReviewTs() {
  // 审计 P1-2（round33）：「上次复习」指真实复习，快检不刷新该时间戳
  const r = await db.reviews.orderBy('reviewedAt').reverse().filter(isRealReview).first();
  return r?.reviewedAt || 0;
}

// 近 N 天每日复习量（用于"本周 vs 上周"对比）
export async function getDailyCounts(days) {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 审计 P1-2 + D-4（round33）：排除 quick + 用索引限定回溯窗口，不再全表物化
  const since = today.getTime() - (days + 1) * 86400000;
  const all = (await db.reviews.where('reviewedAt').above(since).toArray()).filter(isRealReview);
  const byDay = new Map();
  for (const r of all) {
    const d = new Date(r.reviewedAt); d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    out.push({ date: d.getTime(), count: byDay.get(d.getTime()) || 0 });
  }
  return out;
}
