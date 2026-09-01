// tests/trash-lifecycle.test.mjs —— 删除分级 / 回收站生命周期（2026-08-30 收敛）
// 覆盖：
//   1) 资料（docFile）删除进回收站可恢复：元数据 + 解析全文 + 图谱边回来，原文件标记 missing
//   2) 资料删除写全墓碑：docFile / graphEdge / embedding（级联删除不写墓碑 → 对端回灌）
//   3) 删卡连带删卡组关联，并写 groupLink 墓碑；恢复时关联与墓碑一起还原
//   4) 卡组删除 / 「移出卡组」写墓碑（此前设计有、实现无 → 删除永不生效）
//   5) 删计划级联删任务写 dailyTask 墓碑
//   6) pruneTrash 按 TTL 清理过期快照
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  createCard, deleteCard, restoreFromTrash, pruneTrash, TRASH_TTL_DAYS,
  createCardGroup, setCardGroups, deleteCardGroup, cardGroupsOfCard,
  createDailyPlan, deleteDailyPlan,
} from '../src/repo.js';
import { deleteDocFile } from '../src/docs-lib.js';

after(async () => { try { await db.close(); } catch {} });

// N-4(round11b)：固定参考时刻，所有时间相关断言与此解耦，避免真实运行日期
//   撞上「跨月 28/30/31 天」「周一必红」类边界导致偶发失败。与 pomo 测试同一 REF。
const REF = new Date(2026, 7, 26, 14, 0, 0).getTime(); // 2026-08-26 周三 14:00

async function resetTrash() { await db.trash.clear(); }

// ---------- 1) 资料删除 → 回收站 → 恢复 ----------

test('资料删除：写 trash 快照，可直接从回收站恢复（解析全文不丢）', async () => {
  await resetTrash();
  const id = 'doc-restore-1';
  const fullText = '第一章 线性代数。向量组的线性相关性是贯穿全章的核心概念。'.repeat(20);
  await db.docFiles.put({
    id, name: '线代讲义.pdf', ext: 'pdf', size: 2048, subject: '线性代数',
    status: 'ready', storage: 'opfs', opfsPath: 'doc-restore-1_线代讲义.pdf',
    textLen: fullText.length, createdAt: REF, updatedAt: REF,
  });
  await db.docTexts.put({ id, text: fullText, textLen: fullText.length, updatedAt: REF });
  await db.embeddings.put({ id: 'emb-1', sourceType: 'doc', sourceId: id, updatedAt: REF, vector: [0.1, 0.2] });
  await db.graphEdges.put({
    id: 'edge-1', from: '📄 线代讲义.pdf', to: '向量相关性', label: '涵盖', subject: '线性代数',
    docId: id, updatedAt: REF,
  });

  assert.equal(await deleteDocFile(id), true, '删除成功返回 true');
  assert.equal(await db.docFiles.get(id), undefined, '元数据已删');
  assert.equal(await db.docTexts.get(id), undefined, '全文已删');

  // 快照落在回收站
  const snap = await db.trash.get(id);
  assert.ok(snap, 'trash 有快照');
  assert.equal(snap.kind, 'docFile');
  assert.equal(snap.data._text, fullText, '快照带完整解析全文');
  assert.equal(snap.data._edges.length, 1, '快照带图谱边');

  // 恢复
  assert.equal(await restoreFromTrash(snap), true);
  const back = await db.docFiles.get(id);
  assert.ok(back, '元数据回来了');
  assert.equal(back.name, '线代讲义.pdf');
  assert.equal(back.textLen, fullText.length);
  assert.equal((await db.docTexts.get(id))?.text, fullText, '解析全文完整恢复');
  assert.equal((await db.graphEdges.get('edge-1'))?.docId, id, '图谱边恢复');
  assert.equal(await db.trash.get(id), undefined, '恢复后 trash 记录清除');
  assert.equal(await db.tombstones.get(id), undefined, '恢复后墓碑清除');

  // 原文件已释放 → 必须显式标记 missing，而不是留着指向已删 OPFS 路径
  assert.equal(back.storage, 'missing', '原文件不可恢复，storage 标记为 missing');
  assert.equal(back.opfsPath, undefined, '已失效的 opfsPath 必须清掉');
});

