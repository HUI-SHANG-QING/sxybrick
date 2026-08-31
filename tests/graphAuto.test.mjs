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
const { autoBuildGraph } = await import('../src/algorithms/graphAuto.js');

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

test('autoBuildGraph：前置边的标签是「前置」，不会停留在「同标签」', async () => {
  await db.graphEdges.clear(); await db.cards.clear();
  await db.cards.bulkPut([mkCard('z1', 'basic'), mkCard('z2', 'challenge')]);
  const r = await autoBuildGraph({});
  assert.equal(r.edges[0].label, '前置', `kind 已升级为 prereq，标签应同步，实际 ${r.edges[0].label}`);
});
