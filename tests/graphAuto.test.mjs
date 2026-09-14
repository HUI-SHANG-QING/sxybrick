// 前驱多层回溯纯函数测试（无 Dexie、无网络、不挂）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrereqPlan } from '../src/algorithms/prereq.js';

const edge = (from, to, kind = 'prereq') => ({ from, to, kind });

test('单层前驱：直接前置未掌握应被收集', () => {
  const edges = [edge('B', 'A')]; // B 是 A 的前置
  const { prereqCardIds } = resolvePrereqPlan(edges, new Set(), 'A');
  assert.deepEqual(prereqCardIds.sort(), ['B']);
});

test('多层前驱：未掌握前置的前置也应被收集（N4 核心修复）', () => {
  // A←B←C 三层链，B、C 均未掌握
  const edges = [edge('B', 'A'), edge('C', 'B')];
  const { prereqCardIds } = resolvePrereqPlan(edges, new Set(), 'A');
  assert.deepEqual(prereqCardIds.sort(), ['B', 'C']);
});

test('已掌握的前置不进练习集，但从它继续向上回溯', () => {
  // A←B（B未掌握）←C（C已掌握）；C 还有未掌握前置 D → D 应被收集
  const edges = [edge('B', 'A'), edge('C', 'B'), edge('D', 'C')];
  const mastered = new Set(['C']);
  const { prereqCardIds } = resolvePrereqPlan(edges, mastered, 'A');
  assert.deepEqual(prereqCardIds.sort(), ['B', 'D']);
});

test('环路不致死循环', () => {
  const edges = [edge('B', 'A'), edge('A', 'B')]; // A↔B 互转
  const { prereqCardIds } = resolvePrereqPlan(edges, new Set(), 'A');
  assert.deepEqual(prereqCardIds.sort(), ['B']);
});

test('related 保持单层，且不影响 prereq 收集', () => {
  const edges = [edge('B', 'A', 'related'), edge('C', 'A', 'prereq')];
  const { prereqCardIds, relatedCardIds } = resolvePrereqPlan(edges, new Set(), 'A');
  assert.deepEqual(prereqCardIds, ['C']);
  assert.deepEqual(relatedCardIds, ['B']);
});

test('空边表安全返回空', () => {
  const { prereqCardIds, relatedCardIds } = resolvePrereqPlan([], new Set(), 'A');
  assert.deepEqual(prereqCardIds, []);
  assert.deepEqual(relatedCardIds, []);
});

test('目标卡自身不会被当作前驱加入', () => {
  const edges = [edge('A', 'A')]; // 自环
  const { prereqCardIds } = resolvePrereqPlan(edges, new Set(), 'A');
  assert.deepEqual(prereqCardIds, []);
});

// ---------------------------------------------------------------------------
// autoBuildGraph：同一对卡片的边唯一性（需要 fake-indexeddb，故单独起一段）
// ---------------------------------------------------------------------------
const dbMod = await import('fake-indexeddb/auto');
const { db } = await import('../src/db.js');
const { autoBuildGraph, pruneDeadEdges } = await import('../src/algorithms/graphAuto.js');

const mkCard = (id, difficulty) => ({
  id, front: 'F-' + id, back: 'B-' + id, subject: '计组', tags: ['t1'], type: 'basic',
  difficulty, createdAt: Date.now(), updatedAt: Date.now(),
  ease: 2.5, level: 0, intervalDays: 0, dueAt: Date.now(), reviewedAt: 0,
});

test('autoBuildGraph：同一对卡片只落库一条边，id 与难度顺序无关', async () => {
  // 同序：id 字典序 a<b，难度 basic<challenge（低难度在前 → 前置方向 a→b）
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([mkCard('aaa', 'basic'), mkCard('bbb', 'challenge')]);
  const r1 = await autoBuildGraph({});

  // 反序：id 字典序仍是 a<b，但难度 bbb(basic) < aaa(challenge) → 前置方向 b→a
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([mkCard('aaa', 'challenge'), mkCard('bbb', 'basic')]);
  const r2 = await autoBuildGraph({});

  // 旧实现：反序会写出 auto-aaa-bbb 与 auto-bbb-aaa 两条（同对卡重复连线，
  // 各吃掉 maxEdgesPerCard 一个名额）；同序则两条同 id、bulkPut 静默覆盖丢一条。
  assert.equal(r1.edges.length, 1, `同序应只有 1 条边，实际 ${r1.edges.length}`);
  assert.equal(r2.edges.length, 1, `反序应只有 1 条边，实际 ${r2.edges.length}`);
  assert.equal(r1.edges[0].id, r2.edges[0].id, '边 id 必须与方向无关（否则跨设备会各写一条）');

  // 库里的行数要和返回值一致（旧实现返回 2 条、库里只剩 1 条）
  const inDb1 = await db.graphEdges.toArray();
  assert.equal(inDb1.length, 1, `库里应只有 1 行，实际 ${inDb1.length}`);
});

