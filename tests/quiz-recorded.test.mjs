// tests/quiz-recorded.test.mjs —— AI 出题「记入复习」的持久防重（round82，修 round83 P3-2）
//
// 背景：`recorded` 只存在组件内存里，切页/刷新即丢 → 同一道题能重复点「记入复习」，
// 对同一张卡重复 review(2) 会把 FSRS 稳定性虚增（掌握度注水）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { quizRecordKey, isQuizRecorded, markQuizRecorded } from '../src/utils/quiz-recorded.js';

test('键：同一卡的同一道题稳定同键，题干空白差异不影响', () => {
  const a = quizRecordKey('c1', '停止-等待协议的窗口是几？');
  const b = quizRecordKey('c1', '停止-等待协议的窗口是几？');
  assert.equal(a, b);
  // 折叠的语义 = 「连续空白的**数量**归一为 1 个空格」：同一处空白 1 个 vs 多个才算同一题。
  assert.equal(quizRecordKey('c1', '停止-等待 协议的 窗口是几？'), quizRecordKey('c1', '停止-等待   协议的   窗口是几？'), '连续空白数量不同 → 同键');
  // 反例：空白**有无**不同 = 两个不同的题面（本用例初版拿这一对当"同题"，闸门当场判红——样本错，不是实现错）
  assert.notEqual(quizRecordKey('c1', '停止-等待 协议的窗口是几？'), quizRecordKey('c1', '停止-等待 协议的 窗口是几？'), '空白有无不同 → 必须不同键');
  assert.notEqual(quizRecordKey('c2', '停止-等待协议的窗口是几？'), a, '不同卡必须不同键');
});

test('记入后查询为真，且不误伤其它题/其它卡', () => {
  const cid = 'card-A';
  const q = '唯一的题干';
  assert.equal(isQuizRecorded(cid, q), false, '未记过时为假');
  markQuizRecorded(cid, q);
  assert.equal(isQuizRecorded(cid, q), true);
  assert.equal(isQuizRecorded(cid, '另一道题'), false);
  assert.equal(isQuizRecorded('card-B', q), false);
});

test('无 localStorage 环境（Node/隐私模式）退化为内存，不抛错', () => {
  const had = 'localStorage' in globalThis;
  const original = globalThis.localStorage;
  try {
    delete globalThis.localStorage;
    const cid = 'card-mem';
    const q = '内存兜底题';
    assert.doesNotThrow(() => markQuizRecorded(cid, q));
    assert.equal(isQuizRecorded(cid, q), true, '内存兜底也要生效');
  } finally {
    if (had) globalThis.localStorage = original;
  }
});
