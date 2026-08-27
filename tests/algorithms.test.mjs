// tests/algorithms.test.mjs — 智能层算法单测（前测 / 考试窗口 / 错题聚类）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInitialStability, initialStabilityForCard } from '../src/algorithms/pretest.js';
import { isRestDay, nextWorkDay, examWindowUrgency, compressIntoWindow, prioritizeForExam } from '../src/algorithms/scheduling.js';
import { attributeMistakes, tokenize } from '../src/algorithms/mistakeAttribution.js';

const DAY = 86400000;

// ---------- 前测：初始稳定度 ----------
test('estimateInitialStability 单调且受科目/难度调制', () => {
  const s0 = estimateInitialStability({ familiarity: 0, subject: '线代' });
  const s5 = estimateInitialStability({ familiarity: 5, subject: '线代' });
  assert.ok(s5 > s0, '熟悉度越高初始 S 越大');
  assert.ok(s0 >= 0.5, '下界 0.5 天');
  // 难的科目同等自评分 S 更低
  const easy = estimateInitialStability({ familiarity: 3, subject: '随便' });
  const hard = estimateInitialStability({ familiarity: 3, subject: '数学' });
  assert.ok(hard < easy, '数学科目打折');
  // 挑战难度比基础难度低
  const b = estimateInitialStability({ familiarity: 3, difficulty: 'basic' });
  const c = estimateInitialStability({ familiarity: 3, difficulty: 'challenge' });
  assert.ok(c < b);
});

test('initialStabilityForCard：仅无复习历史且有前测科目时生效', () => {
  const map = { 线代: 4.2 };
  assert.equal(initialStabilityForCard({ subject: '高数' }, map), null, '无前测科目 → null');
  assert.equal(initialStabilityForCard({ subject: '线代', fsrs: { reps: 3 } }, map), null, '已有复习历史 → null');
  const s = initialStabilityForCard({ subject: '线代', difficulty: 'basic' }, map);
  assert.ok(s >= 0.5 && s > 4, '基础难度上浮后仍基于 4.2');
});

// ---------- 考试窗口 / 节假日 ----------
test('isRestDay / nextWorkDay：周末与指定日期', () => {
  // 2026-08-29 是周六
  const sat = new Date(2026, 7, 29, 10, 0).getTime();
  const sun = new Date(2026, 7, 30, 10, 0).getTime();
  const mon = new Date(2026, 7, 31, 10, 0).getTime();
  const cfg = { weekdays: [0, 6] };
  assert.ok(isRestDay(sat, cfg) && isRestDay(sun, cfg));
  assert.ok(!isRestDay(mon, cfg));
  assert.equal(nextWorkDay(sat, cfg), mon, '周六顺延到周一');
  assert.equal(nextWorkDay(mon, cfg), mon, '周一不动');
  assert.ok(isRestDay(mon, { dates: ['2026-08-31'] }), '指定日期休息');
});

test('examWindowUrgency：临近+低留存 → 高紧迫', () => {
  const now = Date.now();
  const examAt = now + 3 * DAY;
  const weak = { fsrs: { s: 0.5, last: now - 5 * DAY }, dueAt: now + 20 * DAY };
  const strong = { fsrs: { s: 30, last: now }, dueAt: now + 10 * DAY };
  const u1 = examWindowUrgency(weak, examAt, { now });
  const u2 = examWindowUrgency(strong, examAt, { now });
  assert.ok(u1.urgency > u2.urgency, '薄弱卡紧迫度更高');
  assert.ok(u1.urgency > 0.5, '严重薄弱卡紧迫度显著');
  assert.ok(u1.atExamR < u2.atExamR, '薄弱卡考时留存更低');
});

test('compressIntoWindow：考后 due 软压缩到考前', () => {
  const now = Date.now();
  const examAt = now + 10 * DAY;
  const late = now + 30 * DAY;
  const moved = compressIntoWindow(late, examAt, { now });
  assert.ok(moved <= examAt - 0.4 * DAY, '压缩进考前窗口');
  assert.equal(compressIntoWindow(now + 5 * DAY, examAt, { now }), now + 5 * DAY, '考前的 due 不动');
});

test('prioritizeForExam：按紧迫度排序', () => {
  const now = Date.now();
  const examAt = now + 5 * DAY;
  const list = [
    { id: 'a', fsrs: { s: 20, last: now } },
    { id: 'b', fsrs: { s: 0.4, last: now - 7 * DAY } },
    { id: 'c', fsrs: { s: 5, last: now - 2 * DAY } },
  ];
  const sorted = prioritizeForExam(list, examAt, { now });
  assert.equal(sorted[0].id, 'b', '最薄弱排最前');
  assert.ok(sorted.every(x => typeof x._examUrgency === 'number'));
});

// ---------- 错题聚类 ----------
test('tokenize：英文词 + 中文 bigram', () => {
  const t = tokenize('TCP三次握手 Handshake');
  assert.ok(t.includes('tcp') && t.includes('handshake'));
  assert.ok(t.includes('三次') && t.includes('次握') && t.includes('握手'), '中文 bigram');
});

test('attributeMistakes：同类错题聚成一簇', () => {
  const cards = [
    { id: '1', front: 'TCP三次握手的第二步是什么', back: 'SYN+ACK', subject: '计网', tags: ['TCP'] },
    { id: '2', front: 'TCP三次握手完成进入什么状态', back: 'ESTABLISHED', subject: '计网', tags: ['TCP'] },
    { id: '3', front: 'HTTP默认端口号是多少', back: '80', subject: '计网', tags: ['HTTP'] },
  ];
  const clusters = attributeMistakes(cards);
  assert.ok(clusters.length >= 1);
  const tcpCluster = clusters.find(c => c.cardIds.includes('1') && c.cardIds.includes('2'));
  assert.ok(tcpCluster, '两张 TCP 卡应聚在一起');
  assert.ok(tcpCluster.size === 2);
  assert.ok(clusters.every(c => c.size >= 1 && c.score > 0));
});

test('attributeMistakes：单卡退化为单例簇', () => {
  const clusters = attributeMistakes([{ id: 'x', front: '孤卡', subject: '线代' }]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].cardIds[0], 'x');
});
