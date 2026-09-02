// 本地数据库（IndexedDB，浏览器内置，离线可用）
// 与原版 node:sqlite 的差异：id 改用 UUID（全局唯一），保证多设备合并时不冲突
//
// M3 演示模式（双实例隔离）：
//   真实数据 → Dexie('sxybrick')；测试数据 → Dexie('sxybrick-test')。
//   两实例 schema 完全相同（defineSchema 各执行一遍），物理上不同 IndexedDB 数据库，
//   测试数据永远读写不到真实表。
//   `export let db` 是 ESM live binding：setDbInstance() 重赋值后，
//   全项目所有 `import { db }` 自动跟随当前实例，业务层零改动。
//   模式切换走整页 reload（stores/appMode.js 负责），保证所有视图重新查询。
import Dexie from 'dexie';

const REAL_DB_NAME = 'sxybrick';
const TEST_DB_NAME = 'sxybrick-test';
export const MODE_KEY = 'sxy_app_mode';

const instances = {
  real: new Dexie(REAL_DB_NAME),
  test: new Dexie(TEST_DB_NAME),
};

// ---------- 全量 schema（v1~v23）：两个实例共用同一份定义 ----------
function defineSchema(d) {
d.version(1).stores({
  cards: 'id, subject, dueAt, updatedAt, createdAt',
  reviews: 'id, cardId, reviewedAt',
  images: 'id',
  tombstones: 'id, deletedAt', // 删除墓碑：记录被删卡片的 id + 删除时间，用于跨设备同步删除
  meta: 'key',                 // 键值：deviceId 等
});

// v2：新增 AI 对话历史表（随数据包一起同步）
d.version(2).stores({
  aiChats: 'id, updatedAt',
});

// v3：新增 Agent 记忆库表（分层记忆：core核心/preference偏好/fact事实）
d.version(3).stores({
  aiMemories: 'id, updatedAt, category',
});

// v4：新增备忘录表（四象限：重要/紧急）
d.version(4).stores({
  memos: 'id, at, updatedAt',
});

// v5：新增学习计划表 + 知识图谱关系表（均随数据包同步）
d.version(5).stores({
  plans: 'id, status, updatedAt',
  graphEdges: 'id, from, to, updatedAt',
});

// v6：新增 AI 文档表 + 番茄专注记录表（均随数据包同步）
d.version(6).stores({
  docs: 'id, type, updatedAt',
  pomoSessions: 'id, startedAt',
});

// v7：新增思维导图 / 每周学习报告 / 成就解锁表（借鉴 Progress AI，均随数据包同步）
d.version(7).stores({
  mindmaps: 'id, updatedAt',
  weeklyReports: 'id, weekStart, updatedAt',
  achievements: 'id, unlockedAt',
});

// v8：新增模考成绩存档表（组卷模考，随数据包同步）
d.version(8).stores({
  exams: 'id, createdAt',
});

// v9：新增向量嵌入表（RAG 检索增强：卡片/文档 chunk 的 embedding 向量）
// sourceType: 'card' | 'doc'；sourceId: 卡片/文档 id；chunkIdx: 分块序号
// vector: Float32Array（或普通数组）；modelSig: 模型签名，模型变更时需重建索引
d.version(9).stores({
  embeddings: 'id, sourceType, sourceId, subject, updatedAt, modelSig',
});

// v10：新增主动智能体通知表（随数据包同步）
// read 用 0/1 整数以支持 IndexedDB 索引（boolean 不可索引）
d.version(10).stores({
  notifications: 'id, read, createdAt',
});

// v11：新增本地错误日志表（#16 错误边界+日志，便于排查看不见的崩溃）
// severity: 'error'|'warn'；ctx: 组件/路由名；stack: 错误堆栈
d.version(11).stores({
  errors: 'id, createdAt, severity',
});

// v12：cards 新增 difficulty 索引（P3-E 渐进式复杂度，便于按难度梯度编排复习）
d.version(12).stores({
  cards: 'id, subject, dueAt, updatedAt, createdAt, difficulty',
});

// v13：新增用户全操作埋点表（恐怖级本地监控；存本地 IndexedDB，纯前端无服务端、无密码加密；属敏感监控数据，可一键导出/清空/同步）
// A 级（业务级）+ B 级（DOM 交互级）统一存此表
//   t:        毫秒时间戳（主索引）
//   type:     动作大类（page_view / review_rate / card_edit / export / sync / ai_call / pomodoro /
//             feynman / memo / plan / health / graph / mindmap / weekly / exam / wrongbook /
//             dom_click_chip / dom_click_btn / dom_click_card / dom_change_select / dom_asset_click 等）
//   category: 细分类（如 review_rate: '0'|'1'|'2'；dom_click_btn: 'save'|'delete' 等）
//   page:     路由页面（/review /cards /health ...）
//   module:   模块（学习/复习/错题/整理/AI/计划/健康/图谱/导图/周报/模考/备忘/同步/导出/书房/成就/仪表盘/超级监控）
//   payload:  自由 JSON 对象（任意附加信息，如卡片 front 摘要、背诵评分、AI token 数、导出格式、同步结果）
//   _meta:    内部字段（设备 id、会话 id、是否批量合并等）
d.version(13).stores({
  userOps: 'id, t, type, category, page, module',
});

// v14：新增人生监控（隐私数据）结构化表（物理行为+精神心得，B 档超级详尽版）
// 行为上：睡眠/饮食/运动/学习/工作/屏幕时间/财务等详细块
// 精神上：心得体会 Markdown 富文本
// 自定义：customTags(数组) + customKV(JSON) + 时间段详细
//   id, date(YYYY-MM-DD, 便于按天聚合查询), startTime(ms), endTime(ms),
//   type(主类型: sleep/eat/move/learn/work/screen/social/meditation/commute/housework/medical/shop/finance/other/mental)
//   subType(子类型 2 级), location, people(数组), mood, energy, focus, pleasure, stress, painIndex, painParts(数组)
//   sleepBlock, eatBlock, moveBlock, learnBlock, workBlock, screenBlock, financeBlock
//   mental: Markdown 字符串
//   customTags(数组), customKV(JSON)
//   createdAt, updatedAt: 毫秒
d.version(14).stores({
  privacyRecords: 'id, date, startTime, endTime, type, mood, updatedAt',
});

// v15：新增同步快照表（P3-3 多设备同步增强）
//   每次 importBackup 前自动 saveSnapshot，支持历史回滚；snapshots 本身不同步（设备本地诊断数据）
//   id, label(快照名/来源), kind(backup-before-import | manual | auto-before-sync), createdAt, rows(JSON), sizeBytes
d.version(15).stores({
  snapshots: 'id, createdAt, kind',
});

// v16：新增插件表（P3-4 插件/MCP 接入机制）
//   插件以 ES Module 字符串形式存于本表，运行时通过 Blob URL 动态 import
//   id(插件 name 作主键), version, description, author, code(JS 字符串), enabled(0/1),
//   installedAt, updatedAt, lastError(上次调用失败的错误信息，便于排查)
//   plugins 本身不同步（设备本地扩展，跨设备无意义且可能含敏感配置）
d.version(16).stores({
  plugins: 'id, enabled, installedAt',
});

// v17：新增资料库表（Phase 6 学习资料中枢）
//   docFiles：上传的资料文件元数据（进入同步——跨设备可见文件清单）
//     id, name(原始文件名含扩展名), ext(小写扩展名), size(字节), mime,
//     subject(所属科目，联动过滤用), status(uploading|parsing|ready|failed),
//     storage('opfs'|'idb' 小文件降级), opfsPath(OPFS 内相对路径),
//     pageCount(PDF 页数), ocrUsed(是否走 OCR), error(失败原因), createdAt, updatedAt
//   docTexts：解析全文（本地表，不同步——大字段不进同步链路；id 与 docFiles.id 一一对应）
//     id, text(全文，字符不丢), textLen, updatedAt
//   原文件存 OPFS（几百 MB 大文件），跨设备仅同步元数据（点开提示本机无原文）
d.version(17).stores({
  docFiles: 'id, name, status, subject, createdAt, updatedAt',
  docTexts: 'id, updatedAt',
});

// v18：新增笔记表（D3.1，用户明示弱项补救）
//   notes：完整笔记（区别于 memos：memos 是四象限短备忘；notes 是 title+content+tags+双向链接的厚笔记）
//     id, title, content(Markdown正文，支持[[card-id]][[doc-id]]双向链接),
//     category(分类), tags(数组), linkedCardIds(双向关联卡片),
//     linkedDocId(关联资料), linkedPlanIds(关联每日规划任务，为 D8 预留),
//     updatedAt, createdAt
d.version(18).stores({
  notes: 'id, category, updatedAt, createdAt',
});

// v19：新增每日规划/打卡表（D8 每日规划/打卡模块）
//   dailyPlans：每日计划头（口述文本的容器）
//     id, date(YYYY-MM-DD 索引，便于按天聚合), rawInput(用户原始口述),
//     status(active|archived), createdAt, updatedAt
//   dailyTasks：任务明细（一计划多任务；四象限 + 打卡状态）
//     id, planId(关联 dailyPlans.id), date(YYYY-MM-DD), title, type(review/pomodoro/doc/exam/note/other),
//     important(0/1), urgent(0/1), quadrant(Q1~Q4), estimatedMinutes, subject, targetCount,
//     status(pending|done|partial|skipped), completedAt, completionNote,
//     createdAt, updatedAt
d.version(19).stores({
  dailyPlans: 'id, date, status, updatedAt',
  dailyTasks: 'id, planId, date, status, updatedAt',
});

// v20：回收站（P2-22）——仅本地，不进同步/备份；删除内容前快照写入，30 天内可恢复
d.version(20).stores({
  trash: 'id, kind, deletedAt',
});

// v21：AI 用量账本（P2-27）——本地记账，不进同步（已入 EXCLUDED_FROM_SYNC）；
//   用量属于本设备计费上下文，跨设备合并无意义
//   id, t(ms 主索引), source(调用方标签：chat/agent:xxx/pipeline:xxx/docqa/genDeck/mindmap/embedding...)
//   model, promptTokens, completionTokens, totalTokens, durationMs, ok(0/1), est(0/1 是否估算值)
d.version(21).stores({
  aiUsage: 'id, t, source',
});

// v22：卡组（M1）——多对多分组，卡片全局唯一、学习数据不随分组隔离
//   cardGroups：卡组元数据。id, name(名称), description(可选描述), color(可选颜色标签),
//     status('active' 背诵中 | 'archived' 备用/暂停), sortOrder(手动排序), createdAt, updatedAt
//   cardGroupLinks：卡片-卡组关联（多对多）。id, cardId, groupId, addedAt；
//     删除即移出（无墓碑：移出操作按 updatedAt 谁新听谁合并，见 sync-manifest）
d.version(22).stores({
  cardGroups: 'id, name, status, sortOrder, createdAt, updatedAt',
  cardGroupLinks: 'id, cardId, groupId, addedAt',
});

// v23：卡片智能联动分析（M2）——工作台对话历史与分析结果，参与同步（跨设备可回看）
//   analysisSessions：一次分析会话（选定卡片集合 + 多轮对话）。
//     id, title(自动摘要或用户命名), cardIds(JSON 数组，会话创建时的卡片快照),
//     mode('local' | 'ai' | 'mixed'), createdAt, updatedAt
//   analysisMessages：会话内的消息（问题 + 结构化结果）。
//     id, sessionId, role('user' | 'assistant'), question,
//     resultType('graph' | 'list' | 'text' | 'timeline'), resultData(JSON 串),
//     engine('local' | 'ai' | 'fallback'), t(毫秒时间戳主索引)
//   同步：两表均按 updatedAt/t 合并（见 sync-manifest v23 条目）
d.version(23).stores({
  analysisSessions: 'id, createdAt, updatedAt',
  analysisMessages: 'id, sessionId, t',
});

// v24：资料文件降级存储（本地表，**不进同步**）。
//   OPFS 不可用时（Firefox/Safari 无 createWritable、无痕模式、配额不足），
//   ≤10MB 的文件降级存 IndexedDB。此前把 Blob 直接塞进 docFiles，
//   而 docFiles 是同步表（sync-manifest 已登记），等于每次备份/跨设备同步
//   都会把整个文件二进制打包进 JSON——包体爆炸且跨设备毫无意义（对端没有原文语境）。
//   现在 Blob 单独存 docBlobs，docFiles 只留元数据。
d.version(24).stores({
  docBlobs: 'id',
});

// v25：英语单词模块（独立表，与记忆卡物理隔离；复用 FSRS 调度算法）
//   wordCards：单词/词组/短句/范文。kind ∈ {word, phrase, sentence, template}；
//     - template（范文模板）不参与 SRS 复习队列，仅存储 + 收藏 + 导出；
//     - familiar(0/1) 熟词标记：移出默认复习队列但仍可检索、可导出。
//     - subject 记录考试类别（考研/四六级/雅思…），便于按类别导出与筛选。
//   wordReviews：复习记录（idOnly 幂等，跨设备同步，selfExplanation 字段级合并）
//   wordGroups：词组（类似卡组，英语模块专属多对多分组）
//   wordGroupLinks：单词-词组关联（多对多；移出写墓碑，跨设备按 addedAt vs 墓碑时间裁决）
d.version(25).stores({
  wordCards: 'id, kind, subject, dueAt, updatedAt, createdAt, familiar',
  wordReviews: 'id, cardId, reviewedAt',
  wordGroups: 'id, name, status, sortOrder, createdAt, updatedAt',
  wordGroupLinks: 'id, cardId, groupId, addedAt',
});

// v26：英语模块升级（不背风 UI + AI 生成 + 自适应复习 + 设置面板 + 学习统计）
//   wordCards 扩展字段（非索引，按对象属性存）：pos(词性), defs(多义项[{pos,meaning}]),
//     synonyms(同义词数组), collocations(词组搭配数组), phrases(相关短语数组),
//     examples(例句数组[{level:'simple'|'long'|'en1'|'en2', sentence, translation}]),
//     mnemonics(助记数组), rootAffix(词根词缀), confusions(混淆项数组[{word, meaning}]),
//     syllable(音节拆分), audio(自定义音频 base64/URL,可空)
//   wordSettings：用户偏好（单行 id='me'）——发音口音/学习节奏/复习节奏/默认例句难度/
//     自动生成开关/LLM provider & key(本地加密)/拼写提示/助记顺序/拆分助记/混淆项辨析/
//     AI 失败时回退策略等。跨设备同步（key 不进同步：在 sync-manifest 里走 exportFilter 剔除）
//   wordCheckins：每日签到（id, date(YYYY-MM-DD 主索引), count(连续天数), createdAt）
//   wordExportHistory：导出历史（id, kind('a4write'|'zhList'|'enList'|'md'|'anki'|'csv'),
//     total, scope, lang, ordered, createdAt, fileName, sizeBytes, pageCount）。仅本地。
//   wordSyllabusMeta：考研大纲词表元信息（id='kaoyan2027', wordCount, loadedAt, source）
//     ——真实词表走 src/data/kaoyan-vocab-2027.json 动态 import，本表只存元信息以便统计页展示
d.version(26).stores({
  wordCards: 'id, kind, subject, dueAt, updatedAt, createdAt, familiar',
  wordReviews: 'id, cardId, reviewedAt',
  wordGroups: 'id, name, status, sortOrder, createdAt, updatedAt',
  wordGroupLinks: 'id, cardId, groupId, addedAt',
  wordSettings: 'id',
  wordCheckins: 'id, date',
  wordExportHistory: 'id, createdAt',
  wordSyllabusMeta: 'id',
});

} // end defineSchema

