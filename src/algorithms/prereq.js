// 前驱依赖解析的纯逻辑层（无 IO、无 Dexie 依赖，可独立单测）。
// 抽出原因：derivePrereqPlan 原仅回溯单层前驱（N4），对「未掌握前置的前置」视而不见，
// 导致错题轰炸 / 学习计划可能从更高阶概念开始、跳过更底层的未掌握前置。
// 这里把多层 BFS 回溯做成纯函数，编排层负责加载边与已掌握集合后调用。

/**
 * 沿 prereq 边做多层 BFS 回溯，收集目标卡的所有「未掌握」祖先前置卡。
 *
 * ⚠️ ID 空间：图谱里混着两种端点写法（见 graph-resolve.js 说明）——
 * 有的边 from/to 就是卡片 id，有的 from/to 是人类可读文本、卡片 id 在 fromCardId/toCardId。
 * 这里统一优先取 *CardId 字段，取不到才退回 from/to，
 * 否则「AI 生成 / 智能推荐」建的边会被整条链路无视（前置回溯静默失效）。
 *
 * @param {Array<{from:string,to:string,kind:string,fromCardId?:string,toCardId?:string}>} edges 图谱边
 * @param {Set<string>} masteredSet 已掌握卡片 id 集合
 * @param {string} cardId 目标薄弱卡
 * @returns {{prereqCardIds:string[], relatedCardIds:string[]}}
 */
/** 判定边的语义类型：有 kind 直接用；没有（AI 生成 / 推荐 / 资料边只有 label）则按 label 推断。 */
export function kindOfEdge(e) {
  const k = String(e?.kind || '').trim();
  if (k === 'prereq' || k === 'related') return k;
  const l = String(e?.label || '');
  if (/前置|依赖|基础|先修|prereq/i.test(l)) return 'prereq';
  return 'related';
}

export function resolvePrereqPlan(edges, masteredSet, cardId) {
  const prereqMap = new Map(); // to -> [from...]
  const relatedMap = new Map(); // to -> [from...]
  for (const e of edges) {
    // 旧版 graphAuto 直接把卡片 id 写进 from/to，新版写在 *CardId 上 → 两者都要认
    const a = String(e.fromCardId || e.from || '').trim();
    const b = String(e.toCardId || e.to || '').trim();
    if (!a || !b || a === b) continue;
    if (kindOfEdge(e) === 'prereq') {
      if (!prereqMap.has(b)) prereqMap.set(b, []);
      prereqMap.get(b).push(a);
    } else {
      if (!relatedMap.has(b)) relatedMap.set(b, []);
      relatedMap.get(b).push(a);
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
