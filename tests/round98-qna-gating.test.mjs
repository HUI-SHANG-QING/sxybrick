// tests/round98-qna-gating.test.mjs —— round98 P2-2 回归
//
// 缺陷：普通问答（round96 起）**无条件**把全库明细注入 system——问「你好」也发全部笔记/文档/
// 单词/计划，费 token、外发隐私、小窗口模型可能撑爆；且每轮把整表正文读进内存再截前 N（N1）。
// 修复：① 按问题意图只注入相关模块（utils/query-intent.js）；② 总字符预算刹车；③ 查询走 limit。
// 本文件锁定：问候语不注入；问到哪个模块才注入哪个；「全部」仍全量；不注入的模块不发起全表读。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { buildModuleNodesContext } from '../src/agent/context.js';
import { wantedModules } from '../src/utils/query-intent.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

async function seed() {
  await Promise.all([db.memos.clear(), db.docs.clear(), db.notes.clear(), db.plans.clear(),
    db.dailyPlans.clear(), db.dailyTasks.clear(), db.pomoSessions.clear(), db.wordCards.clear(),
    db.docFiles.clear(), db.graphEdges.clear()]);
  await db.memos.put({ id: 'm1', text: '明天复习计算机网络', important: true, urgent: false, at: Date.now(), createdAt: Date.now() });
  await db.docs.put({ id: 'd1', title: '操作系统进程线程文档', content: '进程是资源分配基本单位。', type: 'note', tags: [], createdAt: Date.now(), updatedAt: Date.now() });
  await db.notes.put({ id: 'n1', title: '线代第四章节笔记', content: '基础解系与通解的结构。', category: 'idea', tags: [], createdAt: Date.now(), updatedAt: Date.now() });
  await db.plans.put({ id: 'p1', title: '考研冲刺计划', content: '第一阶段打基础。', status: 'active', createdAt: Date.now(), updatedAt: Date.now() });
  await db.pomoSessions.put({ id: 'ps1', startedAt: Date.now() - 3_600_000, duration: 25, tag: '线代', partial: 0, createdAt: Date.now() });
  await db.wordCards.put({ id: 'w1', word: 'abandon', meaning: '放弃', kind: 'syllabus', subject: '英语', createdAt: Date.now(), updatedAt: Date.now() });
  await db.docFiles.put({ id: 'f1', name: '计网真题.pdf', status: 'ready', subject: '计网', createdAt: Date.now(), updatedAt: Date.now() });
  await db.docFiles.put({ id: 'f2', name: '损坏的文件.pdf', status: 'failed', subject: '计网', createdAt: Date.now(), updatedAt: Date.now() });
  await db.graphEdges.put({ id: 'e1', from: '二叉树', to: '树', label: '属于', fromCardId: 'c1', toCardId: 'c2', subject: '数据结构' });
}
beforeEach(seed);

test('wantedModules：问候语不命中；关键词命中对应模块；「全部」返回 null', () => {
  assert.equal(wantedModules('你好').size, 0, '问候语不应命中任何模块');
  assert.equal(wantedModules('').size, 0, '空问题返回空集');
  const s = wantedModules('我的笔记写了什么');
  assert.ok(s.has('notes'), '「笔记」应命中 notes');
  assert.ok(!s.has('pomo'), '「笔记」不应命中番茄钟');
  assert.equal(wantedModules('帮我看看全部模块'), null, '「全部」返回 null（不筛）');
});

test('P2-2：问「你好」不注入任何模块明细（不再无条件全量外发）', async () => {
  assert.equal(await buildModuleNodesContext('你好'), '', '问候语不应注入模块明细');
  assert.equal(await buildModuleNodesContext('今天天气不错'), '', '无关问题也不注入');
});

test('P2-2：问到哪个模块才注入哪个模块（其余不注入）', async () => {
  const notesCtx = await buildModuleNodesContext('我的笔记里写了什么');
  assert.ok(notesCtx.includes('线代第四章节笔记'), '问到笔记 → 注入笔记');
  assert.ok(!notesCtx.includes('abandon'), '没问单词 → 不注入单词');
  assert.ok(!notesCtx.includes('考研冲刺计划'), '没问计划 → 不注入计划');

  const wordCtx = await buildModuleNodesContext('我背了哪些单词');
  assert.ok(wordCtx.includes('abandon'), '问到单词 → 注入单词');
  assert.ok(!wordCtx.includes('线代第四章节笔记'), '没问笔记 → 不注入笔记');

  const pomoCtx = await buildModuleNodesContext('我今天专注了多久');
  assert.ok(pomoCtx.includes('25'), '问到专注 → 注入番茄明细');
  assert.ok(!pomoCtx.includes('abandon'), '没问单词 → 不注入单词');
});

test('P2-2：明确「全部」时仍注入全部模块（保留 round96 能力，按需触发）', async () => {
  const ctx = await buildModuleNodesContext('帮我汇总全部模块的数据');
  assert.ok(ctx.includes('明天复习计算机网络'), '含备忘');
  assert.ok(ctx.includes('线代第四章节笔记'), '含笔记');
  assert.ok(ctx.includes('abandon'), '含单词');
  assert.ok(ctx.includes('考研冲刺计划'), '含计划');
});

test('N2：解析失败/解析中的资料不被当成「你有这份资料」', async () => {
  const ctx = await buildModuleNodesContext('我的资料库里有哪些文件');
  assert.ok(ctx.includes('计网真题.pdf'), 'ready 文件应列出');
  assert.ok(!ctx.includes('损坏的文件.pdf'), 'failed 文件不得列进可用清单');
  assert.ok(/尚未解析成功/.test(ctx), '应单独提示存在未解析成功的资料');
});
