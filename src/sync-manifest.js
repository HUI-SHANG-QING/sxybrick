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
// wordExportHistory：英语模块导出历史（仅本机记录，跨设备无意义且增大包体积）
export const EXCLUDED_FROM_SYNC = [
  'notifications', 'errors', 'snapshots', 'plugins', 'aiUsage', 'wordExportHistory',
  // v27：英语学习时长流水——本机使用语境累计，跨设备相加会虚增，不同步
  'wordStudyLog',
  // round15 P2：本地表补登记（此前在 db 存在但不进同步、也不在排除清单——
  // 破坏「清单 = 唯一事实来源」不变量，未来误加 SYNC_TABLES 无防护）。
  //   docTexts：解析全文（大字段，id 与 docFiles 一一对应）
  //   docBlobs：OPFS 降级时暂存的原文件二进制（v24）
  //   trash：回收站快照（删除语义由墓碑表达，快照仅本机恢复用）
  'docTexts', 'docBlobs', 'trash',
];

// 隐私敏感表——默认不入同步/全量导出，需用户显式 opt-in（PIPL 合规）
export const PRIVACY_SYNC_TABLES = [
  { table: 'privacyRecords', kind: 'privacy', merge: 'updatedAt' },
];

// round17 R17-9：wordCards 的 AI 扩展字段（区别于用户可编辑的 word/meaning/note/tags）——
// 这类字段是「AI 生成、追加式」的：一个形状较简的设备只要 bump updatedAt 就会成为
// mergeCardPair 的内容赢家，把对端更全的 pos/defs/examples/mnemonics 等整行覆盖丢失。
// 合并时对它们做「并集保护」：只要任一端有值就保留（incoming 优先），杜绝整行覆盖。
// 注意：用户可编辑文本（word/meaning/example/note/tags/source/subject）不在其中，
// 仍按 updatedAt 内容赢家语义正常传播删除/修改。
// ⚠️ 必须声明在 SYNC_TABLES 之前（SYNC_TABLES 的 wordCards 条目引用了它，TDZ 约束）。
// v31：新增 modeQuestions（AI 智能模块为 13 种背诵模式生成的题目/答案）。
//   它是「AI 生成、追加式」的：形状较简的设备只要 bump updatedAt 就会成为内容赢家，
//   把对端更全的各模式题目整行覆盖丢失 → 必须受并集保护。
export const WORD_EXT_FIELDS = ['pos', 'defs', 'synonyms', 'collocations', 'phrases', 'examples', 'mnemonics', 'rootAffix', 'confusions', 'syllable', 'derived', 'modeQuestions'];

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
  // v25（英语单词模块）新增：独立四表，与记忆卡物理隔离
  //   wordCards：复用「卡片」级字段合并（内容按 updatedAt、SRS 状态按 reviewedAt），
  //     保证复习动作跨设备传播，不覆盖对端文字/批注编辑（与 cards 同策略）。
  //   wordReviews：复习记录主体不可变 → review 策略（selfExplanation 按 selfExplainAt 字段级合并）。
  //   wordGroups：词组元数据按 updatedAt 合并（重命名/状态/颜色谁新听谁）。
  //   wordGroupLinks：多对多关联，idOnly 幂等；「移出」写 kind=wordGroupLink 墓碑（见 word-repo.js）。
  { table: 'wordCards', kind: 'wordCard', merge: 'card', extFields: WORD_EXT_FIELDS },
  // v30 新增：大纲词中文释义（AI 批量生成 / 用户编辑）。跨设备共享，
  // 否则在手机补齐的释义回到电脑端会整表缺失、覆盖率统计与 UI 反复「待补齐」。
  { table: 'syllabusMeanings', kind: 'syllabusMeaning', merge: 'updatedAt' },
  { table: 'wordReviews', kind: 'wordReview', merge: 'review' },
  { table: 'wordGroups', kind: 'wordGroup', merge: 'updatedAt' },
  { table: 'wordGroupLinks', kind: 'wordGroupLink', merge: 'idOnly' },
  // v26（英语模块升级）新增：设置 / 签到 / 大纲元 / 导出历史
  //   wordSettings：用户偏好单行（id='me'）。按 updatedAt 合并，谁新听谁；
  //     但 LLM Key 是敏感本地凭证，跨设备同步/导出时 strip 剔除（见 sync.js exportRows 的 strip 钩子），
  //     对端导入后保留自己的本地 Key，不会互相泄露。
  { table: 'wordSettings', kind: 'wordSetting', merge: 'updatedAt', strip: ['llmApiKey', 'llmBase'] },
  //   wordCheckins：每日签到（id 含 date，不可变追加）→ idOnly 幂等（同日记多次只留一条）
  { table: 'wordCheckins', kind: 'wordCheckin', merge: 'idOnly' },
  //   wordSyllabusMeta：大纲词表元信息（id='kaoyan2027'，本机展示用）→ idOnly 幂等
  { table: 'wordSyllabusMeta', kind: 'wordSyllabusMeta', merge: 'idOnly' },
  //   wordExportHistory：导出历史，见上方 EXCLUDED_FROM_SYNC（仅本机，不进同步/备份）
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

