// tests/card-filters.test.mjs —— round29：列表筛选口径（applyCardFilters）回归
// 背景（用户实测缺陷）：「错题集」模式的分支取完 weakCards 直接 return，
// 搜索词/科目/标签/AND-OR-NOT 全部被忽略 → 该模式下做「自定义科目 + 标签」混合检索
// 结果永远是全局薄弱卡（看着像检索坏了）。
// 修复后筛选逻辑收敛为纯函数 applyCardFilters，任何数据源（全量卡 / 薄弱卡）共用，
// 这里是它的行为契约：新增数据源必须复用它，不得再各自内联一份。
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCardFilters } from '../src/repo-core.js';

const card = (over = {}) => ({
  id: over.id || 'c' + Math.random().toString(36).slice(2, 8),
  front: '默认正面', back: '默认背面', subject: '计组', tags: [], source: '', mnemonic: '', ...over,
});

const SET = [
  card({ id: 'a', front: 'Cache 映射', back: '直接/全相联/组相联', subject: '计组', tags: ['cache', '重点'], source: '王道', mnemonic: '口诀A' }),
  card({ id: 'b', front: '页面置换', back: 'LRU FIFO', subject: '操作系统', tags: ['内存', '重点'], mnemonic: '口诀B' }),
  card({ id: 'c', front: '死锁条件', back: '互斥 占有且等待', subject: '操作系统', tags: ['进程'], source: '教材' }),
];
const ids = (r) => r.map((c) => c.id).sort();

test('applyCardFilters：无条件时原样返回', () => {
  assert.equal(applyCardFilters(SET), SET);
  assert.deepEqual(ids(applyCardFilters(SET, {})), ['a', 'b', 'c']);
});

test('applyCardFilters：科目精确匹配（两端 trim）', () => {
  assert.deepEqual(ids(applyCardFilters(SET, { subject: '操作系统' })), ['b', 'c']);
  assert.deepEqual(ids(applyCardFilters(SET, { subject: ' 操作系统 ' })), ['b', 'c']);
  assert.deepEqual(ids(applyCardFilters(SET, { subject: '不存在的科目' })), []);
});

test('applyCardFilters：搜索词覆盖六个字段且大小写不敏感', () => {
  assert.deepEqual(ids(applyCardFilters(SET, { q: 'LRU' })), ['b']);          // 大小写不敏感（back）
  assert.deepEqual(ids(applyCardFilters(SET, { q: '王道' })), ['a']);          // source
  assert.deepEqual(ids(applyCardFilters(SET, { q: '口诀B' })), ['b']);        // mnemonic
  assert.deepEqual(ids(applyCardFilters(SET, { q: '进程' })), ['c']);          // tags
  assert.deepEqual(ids(applyCardFilters(SET, { q: ' 死锁 ' })), ['c']);       // 搜索词先 trim
});

test('applyCardFilters：标签 AND / OR / NOT', () => {
  assert.deepEqual(ids(applyCardFilters(SET, { tags: ['重点'] })), ['a', 'b']);
  assert.deepEqual(ids(applyCardFilters(SET, { tags: ['重点', '内存'], logic: 'AND' })), ['b']);
  assert.deepEqual(ids(applyCardFilters(SET, { tags: ['cache', '进程'], logic: 'OR' })), ['a', 'c']);
  assert.deepEqual(ids(applyCardFilters(SET, { tags: ['重点'], logic: 'NOT' })), ['c']);
});

// 用户报告的场景：错题集里「自定义科目 + 标签」混合检索
test('applyCardFilters：科目 + 标签 混合检索（AND 取交集）', () => {
  assert.deepEqual(ids(applyCardFilters(SET, { subject: '操作系统', tags: ['重点'] })), ['b']);
  // 科目与标签冲突时应为空，而不是退回全量
  assert.deepEqual(ids(applyCardFilters(SET, { subject: '计组', tags: ['内存'] })), []);
});

test('applyCardFilters：搜索词 + 科目 + 标签 三者叠加', () => {
  assert.deepEqual(ids(applyCardFilters(SET, { q: '置换', subject: '操作系统', tags: ['重点'] })), ['b']);
  assert.deepEqual(ids(applyCardFilters(SET, { q: 'Cache', subject: '操作系统', tags: ['重点'] })), []);
});
