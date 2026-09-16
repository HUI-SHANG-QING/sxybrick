// tests/round101-all-modules.test.mjs —— round101 回归
//
// 诉求（用户原话）：「所有模块的数据能不能被 Agent 模块和相关 AI 模块充分调用，
// **不仅是模块概要，还要具体到里面的内容**（卡片正反面+图片、每日规划具体文字、计划具体文字…）」。
// 审计发现这些模块此前**连工具都没有**（AI 永久看不到）：考试 / 思维导图 / 周报 / 卡组 / 单词组 / 成就。
// 本文件锁定：① 这些模块已有工具；② 通用 Agent 都挂上了；③ 每个工具都能取到**具体内容**（不是计数）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { toolRegistry, agentRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { registerDefaultAgents } from '../src/agent/agents/index.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const NEW_MODULES = ['list_exams', 'list_mindmaps', 'list_weekly_reports', 'list_card_groups', 'list_word_groups', 'list_achievements'];

test('此前「AI 完全看不到」的模块已有工具（考试/思维导图/周报/卡组/单词组/成就）', () => {
  for (const n of NEW_MODULES) {
    const t = toolRegistry.get(n);
    assert.ok(t, `${n} 必须已注册`);
    assert.equal(typeof t.execute, 'function');
  }
});

test('通用 Agent（assistant / tutor / analyst）都挂上了这些模块工具', () => {
  registerDefaultAgents();
  for (const id of ['assistant', 'tutor', 'analyst']) {
    const a = agentRegistry.get(id);
    assert.ok(a, `${id} 必须存在`);
    for (const n of NEW_MODULES) assert.ok(a.tools.includes(n), `${id} 缺少 ${n}`);
  }
});

test('考试记录：列表给成绩、传 id 给题目明细（不是只给计数）', async () => {
  await db.exams.clear();
  await db.exams.put({ id: 'ex1', title: '线代模考', subject: '线性代数', score: 82, total: 100, questions: [{ q: '求特征值', correct: true }], createdAt: Date.now(), updatedAt: Date.now() });
  const t = toolRegistry.get('list_exams');
  const list = await t.execute({});
  assert.equal(list.data.total, 1);
  assert.equal(list.data.items[0].score, 82, '列表要给得分');
  const one = await t.execute({ id: 'ex1' });
  assert.ok(one.data.questions.includes('求特征值'), '传 id 必须给出题目明细');
});

test('思维导图 / 周报 / 卡组 / 单词组 / 成就：都能取到具体内容', async () => {
  await Promise.all([db.mindmaps.clear(), db.weeklyReports.clear(), db.cardGroups.clear(),
    db.cardGroupLinks.clear(), db.cards.clear(), db.wordGroups.clear(),
    db.wordGroupLinks.clear(), db.wordCards.clear(), db.achievements.clear()]);

  // 思维导图：节点数 + 结构树
  await db.mindmaps.put({ id: 'm1', title: '线代知识树', root: { id: 'r', label: '线代', children: [{ id: 'c1', label: '行列式', children: [] }] }, createdAt: Date.now(), updatedAt: Date.now() });
  const mm = toolRegistry.get('list_mindmaps');
  assert.equal((await mm.execute({})).data.items[0].nodeCount, 2, '节点数要算对');
  assert.ok((await mm.execute({ id: 'm1' })).data.tree.includes('行列式'), '传 id 必须给出结构树');

  // 周报：正文摘要 + 结构化数据
  await db.weeklyReports.put({ id: 'w1', weekStart: Date.now(), title: '第 1 周', summary: '本周复习了停止-等待协议', data: { reviews: 12 }, createdAt: Date.now(), updatedAt: Date.now() });
  const wr = toolRegistry.get('list_weekly_reports');
  assert.ok((await wr.execute({ id: 'w1' })).data.summary.includes('停止-等待'), '周报正文可取');

  // 卡组：组内卡片数 + 组内卡片标题
  await db.cardGroups.put({ id: 'g1', name: '计网错题组', description: '易错', status: 'active', sortOrder: 0, createdAt: Date.now(), updatedAt: Date.now() });
  await db.cards.put({ id: 'c1', front: '停止-等待协议的重传', back: 'b', subject: '计网', tags: [], createdAt: Date.now(), updatedAt: Date.now() });
  await db.cardGroupLinks.put({ id: 'gl1', cardId: 'c1', groupId: 'g1', addedAt: Date.now() });
  const cg = toolRegistry.get('list_card_groups');
  assert.equal((await cg.execute({})).data.items[0].cardCount, 1, '卡组要带组内卡片数');
  assert.ok((await cg.execute({ id: 'g1' })).data.cards[0].title.includes('停止-等待'), '传 id 必须列出组内卡片');

  // 单词组：词数 + 组内单词
  await db.wordGroups.put({ id: 'wg1', name: '核心词汇', status: 'active', sortOrder: 0, createdAt: Date.now(), updatedAt: Date.now() });
  await db.wordCards.put({ id: 'wc1', word: 'abandon', meaning: '放弃', createdAt: Date.now(), updatedAt: Date.now() });
  await db.wordGroupLinks.put({ id: 'wgl1', cardId: 'wc1', groupId: 'wg1', addedAt: Date.now() });
  const wg = toolRegistry.get('list_word_groups');
  assert.equal((await wg.execute({})).data.items[0].wordCount, 1, '单词组要给词数');
  assert.equal((await wg.execute({ id: 'wg1' })).data.words[0].word, 'abandon', '传 id 必须列出组内单词');

  // 成就
  await db.achievements.put({ id: 'ach-pomo_1', key: 'pomo_1', unlockedAt: Date.now() });
  const ac = await toolRegistry.get('list_achievements').execute({});
  assert.equal(ac.data.total, 1);
  assert.equal(ac.data.items[0].key, 'pomo_1');
});
