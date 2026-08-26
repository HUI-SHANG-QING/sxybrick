// 记忆曲线算法（类 SM-2 增强版，纯 JS，浏览器端运行）
// 在经典 SM-2 基础上新增四项：
//   1) 题目难度 difficulty(0易/1中/2难)：越难间隔越短，拟合个性化遗忘曲线；
//   2) 遗忘曲线拟合：间隔随 level 指数增长，ease 为曲线形状参数，难度系数为个体偏移；
//   3) 错因驱动间隔惩罚：概念混淆/记忆不牢/粗心 按错因轻重缩短下次间隔；
//   4) 短期提取巩固（2026-08-26 阶段一·速赢区）：新卡首次答对后插入两段"提取练习"——
//      · 阶段1（当日巩固）：6 小时内再提取一次，强化工作记忆→长期记忆转化；
//      · 阶段2（隔日巩固）：次日再提取一次，跨越睡眠周期固化；
//      · 完成后进入正常 SM-2 梯度（3 天后）。
//      认知科学依据：24h 内首次主动提取是记忆巩固的最强窗口（Roediger & Karpicke, 2006）。
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const GRADUATED_STEPS = [1, 3, 7, 15]; // level 1~4 的间隔（天）

// 短期巩固参数
const CONSOLIDATION_FIRST_HOURS = 6;   // 阶段1：当日 6 小时后
const CONSOLIDATION_SECOND_DAYS = 1;   // 阶段2：隔日

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
 * @param {object} card  { level, ease, difficulty?, consolidation? }
 * @param {number} rating 0没记住/1还模糊/2记住了
 * @param {number} intensity 强度系数
 * @param {boolean} guessed 是否蒙对
 * @param {object} opts { difficulty?, wrongReason?, adaptive? }
 * @returns {{ level, ease, intervalDays, dueAt, consolidation }}
 *   consolidation: null=未启用/已毕业，1=当日巩固待完成，2=隔日巩固待完成
 */
