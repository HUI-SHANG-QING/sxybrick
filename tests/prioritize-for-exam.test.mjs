// tests/prioritize-for-exam.test.mjs — prioritizeForExam 纯函数单测
// D3（round11 审计）：原地写 c._examUrgency 破坏入参 → 改 spread 浅拷贝返回
// 覆盖：不突变入参 / 排序降序 / 字段透传 / 边界（空 / examAt=null）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeForExam } from '../src/algorithms/scheduling.js';

const T = Date.UTC(2026, 7, 27); // 固定"考试时间"
const NOW = T - 7 * 86400000;    // 「现在」= 考试前 7 天（让 proximity 生效）
const OLD = T - 60 * 86400000;   // 60 天前复习过（留存率极低 → risk 接近 1）
const RECENT = T - 1 * 86400000; // 1 天前复习过（留存率高 → risk 接近 0）

function card(id, { last = NOW - 86400000, s = 3 } = {}) {
  return {
    id,
    subject: '未分类',
    front: `卡${id}`,
    difficulty: 'basic',
    type: 'basic',
    level: 1,
    dueAt: NOW,
    fsrs: { s, d: 4, last, reps: 1 },
  };
}

// ---------- D3 修复回归：不再原地写入参 ----------

test('prioritizeForExam: 不再原地写 _examUrgency 到入参对象（修复 D3 原地突变）', () => {
  const a = card('a', { last: OLD });
  const b = card('b', { last: OLD });
  const c = card('c', { last: OLD });
  const before = { a: { ...a }, b: { ...b }, c: { ...c } };
  prioritizeForExam([a, b, c], T, { now: NOW });
  // 原数组元素不应出现 _examUrgency 新字段
  for (const x of [a, b, c]) {
    assert.equal('_examUrgency' in x, false, `入参 ${x.id} 被原地写入了 _examUrgency`);
    // 其他字段也不应被改
    assert.deepEqual(x, before[x.id], `入参 ${x.id} 整体被修改了`);
  }
});

test('prioritizeForExam: 返回值元素携带 _examUrgency 字段（供 buildReviewSession 消费）', () => {
  const out = prioritizeForExam([card('a', { last: OLD }), card('b', { last: RECENT })], T, { now: NOW });
  assert.equal(out.length, 2);
  for (const x of out) {
    assert.equal(typeof x._examUrgency, 'number', '_examUrgency 应为数字');
  }
});

test('prioritizeForExam: 返回值元素 spread 浅拷贝——id/fsrs/dueAt 等字段透传', () => {
  const a = card('a', { last: OLD });
  const out = prioritizeForExam([a], T, { now: NOW });
  assert.equal(out[0].id, a.id);
  assert.equal(out[0].dueAt, a.dueAt);
  assert.equal(out[0].fsrs.s, a.fsrs.s);
  // 浅拷贝语义：fsrs 引用与原对象共享（不深拷贝，避免无谓开销）
  assert.equal(out[0].fsrs, a.fsrs, 'fsrs 浅引用');
});

test('prioritizeForExam: 60 天前复习的卡（risk 接近 1）urgency 高于 1 天前复习的卡（risk 接近 0）', () => {
  const old = card('old', { last: OLD });
  const recent = card('recent', { last: RECENT });
  const out = prioritizeForExam([recent, old], T, { now: NOW });
  // 「60 天前复习」考试时留存率极低 → risk 接近 1 → urgency 高
  // 「1 天前复习」考试时留存率高 → risk ≈ 0 → urgency 仅靠 proximity
  assert.equal(out[0].id, 'old', '留存低的卡排第一');
  assert.equal(out[1].id, 'recent', '留存高的卡排第二');
  assert.ok(out[0]._examUrgency > out[1]._examUrgency, 'urgency 严格降序');
});

// ---------- 边界 ----------

test('prioritizeForExam: examAt=null 时直接返回原数组（短路）', () => {
  const a = card('a', { last: OLD });
  const arr = [a];
  const out = prioritizeForExam(arr, null);
  assert.equal(out, arr, 'null examAt → 原引用返回');
  assert.equal('_examUrgency' in a, false, '不写字段');
});

test('prioritizeForExam: 空数组不报错', () => {
  const out = prioritizeForExam([], T, { now: NOW });
  assert.deepEqual(out, []);
});