test('资料删除：级联删掉的图谱边与向量块都写墓碑（防对端回灌）', async () => {
  await resetTrash();
  const id = 'doc-tomb-1';
  await db.docFiles.put({
    id, name: 't.txt', ext: 'txt', size: 10, status: 'ready', storage: 'idb',
    createdAt: REF, updatedAt: REF,
  });
  await db.embeddings.put({ id: 'emb-x', sourceType: 'doc', sourceId: id, updatedAt: REF });
  await db.graphEdges.put({ id: 'edge-x', from: '📄 t.txt', to: 'a', label: '涵盖', subject: '', docId: id, updatedAt: REF });

  await deleteDocFile(id);
  const kinds = new Set((await db.tombstones.toArray()).map(t => `${t.kind}:${t.id}`));
  assert.ok(kinds.has(`docFile:${id}`), 'docFile 墓碑');
  assert.ok(kinds.has('graphEdge:edge-x'), '级联删的图谱边也要墓碑');
  assert.ok(kinds.has('embedding:emb-x'), '级联删的向量块也要墓碑');
});

// ---------- 2) 删卡：卡组关联 ----------

test('删卡：连带删卡组关联并写 groupLink 墓碑；恢复时关联与墓碑一起还原', async () => {
  await resetTrash();
  const card = await createCard({ front: 'Q-组关联', back: 'A', subject: '计组' });
  const g = await createCardGroup({ name: '组-删卡' });
  await setCardGroups([card.id], [g.id], []);
  assert.equal((await cardGroupsOfCard(card.id)).length, 1, '已在组内');

  await deleteCard(card.id);
  assert.equal((await db.cardGroupLinks.where('cardId').equals(card.id).toArray()).length, 0, '关联行已删（无悬空）');
  const snap = await db.trash.get(card.id);
  assert.equal(snap.kind, 'card');
  assert.equal(snap.data._groupLinks.length, 1, '快照带卡组关联');
  const linkId = snap.data._groupLinks[0].id;
  assert.equal((await db.tombstones.get(linkId))?.kind, 'groupLink', '关联行写了 groupLink 墓碑');

  assert.equal(await restoreFromTrash(snap), true);
  assert.equal((await cardGroupsOfCard(card.id)).length, 1, '恢复后回到原卡组');
  assert.equal(await db.tombstones.get(linkId), undefined, '恢复后关联墓碑清除（否则下次同步又被删）');
  await deleteCardGroup(g.id);
  await deleteCard(card.id);
});

// ---------- 3) 卡组删除 / 移出 ----------

test('删除卡组：卡组本体与级联关联都写墓碑（否则对端会推回来）', async () => {
  const card = await createCard({ front: 'Q-删组', back: 'A', subject: '计组' });
  const g = await createCardGroup({ name: '组-待删' });
  await setCardGroups([card.id], [g.id], []);
  const links = await db.cardGroupLinks.where('groupId').equals(g.id).toArray();
  assert.equal(links.length, 1);

  assert.equal(await deleteCardGroup(g.id), true);
  assert.equal((await db.tombstones.get(g.id))?.kind, 'cardGroup', '卡组墓碑');
  assert.equal((await db.tombstones.get(links[0].id))?.kind, 'groupLink', '关联墓碑');
  await deleteCard(card.id);
});

test('移出卡组：写 groupLink 墓碑（此前只删行 → 移出永不生效）', async () => {
  const card = await createCard({ front: 'Q-移出', back: 'A', subject: '计组' });
  const g = await createCardGroup({ name: '组-移出' });
  const r = await setCardGroups([card.id], [g.id], []);
  assert.equal(r.added, 1);
  const linkId = (await db.cardGroupLinks.where('cardId').equals(card.id).toArray())[0].id;

  const r2 = await setCardGroups([card.id], [], [g.id]);
  assert.equal(r2.removed, 1);
  assert.equal((await db.cardGroupLinks.where('cardId').equals(card.id).toArray()).length, 0, '关联已删');
  const tomb = await db.tombstones.get(linkId);
  assert.equal(tomb?.kind, 'groupLink', '移出必须写墓碑，否则对端推回来');
  await deleteCardGroup(g.id);
  await deleteCard(card.id);
});

