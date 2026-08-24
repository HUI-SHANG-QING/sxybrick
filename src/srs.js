// 记忆曲线算法（类 SM-2 增强版，纯 JS，浏览器端运行）
// 在经典 SM-2 基础上新增三项：
//   1) 题目难度 difficulty(0易/1中/2难)：越难间隔越短，拟合个性化遗忘曲线；
//   2) 遗忘曲线拟合：间隔随 level 指数增长，ease 为曲线形状参数，难度系数为个体偏移；
//   3) 错因驱动间隔惩罚：概念混淆/记忆不牢/粗心 按错因轻重缩短下次间隔。
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const GRADUATED_STEPS = [1, 3, 7, 15]; // level 1~4 的间隔（天）

// 难度 → 间隔系数（越难，间隔越短）
const DIFF_FACTOR = [1.15, 1.0, 0.8];

// 错因 → 间隔保留比例（答对后仍按错因惩罚下次间隔）
function wrongPenalty(reason) {
  const r = String(reason || '');
  if (r.includes('概念') || r.includes('混淆')) return 0.6;  // 概念混淆：重罚
  if (r.includes('记忆') || r.includes('记不') || r.includes('忘')) return 0.7; // 记忆不牢：中罚
  if (r.includes('粗心') || r.includes('马虎') || r.includes('看错')) return 0.9; // 粗心：轻罚
  return 1.0;
}

/**
 * @param {object} card  { level, ease, difficulty? }
 * @param {number} rating 0没记住/1还模糊/2记住了
 * @param {number} intensity 强度系数
 * @param {boolean} guessed 是否蒙对
 * @param {object} opts { difficulty?, wrongReason? }
 */
export function computeNext(card, rating, intensity = 1, guessed = false, opts = {}) {
  const now = Date.now();
  let { level, ease } = card;
  ease = typeof ease === 'number' ? ease : 2.5;
  const difficulty = Number(opts.difficulty ?? card.difficulty ?? 1);
  const wrongReason = opts.wrongReason || card.wrongReason || '';

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
    // 遗忘曲线拟合：level≤4 用学习阶段梯度；之后按 ease^level 指数增长
    days = lvl <= 4 ? GRADUATED_STEPS[lvl - 1] : 15 * Math.pow(ease, lvl - 4);
    days *= DIFF_FACTOR[difficulty] ?? 1.0;         // 难度偏移
    if (guessed) days = Math.max(1, days * 0.6);    // 蒙对时间隔打折
  }

  // 错因驱动的间隔惩罚（仅对“记住了”施加，体现错因对记忆巩固的影响）
  if (rating === 2) {
    days = Math.max(days * wrongPenalty(wrongReason), 10 / 1440);
  }

  const k = Math.min(2, Math.max(0.5, Number(intensity) || 1));
  if (k > 1) days = days / (1 + (k - 1) * 0.5);

  days = Math.min(365, days);
  const dueAt = now + Math.round(days * DAY);
  return { level, ease, intervalDays: days, dueAt };
}
