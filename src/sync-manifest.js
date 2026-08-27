// 同步清单（唯一事实来源）
// 前端 src/sync.js 与局域网中枢 sync-hub/hub.js 共用同一份清单，
// 新增数据表时只需在此登记，导出/导入/中枢合并便自动覆盖，避免多处遗漏。
// 注意：本文件必须保持"无浏览器依赖"，因为 hub.js 会直接在 Node 里 import 它。

export const BACKUP_VERSION = 5;

// merge 策略：
//   card      卡片专属：内容字段按 updatedAt、SRS 字段按 reviewedAt、错因按 wrongReasonAt 字段级合并
//   updatedAt 按 max(updatedAt ?? createdAt ?? 0) 谁新听谁
//   idOnly    按 id 幂等（不可变记录：复习、图片、番茄专注、向量嵌入）

// 本地日志/通知表——设备本地诊断数据，故意不同步（跨设备无意义且增大包体积）
// snapshots：同步快照仅本机回滚用，跨设备无意义且增大包体积
// plugins：插件为本机扩展，跨设备无意义且可能含敏感配置（API Key 等）
export const EXCLUDED_FROM_SYNC = ['notifications', 'errors', 'snapshots', 'plugins'];

// 隐私敏感表——默认不入同步/全量导出，需用户显式 opt-in（PIPL 合规）
export const PRIVACY_SYNC_TABLES = [
  { table: 'privacyRecords', kind: 'privacy', merge: 'updatedAt' },
];

export const SYNC_TABLES = [
  { table: 'cards', kind: 'card', merge: 'card' },
  { table: 'reviews', kind: 'review', merge: 'idOnly' },
  { table: 'images', kind: 'image', merge: 'idOnly' },
  { table: 'aiChats', kind: 'chat', merge: 'updatedAt' },
  { table: 'aiMemories', kind: 'memory', merge: 'updatedAt' },
  { table: 'memos', kind: 'memo', merge: 'updatedAt' },
  { table: 'plans', kind: 'plan', merge: 'updatedAt' },
  { table: 'graphEdges', kind: 'graphEdge', merge: 'updatedAt' },
  { table: 'docs', kind: 'doc', merge: 'updatedAt' },
  { table: 'pomoSessions', kind: 'pomo', merge: 'idOnly' },
  { table: 'mindmaps', kind: 'mindmap', merge: 'updatedAt' },
  { table: 'weeklyReports', kind: 'weeklyReport', merge: 'updatedAt' },
  { table: 'achievements', kind: 'achievement', merge: 'idOnly' }, // 解锁不可逆：id 幂等
  { table: 'exams', kind: 'exam', merge: 'updatedAt' },
  // v9 新增：RAG 向量嵌入（由 cardId+content 确定性生成，idOnly 幂等即可）
  { table: 'embeddings', kind: 'embedding', merge: 'idOnly' },
  // v13 新增：用户全操作埋点（量大：导出时默认提供"仅导出聚合"选项以缩小包体积）
  { table: 'userOps', kind: 'userOp', merge: 'idOnly' },
  // privacyRecords 默认不入同步（PIPL 敏感数据），见 PRIVACY_SYNC_TABLES + includePrivacySync()
];

// 卡片字段级合并分组：
//   内容侧（按 updatedAt 谁新听谁）：文本/科目/标签/来源/错题标记/助记/难度梯度(P3-E)
//   SRS 侧（按 reviewedAt ?? updatedAt 谁新听谁）：记忆曲线状态(ease/level/intervalDays/dueAt) + consolidation(短期巩固状态)
//   错因侧（按 wrongReasonAt 独立取新者）：wrongReason 由复习写入但不 bump updatedAt，
//         故不跟随内容也不跟随 SRS，用独立时间戳 wrongReasonAt 合并，避免跨设备丢失
//   注：difficulty 是卡片固有内容属性（basic/applied/challenge），随内容编辑走 updatedAt 合并，
//       而非复习状态；否则另一台设备单纯复习（reviewedAt 更新）会覆盖本机的难度编辑。
export const CARD_CONTENT_FIELDS = ['front', 'back', 'subject', 'source', 'type', 'marked', 'mnemonic', 'tags', 'frontChars', 'backChars', 'difficulty'];
export const CARD_SRS_FIELDS = ['ease', 'level', 'intervalDays', 'dueAt', 'reviewedAt', 'consolidation', 'fsrs'];

