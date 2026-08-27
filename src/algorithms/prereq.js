// 前驱依赖解析的纯逻辑层（无 IO、无 Dexie 依赖，可独立单测）。
// 抽出原因：derivePrereqPlan 原仅回溯单层前驱（N4），对「未掌握前置的前置」视而不见，
// 导致错题轰炸 / 学习计划可能从更高阶概念开始、跳过更底层的未掌握前置。
// 这里把多层 BFS 回溯做成纯函数，编排层负责加载边与已掌握集合后调用。

/**
 * 沿 prereq 边做多层 BFS 回溯，收集目标卡的所有「未掌握」祖先前置卡。
 * @param {Array<{from:string,to:string,kind:string}>} edges 图谱边
 * @param {Set<string>} masteredSet 已掌握卡片 id 集合
 * @param {string} cardId 目标薄弱卡
 * @returns {{prereqCardIds:string[], relatedCardIds:string[]}}
 */
export function resolvePrereqPlan(edges, masteredSet, cardId) {
  const prereqMap = new Map(); // to -> [from...]
  const relatedMap = new Map(); // to -> [from...]
  for (const e of edges) {
    if (e.kind === 'prereq') {
      if (!prereqMap.has(e.to)) prereqMap.set(e.to, []);
      prereqMap.get(e.to).push(e.from);
    } else if (e.kind === 'related') {
      if (!relatedMap.has(e.to)) relatedMap.set(e.to, []);
      relatedMap.get(e.to).push(e.from);
    }
  }

  // 多层前驱 BFS：从目标卡向上回溯，收集所有层级的未掌握前置
  // （已掌握的前置不进练习集，但仍继续向上回溯其链条，确保不漏更底层的未掌握前置；visited 防环）。
  const prereq = new Set();
  const visited = new Set([cardId]);
  const queue = [cardId];
  while (queue.length) {
    const cur = queue.shift();
    for (const from of prereqMap.get(cur) || []) {
      if (visited.has(from)) continue;
      visited.add(from);
      if (!masteredSet.has(from)) prereq.add(from);
      queue.push(from);
    }
  }

  // related 保持单层（相关 ≠ 前置，避免范围膨胀）
  const related = new Set();
  for (const from of relatedMap.get(cardId) || []) {
    if (!masteredSet.has(from)) related.add(from);
  }

  return { prereqCardIds: [...prereq], relatedCardIds: [...related] };
}
