// 每日目标 + 连续打卡（streak）
// 数据源统一到 IndexedDB（db.reviews / db.meta），随同步链路跨设备同步：
//   - 今日去重卡片数、连续打卡天数：从 db.reviews 推导（reviews 已同步）
//   - 每日目标 goal：存 db.meta(key='goal')，纳入同步
import { db } from '../db.js';

const GOAL_KEY = 'goal';

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export async function getGoal() {
  const row = await db.meta.get(GOAL_KEY);
  return Number(row?.value) || 20;
}
export async function setGoal(n) {
  await db.meta.put({ key: GOAL_KEY, value: Math.max(1, Math.round(n || 20)), updatedAt: Date.now() });
}

// 今日已复习的去重卡片数（从 reviews 推导，跨设备同步）
export async function getTodayCount() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const reviews = await db.reviews.where('reviewedAt').aboveOrEqual(dayStart.getTime()).toArray();
  return new Set(reviews.map(r => r.cardId)).size;
}

// 今日已复习的卡片 id 集合
export async function getTodayIds() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const reviews = await db.reviews.where('reviewedAt').aboveOrEqual(dayStart.getTime()).toArray();
  return new Set(reviews.map(r => r.cardId));
}

// 连续打卡天数：从今天（或昨天）往前数连续有复习记录的天数
export async function getStreak() {
  const reviews = await db.reviews.toArray();
  const days = new Set(reviews.map(r => dayKey(r.reviewedAt)));
  const d = new Date();
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}