// ---------- 表级「已清空水位」（O(1) 批量删除语义） ----------
// 背景：userOps（埋点）/ privacyRecords（隐私）这类表行数可达十万级。
//   「一键清空」若给每一行写墓碑，墓碑表瞬间爆炸，而且前端每次增量同步都会**全量**带墓碑，
//   包体永久变大。但对历史埋点/历史隐私记录来说，「哪一行被删了」毫无意义 ——
//   用户要的语义是「这个时间点之前的全部不要了」。
// 于是用一条水位表达：clearedBefore = T 表示「T 及以前的行本地已清空，合并时一律丢弃」。
//   O(1) 存储、O(n) 过滤、语义精确。
export const CLEARED_BEFORE_PREFIX = 'sxy_cleared_before_';

/** 某表的「已清空水位」localStorage 键 */
export function clearedBeforeKey(table) {
  return `${CLEARED_BEFORE_PREFIX}${table}`;
}

/**
 * 过滤掉「已被本地一键清空」的历史行。
 * @param {Array} rows 待合并的行
 * @param {number} before 清空时刻（0/空 = 未清空，原样返回）
 */
export function filterClearedRows(rows, before) {
  const t = Number(before) || 0;
  if (!t) return rows || [];
  return (rows || []).filter((r) => livenessTs(r) > t);
}

// ---------- 纯合并函数（无浏览器依赖，前端 sync.js 与 Node 端 hub.js 共用） ----------

// 墓碑 kind 缺省 = card（兼容旧数据包）
export function kindOf(t) { return t?.kind || 'card'; }

// 卡片字段级合并：内容、SRS、错因各自独立取「新者」，
// 解决「复习动作 bump updatedAt 会把另一台设备的文字编辑覆盖掉」的数据丢失问题，
// 同时解决「错因随复习写入但不 bump updatedAt，另一台设备编辑文字后错因被丢」的问题
export function mergeCardPair(local, incoming, extFields = []) {
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
  // round17 R17-9：AI 扩展字段并集保护（wordCards 用）——任一端有值即保留，incoming 优先
  for (const f of extFields) {
    const iv = incoming[f];
    const lv = local[f];
    if (iv !== undefined) out[f] = iv;
    else if (lv !== undefined) out[f] = lv;
  }
  return out;
}

/**
 * 剔除行上的 strip 字段（返回浅拷贝；无 strip 字段时返回原对象，零分配）。
 * 供导出侧（sync.js exportRows）、合并侧（mergeRows）与中枢（hub.js merge）共用，
 * 保证「敏感字段永不出域」在三处口径一致。
 */
export function sanitizeStripRow(row, strip) {
  if (!row || !Array.isArray(strip) || !strip.length) return row;
  let hit = false;
  for (const k of strip) { if (row[k] !== undefined) { hit = true; break; } }
  if (!hit) return row;
  const out = { ...row };
  for (const k of strip) delete out[k];
  return out;
}

