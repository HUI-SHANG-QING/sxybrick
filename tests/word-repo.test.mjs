// tests/word-repo.test.mjs —— 英语单词模块数据层测试
// 覆盖：单词卡 CRUD / 复习调度（复用 FSRS） / 熟词 / 批注 / 词组多对多 / 删除墓碑 / 列表统计。
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  createWordCard, updateWordCard, reviewWord, deleteWordCard,
  markFamiliar, setWordNote,
  listWordGroups, createWordGroup, updateWordGroup, deleteWordGroup,
  wordGroupCardIds, wordGroupsOfCard, setWordGroups,
  listWordCards, dueWordCards, wordStats, wordReviewHistory,
} from '../src/word-repo.js';

after(async () => { try { await db.close(); } catch {} });

function mk(payload) { return createWordCard(payload); }

test('createWordCard：默认 word 类型、立即到期、熟词=0', async () => {
  const c = await mk({ word: 'ubiquitous', meaning: '无处不在的', kind: 'word' });
  assert.ok(c.id);
  assert.equal(c.kind, 'word');
  assert.equal(c.familiar, 0);
  assert.ok((c.dueAt || 0) <= Date.now() + 10); // 新卡立即进入复习队列
  assert.equal(c.reviewedAt, 0);
  assert.equal(c.meaning, '无处不在的');
  await assert.rejects(() => mk({ word: '   ' }), /不能为空/);
});

test('updateWordCard：更新字段并推进 updatedAt', async () => {
  const c = await mk({ word: 'abandon', meaning: '放弃' });
  const u = await updateWordCard(c.id, { meaning: '遗弃；放弃', note: '阅读高频' });
  assert.equal(u.meaning, '遗弃；放弃');
  assert.equal(u.note, '阅读高频');
  assert.ok(u.updatedAt >= c.updatedAt);
});

test('reviewWord：复用底层算法推进 SRS 状态 + 写复习记录', async () => {
  const c = await mk({ word: 'benefit', meaning: '好处' });
  const before = c.dueAt;
  const res = await reviewWord(c.id, 2);
  assert.ok(!res.skipped);
  const after = await db.wordCards.get(c.id);
  assert.ok(after.reviewedAt > 0);
  assert.ok(after.dueAt > before); // 记住了 → 间隔变大
  assert.ok(after.fsrs || after.intervalDays > 0);
  const revs = await db.wordReviews.where('cardId').equals(c.id).toArray();
  assert.equal(revs.length, 1);
  assert.equal(revs[0].rating, 2);
});

test('reviewWord：P2-C grade 口径与记忆卡对齐（retrievalGrading 四档 + gradeScore + 信号字段）', async () => {
  const c = await mk({ word: 'advocate', meaning: '提倡' });
  // rating=2 无信号：recall 基准 → medium（旧实现是三档直接 easy，这是口径差异的回归锚点）
  await reviewWord(c.id, 2);
  // rating=0：failed
  const c2 = await mk({ word: 'allocate', meaning: '分配' });
  await reviewWord(c2.id, 0);
  // 带检索强度信号 + 蒙对 + 耗时
  const c3 = await mk({ word: 'anticipate', meaning: '预期' });
  await reviewWord(c3.id, 2, { retrievalStrength: 'generate', responseMs: 1200 });
  const r1 = await db.wordReviews.where('cardId').equals(c.id).first();
  const r2 = await db.wordReviews.where('cardId').equals(c2.id).first();
  const r3 = await db.wordReviews.where('cardId').equals(c3.id).first();
  assert.equal(r1.grade, 'medium', 'rating=2 无信号应落 medium（retrievalGrading recall 基准）');
  assert.equal(r2.grade, 'failed', 'rating=0 应 failed');
  assert.equal(r3.grade, 'easy', 'generate 强度应 easy');
  assert.equal(r3.gradeScore, 0.95, 'gradeScore 与 retrievalGrading 一致');
  assert.equal(r3.retrievalStrength, 'generate');
  assert.equal(r3.responseMs, 1200);
  assert.ok(r1.guessed === false, '未传 guessed 默认 false');
  const ALL = ['failed', 'hard', 'medium', 'easy'];
  for (const r of [r1, r2, r3]) assert.ok(ALL.includes(r.grade), `grade 必须是四档之一（实际 ${r.grade}）`);
});

test('reviewWord：范文(template) 不参与调度', async () => {
  const c = await mk({ word: 'My Essay', meaning: '范文', kind: 'template' });
  const res = await reviewWord(c.id, 2);
  assert.ok(res.skipped);
  const after = await db.wordCards.get(c.id);
  assert.ok(after.reviewedAt > 0);
  assert.ok((after.dueAt || 0) <= Date.now() + 10); // dueAt 未被重排
});