// 两个实例各自应用全量 schema（惰性 open：首次访问才真正连接 IndexedDB）
defineSchema(instances.real);
defineSchema(instances.test);

// ---------- 当前实例（ESM live binding：重赋值后所有 import { db } 自动跟随） ----------
// 单用户本地库：无多档案体系。所有数据归属唯一实例库 'sxybrick'（测试数据走 sxybrick-test）。
// 「清空全部数据」功能见 stores/reset.js（清空当前实例库 + 删除本地存储标记），不做删库级隔离。
let _mode = (typeof localStorage !== 'undefined' && localStorage.getItem(MODE_KEY) === 'test') ? 'test' : 'real';
export let db = _mode === 'test' ? instances.test : instances.real;

/** 切换数据库实例（仅演示模式 test / 真实 real）。返回新实例。 */
export function setDbInstance(mode) {
  if (mode === 'test') {
    _mode = 'test';
    db = instances.test;
  } else {
    _mode = 'real';
    db = instances.real;
  }
  return db;
}

/** 当前模式（'real' | 'test'） */
export function currentDbMode() {
  return _mode;
}

/**
 * 取当前实例（函数形式）——测试里 `const { db } = await import()` 解构拿到的是值快照，
 * 不会跟随 setDbInstance 切换；需要「切换后再取最新实例」时用 getDb()。
 * 业务代码直接用 `import { db }`（ESM live binding）即可，无需本函数。
 */
