// src/algorithms/pretest.js
// 冷启动前测：用「自评分 / 预测验」估计每科目初始记忆稳定度 S，
// 替代 FSRS 默认 S0，让新卡首次排程更贴近真实掌握度，减少前几次复习的抖动。
//
// 纯函数（不依赖 db），便于单测；存储由 repo 层负责（meta['pretestStability']）。

// 自评分 familiarity 0~5 → 初始稳定度（天）
//   0 完全不会 → 0.5 天；  5 滚瓜烂熟 → 12 天
const FAMILIARITY_S = [0.5, 1.0, 2.0, 4.0, 7.0, 12.0];

// 科目难度系数：同等自评分下，越难的科目初始 S 略打折（首次接触更难内化）
//
// ⚠️ 2026-08-30 修复：这里是**包含匹配**的关键词表，不是精确键查找。
//   此前用 `SUBJECT_FACTOR[subject] ?? 1.0` 精确查表，而实际科目名来自
//   repo-core.DEFAULT_SUBJECTS（'计算机网络' / '高等数学' / '概率论' / '线性代数' …），
//   与表里的 '数学' / '计网' / 'OS' 无一精确相等 → 整张表静默失效，全部回退 1.0。
//   即：冷启动前测的「难科打折」功能从来没生效过。
const SUBJECT_FACTOR_RULES = [
  [/数学|高数/, 0.82],
  [/线代|线性代数/, 0.82],
  [/概率/, 0.85],
  [/408|计算机|组成原理|计组/, 0.80],
  [/网络|计网/, 0.85],
  [/操作?系统|\bOS\b/i, 0.85],
  [/英语|单词/, 0.95],   // 记忆型，首次内化相对容易
  [/政治|马原|毛概|史纲/, 0.95],
];

/** 科目名 → 难度系数（包含匹配；命中第一条即返回，都不中返回 1.0） */
export function subjectFactorOf(subject = '') {
  const s = String(subject || '');
  if (!s) return 1.0;
  for (const [re, f] of SUBJECT_FACTOR_RULES) if (re.test(s)) return f;
  return 1.0;
}

// 内容难度（basic/applied/challenge 或 0/1/2）→ 初始 S 微调
const DIFF_ADJ = { 0: 1.1, 1: 1.0, 2: 0.82 };

/**
 * 难度归一化：'basic'|'applied'|'challenge' 与 0|1|2（数字或数字字符串）都要能识别。
 * ⚠️ 此前两处各写一份：一处支持数字、另一处把数字 2 落到 else 分支得 0
 *   —— 同一张卡走 estimateInitialStability 与 initialStabilityForCard 会算出不同的 S。
 */
export function difficultyToNum(d) {
  if (d === 'basic') return 0;
  if (d === 'applied') return 1;
  if (d === 'challenge') return 2;
  const n = Number(d);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n))) : 0;
}

/**
 * 估计初始稳定度（天）
 * @param {object} o { familiarity?:number 0~5, difficulty?:'basic'|'applied'|'challenge'|0|1|2, subject?:string }
 * @returns number 稳定度 S（>=0.5）
 */
export function estimateInitialStability({ familiarity = 2, difficulty = 'basic', subject = '' } = {}) {
  const fam = Math.max(0, Math.min(5, Math.round(Number(familiarity) || 0)));
  let s = FAMILIARITY_S[fam];
  s *= subjectFactorOf(subject);
  s *= DIFF_ADJ[difficultyToNum(difficulty)] ?? 1.0;
  return Math.max(0.5, Number(s.toFixed(3)));
}

/**
 * 若某科目做过前测，返回该科目估计的稳定度；否则返回 null（走 FSRS 默认）。
 * @param {object} card { subject?, difficulty?, fsrs? }
 * @param {object} pretestMap { [subject]: number } 来自 meta['pretestStability']
 */
export function initialStabilityForCard(card, pretestMap) {
  if (card?.fsrs && card.fsrs.reps > 0) return null; // 已有复习历史，不走冷启动
  const subj = card?.subject || 'default';
  const base = pretestMap && pretestMap[subj];
  if (typeof base !== 'number') return null;
  return Math.max(0.5, base * (DIFF_ADJ[difficultyToNum(card?.difficulty)] ?? 1.0));
}
