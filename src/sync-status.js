// src/sync-status.js
// M5 同步状态跟踪：每个数据模块的同步状态（成功/待同步/失败/未配置）+ 条数 + 最后同步时间。
// 设计：
//   - 状态存储：localStorage（仅本机记录，不参与同步）；按 scope 分键（sxy_sync_status_real / _test），
//     演示模式下状态面板自动展示测试数据的同步状态（与 M3 双库隔离联动）
//   - 「待同步」判定：该表最大活跃时间戳（livenessTs）> 该模块 lastSyncAt（有新变更未同步）
//   - 「未配置」判定：无任何同步通道（hub 地址 / gist / 备份记录都没有）
//   - recordModuleResult 由 sync.js / Sync.vue 在每次同步成功/失败后调用（fire-and-forget）
//   - 状态为内存可计算 + localStorage 持久化：刷新不丢，清 localStorage 后从「待同步」重新判定，无损

import { db } from './db.js';
import { backupScope, getEffectiveSyncTables } from './sync.js';
import { livenessTs } from './sync-manifest.js';

const key = () => `sxy_sync_status_${backupScope()}`;

// round18 R18-7（P2）：此前 MODULE_LABELS / MODULE_ORDER 是两份手写清单，
//   v25/v26 新增英语单词 7 表时忘了同步维护 → 最活跃的单词模块在同步状态面板里
//   label 退化成裸表名、按字母序沉底，其同步失败/待同步**不可见**。
//   这与 round17 R17-32（clearTestData 手写 35 表清单漏 word 8 表）同一根因：
//   「按表遍历」的逻辑里手写清单，新增表没有强制登记点。
// 根治：以 SYNC_TABLES 为唯一事实源动态派生展示顺序，新增表自动入面板；
//   MODULE_ORDER 只作为「核心数据在前」的排序提示，不再承担「是否展示」的职责。

/** 表名 → 中文名（i18n 缺失时的兜底；正式文案走 i18n 键 `syncStatus.module.<table>`） */
export const MODULE_LABELS = {
  cards: '卡片', reviews: '复习记录', images: '图片',
  aiChats: 'AI 对话', aiMemories: 'Agent 记忆', memos: '备忘录', plans: '学习计划',
  graphEdges: '知识图谱边', docs: 'AI 文档', pomoSessions: '番茄专注',
  mindmaps: '思维导图', weeklyReports: '每周报告', achievements: '成就', exams: '模考成绩',
  embeddings: '向量嵌入', userOps: '操作记录', docFiles: '资料文件',
  notes: '笔记', dailyPlans: '每日规划', dailyTasks: '每日任务',
  cardGroups: '卡组', cardGroupLinks: '卡片-卡组关联',
  analysisSessions: '联动分析会话', analysisMessages: '联动分析消息',
  // v25 英语单词模块
  wordCards: '单词卡', wordReviews: '单词复习记录',
  wordGroups: '单词词组', wordGroupLinks: '单词-词组关联',
  // v26 英语模块升级
  wordSettings: '单词设置', wordCheckins: '单词签到', wordSyllabusMeta: '大纲词表元信息',
  syllabusMeanings: '大纲词中文释义',
  // 隐私敏感表（默认不入同步，用户 opt-in 后出现在面板）
  privacyRecords: '隐私记录',
};

/** 面板展示顺序（核心数据在前；未列出的表按字母序追加在末尾，不再被漏掉） */
const MODULE_ORDER_HINT = [
  'cards', 'reviews', 'images', 'memos', 'plans', 'notes',
  'cardGroups', 'cardGroupLinks', 'analysisSessions', 'analysisMessages',
  'docs', 'mindmaps', 'graphEdges', 'aiChats', 'aiMemories', 'exams',
  'pomoSessions', 'weeklyReports', 'achievements', 'embeddings', 'docFiles',
  'dailyPlans', 'dailyTasks', 'wordCards', 'wordReviews',
  'wordGroups', 'wordGroupLinks', 'wordSettings', 'wordCheckins',
  'wordSyllabusMeta', 'syllabusMeanings', 'userOps', 'privacyRecords',
];

/**
 * 由「当前有效同步表」动态派生展示顺序：
 *   已登记次序的表按次序排前，SYNC_TABLES 里新增但次序表未列的表按字母序追加。
 * 新增数据表因此无需再手工维护本文件——只要进了 SYNC_TABLES，面板自动出现。
 * @param {Array} tables getEffectiveSyncTables() 结果（缺省自动取）
 */