/** 批量剔除（数组映射版） */
export function sanitizeStripRows(rows, strip) {
  if (!Array.isArray(rows) || !Array.isArray(strip) || !strip.length) return rows || [];
  return rows.map((r) => sanitizeStripRow(r, strip));
}

// 通用行合并（按清单 merge 策略）
// opts.strip: string[] —— 带 strip 钩子的表（如 wordSettings 的 LLM Key）：
//   **strip 字段永不采纳 incoming**，本地有值则保留本地值，本地为空则留空。
//
// round18 R18-5（P2）：此前本分支的语义是「本地有值才保留」（`if (cur[k] !== undefined)`），
//   本地没值时 incoming 的值照常落库 —— 于是导出侧剔除了、合并侧又放进来，
//   strip 退化成「半程保护」。在「本机从未配置 Key + 中枢/旧包里驻留过他人 Key」的组合下，
//   凭证会被灌进本机（且 A 清空本地 Key 后中枢旧值仍会回灌）。
//   与导出侧同口径即可根治：incoming 的 strip 字段一律丢弃。
export function mergeRows(base, incoming, strategy, opts = {}) {
  const strip = Array.isArray(opts.strip) ? opts.strip.filter(Boolean) : [];
  const m = new Map((base || []).map(x => [x.id, x]));
  for (const x of incoming || []) {
    if (!x || x.id == null) continue;
    // incoming 的 strip 字段在此处统一出局：无论「新行直接入」还是「整行替换」，
    // 都不可能把对端的凭证带进来（导出侧已剔除，这里兜住旧包/旧客户端/中枢驻留残留）
    const xr = sanitizeStripRow(x, strip);
    const cur = m.get(x.id);
    if (!cur) { m.set(x.id, xr); continue; }
    if (strategy === 'card') { m.set(x.id, mergeCardPair(cur, xr, opts.extFields)); continue; }
    if (strategy === 'review') {
      // 复习记录主体不可变（idOnly 语义），但 selfExplanation 是错题后补充的反思，
      // 按 selfExplainAt 谁新听谁做字段级合并（否则跨设备只同步到主体、丢失反思）
      //
      // round17 R17-2（P1）：**必须先浅拷贝再改，绝不能原地改 cur**。
      //   cur 与 base 数组元素是同一引用（Map 由 (base||[]).map(x=>[x.id,x]) 构造），
      //   而调用方（sync.js importBackup）用 `JSON.stringify(old) !== JSON.stringify(row)`
      //   判定是否写库，old 与 row 都指向 cur → 差异恒为 0 → 合并结果只在内存、从不落库。
      //   表现为「跨设备错题反思同步后消失」，而 hub 侧（整包保存 data 对象）正常，难以察觉。
      const next = { ...cur };
      if (xr.selfExplanation !== undefined && (xr.selfExplainAt ?? 0) >= (cur.selfExplainAt ?? 0)) {
        next.selfExplanation = xr.selfExplanation;
        if (xr.selfExplainAt) next.selfExplainAt = xr.selfExplainAt;
      }
      m.set(x.id, next);
      continue;
    }
    if (strategy === 'updatedAt') {
      const a = cur.updatedAt ?? cur.createdAt ?? 0;
      const b = xr.updatedAt ?? xr.createdAt ?? 0;
      if (b >= a) {
        if (strip.length) {
          // P1-C + round18 R18-5：整行采用 incoming，但 strip 字段**只认本地值**——
          // 本地有值 → 保留（对端导出前已剔除，不能让它把本机 LLM Key 清成 undefined）；
          // 本地为空 → 留空（绝不回填 incoming 的凭证，见函数头注释）。
          const out = { ...xr };
          for (const k of strip) {
            if (cur[k] !== undefined) out[k] = cur[k];
          }
          m.set(x.id, out);
        } else {
          m.set(x.id, xr);
        }
      }
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
  // loadedAt —— wordSyllabusMeta（v26）：大纲词表元信息的活跃时间戳，
  // 缺则增量包每轮滤掉（与已修的「reviews 永不上传」同类），全量包才带上
  'loadedAt',
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
