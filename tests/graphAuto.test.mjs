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
