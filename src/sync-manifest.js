// 同步清单（唯一事实来源）
// 前端 src/sync.js 与局域网中枢 sync-hub/hub.js 共用同一份清单，
// 新增数据表时只需在此登记，导出/导入/中枢合并便自动覆盖，避免多处遗漏。
// 注意：本文件必须保持"无浏览器依赖"，因为 hub.js 会直接在 Node 里 import 它。

// round34 M10 → round38：新增 5 张同步表（notifications/errors/aiUsage/wordExportHistory/wordStudyLog）
// 属同步集合演进，必须 +1。导入侧 sync.js 用 `backup.version > BACKUP_VERSION` 拒绝过高版本
// （清晰「请升级」而非崩溃），更低版本旧包仍可导入。
export const BACKUP_VERSION = 9;

// merge 策略：
//   card      卡片专属：内容字段按 updatedAt、SRS 字段按 reviewedAt、错因按 wrongReasonAt 字段级合并
//   updatedAt 按 max(updatedAt ?? createdAt ?? 0) 谁新听谁
//   idOnly    按 id 幂等（不可变记录：复习、图片、番茄专注、向量嵌入）

// round38（用户要求）：原「本机日志/统计」类表改为跨设备同步（见 SYNC_TABLES 尾部 v33 条目）。
// 仍显式排除的表仅剩「有硬性技术障碍」的两张：
// snapshots：快照行内含「全库所有表 + 墓碑 + 元数据」的完整 dump（见 sync.js saveSnapshot）——
//   一份快照≈整库大小，跨设备同步 N 份 = N× 库体积 → 中枢/包体爆炸，且快照仅本机回滚用。
// plugins：以 ES Module 代码字符串存库（plugins/manifest.js），跨设备同步＝执行外来代码，
//   且代码/配置可能含硬编码 API Key → 安全风险，保持本机。
export const EXCLUDED_FROM_SYNC = [
  'snapshots', 'plugins',
  // round15 P2：本地表补登记（此前在 db 存在但不进同步、也不在排除清单——
  // 破坏「清单 = 唯一事实来源」不变量，未来误加 SYNC_TABLES 无防护）。
  //   docTexts：解析全文（大字段，id 与 docFiles 一一对应）
  //   docBlobs：OPFS 降级时暂存的原文件二进制（v24）
  //   trash：回收站快照（删除语义由墓碑表达，快照仅本机恢复用；跨设备恢复会与对端
  //          残留墓碑「你恢复、它再删」互相打架，故不随同步）
  //   imageRefs：已于 db v33 删除（round38 ②，只写不读的死表），不再登记。
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

// ---------------------------------------------------------------------------
// 审计 B1：新增数据表「三查」checklist（防硬编码枚举漂移的兜底）。
// 本清单是导出/导入/中枢合并的唯一事实来源，但引用重映射（src/sync-dedup.js 的
// CARD_REF_FIELDS 等四类注册表）与图片引用收集（src/repo.js imageIdsOf）仍是
// 字段级枚举——新增表/字段时漏改任何一处都会留下孤儿引用或误删共享图片。
// 每次加表/加引用字段，逐项打勾：
//   [1] 本清单：SYNC_TABLES / PRIVACY_SYNC_TABLES / EXCLUDED_FROM_SYNC 三选一登记；
//       行 id 若是确定性复合键（如 cardWordLinks 的 `${cardId}:${wordCardId}`），
//       还要在 sync-dedup.remapCardRefs 里登记「字段重映射后重算 id」；
//   [2] 引用注册表：新表含「引用卡片 id」字段 → 按类别加入 CARD_REF_FIELDS /
//       ARRAY_REF_FIELDS / JSON_REF_FIELDS / NESTED_REF_FIELDS（sync-dedup.js）；
//   [3] 图片 GC：新表含图片 id 字段 → repo.imageIdsOf 的扫描范围必须覆盖
//       （前端 cleanupOrphanImages 与 hub.js 的 gcOrphanImages 同源，漏一处
//       就会一端误删另一端共享图）；
//   [4] 级联删除：新表行随卡/词卡生死 → deleteCard / deleteWordCard 的级联
//       集合与快照（_cardWordLinks 模式）要覆盖；
//   [5] 不变量测试：tests/sync-manifest.test.mjs 的「表数量 + 策略合法」断言
//       加一即可锁定新表（数量不符会失败）；字段级漏登记（引用/图片）靠
//       上面 [2][3] + sync-dedup.test.mjs 的注册表防漂移断言 + 评审。
//   [6] 敏感字段 strip 登记：新表含「本地凭证 / 隐私」字段（如 API Key、Base URL）
//       → 在 SYNC_TABLES 该条目加 `strip: ['字段名']`（见 wordSettings 的 llmApiKey/llmBase）。
//       该字段导出/合并/中枢三处统一剔除（sanitizeStripRow 共用），跨设备永不泄露本地凭证。
//       漏登记 = 本机 Key 被对端明文覆盖 / 中枢驻留旧 Key 回灌（round18 R18-5 已实证）。
// ---------------------------------------------------------------------------
export const SYNC_TABLES = [
  { table: 'cards', kind: 'card', merge: 'card' },
  { table: 'reviews', kind: 'review', merge: 'review' },
  { table: 'images', kind: 'image', merge: 'idOnly' },
  { table: 'aiChats', kind: 'chat', merge: 'chat' },
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
  // v13 新增：用户全操作埋点（量大）。保留期策略：仅保留最近 365 天，更老的由
  //   repo.pruneUserOps() 定期清理——清理必须写墓碑（kind='userOp'），否则中枢/对端
  //   持有的旧副本会在下次拉取时把清掉的行"复活"回来（idOnly 合并下 absence ≠ deletion）。
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
  // v31（通用卡 ↔ 英语词卡链接）：cardWordLinks 多对多映射，id=`${cardId}:${wordCardId}` 确定性幂等；
  //   「移除」= 本端删行 + kind='cardWordLink' 墓碑（对端同 id 行被 applyTombstones 清除，悬空链接不复活）。
  //   两张本体表（cards/wordCards）各自按原策略同步，本表只同步「谁对应谁」，内容不互串。
  { table: 'cardWordLinks', kind: 'cardWordLink', merge: 'idOnly' },
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
  //   wordSyllabusMeta：大纲词表元信息（id='kaoyan2027'，wordCount/loadedAt/source 会随
  //   大纲版本更新）→ 原 idOnly「已存在即保留」会让先到者的旧值赢、后更新设备的元信息
  //   永不补传；改 updatedAt 谁新听谁（写入端已带 updatedAt，见 word-repo.saveSyllabusMetaRow）
  { table: 'wordSyllabusMeta', kind: 'wordSyllabusMeta', merge: 'updatedAt' },
  //   wordExportHistory：导出历史（见下方 v33 条目——round38 起改为跨设备同步）
  { table: 'wordExportHistory', kind: 'wordExportHistory', merge: 'idOnly' },
  // ── v33（round38，用户要求）：原「本机日志/统计」类改为跨设备同步，统一多设备视图 ──
  //   notifications：本机提示。round38 ②：改 updatedAt 策略（**全局已读**语义——一处已读
  //     处处已读）；已读操作 bump updatedAt，删除/清空写墓碑 kind='notification'。
  //   errors：错误日志（idOnly；清空走墓碑 kind='error'，防对端复活）
  //   aiUsage：AI 用量账本（idOnly；pruneAiUsage/清空均写墓碑 kind='aiUsage'）
  //   wordExportHistory：英语导出历史（idOnly；过期清理写墓碑 kind='wordExportHistory'）
  //   wordStudyLog：英语学习时长流水（idOnly；round38 ① 按设备分片 id=`t-YYYY-MM-DD-<deviceId>`，
  //     读取按 date/全表求和 → 跨设备不丢也不虚增）
  { table: 'notifications', kind: 'notification', merge: 'updatedAt' },
  { table: 'errors', kind: 'error', merge: 'idOnly' },
  { table: 'aiUsage', kind: 'aiUsage', merge: 'idOnly' },
  { table: 'wordStudyLog', kind: 'wordStudyLog', merge: 'idOnly' },
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

/**
 * 墓碑 kind → 表名 映射（供 repo.pruneTombstones 反查「本地是否仍有残留行」）。
 * round38 ④：**由本清单自动派生**，杜绝手写清单漂移——历史隐患是手写表漏登记了
 * `groupLink`(cardGroupLinks) / `pomo`(pomoSessions) / `memory`(aiMemories) / `privacy`(privacyRecords)
 * 等 kind，导致这些墓碑永远查不到对应表、被 GC 逻辑跳过（墓碑只增不减）。
 * 新增同步表时无需再改任何手写清单（清单=唯一事实来源这一不变量终于对墓碑也成立）。
 * @param {object} extra 需要指向非同步表的额外 kind（一般不需要）
 */
export function tombKindTable(extra = {}) {
  const map = {};
  for (const t of [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES]) map[t.kind || t.table] = t.table;
  return { ...map, ...extra };
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
  // 审计 D1+D5（reviewedAt 语义分裂）：此前 `x.reviewedAt ?? updatedAt` 把「从未复习
  // （undefined/0）」错误等价于「用内容更新时间顶替的 SRS 时间戳」——设备 A 只改内容
  // （updatedAt 很新、从未复习）会在 SRS 竞争里覆盖设备 B 已复习的真实调度，跨设备丢复习进度。
  // 统一哨兵：`reviewedAt` 非有限值一律视为 0（未复习），只在 SRS 竞争中比较它，绝不与
  // updatedAt 混比。新卡已统一 init `reviewedAt:0`（见 repo.createCard / word-repo.createWordCard）。
  const revOf = (x) => (typeof x.reviewedAt === 'number' && Number.isFinite(x.reviewedAt)) ? x.reviewedAt : 0;
  const incRev = revOf(incoming);
  const locRev = revOf(local);
  // 审计 C4（同毫秒/同时钟覆盖）：原 `>=` 在两端时间戳相等时**无条件采纳 incoming**，
  // 并发且同 ms 时实际较新的一方被整体覆盖，且结果由「谁在网络里后到」决定（非确定）。
  // 改严格 `>` + 相等时按序列化字典序确定性收敛——两台设备都收敛到同一个 canonical，
  // 杜绝「A 认 B、B 认 A」的反复横跳，也让同 ms 覆盖变得可复现、可测试。
  const tiebreak = (a, b) => JSON.stringify(a) < JSON.stringify(b);
  const content = incTs > locTs ? incoming : (locTs > incTs ? local : (tiebreak(incoming, local) ? incoming : local));
  const srs = incRev > locRev ? incoming : (locRev > incRev ? local : (tiebreak(incoming, local) ? incoming : local));
  const out = { ...content, updatedAt: Math.max(incTs, locTs) };
  // round29 修（P0）：内容侧此前是**整行 LWW** —— CARD_CONTENT_FIELDS 只存在于定义处，
  // 从未参与合并，导致两端并发编辑不同字段（A 改 front / B 改 back）时一端修改静默丢失，
  // 与文件顶部「内容字段按 updatedAt 字段级合并」的承诺不符。
  // 现在按字段级时间戳 fieldTs 逐字段取新：写入侧（repo.updateCard）对本次真正改动的字段
  // 记录 fieldTs[f]。老数据没有 fieldTs → 退化用整行 updatedAt → 行为与修复前一致（安全）。
  const tsOf = (row, f) => {
    const ts = row && row.fieldTs;
    return ts && typeof ts === 'object' && Number.isFinite(ts[f]) ? ts[f] : null;
  };
  // 字段集 = 内容组 ∪ 两端 fieldTs 记录过的任意字段——后者让派生/状态字段
  // （linkedNoteIds / quickCheckedAt / wordCards 的 familiar·kind 等）也能享受同样的
  // 逐字段保护，只要它们的写入点按约定 bump fieldTs[f]（不再随整行覆盖丢失）。
  const _extra = new Set([...Object.keys(incoming.fieldTs || {}), ...Object.keys(local.fieldTs || {})]);
  const mergeFields = new Set([...CARD_CONTENT_FIELDS, ..._extra]);
  for (const f of mergeFields) {
    if (CARD_SRS_FIELDS.includes(f)) continue; // SRS 由 reviewedAt 驱动，不参与字段级内容合并
    const it = tsOf(incoming, f);
    const lt = tsOf(local, f);
    // 任一端都没有该字段的独立时间戳 → 沿用整行 updatedAt（旧语义，保证向后兼容）
    if (it === null && lt === null) continue;
    const iTs = it === null ? incTs : it;
    const lTs = lt === null ? locTs : lt;
    let winner;
    if (iTs !== lTs) {
      winner = iTs > lTs ? incoming : local;
    } else {
      // fieldTs 平局（含一端是旧客户端/旧数据：改了字段但只 bump 了整行 updatedAt、
      // 没维护 fieldTs）——单凭字段级时间戳分不出谁真改过，回退到整行 updatedAt 判定，
      // 与「两端都无 fieldTs」时完全一致（向后兼容，不丢更新）。
      winner = incTs > locTs ? incoming : (locTs > incTs ? local : (tiebreak(incoming, local) ? incoming : local));
    }
    // 赢家缺该字段（老版本包/老客户端）时退回另一端——否则会把本地已有值抹成 undefined
    const loser = winner === incoming ? local : incoming;
    const v = winner[f] !== undefined ? winner[f] : loser[f];
    if (v !== undefined) out[f] = v;
  }
  // fieldTs 自身取两端逐字段最大值（它是元数据，不是内容，不参与 LWW 覆盖）
  const tsKeys = new Set([...Object.keys(incoming.fieldTs || {}), ...Object.keys(local.fieldTs || {})]);
  if (tsKeys.size) {
    const mergedTs = { ...(local.fieldTs || {}), ...(incoming.fieldTs || {}) };
    for (const f of tsKeys) mergedTs[f] = Math.max(Number(incoming.fieldTs?.[f]) || 0, Number(local.fieldTs?.[f]) || 0);
    out.fieldTs = mergedTs;
  }
  for (const f of CARD_SRS_FIELDS) {
    if (srs && srs[f] !== undefined) out[f] = srs[f];
  }
  // 审计：dueAt 必须与 fsrs 同源——若 SRS 赢家有 dueAt 则已覆盖；
  // 若 SRS 赢家缺 dueAt（老包/老客户端/迁移行），内容赢家的过期值残留会导致
  // 复习队列（按 dueAt）与 predR（按 fsrs.last）两个信号打架，每次同步重复
  // 触发"修复-再错"。优先取 SRS 赢家的 dueAt，其次任一侧有值的，最后置 0。
  if (srs && srs.dueAt !== undefined) out.dueAt = srs.dueAt;
  else if (incoming.dueAt != null || local.dueAt != null) out.dueAt = incoming.dueAt ?? local.dueAt ?? 0;
  else out.dueAt = 0;
  // 错因用独立时间戳 wrongReasonAt 合并（不跟随 updatedAt 也不跟随 reviewedAt）
  // 修复 P1：原 `>=` 在「两端时间戳相等（均为 0 或同一时刻）」时会无条件采纳 incoming，
  // 若 incoming 未携带错因（空串）会把本地已有的错因覆盖为空 → 跨设备错因丢失。
  // 改用严格 `>` 判定，并在时间戳相等时优先保留「有内容」的一方，杜绝空值覆盖。
  const incWRA = incoming.wrongReasonAt ?? 0;
  const locWRA = local.wrongReasonAt ?? 0;
  const incWR = incoming.wrongReason ?? '';
  const locWR = local.wrongReason ?? '';
  let chosen, chosenTs;
  // round34 M1：清除语义必须胜出——本地显式清空（wrongReason 为空）时，无论对端时间戳多新，
  // 都不应被对端「带晚于清空时刻的真实时间戳的旧错因」覆盖（原 `+1` 干扰可被对端 WRA 击败）。
  // 规则：本地为空且对端非空 → 本地清除胜（保留空）；对端为空且本地非空 → 保留本地；
  // 两端都空或都有内容 → 退化为时间戳较新者（原函数语义）。
  if (!locWR && incWR) { chosen = local; chosenTs = locWRA; }       // 本地已清空，维持清空
  else if (locWR && !incWR) { chosen = local; chosenTs = locWRA; } // 对端清空，保留本地错因
  else if (incWRA > locWRA) { chosen = incoming; chosenTs = incWRA; }
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
    // 审计 P2-4（round33）：modeQuestions 按 modeId 键级合并——此前整字段取一端，
    // 两端各为同一词生成不同模式的题（A 造句题 / B 翻译题）时后同步端覆盖先端，
    // 部分模式的题静默丢失。两端都是普通对象（非数组）时按键合并，冲突键取 incoming
    // （与并集保护的 incoming 优先语义一致）。数组/异形结构保持原语义不合并。
    if (f === 'modeQuestions' && iv && lv
      && typeof iv === 'object' && typeof lv === 'object'
      && !Array.isArray(iv) && !Array.isArray(lv)) {
      const merged = { ...lv };
      for (const k of Object.keys(iv)) merged[k] = iv[k];
      out[f] = merged;
    } else if (iv !== undefined) out[f] = iv;
    else if (lv !== undefined) out[f] = lv;
  }
  // round42 F3：兜底保留「本地独有字段」。合并基底是「内容赢家整行」——当内容赢家为对端、
  // 且本地卡有个既不在 CARD_CONTENT_FIELDS、又从未 bump fieldTs、也不在 CARD_SRS_FIELDS 的
  // 字段（未来扩展的非标准字段）时，上面字段级合并不会覆盖它，它会被整行覆盖丢进对端。
  // 这里补一道：凡本地有、合并结果 out 没有的字段（id 不可变跳过），一律保留本地值。
  // 绝不与已合并字段冲突（out 已有则不进），且让 out 与本地键集更一致（sameShape 更易成立）。
  for (const k of Object.keys(local)) {
    if (k === 'id') continue;
    if (!(k in out)) out[k] = local[k];
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

/**
 * round23 P2-2：对话类行（aiChats）的消息无损合并。
 * 对话是「追加型」数据：整行 LWW 会让对端独有的新消息整体丢失（比覆盖一个字段更痛）。
 * 规则：标量字段（title/updatedAt…）仍按时间取新；messages 做**并集**——
 *   保留本端全部消息，再把对端不在本端的消息按序追加（以 id 为键；无 id 时以
 *   role+content 为键，同端内部的重复消息不去重，仅去重"对端也有完全相同一条"）。
 */
function mergeMessageLists(a = [], b = []) {
  const keyOf = (m) => (m && m.id != null ? 'id:' + m.id
    : 'eq:' + String(m && m.role || '') + '\u0001' + String(m && m.content || ''));
  const seen = new Set((a || []).map(keyOf));
  const out = (a || []).slice();
  for (const m of b || []) {
    const k = keyOf(m);
    if (!seen.has(k)) { seen.add(k); out.push(m); }
  }
  return out;
}
export function mergeChatPair(local, incoming) {
  const lt = local.updatedAt ?? local.createdAt ?? 0;
  const it = incoming.updatedAt ?? incoming.createdAt ?? 0;
  const base = it >= lt ? incoming : local; // 时间新的一方提供标量字段
  return {
    ...base,
    title: (base.title != null && String(base.title).trim()) ? base.title : (local.title || incoming.title || ''),
    messages: mergeMessageLists(local.messages, incoming.messages),
    updatedAt: Math.max(lt, it) || Date.now(),
  };
}

// ---------- 跨设备时钟偏移补偿（round30 P2-3） ----------
// LWW 合并的固有缺陷：若对端设备墙钟比本机快，其导出的「旧包」会因 updatedAt 数值更大
// 覆盖本机「物理上更晚」的本地编辑 → 静默丢改。补偿思路：合并前把 incoming 行的时间戳
// 从「对端时钟帧」换算到「本机时钟帧」（本机行不动，它已在本机帧），再按常规 LWW 比较。
// 换算量 clockSkew = 对端时刻 - 本机时刻（从同步通道两侧取：客户端用中枢 HTTP `Date`
// 响应头、中枢用客户端 `x-client-time` 请求头），换算 = 时间戳 - clockSkew。
// 仅改 incoming、不改 base，保证「每台设备本地存储始终在本机帧」——下一轮同步该设备再按
// 自己的 skew 把对端数据换算进本机帧，两端自洽、无累积漂移。
const CLOCK_TS_FIELDS = [
  'updatedAt', 'createdAt', 'reviewedAt', 'selfExplainAt', 'wrongReasonAt',
  'deletedAt', 'addedAt', 'startedAt', 'unlockedAt', 't', 'loadedAt', 'dueAt',
];
export function shiftRowClock(row, skew) {
  if (!row || !Number.isFinite(skew) || skew === 0) return row;
  const out = { ...row };
  for (const f of CLOCK_TS_FIELDS) {
    if (typeof out[f] === 'number' && Number.isFinite(out[f])) out[f] = out[f] - skew;
  }
  // fieldTs 是「逐字段时间戳」元数据，同样换算到本机帧，否则未来字段级比较仍跨帧
  if (out.fieldTs && typeof out.fieldTs === 'object') {
    const ft = {};
    for (const k of Object.keys(out.fieldTs)) {
      const v = out.fieldTs[k];
      ft[k] = (typeof v === 'number' && Number.isFinite(v)) ? v - skew : v;
    }
    out.fieldTs = ft;
  }
  return out;
}

// round30 P3-1：深响应式 Proxy 经 JSON 往返变纯对象（structuredClone 遇 Proxy 直接抛错）。
// 仅用于 merge 入口兜底，sync 行均为纯 JSON，往返安全无副作用。
function cloneSafe(rows) {
  if (!Array.isArray(rows)) return [];
  try { return JSON.parse(JSON.stringify(rows)); } catch { return []; }
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
/**
 * round34 H1：字段级合并（自由文本可编辑表）。当且仅当两端都带 fieldTs 时调用（见 mergeRows
 * updatedAt 分支）。规则：对每字段取 fieldTs 较新者；仅一端有的字段保留该端；id 不可变不参与。
 * fieldTs 自身取各字段较新者；updatedAt 取较新。strip 字段在调用前已由 sanitizeStripRow 剔除，
 * 故不会从 incoming 灌入凭证。任一侧缺 fieldTs 时调用方会退化为整行 LWW，无回归。
 */
export function mergeByFieldTs(cur, xr, strip = []) {
  const cf = (cur.fieldTs && typeof cur.fieldTs === 'object') ? cur.fieldTs : {};
  const xf = (xr.fieldTs && typeof xr.fieldTs === 'object') ? xr.fieldTs : {};
  const out = { ...cur };
  for (const k of Object.keys(xr)) {
    if (k === 'id' || k === 'createdAt' || k === 'fieldTs') continue;
    if (strip.includes(k)) continue; // 双保险：凭证字段绝不采纳 incoming
    // round38 ①：对端独有字段直接采纳（本端无值 → 无冲突）
    if (!(k in cur)) { out[k] = xr[k]; continue; }
    const ct = cf[k] ?? 0;
    const xt = xf[k] ?? 0;
    if (xt > ct) { out[k] = xr[k]; continue; }
    if (xt < ct) continue; // 本端较新 → 保留本端
    // 平局（同一字段两端时间戳相等，常见于同毫秒并发编辑）：必须**确定性收敛**——
    // 此前 `xt >= ct` 无条件取对端，导致 A 取 B 的值、B 取 A 的值，两台设备
    // 各自显示对方的版本且每次同步来回横跳（永久不一致）。改为与 mergeRows /
    // mergeCardPair 同口径：按序列化字典序取小者，两端收敛到同一 canonical。
    if (JSON.stringify(xr[k]) < JSON.stringify(cur[k])) out[k] = xr[k];
  }
  out.fieldTs = { ...cf };
  for (const k of Object.keys(xf)) out.fieldTs[k] = Math.max(out.fieldTs[k] || 0, xf[k] || 0);
  out.updatedAt = Math.max(cur.updatedAt ?? 0, xr.updatedAt ?? 0);
  return out;
}

export function mergeRows(base, incoming, strategy, opts = {}) {
  const strip = Array.isArray(opts.strip) ? opts.strip.filter(Boolean) : [];
  // round30 P3-1：入口统一深拷兜底（JSON 往返剥 Proxy，与 importBackup L607 同口径）。
  // 防「不经 importBackup 直调 mergeRows 并传 reactive」的调用方把 Proxy 带入 bulkPut →
  // structuredClone 抛 DataCloneError。深响应式对象经 JSON 往返变纯对象，安全无副作用
  // （sync 行均为纯 JSON，无 Blob/Date）。
  const baseRows = cloneSafe(base);
  const skew = Number.isFinite(opts.clockSkew) ? opts.clockSkew : 0;
  // round30 P2-3：把 incoming 的时间戳从对端时钟帧换算到本机帧，消除快时钟对端静默覆盖
  // 先 cloneSafe 兜 Proxy（P3-1），再 shiftRowClock 换算时间帧（shift 为浅拷，入站数据已纯 JSON 安全）
  const incRows = skew ? cloneSafe(incoming).map(r => shiftRowClock(r, skew)) : cloneSafe(incoming);
  const m = new Map(baseRows.map(x => [x.id, x]));
  for (const x of incRows) {
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
      // round33 D-3：selfExplainAt 严格 > 才采纳 incoming；等值但内容不同（同毫秒两侧
      // 各写不同反思）时按序列化字典序收敛——原 `>=` 平局必取 incoming，双端会来回翻转
      // （A 收 B 的、B 收 A 的），永不收敛。
      if (xr.selfExplanation !== undefined) {
        const at = xr.selfExplainAt ?? 0;
        const lat = cur.selfExplainAt ?? 0;
        if (at > lat) {
          next.selfExplanation = xr.selfExplanation;
          if (xr.selfExplainAt) next.selfExplainAt = xr.selfExplainAt;
        } else if (at === lat && String(cur.selfExplanation ?? '') !== String(xr.selfExplanation)) {
          const take = String(xr.selfExplanation) < String(cur.selfExplanation ?? '');
          next.selfExplanation = take ? xr.selfExplanation : cur.selfExplanation;
        }
      }
      m.set(x.id, next);
      continue;
    }
    if (strategy === 'chat') { m.set(x.id, mergeChatPair(cur, xr)); continue; }
    if (strategy === 'updatedAt') {
      // round34 H1：字段级合并——当两端都带 fieldTs（自由文本可编辑表 notes/memos/mindmaps/plans
      // 的创建/更新路径会 bump），按「每字段谁的新听谁」合并，杜绝「跨设备并发改不同字段丢一端」。
      // 任一侧缺 fieldTs（旧数据/生成表 docs/exams/graphEdges…）则退化为整行 LWW（原语义，不回归）。
      if (cur.fieldTs && xr.fieldTs && typeof cur.fieldTs === 'object' && typeof xr.fieldTs === 'object') {
        m.set(x.id, mergeByFieldTs(cur, xr, strip)); continue;
      }
      const a = cur.updatedAt ?? cur.createdAt ?? 0;
      const b = xr.updatedAt ?? xr.createdAt ?? 0;
      if (b > a) {
        // round23 P2-2：严格大于才整行取 incoming（等值走下方收敛分支，保证两端一致）
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
      } else if (b === a) {
        // round38：平局分支只序列化一次并复用——此前对超长行（文档 content / 资料）会重复
        // JSON.stringify 3~4 次（纯性能，语义与收敛结果不变）。
        const cs = JSON.stringify(cur);
        const xs = JSON.stringify(xr);
        if (cs !== xs) {
          // round23 P2-2：同时间戳但内容不同（跨设备时钟偏差可造成）→ 确定性收敛：
          // 两设备都选 canonical（序列化字典序小者），杜绝「A 认 B、B 认 A」的反复横跳
          // 或各自保留造成跨设备永久不一致。
          m.set(x.id, xs < cs ? xr : cur);
        } else {
          m.set(x.id, xr); // 内容一致，无差别
        }
      }
    }
    // idOnly：不可变记录，已存在则保留
  }
  return [...m.values()];
}

// 墓碑合并：deletedAt 谁新听谁；kind 兼容旧数据。
// 审计 C4：原 `>=` 使同 deletedAt 时必取 incoming（非确定、可被时钟偏置左右）。
// 改严格 `>`，等值且内容不同时按序列化字典序确定性收敛（双端一致，删除不掉档）。
export function mergeTombstones(base, incoming, opts = {}) {
  const skew = Number.isFinite(opts.clockSkew) ? opts.clockSkew : 0;
  // round30 P2-3：墓碑 deletedAt 同样换算到本机帧，再与本地行 livenessTs（本机帧）比较
  const inc = skew ? cloneSafe(incoming).map(t => shiftRowClock(t, skew)) : cloneSafe(incoming);
  const m = new Map((base || []).filter(t => t && t.id != null).map(t => [t.id, { ...t, kind: kindOf(t) }]));
  for (const t of inc) {
    if (!t || t.id == null) continue;
    const cur = m.get(t.id);
    const nt = { ...t, kind: kindOf(t) };
    if (!cur) { m.set(t.id, nt); continue; }
    const cd = cur.deletedAt ?? 0;
    const td = t.deletedAt ?? 0;
    if (td > cd) m.set(t.id, nt);
    else if (td === cd && JSON.stringify(nt) !== JSON.stringify(cur)) {
      m.set(t.id, JSON.stringify(nt) < JSON.stringify(cur) ? nt : cur);
    }
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
