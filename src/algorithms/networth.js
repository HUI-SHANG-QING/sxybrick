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
  return !!(f && typeof f.s === 'number' && f.reps >= 1);
}

// 单卡当前净值：未复习 = 原值全额；已复习 = 原值 × R(t)（遗忘即折旧）
export function cardNetValue(card, nowTs = Date.now(), w = DEFAULT_WEIGHTS) {
  const wgt = contentWeight(card);
  if (!isReviewed(card)) return wgt;
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
  const bySubject = new Map();

  for (const card of cards || []) {
    if (!card) continue;
    const wgt = contentWeight(card);
    let R = 1;
    if (isReviewed(card)) {
      const f = card.fsrs;
      R = retrievability(f.s, Math.max(0, (nowTs - (f.last ?? nowTs)) / DAY), w);
      if (R >= 0.9) masteredCount++;
    } else {
      newCount++;
    }
    const net = Math.round(wgt * R * 100) / 100;
    totalValue += net;
    idealValue += wgt;

    const subj = card.subject || '未分类';
    const e = bySubject.get(subj) || { subject: subj, value: 0, ideal: 0, count: 0 };
    e.value += net; e.ideal += wgt; e.count++;
    bySubject.set(subj, e);
  }

  totalValue = Math.round(totalValue * 100) / 100;
  idealValue = Math.round(idealValue * 100) / 100;

  const bySubjectList = [...bySubject.values()]
    .map(e => ({
      subject: e.subject,
      value: Math.round(e.value * 100) / 100,
      ideal: Math.round(e.ideal * 100) / 100,
      retentionRate: e.ideal ? Math.round(e.value / e.ideal * 100) : 0,
      count: e.count,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    totalValue,
    idealValue,
    decayedValue: Math.round((idealValue - totalValue) * 100) / 100,
    retentionRate: idealValue ? Math.round(totalValue / idealValue * 100) : 0,
    newCount,
    reviewedCount: (cards || []).length - newCount,
    masteredCount,
    totalCards: (cards || []).length,
    bySubject: bySubjectList,
  };
}
