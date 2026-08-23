// 每日目标 + 连续打卡（streak）：用 localStorage 记录，无需服务器
const GOAL_KEY = 'sxy_goal';
const DAYS_KEY = 'sxy_days';
const COUNT_KEY = 'sxy_day_count';

function fmt(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

export function getGoal() { return Number(localStorage.getItem(GOAL_KEY)) || 20; }
export function setGoal(n) { localStorage.setItem(GOAL_KEY, Math.max(1, Math.round(n || 20))); }

function getDays() { return new Set((localStorage.getItem(DAYS_KEY) || '').split(',').filter(Boolean)); }

// 每次复习自评后调用：记录今天已复习 + 计入打卡日期
export function recordReview() {
  const today = fmt(new Date());
  const days = getDays(); days.add(today);
  localStorage.setItem(DAYS_KEY, [...days].join(','));
  const rec = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null');
  const count = (rec && rec.date === today ? rec.count : 0) + 1;
  localStorage.setItem(COUNT_KEY, JSON.stringify({ date: today, count }));
}

export function getTodayCount() {
  const rec = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null');
  return rec && rec.date === fmt(new Date()) ? rec.count : 0;
}

// 连续打卡天数：从今天（或昨天）往前数连续有记录的天数
export function getStreak() {
  const days = getDays();
  const d = new Date();
  if (!days.has(fmt(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days.has(fmt(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}