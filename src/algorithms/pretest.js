// src/algorithms/pretest.js
// 冷启动前测：用「自评分 / 预测验」估计每科目初始记忆稳定度 S，
// 替代 FSRS 默认 S0，让新卡首次排程更贴近真实掌握度，减少前几次复习的抖动。
//
// 纯函数（不依赖 db），便于单测；存储由 repo 层负责（meta['pretestStability']）。

// 自评分 familiarity 0~5 → 初始稳定度（天）
//   0 完全不会 → 0.5 天；  5 滚瓜烂熟 → 12 天
const FAMILIARITY_S = [0.5, 1.0, 2.0, 4.0, 7.0, 12.0];

// 科目难度系数：同等自评分下，越难的科目初始 S 略打折（首次接触更难内化）
const SUBJECT_FACTOR = {
  '数学': 0.82, '线代': 0.82, '概率': 0.85, '408': 0.8,
  '计算机': 0.85, '计组': 0.82, '计网': 0.85, 'OS': 0.85,
  'default': 1.0,
};

// 内容难度（basic/application/challenge 映射 0/1/2）→ 初始 S 微调
const DIFF_ADJ = { 0: 1.1, 1: 1.0, 2: 0.82 };

/**
 * 估计初始稳定度（天）
 * @param {object} o { familiarity?:number 0~5, difficulty?:'basic'|'applied'|'challenge'|0|1|2, subject?:string }
 * @returns number 稳定度 S（>=0.5）
 */
export function estimateInitialStability({ familiarity = 2, difficulty = 'basic', subject = '' } = {}) {
  const fam = Math.max(0, Math.min(5, Math.round(Number(familiarity) || 0)));
  let s = FAMILIARITY_S[fam];
  const sf = SUBJECT_FACTOR[subject] ?? SUBJECT_FACTOR.default;
  s *= sf;
  const diffNum = difficulty === 'basic' ? 0 : difficulty === 'applied' ? 1 : difficulty === 'challenge' ? 2 : (Number(difficulty) || 0);
  s *= DIFF_ADJ[Math.max(0, Math.min(2, diffNum))] ?? 1.0;
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
  const diffNum = card?.difficulty === 'basic' ? 0 : card?.difficulty === 'applied' ? 1 : card?.difficulty === 'challenge' ? 2 : 0;
  return Math.max(0.5, base * (DIFF_ADJ[diffNum] ?? 1.0));
}