export function buildModuleOrder(tables) {
  const list = tables || getEffectiveSyncTables();
  const names = list.map((t) => t.table);
  const known = MODULE_ORDER_HINT.filter((n) => names.includes(n));
  const rest = names.filter((n) => !MODULE_ORDER_HINT.includes(n)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

/** 面板展示顺序（默认全量表的次序；兼容旧导入方） */
export const MODULE_ORDER = buildModuleOrder();

/**
 * 模块名的 i18n 键。领域层不产出 localized 文本，只给键；
 * 展示层用 `t(moduleLabelKey(m), fallback)` 解析，缺失时回退 MODULE_LABELS/裸表名。
 */
export function moduleLabelKey(table) {
  return `syncStatus.module.${table}`;
}

/** 读当前 scope 的状态存储（损坏/缺失安全返回空结构） */
export function loadStatus() {
  try {
    const raw = JSON.parse(localStorage.getItem(key()) || 'null');
    if (raw && typeof raw.modules === 'object' && raw.modules) return raw;
  } catch {}
  return { version: 1, modules: {} };
}

function saveStatus(st) {
  try { localStorage.setItem(key(), JSON.stringify(st)); } catch {}
}

/**
 * 记录某模块一次同步结果（同步成功后由调用方对涉及的每个模块调用）。
 * @param {string} module 表名
 * @param {object} res { ok: boolean, error?: string, rows?: number, at?: number }
 */
export function recordModuleResult(module, res) {
  const st = loadStatus();
  st.modules[module] = {
    lastSyncAt: res.at || Date.now(),
    lastResult: res.ok ? 'ok' : 'error',
    lastError: res.ok ? '' : String(res.error || '未知错误').slice(0, 300),
    lastRows: Number.isFinite(res.rows) ? res.rows : 0,
  };
  saveStatus(st);
}

/** 一次全量同步成功：对全部有效模块记录成功（rows 为各表行数，缺省 0） */
export function recordAllModulesOk(rowsByTable = {}) {
  for (const t of getEffectiveSyncTables()) {
    recordModuleResult(t.table, { ok: true, rows: rowsByTable[t.table] || 0 });
  }
}

/** 一次全量同步失败：全部有效模块记失败（单模块同步失败只记该模块，用 recordModuleResult） */
export function recordAllModulesError(error) {
  for (const t of getEffectiveSyncTables()) {
    recordModuleResult(t.table, { ok: false, error });
  }
}

/** 切换 scope 后重置（旧 scope 的状态留在各自键里，不串） */
export function resetStatus() {
  localStorage.removeItem(key());
}

/**
 * 计算全模块状态（面板数据源）。
 * @param {object} opts { channels: { hub: boolean, gist: boolean, backup: boolean } }
 *   是否配置了同步通道——决定「未配置」判定
 * @returns {Promise<Array<{module,label,count,status,error,lastSyncAt,lastRows}>>}
 *   status: 'ok' 成功 | 'pending' 待同步 | 'error' 失败 | 'none' 未配置
 */
export async function getModuleStatus(opts = {}) {
  const st = loadStatus();
  const hasChannel = !!(opts.channels && (opts.channels.hub || opts.channels.gist || opts.channels.backup));
  const tables = getEffectiveSyncTables();
  // 并发取各表行数 + 最大活跃时间戳（单事务外并行 count 即可，读操作）
  const out = [];
  for (const t of tables) {
    let count = 0, maxTs = 0;
    try {
      count = await db[t.table].count();
      // 大表（userOps/embeddings 可能上万行）全量 toArray 取 max 太贵：
      // 折中——cap 5000 行内取 max；超出部分按「有数据即可能待同步」保守处理
      const rows = await db[t.table].limit(5000).toArray();
      for (const r of rows) { const ts = livenessTs(r) || 0; if (ts > maxTs) maxTs = ts; }
      if (count > 5000) maxTs = Math.max(maxTs, 1); // 保守：视为有新变更
    } catch { /* 表不存在（未迁移）：count=0，状态 pending */ }

    const rec = st.modules[t.table] || {};
    let status;
    if (!hasChannel) status = 'none';
    else if (rec.lastResult === 'error') status = 'error';
    else if (!rec.lastSyncAt) status = count ? 'pending' : 'ok'; // 从未同步：有数据=待同步，空表=无事可做
    else if (maxTs > rec.lastSyncAt) status = 'pending';
    else status = 'ok';

    out.push({
      module: t.table,
      label: MODULE_LABELS[t.table] || t.table, // i18n 缺失时的兜底
      labelKey: moduleLabelKey(t.table),
      merge: t.merge,
      count,
      status,
      error: rec.lastError || '',
      lastSyncAt: rec.lastSyncAt || 0,
      lastRows: rec.lastRows || 0,
    });
  }
  // 按动态派生的次序排序（SYNC_TABLES 新增表自动排在末尾，不再被漏掉）
  const order = buildModuleOrder(tables);
  out.sort((a, b) => (order.indexOf(a.module) - order.indexOf(b.module)) || a.module.localeCompare(b.module));
  return out;
}

/** 状态计数摘要（面板顶部）：{ ok, pending, error, none, total } */
export function summarizeStatus(list) {
  const s = { ok: 0, pending: 0, error: 0, none: 0, total: list.length };
  for (const m of list) s[m.status] = (s[m.status] || 0) + 1;
  return s;
}
