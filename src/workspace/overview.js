// src/workspace/overview.js
// 工作台数据聚合层（只读）：把全部模块的实时指标 + 全局洞察聚合为一次可渲染快照。
// 设计要点：
//   1. 每个指标独立 try/catch —— 单模块取数失败只影响该卡片（显示 —），不拖垮整页；
//   2. 全部走既有数据层（analytics / repo / db），不新增数据表、不触碰同步链路；
//   3. 视图（Workspace.vue）只调用本层，本层不碰 DOM —— 单向调用，杜绝渲染环路。
import { db } from '../db.js';
import { getStats, weakCards } from '../repo.js';
import {
  getCrossModuleInsight, getSubjectDiagnosis, getAssetHealth, getForgetRisk, getLearningProfile,
} from '../agent/analytics.js';

export const LAST_SYNC_KEY = 'sxy_hub_last_sync';

async function safe(p, fallback = null) {
  try { return await p; } catch { return fallback; }
}

/**
 * 工作台一次快照
 * @returns {Promise<{ modules: Object<string,{n:number|null,warn:boolean}>, stats, insight, diag, health, risks, profile, meta: { online, lastSync } }>}
 */
export async function getWorkspaceOverview() {
  const [stats, insight, diag, health, risks, profile] = await Promise.all([
    safe(getStats()), safe(getCrossModuleInsight()), safe(getSubjectDiagnosis()),
    safe(getAssetHealth()), safe(getForgetRisk(5)), safe(getLearningProfile()),
  ]);
  // 各模块独立计数（并行 + 容错）
  const [examN, weeklyN, achN, noteN, mmN, docFN, opsN, privN, pluginN, dailyN, memoN] = await Promise.all([
    safe(db.exams.count()), safe(db.weeklyReports.count()), safe(db.achievements.count()),
    safe(db.notes.count()), safe(db.mindmaps.count()), safe(db.docFiles.count()),
    safe(db.userOps.count()), safe(db.privacyRecords.count()), safe(db.plugins.count()),
    safe(db.dailyPlans.count()), safe(db.memos.count()),
  ]);
  const weakN = insight?.weakCount ?? (await safe(weakCards(20)))?.length ?? 0;

  // 今日已过 0 点仍未复习的到期卡 = 「昨日遗留 / 逾期」：红标展示，提示顺延
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const overdueN = await safe(db.cards.where('dueAt').below(dayStart.getTime()).count(), 0);

  const healthIssues = (health?.duplicates?.length || 0) + (health?.zombieCount || 0) + (health?.orphanImageCount || 0);

  const modules = {};
  const set = (k, n, warn = false) => { modules[k] = { n, warn }; };

  // —— 学习 ——
  set('cards', stats?.totalCards ?? null);
  set('review', stats?.dueToday ?? null, (stats?.dueToday || 0) > 0);
  set('wrong', weakN, weakN > 0);
  set('stats', stats?.avgMastery ?? null);
  set('exam', examN);
  set('genquiz', null);
  // —— 规划 ——
  set('daily', dailyN);
  set('plans', insight?.plans?.active ?? null);
  set('pomodoro', insight?.pomodoro?.today ?? null);
  set('weekly', weeklyN);
  set('achievements', achN);
  // —— 知识 ——
  set('notes', noteN);
  set('memo', memoN ?? insight?.memos?.total ?? null);
  set('docs', insight?.docs?.total ?? null);
  set('mindmap', mmN);
  set('graph', insight?.graphEdges?.total ?? null);
  set('categories', null);
  set('search', null);
  set('library', null);
  set('materials', docFN);
  // —— 智能 ——
  set('ai', insight?.ai?.chat ?? null);
  set('agent', insight?.ai?.agent ?? null);
  set('feynman', insight?.ai?.feynman ?? null);
  set('insight', null);
  set('health', healthIssues, healthIssues > 0);
  // —— 系统 ——
  set('sync', null);
  set('export', null);
  set('user-dashboard', opsN);
  set('privacy', privN);
  set('plugins', pluginN);

  let lastSync = 0;
  try { lastSync = Number(localStorage.getItem(LAST_SYNC_KEY) || 0) || 0; } catch {}

  return {
    modules,
    stats, insight, diag, health, risks, profile,
    overdue: overdueN,
    meta: { online: typeof navigator !== 'undefined' ? navigator.onLine : true, lastSync },
  };
}

/** 最近同步时间（毫秒），无记录返回 0 */
export function getLastSyncTs() {
  try { return Number(localStorage.getItem(LAST_SYNC_KEY) || 0) || 0; } catch { return 0; }
}
