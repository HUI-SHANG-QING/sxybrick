// 记忆曲线算法（类 SM-2 改进版，纯 JS，可同时运行在浏览器端）
// 输入：当前 level、ease、自评 rating(0没记住/1还模糊/2记住了)、强度 intensity、是否蒙对 guessed
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const GRADUATED_STEPS = [1, 3, 7, 15]; // level 1~4 的间隔（天）

export function computeNext(card, rating, intensity = 1, guessed = false) {
  const now = Date.now();
  let { level, ease } = card;
  ease = typeof ease === 'number' ? ease : 2.5;

  if (rating === 2) {
    if (guessed) { ease = Math.max(1.3, ease - 0.05); } // 蒙对：不加等级、略降难度系数
    else { level += 1; ease = Math.min(2.8, ease + 0.05); }
  } else if (rating === 1) {
    ease = Math.max(1.3, ease - 0.1);
  } else {
    level = Math.max(0, level - 2); // 遗忘回退
    ease = Math.max(1.3, ease - 0.2);
  }

  let days;
  if (rating === 0) days = 10 / 1440;              // 10 分钟后重学
  else if (rating === 1) days = level === 0 ? 10 / 1440 : 1;
  else {
    const lvl = Math.max(1, level);
    days = lvl <= 4 ? GRADUATED_STEPS[lvl - 1] : 15 * Math.pow(ease, lvl - 4);
    if (guessed) days = Math.max(1, days * 0.6);   // 蒙对时间隔打折
  }

  const k = Math.min(2, Math.max(0.5, Number(intensity) || 1));
  if (k > 1) days = days / (1 + (k - 1) * 0.5);

  days = Math.min(365, days);
  const dueAt = now + Math.round(days * DAY);
  return { level, ease, intervalDays: days, dueAt };
}