// tests/round96-qna-all-modules.test.mjs —— round96 回归
//
// 用户诉求：「不仅是 agent，AI 学习助手（普通问答）也要能实现看到所有模块的信息，尤其是图片」。
// 普通问答无工具，只能看注入的 system 上下文；此前它只从 getModuleSummary 拿到各模块**计数**，
// 文档/笔记只注入**标题**（正文与其中的图都到不了模型）。round96 把 buildModuleNodesContext
// 扩成「全模块明细快照」，文档/笔记正文用 clipText 保图片引用 → 交 enrichForLlm 作为附图送出。
//
// 本文件锁定：① 普通问答上下文覆盖 备忘/文档/笔记/计划/每日/番茄/单词/资料库/图谱 全模块；
//            ② 文档/笔记正文里的图片引用完整保留；③ 该上下文经 enrichForLlm 真的把图送出（vision≥1）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { putImage } from '../src/images.js';
import { buildFullContext, buildModuleNodesContext } from '../src/agent/context.js';
import { enrichForLlm } from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const IMG_ID = '550e8400-e29b-41d4-a716-446655440000';
const IMG_REF = `![image](sxy-img://${IMG_ID})`;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });
const VISION = { imageAnalysis: { mode: 'visionFirst', visionLimit: 4, imageQuality: 'high' } };

async function seedAllModules() {
  await Promise.all([db.memos.clear(), db.docs.clear(), db.notes.clear(), db.plans.clear(),
    db.dailyPlans.clear(), db.dailyTasks.clear(), db.pomoSessions.clear(), db.wordCards.clear(),
    db.docFiles.clear(), db.graphEdges.clear(), db.images.clear(), db.cards.clear(), db.reviews.clear()]);
  await db.memos.put({ id: 'm1', text: '明天复习计算机网络', important: true, urgent: false, at: Date.now() });
  await db.docs.put({ id: 'd1', title: '操作系统进程线程笔记', content: '进程是资源分配基本单位，线程是调度基本单位。' + IMG_REF, type: 'note', tags: [], createdAt: Date.now(), updatedAt: Date.now() });
  await db.notes.put({ id: 'n1', title: '线代第四章节笔记', content: '基础解系与通解的结构。' + IMG_REF, category: 'idea', tags: [], createdAt: Date.now(), updatedAt: Date.now() });
  await db.plans.put({ id: 'p1', title: '考研冲刺计划', content: '第一阶段打基础，第二阶段强化。', status: 'active', createdAt: Date.now(), updatedAt: Date.now() });
  await db.dailyPlans.put({ id: 'dp1', date: '2026-09-15', status: 'active', updatedAt: Date.now() });
  await db.dailyTasks.put({ id: 't1', planId: 'dp1', date: '2026-09-15', status: 'done', updatedAt: Date.now() });
  await db.pomoSessions.put({ id: 'ps1', startedAt: Date.now() - 3_600_000, duration: 25, tag: '线代', partial: 0, createdAt: Date.now() });
  await db.wordCards.put({ id: 'w1', word: 'abandon', meaning: '放弃，抛弃', kind: 'syllabus', subject: '英语', createdAt: Date.now(), updatedAt: Date.now() });
  await db.docFiles.put({ id: 'f1', name: '计网真题.pdf', status: 'ready', subject: '计网', createdAt: Date.now(), updatedAt: Date.now() });
  await db.graphEdges.put({ id: 'e1', from: '二叉树', to: '树', label: '属于', fromCardId: 'c1', toCardId: 'c2', subject: '数据结构' });
}

test('普通问答上下文覆盖「全模块明细」：备忘/文档/笔记/计划/每日/番茄/单词/资料库/图谱', async () => {
  await seedAllModules();
  const ctx = await buildModuleNodesContext();
  assert.ok(ctx, '应返回非空全模块快照');
  assert.ok(ctx.includes('明天复习计算机网络'), '备忘全文可见');
  assert.ok(ctx.includes('操作系统进程线程笔记'), 'AI 文档标题可见');
  assert.ok(ctx.includes('进程是资源分配基本单位'), 'AI 文档正文可见（不再只有标题）');
  assert.ok(ctx.includes('线代第四章节笔记') && ctx.includes('基础解系与通解'), '笔记标题与正文可见');
  assert.ok(ctx.includes('考研冲刺计划'), '长期计划标题可见');
  assert.ok(ctx.includes('2026-09-15'), '每日规划执行情况可见');
  assert.ok(ctx.includes('25'), '番茄钟逐次明细可见（时长）');
  assert.ok(ctx.includes('abandon'), '单词模块可见');
  assert.ok(ctx.includes('计网真题.pdf'), '资料库文件可见');
  assert.ok(ctx.includes('二叉树（起点）→树（终点），关联关系为：属于'), '知识图谱边端点可见');
});

test('文档/笔记正文里的图片引用必须完整保留（否则会假报缺失）', async () => {
  await seedAllModules();
  const ctx = await buildModuleNodesContext();
  assert.match(ctx, /sxy-img:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/, '图片引用必须是完整 36 位 uuid');
});

test('普通问答上下文经 enrichForLlm 必须真的把文档/笔记里的图送出（vision≥1）', async () => {
  await seedAllModules();
  await putImage(IMG_ID, pngBlob(), 'image/png');
  const [base, modules] = await Promise.all([buildFullContext('我笔记里的图讲了什么'), buildModuleNodesContext()]);
  const messages = [
    { role: 'system', content: base + '\n\n' + modules },
    { role: 'user', content: '帮我讲讲我笔记和文档里的图' },
  ];
  const { vision } = await enrichForLlm(messages, { settings: VISION });
  assert.ok(vision >= 1, `普通问答必须能看到并送出文档/笔记里的图，实际 vision=${vision}`);
});