test('markFamiliar：标记熟词并移出活跃队列', async () => {
  const c = await mk({ word: 'apple', meaning: '苹果' });
  const r = await markFamiliar(c.id, 1);
  assert.equal(r.familiar, 1);
  assert.ok((r.dueAt || 0) > Date.now() + 300 * 86400000); // 推到一年外
  const due = await dueWordCards();
  assert.ok(!due.some(x => x.id === c.id));
  await markFamiliar(c.id, 0);
  const due2 = await dueWordCards();
  assert.ok(due2.some(x => x.id === c.id));
});

test('setWordNote：更新批注', async () => {
  const c = await mk({ word: 'justify', meaning: '证明…合理' });
  await setWordNote(c.id, '写作常用');
  const after = await db.wordCards.get(c.id);
  assert.equal(after.note, '写作常用');
});

test('词组：CRUD + 多对多关联 + 移出墓碑', async () => {
  const g = await createWordGroup({ name: ' 阅读高频 ', color: '#2fbf71' });
  assert.equal(g.name, '阅读高频');
  assert.equal(g.status, 'active');
  const a = await mk({ word: 'ambiguous', meaning: '模糊的' });
  const b = await mk({ word: 'coincide', meaning: '巧合' });
  const r1 = await setWordGroups([a.id, b.id], [g.id], []);
  assert.equal(r1.added, 2);
  let ids = await wordGroupCardIds(g.id);
  assert.deepEqual(ids.sort(), [a.id, b.id].sort());
  let owned = await wordGroupsOfCard(a.id);
  assert.ok(owned.some(x => x.id === g.id));
  // 移出一个
  const r2 = await setWordGroups([a.id], [], [g.id]);
  assert.equal(r2.removed, 1);
  ids = await wordGroupCardIds(g.id);
  assert.deepEqual(ids, [b.id]);
  // 移出写墓碑（跨设备删除生效）
  const tombs = (await db.tombstones.toArray()).filter(t => t.kind === 'wordGroupLink');
  assert.ok(tombs.length >= 1);
  await updateWordGroup(g.id, { status: 'archived' });
  const ug = await db.wordGroups.get(g.id);
  assert.equal(ug.status, 'archived');
  await deleteWordGroup(g.id);
  assert.equal(await db.wordGroups.get(g.id), undefined);
});

test('deleteWordCard：回收站快照 + 墓碑 + 级联清理', async () => {
  const c = await mk({ word: 'deleteMe', meaning: '删我' });
  const g = await createWordGroup({ name: 'grp' });
  await setWordGroups([c.id], [g.id], []);
  await reviewWord(c.id, 1);
  await deleteWordCard(c.id);
  assert.equal(await db.wordCards.get(c.id), undefined);
  // 复习记录应被级联删除
  const revs = await db.wordReviews.where('cardId').equals(c.id).toArray();
  assert.equal(revs.length, 0);
  // 关联应被级联删除
  const links = await db.wordGroupLinks.where('cardId').equals(c.id).toArray();
  assert.equal(links.length, 0);
  // 墓碑（跨设备删除）
  const tomb = await db.tombstones.get(c.id);
  assert.ok(tomb && tomb.kind === 'wordCard');
  // 回收站快照
  const trash = await db.trash.where('id').equals(c.id).toArray();
  assert.equal(trash.length, 1);
});

test('listWordCards / dueWordCards / wordStats 筛选与统计', async () => {
  await mk({ word: 'w1', meaning: 'm1', kind: 'word' });
  await mk({ word: 'w2', meaning: 'm2', kind: 'phrase' });
  await mk({ word: 'w3', meaning: 'm3', kind: 'template' });
  const words = await listWordCards({ kind: 'word' });
  assert.ok(words.length >= 1 && words.every(x => x.kind === 'word'));
  const tmpl = await listWordCards({ kind: 'template' });
  assert.ok(tmpl.every(x => x.kind === 'template'));
  const due = await dueWordCards();
  assert.ok(due.every(x => x.kind !== 'template')); // 范文不入复习队列
  const st = await wordStats();
  assert.ok(st.total >= 3);
  assert.ok(st.templates >= 1);
  assert.ok(st.schedulable >= 2);
});

test('wordReviewHistory：已背记录倒序且带回卡片', async () => {
  const c = await mk({ word: 'history', meaning: '历史' });
  await reviewWord(c.id, 2);
  const hist = await wordReviewHistory(10);
  assert.ok(hist.length >= 1);
  assert.equal(hist[0].card?.id, c.id);
});
