// 源→卡→数据全血缘（source lineage）
// 把卡片的自由文本 source 升级为「可聚合、可追溯」的资产维度（MVP 不新增表）：
//   normalizeSource     归一化来源名（同源聚合）
//   aggregateBySource   每来源的卡片数/已复习/到期/错题/知识净值
//   traceCardLineage    单卡血缘（来源 + 变式链 sourceCardId + 同源卡）
// 纯函数、确定性，Node 可直接单测。

import { isReviewed, cardNetValue, contentWeight } from './networth.js';

export function normalizeSource(source) {
  return String(source || '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

const round2 = v => Math.round(v * 100) / 100;

/**
 * 按来源聚合卡片资产。
 * @param {Array} cards 卡片数组
 * @param {number} nowTs 参考时间戳
 * @returns {Array<{source, cards, reviewed, due, marked, value, mastery}>} 按卡片数降序
 */
export function aggregateBySource(cards, nowTs = Date.now()) {
  const agg = new Map();
  for (const c of cards || []) {
    if (!c) continue;
    const key = normalizeSource(c.source) || '（无来源）';
    const e = agg.get(key) || { source: key, cards: 0, reviewed: 0, due: 0, marked: 0, value: 0 };
    e.cards += 1;
    if (isReviewed(c)) e.reviewed += 1;
    if ((c.dueAt ?? 0) <= nowTs) e.due += 1;
    if (c.marked) e.marked += 1;
    e.value += cardNetValue(c, nowTs);
    agg.set(key, e);
  }
  return [...agg.values()]
    .map(e => ({
      source: e.source,
      cards: e.cards,
      reviewed: e.reviewed,
      due: e.due,
      marked: e.marked,
      value: round2(e.value),
      mastery: e.cards ? Math.round((e.reviewed / e.cards) * 100) : 0,
    }))
    .sort((a, b) => b.cards - a.cards);
}

/**
 * 单卡血缘：来源 + 变式链（sourceCardId 双向）+ 同源卡清单。
 * @param {object} card 目标卡
 * @param {Array} cards 全部卡片（用于找变式与同源）
 */
export function traceCardLineage(card, cards) {
  const list = cards || [];
  const source = normalizeSource(card?.source) || '（无来源）';
  // 变式链：直接父子（我引用别人 / 别人引用我）+ 同 parent 的兄弟姐妹（变式卡共享 origin）
  const variants = list.filter(c => {
    if (!c || c.id === card.id) return false;
    if (c.sourceCardId === card.id || c.id === card.sourceCardId) return true;
    if (card?.sourceCardId && c.sourceCardId === card.sourceCardId) return true;
    return false;
  });
  const sameSource = list.filter(c =>
    c && c.id !== card.id && normalizeSource(c.source) === source && !c.sourceCardId,
  );
  return {
    source,
    variantOf: card?.sourceCardId || null,
    variants: variants.map(c => ({ id: c.id, front: String(c.front || '').slice(0, 40), sourceCardId: c.sourceCardId || '' })),
    sameSourceIds: sameSource.slice(0, 20).map(c => c.id),
    sameSourceCount: sameSource.length,
  };
}

// 血缘总览：所有来源 + 变式关系汇总（供「来源资产」面板一次性展示）
export function sourceOverview(cards, nowTs = Date.now()) {
  const bySource = aggregateBySource(cards, nowTs);
  let variantCount = 0;
  for (const c of cards || []) if (c?.sourceCardId) variantCount++;
  const untraced = (cards || []).filter(c => !normalizeSource(c?.source)).length;
  return {
    bySource,
    variantCount,
    untraced,
    totalSources: bySource.length,
  };
}

// re-export 便于调用方一次 import（contentWeight 供展示每来源资产原值）
export { contentWeight };
