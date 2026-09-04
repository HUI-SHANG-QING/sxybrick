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
//
// P1-1：新增 FSRS-4.5 调度器（scheduleReview），与 SM-2 并行 opt-in：
//   - opts.scheduler === 'fsrs' → 走 fsrs.schedule（用机器学习拟合的遗忘曲线）
//   - 否则 → 沿用 computeNext（SM-2 变体，含巩固/错因惩罚）
//   FSRS 路径的难度 D 与稳定度 S 已自适应卡片难度与错因信号，故不复用 SM-2 的错因惩罚与
//   短期巩固状态机（避免双重惩罚）；wrongReason 仍写入复习日志供分析。
import { schedule as fsrsSchedule } from './fsrs.js';
import { examWindowUrgency, compressIntoWindow, applyElasticDue } from './algorithms/scheduling.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const GRADUATED_STEPS = [1, 3, 7, 15]; // level 1~4 的间隔（天）

// 短期巩固参数
const CONSOLIDATION_FIRST_HOURS = 6;   // 阶段1：当日 6 小时后
const CONSOLIDATION_SECOND_DAYS = 1;   // 阶段2：隔日

// 难度 → 间隔系数（越难，间隔越短）
const DIFF_FACTOR = [1.15, 1.0, 0.8];

// 错因枚举 → 间隔保留比例（答对后仍按错因惩罚下次间隔）
// 使用受控枚举码，不再用中文子串嗅探（避免措辞偏差导致静默失效）
const WRONG_PENALTY_MAP = {
  CONCEPT_MIS: 0.6,   // 概念混淆：重罚
  MEMORY_WEAK: 0.7,   // 记忆不牢：中罚
  MEMORY_VAGUE: 0.7,  // 记忆模糊：中罚（同记忆不牢）
  REVIEW_ERROR: 0.85, // 审题偏差：中轻罚
  CALC_ERROR: 0.9,    // 计算失误：轻罚
  CARELESS: 0.9,      // 粗心：轻罚
  OTHER: 1.0,         // 其他：不罚
  '': 1.0,            // 无错因：不罚
};
function wrongPenalty(reason) {
  if (!reason) return 1.0;
  // 新：枚举码直接查表
  if (WRONG_PENALTY_MAP[reason] !== undefined) return WRONG_PENALTY_MAP[reason];
  // 旧：中文字符串回退（向后兼容旧数据）
  const r = String(reason);
  if (r.includes('概念') || r.includes('混淆')) return 0.6;
  if (r.includes('记忆') || r.includes('记不') || r.includes('忘') || r.includes('模糊')) return 0.7;
  if (r.includes('粗心') || r.includes('马虎') || r.includes('看错')) return 0.9;
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
  ease = Number.isFinite(Number(ease)) ? Number(ease) : 2.5;
  // ⚠️ level 必须归一化（2026-08-30）：undefined/NaN 会在「已毕业卡正常升级」分支
  //   执行 `level += 1` → NaN → days=NaN → dueAt=NaN。
  //   而 `dueAt <= now` 对 NaN 恒为 false —— 这张卡会**永久消失于复习队列**，
  //   不报错、不告警，用户只会觉得"卡莫名不见了"。FSRS 分支有护栏，SM-2 此前没有。
  level = Number.isFinite(Number(level)) ? Math.max(0, Math.trunc(Number(level))) : 0;
  // 难度系数：opts.difficulty（复习时评分 0/1/2）优先；否则取卡片固有 difficulty
  // 兼容字符串梯度（P3-E：basic/applied/challenge → 0/1/2）与旧数值
  const DIFF_MAP = { basic: 0, applied: 1, challenge: 2 };
  const rawDiff = opts.difficulty ?? card.difficulty ?? 1;
  const difficulty = DIFF_MAP[rawDiff] ?? (Number.isFinite(Number(rawDiff)) ? Number(rawDiff) : 1);
  const wrongReason = opts.wrongReason || card.wrongReason || '';
  // 短期巩固状态：null/0=未启用或已毕业，1=当日巩固待完成，2=隔日巩固待完成
  let consolidation = card.consolidation || null;
  if (consolidation === 0) consolidation = null;
  // D2: 巩固阶段超时失效——距上次复习超过 24h 未复习，自动跳过巩固，
  // 直接进入正常 SM-2 梯度。防止用户长期不来后卡在「待巩固」状态。
  if ((consolidation === 1 || consolidation === 2) && card.dueAt) {
    const hoursOverdue = (Date.now() - card.dueAt) / 3600000;
    if (hoursOverdue > 24) {
      if (consolidation === 2) level = Math.max(1, level + 1); // 阶段2 超时视为已掌握
      consolidation = null;
    }
  }

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
    // D7: 遗忘间隔随 ease 微弱变化（ease=1.3→10min，ease=2.8→6h），不再一刀切 10 分钟
    days = Math.max(10 / 1440, Math.min(0.25, (ease - 1.3) * 0.167));
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

  // 兜底：任何环节漏出 NaN/Infinity 都会让这张卡永久消失于队列（`NaN <= now` 恒假），
  // 这里做最后一道拦截，保证 dueAt 永远是可比较的有限时间戳。
  if (!Number.isFinite(days) || days <= 0) days = 10 / 1440;
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

/**
 * P1-1 调度分发器：FSRS opt-in，否则走 SM-2 变体
 * @param {object} card  { level, ease, difficulty?, consolidation?, fsrs? }
 * @param {number} rating 0没记住/1还模糊/2记住了
 * @param {number} intensity 强度系数
 * @param {boolean} guessed 是否蒙对
 * @param {object} opts { difficulty?, wrongReason?, adaptive?, scheduler?, weights?, desiredRetention?, retrievalStrength? }
 *   - opts.scheduler === 'fsrs' 时启用 FSRS（opts.weights 为用户训练出的 19 权重）
 *   - opts.retrievalStrength: P1-3 检索强度分级（recognize/recall/generate/explain）
 * @returns {{ level, ease, intervalDays, dueAt, consolidation, fsrs? }}
 */
// P1-3 检索强度 → 间隔乘子（认知科学：生成效应 Generation Effect、费曼学习法）
//   recognize 再认：×0.7（看了选项才认出 ≠ 真记住，间隔缩短，更早重测）
//   recall    回忆：×1.0（基准，主动从记忆提取）
//   generate  生成：×1.25（用自己的话重组输出，生成效应强 25%）
//   explain   讲解：×1.5 （费曼学习法，向他人讲解，检索强度最高）
// 注：乘子在 SM-2 与 FSRS 路径之后统一应用，与 intensity（时间压力维度）正交
export const RETRIEVAL_STRENGTH_OPTIONS = [
  { code: 'recognize', label: '再认', factor: 0.7, desc: '看了选项能认出（掌握度最低）' },
  { code: 'recall',    label: '回忆', factor: 1.0, desc: '主动从记忆提取（基准）' },
  { code: 'generate',  label: '生成', factor: 1.25, desc: '用自己的话重组输出（生成效应）' },
  { code: 'explain',   label: '讲解', factor: 1.5, desc: '费曼学习法，向他人讲解（最强）' },
];
const RETRIEVAL_FACTOR = Object.fromEntries(RETRIEVAL_STRENGTH_OPTIONS.map(o => [o.code, o.factor]));

export function scheduleReview(card, rating, intensity = 1, guessed = false, opts = {}) {
  let r;
  if (opts.scheduler === 'fsrs') {
    // round15 P2：蒙对不算真掌握——FSRS 按 hard（rating=1）推进状态。
    // 此前仅缩 intervalDays×0.6，但 S 仍按 good 完整提升（stabilityAfterRecall 单步≈2.6×），
    // 蒙对卡与真记住同速增长 → 远期间隔系统性放大；与 SM-2 路径「蒙对不升级、降 ease」语义不一致。
    // FSRS 的 hard 档本身已给短间隔（提取不流畅），无需再叠加乘子。
    const fsrsRating = (guessed && rating === 2) ? 1 : rating;
    r = fsrsSchedule(card, fsrsRating, { weights: opts.weights, desiredRetention: opts.desiredRetention, initialStability: opts.initialStability });
  } else {
    r = computeNext(card, rating, intensity, guessed, opts);
  }
  // P1-3 检索强度分级：在调度结果上统一应用乘子
  const rs = opts.retrievalStrength;
  if (rs && RETRIEVAL_FACTOR[rs] !== undefined && RETRIEVAL_FACTOR[rs] !== 1.0) {
    // round17 R17-7：乘子后必须同步封顶 365 天（与 computeNext:164 / fsrs.MAX_STABILITY=365
    // 的既有上限一致）——此前只保下界，explain(×1.5) 可把 365 天卡推到 547.5 天，
    // 卡片离下次复习超过一年，设计上限被旁路
    r.intervalDays = Math.min(365, Math.max(10 / 1440, r.intervalDays * RETRIEVAL_FACTOR[rs]));
    r.dueAt = Date.now() + Math.round(r.intervalDays * DAY);
  }
  // 考试窗口感知：标注紧迫度（不改 FSRS 真实状态，仅在排程优先级层面生效）
  if (opts.examAt) {
    const eu = examWindowUrgency(card, opts.examAt, { desiredRetention: opts.desiredRetention });
    r.examUrgency = eu.urgency;
    r.atExamR = eu.atExamR;
    // 若下次复习落在考试之后，软压缩到考前窗口
    r.dueAt = compressIntoWindow(r.dueAt, opts.examAt);
  }
  // 节假日弹性：due 落在休息日则顺延到最近工作日（仅展示/排程层）
  if (opts.restDays && opts.restDays.weekdays?.length || opts.restDays?.dates?.length) {
    const moved = applyElasticDue(r.dueAt, opts.restDays);
    if (moved !== r.dueAt) r.dueAt = moved;
  }
  return r;
}
