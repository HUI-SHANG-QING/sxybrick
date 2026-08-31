// 知识净值（Knowledge Net Worth）
// 把卡片库看作「知识资产负债表」：每张卡有内容权重（资产原值），
// 已复习的卡按记忆保持度 R(t) 折旧（遗忘=折旧），净值 = 原值 × R。
// 纯函数、确定性，Node 可直接单测。与 FSRS 共用 retrievability 保持口径一致。

import { retrievability, DEFAULT_WEIGHTS } from '../fsrs.js';

const DAY = 24 * 60 * 60 * 1000;

// 内容权重（资产原值）：
//   基础 1 + 难度梯度加成（applied +0.5 / challenge +1）+ 错题重点加成（+0.5）+ 来源溯源加成（+0.2）
//   范围约 1 ~ 2.7，越大代表这张卡「掌握后的含金量」越高。
export function contentWeight(card) {
  const diff = card?.difficulty;
  const diffBonus = diff === 'challenge' ? 1 : diff === 'applied' ? 0.5 : 0;
  const markedBonus = card?.marked ? 0.5 : 0;
  const sourceBonus = (card?.source && String(card.source).trim()) ? 0.2 : 0;
  return Math.round((1 + diffBonus + markedBonus + sourceBonus) * 100) / 100;
}

// 判断卡片是否已复习过（有有效 fsrs 状态且 reps >= 1）
export function isReviewed(card) {
  const f = card?.fsrs;
  // 必须用 Number.isFinite 而不是 typeof：NaN 的 typeof 也是 'number'，
  // 一旦放过 NaN，它会一路污染 retrievability → 单卡净值 → 全局总净值 →
  // 按来源聚合，整张报表变成一串 NaN，且没有任何报错。
  return !!(f && Number.isFinite(f.s) && f.s > 0 && f.reps >= 1);
}

/** 单卡「原值」= 内容权重（与该卡是否已学无关） */
export function cardIdealValue(card) {
  return contentWeight(card);
}

/**
 * 单卡当前净值：未复习 = **0**；已复习 = 原值 × R(t)（遗忘即折旧）。
 *
 * ⚠️ 2026-08-30 修复：此前未复习卡按「原值全额」计（R 默认 1），
 *   于是导入 1000 张新卡后 净值 1000+、知识保持率 100% ——
 *   「还没背过」被当成了「完全记住」，与「未复习科目按 0 分拉低掌握度」是同一类
 *   「无数据 ≠ 0 / ≠ 满分」的口径错误，只是方向相反。
 *   正确语义：没学过的卡尚未沉淀出任何知识净值，计 0。
 */
export function cardNetValue(card, nowTs = Date.now(), w = DEFAULT_WEIGHTS) {
  const wgt = contentWeight(card);
  if (!isReviewed(card)) return 0;
  const f = card.fsrs;
  const elapsedDays = Math.max(0, (nowTs - (f.last ?? nowTs)) / DAY);
  const R = retrievability(f.s, elapsedDays, w);
  return Math.round(wgt * R * 100) / 100;
}

/**
 * 汇总知识净值。
 * @param {Array} cards 卡片数组
 * @param {number} nowTs 参考时间戳（默认 Date.now()）
 * @param {Array} w      FSRS 权重（默认 DEFAULT_WEIGHTS）
 * @returns {{
 *   totalValue, idealValue, decayedValue, retentionRate,
 *   newCount, reviewedCount, masteredCount, totalCards, bySubject
 * }}
 */
export function computeNetWorth(cards, nowTs = Date.now(), w = DEFAULT_WEIGHTS) {
  let totalValue = 0, idealValue = 0, newCount = 0, masteredCount = 0;
  // reviewedIdeal：保持率的**分母**，只算「学过的卡」。
  //   若把未复习卡算进分母，导入一堆新卡会把保持率稀释成很低（与旧的"满分"是同一错误的两个极端）。
  //   未复习卡的净值按 0 计、原值仍单列在 newIdeal 里，UI 可展示「还有多少潜力没挖」。
  let reviewedIdeal = 0, newIdeal = 0;
  const bySubject = new Map();

  for (const card of cards || []) {
    if (!card) continue;
    const wgt = contentWeight(card);
    let R = 0; // 未复习 = 0（不是 1）
    if (isReviewed(card)) {
      const f = card.fsrs;
      R = retrievability(f.s, Math.max(0, (nowTs - (f.last ?? nowTs)) / DAY), w);
      if (R >= 0.9) masteredCount++;
      reviewedIdeal += wgt;
    } else {
      newCount++;
      newIdeal += wgt;
    }
    const net = Math.round(wgt * R * 100) / 100;
    totalValue += net;
    idealValue += wgt; // 原值 = 全量潜力（含未学的卡）

    const subj = card.subject || '未分类';
    const e = bySubject.get(subj) || { subject: subj, value: 0, ideal: 0, reviewedIdeal: 0, count: 0 };
    e.value += net; e.ideal += wgt; e.count++;
    if (isReviewed(card)) e.reviewedIdeal += wgt;
    bySubject.set(subj, e);
  }

  totalValue = Math.round(totalValue * 100) / 100;
  idealValue = Math.round(idealValue * 100) / 100;
  reviewedIdeal = Math.round(reviewedIdeal * 100) / 100;
  newIdeal = Math.round(newIdeal * 100) / 100;

  const bySubjectList = [...bySubject.values()]
    .map(e => ({
      subject: e.subject,
      value: Math.round(e.value * 100) / 100,
      ideal: Math.round(e.ideal * 100) / 100,
      // 分母用「该科已学卡的原值」，未学的卡不参与保持率
      retentionRate: e.reviewedIdeal ? Math.round(e.value / e.reviewedIdeal * 100) : 0,
      count: e.count,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    totalValue,
    idealValue,
    reviewedIdeal,
    newIdeal,
    decayedValue: Math.round((reviewedIdeal - totalValue) * 100) / 100,
    retentionRate: reviewedIdeal ? Math.round(totalValue / reviewedIdeal * 100) : 0,
    newCount,
    reviewedCount: (cards || []).length - newCount,
    masteredCount,
    totalCards: (cards || []).length,
    bySubject: bySubjectList,
  };
}