// ---------- 纯合并函数（无浏览器依赖，前端 sync.js 与 Node 端 hub.js 共用） ----------

// 墓碑 kind 缺省 = card（兼容旧数据包）
export function kindOf(t) { return t?.kind || 'card'; }

// 卡片字段级合并：内容、SRS、错因各自独立取「新者」，
// 解决「复习动作 bump updatedAt 会把另一台设备的文字编辑覆盖掉」的数据丢失问题，
// 同时解决「错因随复习写入但不 bump updatedAt，另一台设备编辑文字后错因被丢」的问题
export function mergeCardPair(local, incoming) {
  const incTs = incoming.updatedAt ?? 0;
  const locTs = local.updatedAt ?? 0;
  const incRev = incoming.reviewedAt ?? incTs; // 旧数据无 reviewedAt：退化为 updatedAt
  const locRev = local.reviewedAt ?? locTs;
  const content = incTs >= locTs ? incoming : local;
  const srs = incRev >= locRev ? incoming : local;
  const out = { ...content, updatedAt: Math.max(incTs, locTs) };
  for (const f of CARD_SRS_FIELDS) {
    if (srs && srs[f] !== undefined) out[f] = srs[f];
  }
  // 错因用独立时间戳 wrongReasonAt 合并（不跟随 updatedAt 也不跟随 reviewedAt）
  const incWRA = incoming.wrongReasonAt ?? 0;
  const locWRA = local.wrongReasonAt ?? 0;
  if (incWRA >= locWRA) {
    out.wrongReason = incoming.wrongReason ?? '';
    if (incWRA) out.wrongReasonAt = incWRA;
  } else {
    out.wrongReason = local.wrongReason ?? '';
    if (locWRA) out.wrongReasonAt = locWRA;
  }
  return out;
}

// 通用行合并（按清单 merge 策略）
export function mergeRows(base, incoming, strategy) {
  const m = new Map((base || []).map(x => [x.id, x]));
  for (const x of incoming || []) {
    if (!x || x.id == null) continue;
    const cur = m.get(x.id);
    if (!cur) { m.set(x.id, x); continue; }
    if (strategy === 'card') { m.set(x.id, mergeCardPair(cur, x)); continue; }
    if (strategy === 'updatedAt') {
      const a = cur.updatedAt ?? cur.createdAt ?? 0;
      const b = x.updatedAt ?? x.createdAt ?? 0;
      if (b >= a) m.set(x.id, x);
    }
    // idOnly：不可变记录，已存在则保留
  }
  return [...m.values()];
}

// 墓碑合并：deletedAt 谁新听谁；kind 兼容旧数据
export function mergeTombstones(base, incoming) {
  const m = new Map((base || []).filter(t => t && t.id != null).map(t => [t.id, { ...t, kind: kindOf(t) }]));
  for (const t of incoming || []) {
    if (!t || t.id == null) continue;
    const cur = m.get(t.id);
    if (!cur || (t.deletedAt ?? 0) >= (cur.deletedAt ?? 0)) m.set(t.id, { ...t, kind: kindOf(t) });
  }
  return [...m.values()];
}

// 对某一种类的行应用墓碑：
//   行时间 <= 墓碑时间 → 删除，返回 removed；
//   行时间 >  墓碑时间 → 该行已「复活」，标记墓碑为 stale（应清除）
export function applyTombstones(rows, tombstones, kind) {
  const map = new Map((rows || []).map(r => [r.id, r]));
  const removed = [];
  const stale = [];
  for (const t of tombstones || []) {
    if (kindOf(t) !== kind) continue;
    const r = map.get(t.id);
    if (!r) continue;
    const rTs = r.updatedAt ?? r.createdAt ?? 0;
    if (rTs <= (t.deletedAt ?? 0)) { map.delete(t.id); removed.push(t.id); }
    else stale.push(t.id);
  }
  return { rows: [...map.values()], removed, stale };
}
