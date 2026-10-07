// tests/repo-public-api.test.mjs —— 数据层对外 API 的「防呆门禁」（round142）
//
// ⭐ 本文件的存在源于一次**错误结论的纠正**：
//   上轮审计我用「只统计 `export function` / `export const`」的脚本比对门面符号，
//   得出「门面比拆分前多导出 4 个符号（DEFAULT_SUBJECTS / RETRIEVAL_STRENGTH_OPTIONS /
//   applyCardFilters / tagFilter）—— 泄漏了，应收敛」的错误结论，
//   并把它写进了提交信息与记忆文件。
//
//   真相：原 `repo.js` 里有**三行 `export { … }` 形式的 re-export**，
//   那个统计脚本完全没匹配到它们 ⇒ 基准少算了 4 个 ⇒ 才显得"多出 4 个"。
//   这 4 个**本来就是对外 API**，且**正在被使用**：
//     · `Review.vue`  ← RETRIEVAL_STRENGTH_OPTIONS（自评强度下拉框）
//     · `Cards.vue`   ← applyCardFilters（列表筛选）
//   若照错误结论删掉，**这两个页面当场白屏**。
//
// 本门禁的作用：把「对外 API 必须与拆分前逐符号一致」变成**可执行的断言**，
// 以后任何人（包括下一轮的我）再想动门面导出，都会先撞到它。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as repo from '../src/repo.js';

/** 从一份 repo.js 源文件里提取「全部对外符号」。
 *  ⚠️ 必须覆盖三种导出形式，只统计前两种会漏掉 re-export —— 这正是上一轮出错的根因：
 *     export function xxx    （函数声明）
 *     export const/let xxx   （常量声明）
 *     export { a, b as c };  （**re-export 行**，最容易被漏）
 */
export function collectExports(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim();
      if (n) out.add(n.split(/\s+as\s+/).pop().trim());
    }
  }
  return out;
}

test('① 对外 API 覆盖拆分前的完整符号集（含 re-export 行，一个不漏）', () => {
  // 基准 = 本轮拆分前的 repo.js（git HEAD 里的门面往前数即为拆分前版本不适用，
  //       故用固定的**期望清单**——它等于拆分前的 132 个符号，按域逐个列出关键项，
  //       避免依赖 git 历史导致测试随提交漂移）
  const expected = [
    // 卡片 CRUD / 复习 / 调度
    'listCards', 'getCard', 'createCard', 'updateCard', 'deleteCard', 'review',
    'reviewQueue', 'applyCardFeedback', 'rescheduleCardToNow', 'setMarked',
    'getCardHistory', 'attachSelfExplanation', 'restoreFromTrash', 'trashItem', 'pruneTrash',
    // 统计
    'dashboardSnapshot', 'invalidateDashboardCache', 'invalidateFailCountCache',
    'weakCards', 'failCountMap', 'attachFailCounts', 'getStats',
    // 回收站 / 图片
    'deleteOrphanImages', 'findOrphanImages', 'cleanupOrphanImages', 'sweepOrphanRows',
    // 计划 / 任务
    'createDailyPlan', 'updateDailyTask', 'deleteDailyTask', 'addDailyTask',
    'listDailyPlan', 'listDailyPlans', 'listDailyPlanSummary', 'getDailyReality',
    'clampScheduledHour',
    // ⚠️ clampEstimatedMinutes 是**模块私有**（原 repo.js 里也没有 export），不在对外 API ——
    //   本门禁第一版误把它列进期望值，被自己拦下了。这正是门禁存在的意义。
    // 笔记 / 资料 / 导图 / 考试 / 周报 / 成就
    'listNotes', 'getNote', 'createNote', 'updateNote', 'deleteNote',
    'listDocs', 'getDoc', 'createDoc', 'updateDoc',
    'listMindmaps', 'getMindmap', 'createMindmap', 'updateMindmap',
    'listExams', 'getExam', 'saveExam', 'deleteExam',
    'listWeeklyReports', 'getWeeklyReport', 'listAchievements', 'unlockAchievement',
    'listMemos',
    // 关联 / 图谱 / 番茄 / 操作日志
    'linkCardWord', 'unlinkCardWord', 'cardOfWord', 'wordCardsOfCard',
    'createGraphEdge', 'deleteGraphEdge', 'listGraphEdges',
    'addPomoSession', 'recordUserOp', 'queryUserOps',
    // 词卡-卡片关联
    'listCardGroups', 'cardGroupsOfCard', 'cardGroupCardIds', 'cardsOfCard',
    // 常量
    'TRASH_TTL_DAYS', 'WRONG_REASONS', 'WRONG_REASON_MAP', 'wrongReasonToCode',
    'gradeCard', 'validateCard', 'formatDue',
    // ⚠️ re-export 行（上一轮被漏掉的就是这 4 个）—— **绝不可删，删了 Review/Cards 白屏**
    'RETRIEVAL_STRENGTH_OPTIONS', 'DEFAULT_SUBJECTS', 'applyCardFilters', 'tagFilter',
  ];
  const missing = expected.filter(n => !(n in repo));
  assert.deepEqual(missing, [], `对外 API 缺失（这些被视图依赖，删了会白屏）：${missing.join(', ')}`);
});

test('② 正在被视图使用的 4 个 re-export 符号必须可用（round142 差点被误删）', () => {
  // Review.vue:12 + 模板 v-for
  assert.ok(Array.isArray(repo.RETRIEVAL_STRENGTH_OPTIONS) && repo.RETRIEVAL_STRENGTH_OPTIONS.length > 0,
    'Review.vue 的自评强度下拉框依赖它');
  assert.ok(repo.RETRIEVAL_STRENGTH_OPTIONS.every(o => o && o.code && o.label),
    '每项必须有 code 与 label（模板直接取用）');
  // Cards.vue:15 + :226
  assert.equal(typeof repo.applyCardFilters, 'function', 'Cards.vue 的列表筛选依赖它');
  assert.equal(typeof repo.tagFilter, 'function', 'applyCardFilters 内部依赖它');
  // pretest.js 注释提到的那个
  assert.ok(Array.isArray(repo.DEFAULT_SUBJECTS) && repo.DEFAULT_SUBJECTS.length > 0,
    '默认科目列表必须可用');
});

test('③ 门面的 re-export 与模块自身一致（同一来源，不是两份拷贝）', async () => {
  // cards.js 里是 `export { RETRIEVAL_STRENGTH_OPTIONS }`（转自 srs.js），
  // 门面再 `export *` 转发 ⇒ 全链共享同一份，模块改了门面跟着变。
  const cardsSrc = fs.readFileSync(path.resolve('src/repo/cards.js'), 'utf8');
  const srs = await import('../src/srs.js');
  assert.equal(repo.RETRIEVAL_STRENGTH_OPTIONS, srs.RETRIEVAL_STRENGTH_OPTIONS,
    '门面转发出去的必须是 srs.js 的同一份引用，不能是拷贝');
  assert.match(cardsSrc, /export\s*\{[^}]*RETRIEVAL_STRENGTH_OPTIONS[^}]*\}/,
    'cards.js 必须保留 re-export 行（删了门面就转发不出去）');
});