// ---------- 4) 每日计划级联 ----------

test('删除每日计划：级联删的任务逐条写 dailyTask 墓碑', async () => {
  const { plan } = await createDailyPlan({ rawInput: '复习：线代 2 小时；做题：计组 1 小时' });
  const tasks = await db.dailyTasks.where('planId').equals(plan.id).toArray();
  assert.ok(tasks.length >= 1, '至少解析出 1 条任务');

  await deleteDailyPlan(plan.id);
  assert.equal((await db.dailyTasks.where('planId').equals(plan.id).toArray()).length, 0);
  for (const t of tasks) {
    assert.equal((await db.tombstones.get(t.id))?.kind, 'dailyTask', `任务 ${t.id} 缺墓碑`);
  }
  assert.equal((await db.tombstones.get(plan.id))?.kind, 'dailyPlan');
});

test('同一天重建计划：覆盖掉的旧任务也写墓碑', async () => {
  const first = await createDailyPlan({ rawInput: '背单词 30 分钟', date: '2026-08-30' });
  const oldTasks = await db.dailyTasks.where('planId').equals(first.plan.id).toArray();
  assert.ok(oldTasks.length >= 1);

  await createDailyPlan({ rawInput: '做真题 90 分钟', date: '2026-08-30' });
  for (const t of oldTasks) {
    assert.equal((await db.tombstones.get(t.id))?.kind, 'dailyTask', '覆盖重建时旧任务缺墓碑');
  }
  const plans = await db.dailyPlans.where('date').equals('2026-08-30').toArray();
  assert.equal(plans.length, 1, '同日只保留一份计划');
  await deleteDailyPlan(plans[0].id);
});

// ---------- 5) 回收站 TTL ----------

test('pruneTrash：清理超过 TTL 的快照，保留墓碑', async () => {
  await resetTrash();
  const old = REF - (TRASH_TTL_DAYS + 1) * 86400000;
  const fresh = REF;
  await db.trash.put({ id: 'old-1', kind: 'memo', deletedAt: old, data: { id: 'old-1', text: '过期' } });
  await db.trash.put({ id: 'new-1', kind: 'memo', deletedAt: fresh, data: { id: 'new-1', text: '新鲜' } });
  await db.tombstones.put({ id: 'old-1', kind: 'memo', deletedAt: old });

  const cleaned = await pruneTrash(TRASH_TTL_DAYS, REF);
  assert.equal(cleaned, 1, '只清 1 条过期快照');
  assert.equal(await db.trash.get('old-1'), undefined);
  assert.ok(await db.trash.get('new-1'), '未过期的保留');
  assert.ok(await db.tombstones.get('old-1'), '墓碑不受回收站 TTL 影响（跨设备删除语义必须保留）');
  await db.tombstones.delete('old-1');
});

test('restoreFromTrash：未知 kind 返回 false 且不改动数据', async () => {
  assert.equal(await restoreFromTrash(null), false);
  assert.equal(await restoreFromTrash({ id: 'x', kind: 'unknownKind', data: { a: 1 } }), false);
});

// ---------- 6) P1-A：单词卡 / 词组回收站恢复（wordCard / wordGroup） ----------