export function getDb() {
  return db;
}

// ---------- R3 IndexedDB 故障可见性 ----------
// 无痕模式 / 配额写满 / 另一标签页占着旧版本连接 时，db.* 操作会静默 reject，
// 而业务侧大量空 catch → UI 空列表且零提示（用户误判"数据丢了"）。
// 把 blocked / versionchange / open 失败收口成一个状态，由 App.vue 顶部横幅消费。
let _dbStatus = 'ok';
const _dbStatusListeners = new Set();
/** 当前库状态：'ok' | 'blocked' | 'versionchange' | 'error:...' */
export function getDbStatus() {
  return _dbStatus;
}
/** 订阅状态变化，返回退订函数（App 横幅挂载时订阅、卸载时退订） */
export function onDbStatusChange(fn) {
  _dbStatusListeners.add(fn);
  return () => _dbStatusListeners.delete(fn);
}
function setDbStatus(s) {
  _dbStatus = s;
  for (const fn of _dbStatusListeners) {
    try { fn(s); } catch { /* 订阅方异常不影响状态机 */ }
  }
}
for (const inst of Object.values(instances)) {
  // blocked：另一个标签页持旧版本连接不放，本页升级被阻塞（多见于双开）
  inst.on('blocked', () => setDbStatus('blocked'));
  // versionchange：本页被要求关闭以让位新版连接（另一标签页升级了库版本）
  inst.on('versionchange', (e) => { setDbStatus('versionchange'); try { e?.close?.(); } catch { /* 关闭失败不阻塞 */ } });
}
// 显式打开：尽早暴露 open 失败（隐私模式/配额写满），成功后被 Dexie 内部缓存，
// 后续业务调用不再重复握手。失败只改状态不抛出——业务调用自行 catch 走空列表兜底。
Promise.all(Object.values(instances).map((inst) => inst.open())).catch((err) => {
  setDbStatus(`error:${err?.name || 'open-failed'}`);
});


export function uid() {
  return (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}