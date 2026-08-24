// 每日目标 + 连续打卡（streak）：用 localStorage 记录，无需服务器
// 计数口径：今日「去重卡片数」——同一张卡今天复习多次只算 1 张
const GOAL_KEY = 'sxy_goal';
const DAYS_KEY = 'sxy_days';
const COUNT_KEY = 'sxy_day_count';

function fmt(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

export function getGoal() { return Number(localStorage.getItem(GOAL_KEY)) || 20; }
export function setGoal(n) { localStorage.setItem(GOAL_KEY, Math.max(1, Math.round(n || 20))); }

function getDays() { return new Set((localStorage.getItem(DAYS_KEY) || '').split(',').filter(Boolean)); }

// 每次完成一张卡的自评后调用：记录今天复习过的卡片（去重）+ 计入打卡日期
export function recordReview(cardId) {
  const today = fmt(new Date());
  const days = getDays(); days.add(today);
  localStorage.setItem(DAYS_KEY, [...days].join(','));
  const rec = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null');
  const ids = (rec && rec.date === today && Array.isArray(rec.ids)) ? rec.ids : [];
  if (cardId && !ids.includes(cardId)) ids.push(cardId);
  localStorage.setItem(COUNT_KEY, JSON.stringify({ date: today, ids }));
}

// 今日已复习的去重卡片数
export function getTodayCount() {
  const rec = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null');
  return rec && rec.date === fmt(new Date()) && Array.isArray(rec.ids) ? rec.ids.length : 0;
}

// 今日已复习的卡片 id 集合（用于判断某张卡今天是否已复习过）
export function getTodayIds() {
  const rec = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null');
  return rec && rec.date === fmt(new Date()) && Array.isArray(rec.ids) ? new Set(rec.ids) : new Set();
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