test('P1-A 删单词卡：进回收站，恢复后 wordReviews/wordGroupLinks 一并回来、墓碑清除', async () => {
  await resetTrash();
  const t = REF;
  // 造一张单词卡 + 一条复习 + 一个词组关联
  await db.wordCards.put({ id: 'wc1', kind: 'word', word: 'abandon', meaning: 'v. 放弃', subject: '考研', createdAt: t, updatedAt: t, reviewedAt: 0, familiar: 0 });
  await db.wordReviews.put({ id: 'wr1', cardId: 'wc1', rating: 2, reviewedAt: t, updatedAt: t });
  await db.wordGroups.put({ id: 'wg1', name: '高频动词', sortOrder: 0, createdAt: t, updatedAt: t });
  await db.wordGroupLinks.put({ id: 'wgl1', cardId: 'wc1', groupId: 'wg1', addedAt: t, updatedAt: t });

  // 删除：走 word-repo 的 deleteWordCard（快照 + 墓碑双写）
  const { deleteWordCard } = await import('../src/word-repo.js');
  assert.equal(await deleteWordCard('wc1'), true);
  assert.equal(await db.wordCards.get('wc1'), undefined, '单词卡已删');
  assert.equal((await db.wordReviews.where('cardId').equals('wc1').toArray()).length, 0, '复习已删');
  assert.equal((await db.wordGroupLinks.where('cardId').equals('wc1').toArray()).length, 0, '词组关联已删');

  const snap = await db.trash.get('wc1');
  assert.equal(snap.kind, 'wordCard', '快照 kind=wordCard（回收站可识别）');
  assert.equal(snap.data._reviews.length, 1, '快照带复习记录');
  assert.equal(snap.data._groupLinks.length, 1, '快照带词组关联');
  assert.equal((await db.tombstones.get('wgl1'))?.kind, 'wordGroupLink', '关联行写了 wordGroupLink 墓碑');

  // 恢复：wordCard 走 wordCards 表，附表还原到 wordReviews / wordGroupLinks
  assert.equal(await restoreFromTrash(snap), true);
  const back = await db.wordCards.get('wc1');
  assert.ok(back, '单词卡回来了');
  assert.equal(back.word, 'abandon');
  assert.equal((await db.wordReviews.where('cardId').equals('wc1').toArray()).length, 1, '复习记录回来了');
  assert.equal((await db.wordGroupLinks.where('cardId').equals('wc1').toArray()).length, 1, '词组关联回来了');
  assert.equal(await db.tombstones.get('wgl1'), undefined, '关联墓碑清除（否则下次同步又被删）');
  assert.equal(await db.tombstones.get('wc1'), undefined, '卡墓碑清除');
  await db.trash.delete('wc1'); await db.wordCards.delete('wc1');
  await db.wordReviews.where('cardId').equals('wc1').delete();
  await db.wordGroupLinks.where('cardId').equals('wc1').delete();
});

test('P1-A 删词组：进回收站（此前无快照），恢复后成员关联回来', async () => {
  await resetTrash();
  const t = REF;
  const { deleteWordGroup } = await import('../src/word-repo.js');
  await db.wordGroups.put({ id: 'wg2', name: '核心短语', sortOrder: 1, createdAt: t, updatedAt: t });
  await db.wordCards.put({ id: 'wc2', kind: 'phrase', word: 'break the ice', meaning: '破冰', subject: '考研', createdAt: t, updatedAt: t, reviewedAt: 0, familiar: 0 });
  await db.wordGroupLinks.put({ id: 'wgl2', cardId: 'wc2', groupId: 'wg2', addedAt: t, updatedAt: t });

  assert.equal(await deleteWordGroup('wg2'), true);
  assert.equal(await db.wordGroups.get('wg2'), undefined);
  const snap = await db.trash.get('wg2');
  assert.equal(snap.kind, 'wordGroup', '词组也写回收站快照（P1-A 新增）');
  assert.equal(snap.data._groupLinks.length, 1, '快照带成员关联');

  assert.equal(await restoreFromTrash(snap), true);
  assert.equal((await db.wordGroups.get('wg2'))?.name, '核心短语', '词组恢复');
  assert.equal((await db.wordGroupLinks.where('groupId').equals('wg2').toArray()).length, 1, '成员关联恢复');
  assert.equal(await db.tombstones.get('wgl2'), undefined, '关联墓碑清除');
  await db.trash.delete('wg2'); await db.wordGroups.delete('wg2');
  await db.wordGroupLinks.where('groupId').equals('wg2').delete();
  await db.wordCards.delete('wc2');
});

