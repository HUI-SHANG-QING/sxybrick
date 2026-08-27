// src/sync-dedup.js
// 跨设备导入时的「卡片内容去重」纯函数（无 Dexie/IndexedDB 依赖，可在 node 单测）。
//
// 历史 bug（P0）：旧逻辑按 front||back||subject 内容键去重，会把「同一张卡（同 id）
// 在两台设备上因复习导致 SRS 字段不同」的卡误判为重复而丢弃 → 跨设备复习进度永不同步。
// 修复原则：
//   1) 同 id 的卡【必放行】，交给 sync-manifest 的 mergeRows 做字段级合并（SRS 按 reviewedAt 取新），
//      这样纯复习（ease/level/interval/dueAt 变）的卡能跨设备传播。
//   2) 仅「不同 id 且内容雷同」才视为真·重复跳过（避免重复建卡，保留原去重意图）。
export function dedupeIncomingCards(incoming, baseById, baseCards = []) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const localDupKeys = new Set(
    (baseCards || []).map((c) => `${norm(c.front)}||${norm(c.back)}||${c.subject || ''}`)
  );
  const seen = new Set();
  const kept = [];
  let duplicated = 0;
  for (const c of incoming || []) {
    if (baseById && baseById.has(c.id)) {
      kept.push(c); // 同 id → 走 mergeRows 合并 SRS，绝不被内容去重丢弃
      continue;
    }
    const k = `${norm(c.front)}||${norm(c.back)}||${c.subject || ''}`;
    if (localDupKeys.has(k) || seen.has(k)) {
      duplicated++; // 异 id 同内容（或批次内重复）→ 真重复，跳过
      continue;
    }
    kept.push(c);
    seen.add(k);
  }
  return { kept, duplicated };
}
