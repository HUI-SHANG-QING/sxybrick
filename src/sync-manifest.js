// 同步清单（唯一事实来源）
// 前端 src/sync.js 与局域网中枢 sync-hub/hub.js 共用同一份清单，
// 新增数据表时只需在此登记，导出/导入/中枢合并便自动覆盖，避免多处遗漏。
// 注意：本文件必须保持"无浏览器依赖"，因为 hub.js 会直接在 Node 里 import 它。

export const BACKUP_VERSION = 7;

// merge 策略：
//   card      卡片专属：内容字段按 updatedAt、SRS 字段按 reviewedAt、错因按 wrongReasonAt 字段级合并
//   updatedAt 按 max(updatedAt ?? createdAt ?? 0) 谁新听谁
//   idOnly    按 id 幂等（不可变记录：复习、图片、番茄专注、向量嵌入）

// 本地日志/通知表——设备本地诊断数据，故意不同步（跨设备无意义且增大包体积）
// snapshots：同步快照仅本机回滚用，跨设备无意义且增大包体积
// plugins：插件为本机扩展，跨设备无意义且可能含敏感配置（API Key 等）
// aiUsage：AI 用量账本（P2-27），本设备计费上下文，不同步
export const EXCLUDED_FROM_SYNC = ['notifications', 'errors', 'snapshots', 'plugins', 'aiUsage'];

// 隐私敏感表——默认不入同步/全量导出，需用户显式 opt-in（PIPL 合规）
export const PRIVACY_SYNC_TABLES = [
  { table: 'privacyRecords', kind: 'privacy', merge: 'updatedAt' },
];

export const SYNC_TABLES = [
  { table: 'cards', kind: 'card', merge: 'card' },
  { table: 'reviews', kind: 'review', merge: 'review' },
  { table: 'images', kind: 'image', merge: 'idOnly' },
  { table: 'aiChats', kind: 'chat', merge: 'updatedAt' },
  { table: 'aiMemories', kind: 'memory', merge: 'updatedAt' },
  { table: 'memos', kind: 'memo', merge: 'updatedAt' },
  { table: 'plans', kind: 'plan', merge: 'updatedAt' },
  // graphEdges：只同步「人工确认 / AI 生成 / 资料」的关联，
  //   **不同步 kind='auto' 的自动推导边**——它是从卡片集合确定性推出来的派生数据，
  //   每台设备自己重算即可。若让它进同步会有两个坑：
  //   ① A 设备每次重建都 bulkDelete 旧边再写新边，但不产生墓碑（派生数据不该带删除语义），
  //      B 设备上的旧 auto 边会永久堆积；
  //   ② id 是 `auto-${aId}-${bId}` 这种确定性拼接，两端同 id 行的 updatedAt 会互相覆盖，
  //      出现「越同步越乱」的伪冲突。故在导出侧直接过滤。
  { table: 'graphEdges', kind: 'graphEdge', merge: 'updatedAt', exportFilter: (r) => r?.kind !== 'auto' },
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
  // v17 新增：资料库文件元数据（Phase 6）——只同步元数据（文件名/大小/状态/科目），
  //   原文件（OPFS）与解析全文（docTexts 本地表）不同步，跨设备可见清单但不可预览原文
  { table: 'docFiles', kind: 'docFile', merge: 'updatedAt' },
  // privacyRecords 默认不入同步（PIPL 敏感数据），见 PRIVACY_SYNC_TABLES + includePrivacySync()
  // v18 新增：笔记（双向链接跨设备打通；合并策略按 updatedAt，谁新听谁）
  { table: 'notes', kind: 'note', merge: 'updatedAt' },
  // v19 新增：每日规划/打卡（D8）——计划头 + 任务明细，均按 updatedAt 合并
  { table: 'dailyPlans', kind: 'dailyPlan', merge: 'updatedAt' },
  { table: 'dailyTasks', kind: 'dailyTask', merge: 'updatedAt' },
  // v22（M1）新增：卡组 + 卡片-卡组关联
  //   cardGroups 按 updatedAt 合并（重命名/状态/颜色，谁新听谁）
  //   cardGroupLinks：加入按 addedAt 记录；「移出」= 本端删行（墓碑 kind=groupLink）。
  //   冲突口径：设备1 移入 / 设备2 移出，按「加入时间 vs 墓碑删除时间」谁新听谁
  //   （sync.js 通用墓碑合并已支持任意 kind，link 行 id 全局唯一即可）
  { table: 'cardGroups', kind: 'cardGroup', merge: 'updatedAt' },
  { table: 'cardGroupLinks', kind: 'groupLink', merge: 'idOnly' },
  // v23（M2）新增：联动分析会话 + 消息（对话历史跨设备回看）
  //   会话按 updatedAt 合并（标题/卡片集更新）；消息不可变（append-only）→ idOnly 幂等
  { table: 'analysisSessions', kind: 'analysisSession', merge: 'updatedAt' },
  { table: 'analysisMessages', kind: 'analysisMessage', merge: 'idOnly' },
];

