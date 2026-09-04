// src/sync-dedup.js
// 跨设备导入时的「卡片内容去重」纯函数（无 Dexie/IndexedDB 依赖，可在 node 单测）。
//
// 历史 bug（P0）：旧逻辑按 front||back||subject 内容键去重，会把「同一张卡（同 id）
// 在两台设备上因复习导致 SRS 字段不同」的卡误判为重复而丢弃 → 跨设备复习进度永不同步。
// 修复原则：
//   1) 同 id 的卡【必放行】，交给 sync-manifest 的 mergeRows 做字段级合并（SRS 按 reviewedAt 取新），
//      这样纯复习（ease/level/interval/dueAt 变）的卡能跨设备传播。
//   2) 仅「不同 id 且内容雷同」才视为真·重复跳过（避免重复建卡，保留原去重意图）。
//
// 2026-08-31（round12）补充：被跳过的「异 id 同内容」卡，其关联数据（复习记录 / 图谱边 / 卡组关联）
// 仍带着旧 cardId 进入合并 → 变成指向不存在卡片的孤儿行。故返回 idRemap（跳过 id → 保留 id），
// 由 importBackup 在合并前把引用重定向到保留下来的那张卡，避免复习/图谱污染。
export function dedupeIncomingCards(incoming, baseById, baseCards = []) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const keyToKeptId = new Map(); // 内容键 → 保留下来的 id（本地优先，其次批次内首个保留的 incoming）
  // O1（round13）：用 \x01 不可打印分隔符替代 ||——卡面本身含 || 时
  // 不同卡会生成相同内容键被误判为重复，\x01 不会出现在正常文本中。
  const SEP = '\x01';
  for (const c of (baseCards || [])) {
    const k = `${norm(c.front)}${SEP}${norm(c.back)}${SEP}${c.subject || ''}`;
    if (!keyToKeptId.has(k)) keyToKeptId.set(k, c.id); // 本地卡优先作为重定向目标
  }
  const kept = [];
  const idRemap = new Map();
  let duplicated = 0;
  for (const c of incoming || []) {
    if (baseById && baseById.has(c.id)) {
      kept.push(c); // 同 id → 走 mergeRows 合并 SRS，绝不被内容去重丢弃
      continue;
    }
    const k = `${norm(c.front)}${SEP}${norm(c.back)}${SEP}${c.subject || ''}`;
    if (keyToKeptId.has(k)) {
      // 异 id 同内容（或批次内重复）→ 真重复，跳过；关联数据重定向到保留 id
      duplicated++;
      idRemap.set(c.id, keyToKeptId.get(k));
      continue;
    }
    kept.push(c);
    keyToKeptId.set(k, c.id); // 批次内首个：后续同内容 incoming 也重定向到它
  }
  return { kept, duplicated, idRemap };
}

// ---------------------------------------------------------------------------
// 卡片引用字段注册表（BUG-04 收敛：单一来源，避免在 sync.js 里硬编码枚举导致漏改）
// 任何一张表若新增「引用卡片 id」的字段，都必须在这里登记对应类别，
// 否则被内容去重跳过的卡（异 id 同内容）会在该字段留下指向不存在卡片的孤儿引用。
// 类别说明：
//   scalar —— 字段值本身是单个卡片 id（cardId / sourceId / sourceCardId / fromCardId / toCardId）
//   array  —— 字段值是卡片 id 字符串数组（如 notes.linkedCardIds）
//   json   —— 字段值是 JSON 字符串，解析后为卡片 id 数组（如 analysisSessions.cardIds）
//   nested —— 字段值是对象数组，对象含 cardId 子字段（如 exams.questions: [{cardId}]）
// ---------------------------------------------------------------------------
export const CARD_REF_FIELDS = ['cardId', 'fromCardId', 'toCardId', 'sourceId', 'sourceCardId'];
export const ARRAY_REF_FIELDS = ['linkedCardIds'];
export const JSON_REF_FIELDS = ['cardIds'];
export const NESTED_REF_FIELDS = ['questions'];

/**
 * 把 backup 里所有「引用卡片 id」的字段按 idRemap 重定向到保留卡（纯函数，无 IO）。
 * 这是 importBackup 0b 步的核心，抽到纯逻辑层后：① sync.js 与单测共用同一实现，
 * ② 避免测试里维护一份易漂移的内联副本（BUG-04 的「硬编码枚举」问题）。
 * @param {object} backup 导入数据包（键 = 表名，值 = 行数组或非数组）
 * @param {Map<string,string>} idRemap 跳过 id → 保留 id
 * @returns {object} 重定向后的新 backup（不修改入参）
 */
export function remapCardRefs(backup, idRemap) {
  if (!backup || !idRemap || !idRemap.size) return backup;
  const remap = (v) => (idRemap.has(v) ? idRemap.get(v) : v);
  const out = {};
  for (const key of Object.keys(backup)) {
    const rows = backup[key];
    if (!Array.isArray(rows)) { out[key] = rows; continue; }
    out[key] = rows.map((r) => {
      let row = r;
      // cards 表自身只重定向 sourceCardId 单字段——绝不能对 cards 行做整行级
      // cardId 重定向（那会把保留卡的自身 id 改掉）
      if (key === 'cards') {
        if (r.sourceCardId != null && idRemap.has(r.sourceCardId)) {
          row = { ...row, sourceCardId: idRemap.get(r.sourceCardId) };
        }
        return row;
      }
      for (const f of CARD_REF_FIELDS) {
        if (r[f] != null && idRemap.has(r[f])) row = { ...row, [f]: idRemap.get(r[f]) };
      }
      for (const f of ARRAY_REF_FIELDS) {
        if (Array.isArray(r[f])) row = { ...row, [f]: r[f].map((x) => remap(x)) };
      }
      for (const f of JSON_REF_FIELDS) {
        if (typeof r[f] === 'string') {
          try {
            const arr = JSON.parse(r[f]);
            if (Array.isArray(arr)) row = { ...row, [f]: JSON.stringify(arr.map((x) => remap(x))) };
          } catch { /* 非 JSON 字符串：原样保留 */ }
        }
      }
      for (const f of NESTED_REF_FIELDS) {
        if (Array.isArray(r[f])) {
          row = { ...row, [f]: r[f].map((q) => (q && typeof q === 'object' && q.cardId != null && idRemap.has(q.cardId)) ? { ...q, cardId: remap(q.cardId) } : q) };
        }
      }
      return row;
    });
  }
  return out;
}
