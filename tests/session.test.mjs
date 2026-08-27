// tests/session.test.mjs — 复习会话编排单测（交错练习 / 检索分级 / 间隔效应 / 错题反哺出题）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interleaveQueue,
  retrievalGrading,
  estimateRetrievalDifficulty,
  buildReviewSession,
  planMistakeQuiz,
} from '../src/algorithms/session.js';

const DAY = 86400000;

function card(id, subject, extra = {}) {
  return { id, subject: subject || '未分类', front: `卡${id}`, difficulty: 'basic', type: 'basic', level: 1, dueAt: Date.now(), fsrs: { s: 3, last: Date.now() }, ...extra };
}

// ---------- 交错练习 ----------
test('interleaveQueue：同科目卡不相邻（可满足时）', () => {
  const list = [
    card('a', '线代'), card('b', '线代'), card('c', '计组'),
    card('d', '计组'), card('e', '线代'), card('f', '计组'),
  ];
  const q = interleaveQueue(list);
  assert.equal(q.length, 6, '不打散数量');
  assert.deepEqual([...q].sort((x, y) => x.id.localeCompare(y.id)).map(x => x.id), ['a', 'b', 'c', 'd', 'e', 'f'], '集合不变');
  for (let i = 0; i < q.length - 1; i++) {
    assert.notEqual(q[i].subject, q[i + 1].subject, `相邻 ${q[i].id}/${q[i+1].id} 不应同科目`);
  }
});

test('interleaveQueue：单卡/空数组原样返回', () => {
  assert.deepEqual(interleaveQueue([card('a', '高数')]).map(x => x.id), ['a']);
  assert.deepEqual(interleaveQueue([]), []);
});

test('interleaveQueue：同源变式重罚（防相邻）', () => {
  const list = [
    card('a', '高数', { sourceCardId: 's1' }),
    card('b', '高数', { sourceCardId: 's1' }),
    card('c', '英语', {}),
  ];
  const q = interleaveQueue(list);
  // 变式 b 应与 c 相邻而非与 a 相邻
  const ia = q.findIndex(x => x.id === 'a'), ib = q.findIndex(x => x.id === 'b');
  assert.ok(Math.abs(ia - ib) >= 2, '同源变式应被隔开');
});

// ---------- 检索分级 ----------
test('retrievalGrading：评级/蒙对/检索强度/时长分档', () => {
  assert.equal(retrievalGrading({ rating: 0 }).level, 'failed');
  assert.equal(retrievalGrading({ rating: 1 }).level, 'hard');
  assert.equal(retrievalGrading({ rating: 2, guessed: true }).level, 'hard', '蒙对按艰难');
  assert.equal(retrievalGrading({ rating: 2, retrievalStrength: 'recognize' }).level, 'medium');
  assert.equal(retrievalGrading({ rating: 2, retrievalStrength: 'recall' }).level, 'medium');
  assert.equal(retrievalGrading({ rating: 2, retrievalStrength: 'generate' }).level, 'easy');
  assert.equal(retrievalGrading({ rating: 2, retrievalStrength: 'explain' }).level, 'easy');
  // 答对但耗时 10s → 降档
  const slow = retrievalGrading({ rating: 2, retrievalStrength: 'recall', responseMs: 10000 });
  assert.equal(slow.level, 'hard', '慢速回忆降为艰难');
  // 分数单调：流畅 > 一般 > 艰难 > 遗忘
  assert.ok(retrievalGrading({ rating: 2, retrievalStrength: 'explain' }).score > retrievalGrading({ rating: 2, retrievalStrength: 'recall' }).score);
  assert.equal(retrievalGrading({ rating: 0 }).score, 0);
});

test('estimateRetrievalDifficulty：平均提取流畅度，无历史为 null', () => {
  assert.equal(estimateRetrievalDifficulty(card('a', 'x'), []), null);
  const v = estimateRetrievalDifficulty(card('a', 'x'), [
    { rating: 0 }, { rating: 2, retrievalStrength: 'recall' },
  ]);
  assert.equal(v, Number(((0 + 0.8) / 2).toFixed(2)), '0 与 0.8 平均');
});

// ---------- 会话编排（测试间隔效应） ----------
test('buildReviewSession：考试窗口优先 + 难卡早重现 + 交错', () => {
  const now = Date.now();
  const examAt = now + 3 * DAY;
  const list = [
    card('weak', '计网', { fsrs: { s: 0.4, last: now - 5 * DAY }, dueAt: now + 10 * DAY }),
    card('strong', '线代', { fsrs: { s: 20, last: now }, dueAt: now + 1 * DAY }),
    card('mid', '计组', { fsrs: { s: 5, last: now - 2 * DAY }, dueAt: now + 2 * DAY }),
  ];
  const reviewsByCard = new Map([['weak', [{ rating: 0 }, { rating: 0 }]]]); // weak 检索最差
  const { queue, meta } = buildReviewSession(list, { examAt, reviewsByCard, interleave: true });
  assert.equal(meta.examUrgencyApplied, true);
  assert.equal(meta.graded, 1);
  assert.equal(queue[0].id, 'weak', '临考薄弱卡排最前');
  assert.equal(queue.length, 3);
});

test('buildReviewSession：无考试时不排序破坏、交错开关生效', () => {
  const list = [
    card('a', '高数'), card('b', '高数'), card('c', '英语'),
  ];
  const a = buildReviewSession(list, { interleave: false }).queue;
  assert.deepEqual(a.map(x => x.id), ['a', 'b', 'c'], '不交错 = 保持原序');
  const b = buildReviewSession(list, { interleave: true }).queue;
  assert.notEqual(b[0].subject, b[1].subject, '交错后相邻不同科目');
});

// ---------- 错题聚类反哺出题 ----------
test('planMistakeQuiz：前置卡先补 + 簇内错题 + 数量封顶', () => {
  const clusters = [
    { concept: 'TCP', size: 2, score: 0.8, cardIds: ['c2', 'c3'] },
    { concept: 'HTTP', size: 1, score: 0.7, cardIds: ['c5'] },
  ];
  const cards = [
    card('p1', '计网', { sourceCardId: '' }), // 前置卡（未掌握）
    card('c2', '计网'), card('c3', '计网'), card('c5', '计网'),
  ];
  const prereq = new Map([['c2', ['p1']]]);
  const r = planMistakeQuiz(clusters, cards, { limit: 2, count: 10, prereq, interleave: false });
  assert.equal(r.meta.prereqCount, 1);
  assert.equal(r.sequence[0].id, 'p1', '前置卡排最前');
  assert.ok(r.sequence.some(x => x.id === 'c2') && r.sequence.some(x => x.id === 'c3'));
  // 数量封顶
  const r2 = planMistakeQuiz(clusters, cards, { limit: 2, count: 2, prereq: new Map(), interleave: false });
  assert.equal(r2.sequence.length, 2);
});

test('planMistakeQuiz：交错时前置优先 + 科目打散；空簇退化', () => {
  const clusters = [{ concept: 'X', size: 2, score: 0.9, cardIds: ['a', 'b'] }];
  const cards = [card('p', '计组'), card('a', '计组'), card('b', '计组')];
  const r = planMistakeQuiz(clusters, cards, { prereq: new Map([['a', ['p']]]), interleave: true });
  assert.equal(r.sequence.length, 3);
  assert.equal(r.sequence[0].id, 'p', '交错下前置仍优先（同惩罚决胜键）');
  const empty = planMistakeQuiz([], cards, {});
  assert.deepEqual(empty.sequence, []);
  assert.ok(empty.meta.note, '空簇有提示');
});
