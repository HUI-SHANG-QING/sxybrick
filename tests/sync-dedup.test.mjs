// tests/sync-dedup.test.mjs — 跨设备导入卡片内容去重（P0 修复）单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeIncomingCards, remapCardRefs, CARD_REF_FIELDS, ARRAY_REF_FIELDS, JSON_REF_FIELDS, NESTED_REF_FIELDS } from '../src/sync-dedup.js';

function card(id, front, back, subject) {
  return { id, front, back, subject: subject || '计组', ease: 2.5, level: 3, intervalDays: 10, dueAt: Date.now() };
}

// ---------- P0 核心：同 id 卡必须放行，不被内容去重丢弃 ----------

test('同 id 卡（仅 SRS 字段不同）被放行，交后续字段级合并', () => {
  const local = card('C1', 'Q1', 'A1'); // 本地：刚建，未复习
  const incoming = card('C1', 'Q1', 'A1'); // 远端：同一张，已复习（SRS 变）
  incoming.ease = 1.8; incoming.level = 5; incoming.intervalDays = 40;
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 0, '同 id 不应计入重复');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'C1');
  assert.equal(kept[0].ease, 1.8, '放行后由 mergeRows 合并 SRS');
});

test('异 id 但内容雷同 → 视为真重复跳过', () => {
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C2', 'Q1', 'A1'); // 内容完全相同但不同 id
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 1);
  assert.equal(kept.length, 0, '内容重复卡应被跳过，避免重复建卡');
});

test('异 id 且内容不同 → 保留导入', () => {
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C2', 'Q2', 'A2');
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'C2');
});

test('同 id 优先于内容去重：即便内容也雷同也放行', () => {
  // 极端：远端把卡内容也改了，但 id 仍是同一张 —— 必须放行（按 id 合并，而非按内容丢弃）
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C1', 'Q1-modified', 'A1-modified');
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'C1');
});

test('批次内重复（异 id 同内容）只保留首个', () => {
  const local = card('C1', 'Q1', 'A1');
  const baseById = new Map([[local.id, local]]);
  const incoming = [card('C2', 'Q2', 'A2'), card('C3', 'Q2', 'A2'), card('C4', 'Q3', 'A3')];
  const { kept, duplicated } = dedupeIncomingCards(incoming, baseById, [local]);
  assert.equal(duplicated, 1, 'C3 与 C2 内容重复');
  assert.deepEqual(kept.map(c => c.id), ['C2', 'C4']);
});

test('空输入安全', () => {
  const { kept, duplicated } = dedupeIncomingCards([], new Map(), []);
  assert.equal(kept.length, 0);
  assert.equal(duplicated, 0);
});

// ---------- round12：被跳过卡的关联数据必须重定向到保留卡（避免孤儿行） ----------


test('idRemap：异 id 同内容被跳过的卡映射到保留 id', () => {
  // 本地已有一张 C1(Q1/A1)；远端备份里 C2 与 C1 内容雷同 → 跳过，
  // 但 C2 关联了一张复习记录 / 一条图谱边，这些引用必须重定向到 C1。
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C2', 'Q1', 'A1'); // 内容雷同，异 id
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated, idRemap } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 1);
  assert.equal(kept.length, 0, 'C2 作为真重复被跳过');
  assert.equal(idRemap.size, 1);
  assert.equal(idRemap.get('C2'), 'C1', '跳过 id → 保留 id 的重定向映射');
});

test('idRemap：同 id 卡不产生重定向（SRS 合并路径）', () => {
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C1', 'Q1', 'A1');
  const baseById = new Map([[local.id, local]]);
  const { idRemap } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(idRemap.size, 0, '同 id 放行不应产生任何重定向');
});