/**
 * 导出侧行级过滤（可选）：清单条目可带 exportFilter(row) => boolean。
 * 用于排除「派生数据 / 本机专属数据」，避免它们进入备份包或被同步到别的设备。
 * 纯函数，Node（hub）与浏览器（sync.js）共用。
 */
export function shouldExportRow(entry, row) {
  if (!entry || typeof entry.exportFilter !== 'function') return true;
  try { return entry.exportFilter(row) !== false; } catch { return true; }
}

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
  // 修复 P1：原 `>=` 在「两端时间戳相等（均为 0 或同一时刻）」时会无条件采纳 incoming，
  // 若 incoming 未携带错因（空串）会把本地已有的错因覆盖为空 → 跨设备错因丢失。
  // 改用严格 `>` 判定，并在时间戳相等时优先保留「有内容」的一方，杜绝空值覆盖。
  const incWRA = incoming.wrongReasonAt ?? 0;
  const locWRA = local.wrongReasonAt ?? 0;
  const incWR = incoming.wrongReason ?? '';
  const locWR = local.wrongReason ?? '';
  let chosen, chosenTs;
  if (incWRA > locWRA) { chosen = incoming; chosenTs = incWRA; }
  else if (locWRA > incWRA) { chosen = local; chosenTs = locWRA; }
  else {
    // 时间戳相等：优先保留有内容的一方，避免「一方改了错因但没 bump 时间戳」被空值覆盖
    if (incWR && !locWR) { chosen = incoming; chosenTs = incWRA; }
    else if (locWR && !incWR) { chosen = local; chosenTs = locWRA; }
    else { chosen = incoming; chosenTs = incWRA; } // 都空或内容相同，取 incoming 无差别
  }
  out.wrongReason = chosen.wrongReason ?? '';
  if (chosenTs) out.wrongReasonAt = chosenTs;
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
    if (strategy === 'review') {
      // 复习记录主体不可变（idOnly 语义），但 selfExplanation 是错题后补充的反思，
      // 按 selfExplainAt 谁新听谁做字段级合并（否则跨设备只同步到主体、丢失反思）
      if (x.selfExplanation !== undefined && (x.selfExplainAt ?? 0) >= (cur.selfExplainAt ?? 0)) {
        cur.selfExplanation = x.selfExplanation;
        if (x.selfExplainAt) cur.selfExplainAt = x.selfExplainAt;
      }
      m.set(x.id, cur);
      continue;
    }
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

// 「活跃时间戳」字段集合：行在这些字段上的任意一次更新，都说明该行在删除之后仍被改动过。
// 判定墓碑是否 stale 时必须全部纳入 —— 只看 updatedAt 会漏掉复习、错因、自我解释等路径。
//
// 历史缺陷（P0）：原实现仅用 `updatedAt ?? createdAt`，而卡片合并侧（mergeCardPair）
// 的 SRS 字段是按 reviewedAt 取的。于是出现这样的竞态：
//   A 机删卡（deletedAt=100，卡片 updatedAt 仍为 50）
//   B 机此前复习过（reviewedAt=200，updatedAt 仍为 50）
//   → 复活判定 50 <= 100 → 判定「已删除」→ B 机的卡片连同复习进度一起被抹掉。
// 字段覆盖各表的不同时间语义（2026-08-29 补全 unlockedAt / t）：
//   updatedAt/reviewedAt/wrongReasonAt/selfExplainAt/createdAt —— 卡片与按 updatedAt 合并的表
//   reviewedAt —— reviews 只有它（此前缺失 → 复习记录判定值恒 0，永不进增量包）
//   unlockedAt —— achievements 只有它；t —— userOps 只有它（缺则这两表同样永不上传）
//   createdAt/startedAt —— pomoSessions 等
const LIVENESS_FIELDS = [
  'updatedAt', 'reviewedAt', 'wrongReasonAt', 'selfExplainAt',
  'createdAt', 'startedAt', 'unlockedAt', 't',
  // addedAt —— cardGroupLinks（M1）：加入时间即该行的唯一活跃时间戳，
  // 缺则关联行永不进增量包（墓碑判定值恒 0）
  'addedAt',
];

/**
 * 行的最新活跃时间戳（取所有已知时间字段的最大值）。
 * 非法值（NaN / 非数字 / 负数）一律忽略，避免污染比较结果。
 */
export function livenessTs(row) {
  if (!row) return 0;
  let max = 0;
  for (const f of LIVENESS_FIELDS) {
    const v = row[f];
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

// 对某一种类的行应用墓碑：
//   行的最新活跃时间 <= 墓碑时间 → 删除，返回 removed；
//   行的最新活跃时间 >  墓碑时间 → 该行已「复活」，标记墓碑为 stale（应清除）
export function applyTombstones(rows, tombstones, kind) {
  const map = new Map((rows || []).map(r => [r.id, r]));
  const removed = [];
  const stale = [];
  for (const t of tombstones || []) {
    if (kindOf(t) !== kind) continue;
    const r = map.get(t.id);
    if (!r) continue;
    const rTs = livenessTs(r);
    if (rTs <= (t.deletedAt ?? 0)) { map.delete(t.id); removed.push(t.id); }
    else stale.push(t.id);
  }
  return { rows: [...map.values()], removed, stale };
}