export function computeNext(card, rating, intensity = 1, guessed = false, opts = {}) {
  const now = Date.now();
  let { level, ease } = card;
  ease = typeof ease === 'number' ? ease : 2.5;
  // 难度系数：opts.difficulty（复习时评分 0/1/2）优先；否则取卡片固有 difficulty
  // 兼容字符串梯度（P3-E：basic/applied/challenge → 0/1/2）与旧数值
  const DIFF_MAP = { basic: 0, applied: 1, challenge: 2 };
  const rawDiff = opts.difficulty ?? card.difficulty ?? 1;
  const difficulty = DIFF_MAP[rawDiff] ?? (Number.isFinite(Number(rawDiff)) ? Number(rawDiff) : 1);
  const wrongReason = opts.wrongReason || card.wrongReason || '';
  // 短期巩固状态：null/0=未启用或已毕业，1=当日巩固待完成，2=隔日巩固待完成
  let consolidation = card.consolidation || null;
  if (consolidation === 0) consolidation = null;

  // ---------- 等级与 ease 调整（含短期巩固状态机） ----------
  if (rating === 2) {
    if (guessed) {
      // 蒙对：不加等级、略降 ease，并退出短期巩固（不算真掌握）
      ease = Math.max(1.3, ease - 0.05);
      consolidation = null;
    } else if (consolidation === 1) {
      // 阶段1（当日巩固）完成 → 进入阶段2（隔日巩固），level 不变
      consolidation = 2;
      ease = Math.min(2.8, ease + 0.05);
    } else if (consolidation === 2) {
      // 阶段2（隔日巩固）完成 → 毕业，level 升一级，进入正常 SM-2 梯度
      consolidation = null;
      level = level + 1;
      ease = Math.min(2.8, ease + 0.05);
    } else if (level === 0) {
      // 新卡首次答对 → 进入阶段1（当日巩固），level 升到 1
      consolidation = 1;
      level = 1;
      ease = Math.min(2.8, ease + 0.05);
    } else {
      // 已毕业卡正常升级
      level += 1;
      ease = Math.min(2.8, ease + 0.05);
    }
  } else if (rating === 1) {
    ease = Math.max(1.3, ease - 0.1);
    consolidation = null;   // 模糊 → 退出短期巩固，回正常流程
  } else {
    level = Math.max(0, level - 2); // 遗忘回退
    ease = Math.max(1.3, ease - 0.2);
    consolidation = null;   // 遗忘 → 退出短期巩固
  }

  // ---------- 间隔计算 ----------
  let days;
  if (rating === 0) {
    days = 10 / 1440;              // 10 分钟后重学
  } else if (rating === 1) {
    days = level === 0 ? 10 / 1440 : 1;
  } else {
    // rating === 2
    if (consolidation === 1) {
      // 阶段1：当日 6 小时后再次提取
      days = CONSOLIDATION_FIRST_HOURS / 24;
    } else if (consolidation === 2) {
      // 阶段2：隔日再次提取
      days = CONSOLIDATION_SECOND_DAYS;
    } else {
      // 正常 SM-2 梯度
      const lvl = Math.max(1, level);
      // 遗忘曲线拟合：level≤4 用学习阶段梯度；之后按 ease^level 指数增长
      days = lvl <= 4 ? GRADUATED_STEPS[lvl - 1] : 15 * Math.pow(ease, lvl - 4);
      days *= DIFF_FACTOR[difficulty] ?? 1.0;         // 难度偏移
      if (guessed) days = Math.max(1, days * 0.6);    // 蒙对时间隔打折
    }
  }

  // 错因驱动的间隔惩罚（仅对「记住了」+ 非短期巩固阶段施加）
  // 短期巩固阶段本身就是高频提取，不再叠加错因惩罚以免过载
  if (rating === 2 && consolidation === null) {
    days = Math.max(days * wrongPenalty(wrongReason), 10 / 1440);
  }

  const k = Math.min(2, Math.max(0.5, Number(intensity) || 1));
  if (k > 1) days = days / (1 + (k - 1) * 0.5);

  // 自适应节奏（C4，可选开启）：按该卡近 10 次复习的错误率微调间隔
  //   - 近 10 次中错误率 ≥40%：间隔 ×0.8（频繁出错 → 加快重现）
  //   - 近 10 次全对且等级 ≥3：间隔 ×1.1（稳定掌握 → 拉长间隔）
  // 仅作用于「记住了」+ 已毕业的卡（非短期巩固阶段），且样本量 ≥5 才有统计意义
  if (rating === 2 && consolidation === null && opts.adaptive && opts.adaptive.reviews >= 5) {
    const failRate = Number(opts.adaptive.failRate) || 0;
    if (failRate >= 0.4) days *= 0.8;
    else if (failRate === 0 && (level || 0) >= 3) days *= 1.1;
  }

  days = Math.min(365, days);
  const dueAt = now + Math.round(days * DAY);
  return { level, ease, intervalDays: days, dueAt, consolidation };
}

/**
 * 学习行为回写：复习之外的行为信号（语音复述覆盖率、费曼练习等）微调 SRS 状态。
 * 规则（工程化二版）：
 *   - 语音覆盖率 < 40%：ease -0.15，且 dueAt 提前到 30 分钟内（趁热重练）
 *   - 语音覆盖率 >= 85%：ease +0.05（上限 2.8）
 *   - 费曼练习加成：ease +0.03（上限 2.8），不改等级
 * 不改 level 与 updatedAt（内容未变），只动 ease/dueAt，与双时间戳同步模型兼容。
 */
export function applyFeedback(card, { score = null, feynman = false } = {}) {
  let ease = typeof card.ease === 'number' ? card.ease : 2.5;
  let dueAt = typeof card.dueAt === 'number' ? card.dueAt : Date.now();
  if (typeof score === 'number') {
    if (score < 40) {
      ease = Math.max(1.3, ease - 0.15);
      dueAt = Math.min(dueAt, Date.now() + 30 * 60 * 1000);
    } else if (score >= 85) {
      ease = Math.min(2.8, ease + 0.05);
    }
  }
  if (feynman) ease = Math.min(2.8, ease + 0.03);
  return { ease, dueAt };
}