test('导入前关联引用重定向：标量+数组+JSON+嵌套字段的卡 id 被改写', () => {
  // 直接测 sync-dedup.js 的 remapCardRefs（与 src/sync.js importBackup 0b 步同一实现，
  // BUG-04 收敛后不再维护内联副本）。CARD_REF_FIELDS 含 sourceCardId——
  // 变式卡链引用字段，round17 R17-8 补入，漏掉会致变式血缘统计永久断裂。
  const idRemap = new Map([['C2', 'C1']]);
  const backup = {
    cards: [{ id: 'C1', front: 'Q1', back: 'A1' }, { id: 'C9', front: 'Q9', back: 'A9', sourceCardId: 'C2' }],
    reviews: [{ id: 'R1', cardId: 'C2', rating: 4 }], // 孤儿：本指向被跳过的 C2
    graphEdges: [{ id: 'E1', fromCardId: 'C2', toCardId: 'C3', label: '相关' }],
    cardGroupLinks: [{ id: 'L1', cardId: 'C2', groupId: 'G1' }],
    embeddings: [
      { id: 'V1', sourceType: 'card', sourceId: 'C2' }, // N-6：向量索引引用字段
      { id: 'V2', sourceType: 'doc', sourceId: 'DOC1' }, // 非卡片源不受影响
    ],
    notes: [{ id: 'N1', linkedCardIds: ['C2', 'C3'], title: '笔记' }], // round15 P2：数组引用
    plans: [{ id: 'P1', linkedCardIds: ['C2'], title: '计划' }],
    analysisSessions: [{ id: 'S1', cardIds: '["C2","C3"]' }],           // JSON 串数组
    exams: [{ id: 'X1', questions: [{ front: 'a', cardId: 'C2' }, { front: 'b' }] }], // 嵌套
    meta: { version: 1 }, // 非数组键原样保留
  };
  const out = remapCardRefs(backup, idRemap);
  assert.equal(out.reviews[0].cardId, 'C1', '复习记录重定向到保留卡');
  assert.equal(out.graphEdges[0].fromCardId, 'C1', '图谱边起点重定向到保留卡');
  assert.equal(out.graphEdges[0].toCardId, 'C3', '无关引用保持不变');
  assert.equal(out.cardGroupLinks[0].cardId, 'C1', '卡组关联重定向到保留卡');
  assert.equal(out.embeddings[0].sourceId, 'C1', 'embeddings.sourceId 重定向到保留卡（N-6）');
  assert.equal(out.embeddings[1].sourceId, 'DOC1', '非卡片源 sourceId 不受影响');
  assert.deepEqual(out.notes[0].linkedCardIds, ['C1', 'C3'], 'notes.linkedCardIds 数组重定向（round15 P2）');
  assert.deepEqual(out.plans[0].linkedCardIds, ['C1'], 'plans.linkedCardIds 数组重定向');
  assert.equal(out.analysisSessions[0].cardIds, '["C1","C3"]', 'analysisSessions.cardIds JSON 串重定向');
  assert.equal(out.exams[0].questions[0].cardId, 'C1', 'exams.questions[].cardId 嵌套重定向');
  assert.equal(out.exams[0].questions[1].cardId, undefined, '无 cardId 的题目不受影响');
  assert.equal(out.cards[0].id, 'C1', 'cards 表保留卡的自身 id 绝不被改写');
  assert.equal(out.cards[1].sourceCardId, 'C1', 'cards 表 sourceCardId 单独重定向（R17-8）');
  assert.deepEqual(out.meta, { version: 1 }, '非数组键原样保留');
});

test('remapCardRefs：注册表字段覆盖已知卡片引用字段（BUG-04 防漂移）', () => {
  // 锁定当前正确状态：任何一个被历史 bug 证明过的引用字段都不能从注册表消失
  assert.ok(CARD_REF_FIELDS.includes('sourceId'), 'N-6 曾漏掉的 sourceId 必须在');
  assert.ok(CARD_REF_FIELDS.includes('sourceCardId'), 'R17-8 补入的 sourceCardId 必须在');
  assert.ok(CARD_REF_FIELDS.includes('fromCardId') && CARD_REF_FIELDS.includes('toCardId'), '图谱边字段必须在');
  assert.ok(ARRAY_REF_FIELDS.includes('linkedCardIds'), '数组引用 linkedCardIds 必须在');
  assert.ok(JSON_REF_FIELDS.includes('cardIds'), 'JSON 引用 cardIds 必须在');
  assert.ok(NESTED_REF_FIELDS.includes('questions'), '嵌套引用 questions 必须在');
  // 四类清单不得相互重叠（同一字段只能归一类，避免重复改写）
  const all = [...CARD_REF_FIELDS, ...ARRAY_REF_FIELDS, ...JSON_REF_FIELDS, ...NESTED_REF_FIELDS];
  assert.equal(new Set(all).size, all.length, '四类字段清单不得有交集');
});