// ---------- round15 P1：删除级联完整化 ----------

test('删卡：级联删的图谱边写墓碑 + 卡片向量删除（round15 P1，防对端回灌幽灵边/幽灵向量）', async () => {
  await resetTrash();
  const card = await createCard({ front: 'Q-级联删', back: 'A', subject: '计网' });
  await db.graphEdges.put({ id: 'edge-delcard', from: 'Q-级联删', to: 'X', fromCardId: card.id, toCardId: 'other', label: 'related', subject: '计网', kind: 'manual', updatedAt: REF, createdAt: REF });
  await db.embeddings.put({ id: 'emb-delcard', sourceType: 'card', sourceId: card.id, updatedAt: REF });

  await deleteCard(card.id);
  assert.equal(await db.graphEdges.get('edge-delcard'), undefined, '本端边已删');
  assert.equal((await db.tombstones.get('edge-delcard'))?.kind, 'graphEdge', '边写了墓碑（对端不回灌）');
  assert.equal(await db.embeddings.get('emb-delcard'), undefined, '卡片向量已删（RAG 无幽灵）');
  await db.tombstones.clear();
});

test('删词卡：级联删的 wordReviews 写墓碑（round15 P1，否则对端 idOnly 幂等反复回传孤儿）', async () => {
  await resetTrash();
  const { createWordCard, deleteWordCard, reviewWord } = await import('../src/word-repo.js');
  const w = await createWordCard({ kind: 'word', word: 'cascade', meaning: '级联' });
  await reviewWord(w.id, 2);
  const rev = await db.wordReviews.where('cardId').equals(w.id).first();
  assert.ok(rev, '有复习记录');

  await deleteWordCard(w.id);
  assert.equal(await db.wordReviews.where('cardId').equals(w.id).count(), 0, '本端复习记录已删');
  assert.equal((await db.tombstones.get(rev.id))?.kind, 'wordReview', '复习记录写了墓碑（对端不残留）');
  await db.trash.clear();
});

// ---------- round16 R16-1：记忆卡侧复习墓碑（word 侧 round15 已修，卡侧漏了同款） ----------

test('R16-1 删记忆卡：级联删的 reviews 写墓碑；恢复时清墓碑（防对端回灌孤儿复习）', async () => {
  await resetTrash();
  await db.tombstones.clear();
  const card = await createCard({ front: 'Q-R16-1', back: 'A', subject: '计组' });
  const t = REF;
  await db.reviews.put({ id: 'rv-r16-1', cardId: card.id, rating: 2, reviewedAt: t, updatedAt: t });
  await db.reviews.put({ id: 'rv-r16-2', cardId: card.id, rating: 0, reviewedAt: t, updatedAt: t });

  await deleteCard(card.id);
  assert.equal(await db.reviews.where('cardId').equals(card.id).count(), 0, '本端复习记录已删');
  assert.equal((await db.tombstones.get('rv-r16-1'))?.kind, 'review', '复习记录 1 写了 review 墓碑');
  assert.equal((await db.tombstones.get('rv-r16-2'))?.kind, 'review', '复习记录 2 写了 review 墓碑');

  // 恢复：复习记录与卡一起回来，墓碑清除（否则下次同步被自己的墓碑重新删掉）
  const snap = await db.trash.get(card.id);
  assert.equal(await restoreFromTrash(snap), true);
  assert.equal(await db.reviews.where('cardId').equals(card.id).count(), 2, '复习记录恢复');
  assert.equal(await db.tombstones.get('rv-r16-1'), undefined, '恢复后 review 墓碑清除');
  assert.equal(await db.tombstones.get('rv-r16-2'), undefined, '恢复后 review 墓碑清除');
  await db.trash.clear(); await db.tombstones.clear();
  await db.reviews.where('cardId').equals(card.id).delete();
  await db.cards.delete(card.id);
});