test('autoBuildGraph：stats.prereq / related 真实计数（不能恒为 0）', async () => {
  await db.graphEdges.clear(); await db.cards.clear();
  // 两卡同科目同标签 + 难度不同 → 先建 related（同标签），再升级为 prereq（前置）
  await db.cards.bulkPut([mkCard('x1', 'basic'), mkCard('x2', 'challenge')]);
  const r = await autoBuildGraph({});

  // 旧实现按 rows 的 kind（恒为 'auto'，派生边标记）过滤 'prereq'/'related' → 永远是 0
  assert.equal(r.stats.prereq, 1, `应统计出 1 条前置边，实际 ${r.stats.prereq}`);
  assert.equal(r.stats.related, 0, '该边已升级为 prereq，不应同时计入 related');
  assert.equal(r.stats.prereq + r.stats.related, r.edges.length, '统计数必须与落库边数一致');

  // 纯 related 场景：两卡同标签但难度相同（不产生前置）
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([mkCard('y1', 'basic'), mkCard('y2', 'basic')]);
  const r2 = await autoBuildGraph({});
  assert.equal(r2.stats.related, 1, `应统计出 1 条相关边，实际 ${r2.stats.related}`);
  assert.equal(r2.stats.prereq, 0);
});

test('autoBuildGraph：边标签落库语义 code 而非中文（round11b N-1）', async () => {
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([mkCard('z1', 'basic'), mkCard('z2', 'challenge')]);
  const r = await autoBuildGraph({});
  // kind 升级为 prereq 时 label 必须同步（旧实现停留在「同标签」），且是 code 不是中文
  assert.equal(r.edges[0].labelKind, 'prereq', `labelKind 应为 prereq，实际 ${r.edges[0].labelKind}`);
  assert.equal(r.edges[0].label, 'prereq', `label 应为语义 code，实际 ${r.edges[0].label}`);
  // 核心防线：数据层落库内容不得含中文（已落库的旧边换语言不会变，只能等重建）
  for (const e of r.edges) {
    assert.ok(!/[\u4e00-\u9fa5]/.test(e.label || ''), `边标签落库了中文：${e.label}`);
  }
  // 落库后从 db 读回来同样不得有中文
  const inDb = await db.graphEdges.toArray();
  for (const e of inDb) {
    assert.ok(e.labelKind, `落库边必须有 labelKind（视图靠它判断是否需要翻译）：${e.id}`);
    assert.ok(!/[\u4e00-\u9fa5]/.test(e.label || ''), `库里落了中文标签：${e.label}`);
  }
});

// ---------------------------------------------------------------------------
// pruneDeadEdges：死边清理判定（2026-09-14 审计 P1）
// 旧实现用 `fromCardId || from` 校验"卡片存在性"→ AI 建的知识点文本边
// （fromCardId 为空、from 是人类可读知识点名）被整批误判死边删除并写墓碑。
// ---------------------------------------------------------------------------
test('pruneDeadEdges：AI 知识点文本边（无 cardId）不误删', async () => {
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([{ id: 'card-1', front: 'F', back: 'B' }]);
  // link_cards 建边：按卡片正面解析不到 id → fromCardId 空、from/to 是知识点名
  await db.graphEdges.bulkPut([
    { id: 'e-ai', from: '死锁', to: '银行家算法', label: '前置', fromCardId: '', toCardId: '', kind: 'manual' },
  ]);
  const r = await pruneDeadEdges();
  assert.equal(r.removed, 0, '纯文本知识点边不是死边，不得误删');
  assert.equal((await db.graphEdges.toArray()).length, 1, '边应保留');
});

test('pruneDeadEdges：声称引用已删卡片的边才清理 + 写墓碑', async () => {
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([{ id: 'alive-1', front: 'F', back: 'B' }]);
  await db.tombstones.clear();
  await db.graphEdges.bulkPut([
    { id: 'e-dead', from: 'GONE', to: 'alive-1', label: '相关', fromCardId: 'ghost-9', toCardId: 'alive-1', kind: 'manual' },
    { id: 'e-live', from: 'F', to: 'alive-1', label: '相关', fromCardId: 'alive-1', toCardId: 'alive-1', kind: 'manual' },
  ]);
  const r = await pruneDeadEdges();
  assert.equal(r.removed, 1, '只有引用幽灵卡的那条死');
  assert.ok(r.ids.includes('e-dead'));
  assert.equal((await db.graphEdges.toArray()).length, 1, '有效边保留');
  const tombstones = await db.tombstones.toArray();
  assert.ok(tombstones.some(t => t.id === 'e-dead' && t.kind === 'graphEdge'), '手动边被删应写墓碑');
});

test('pruneDeadEdges：历史裸 UUID 脏边清理；资料边豁免', async () => {
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([{ id: 'deadbeef-1234-5678-9abc-def012345678', front: 'F', back: 'B' }]);
  const deadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 不存在的卡 id
  await db.graphEdges.bulkPut([
    { id: 'e-raw', from: deadId, to: 'alive-label', kind: 'manual' }, // 历史裸 UUID 脏边
    { id: 'e-doc', from: '📄 操作系统笔记.pdf', to: 'F', docId: 'doc-1', type: 'doc-card', kind: 'manual' },
  ]);
  const r = await pruneDeadEdges();
  assert.equal(r.removed, 1, '只清裸 UUID 脏边');
  assert.ok(r.ids.includes('e-raw'));
  const remain = await db.graphEdges.toArray();
  assert.ok(remain.some(e => e.id === 'e-doc'), '资料边豁免保留');
  assert.equal(remain.length, 1, '另一条是 e-doc');
});
