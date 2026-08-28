// 测试：每日规划解析器（纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
const {
  splitTasks, extractQuantity, inferType, inferQuadrant, inferSubject,
  parsePlan, parsePlanWithSummary,
} = await import('../src/utils/plan-parser.js');

// ──────────────── splitTasks ────────────────

test('splitTasks：按换行/分号/句号/顿号切分', () => {
  assert.deepEqual(splitTasks('复习30张卡片；番茄25分钟\n看线代讲义'), ['复习30张卡片', '番茄25分钟', '看线代讲义']);
  assert.deepEqual(splitTasks('a、b、c'), ['a', 'b', 'c']);
  assert.deepEqual(splitTasks(''), []);
  assert.deepEqual(splitTasks(null), []);
});

// ──────────────── extractQuantity ────────────────

test('extractQuantity：张/分钟/小时/章', () => {
  assert.deepEqual(extractQuantity('复习 30 张卡片'), { targetCount: 30, estimatedMinutes: null });
  assert.deepEqual(extractQuantity('番茄钟 25 分钟'), { targetCount: null, estimatedMinutes: 25 });
  assert.deepEqual(extractQuantity('专注 1 小时'), { targetCount: null, estimatedMinutes: 60 });
  assert.deepEqual(extractQuantity('看 2 章讲义'), { targetCount: 2, estimatedMinutes: null });
});

test('extractQuantity：无数量', () => {
  assert.deepEqual(extractQuantity('随便看看'), { targetCount: null, estimatedMinutes: null });
});

// ──────────────── inferType ────────────────

test('inferType：动作分类', () => {
  assert.equal(inferType('复习 30 张卡片'), 'review');
  assert.equal(inferType('番茄钟 25 分钟'), 'pomodoro');
  assert.equal(inferType('看线代讲义'), 'doc');
  assert.equal(inferType('做 20 道题'), 'exam');
  assert.equal(inferType('整理笔记'), 'note');
  assert.equal(inferType('随便干点啥'), 'other');
});

// ──────────────── inferQuadrant ────────────────

test('inferQuadrant：四象限推断', () => {
  // Q1：重要+紧急
  assert.deepEqual(inferQuadrant('复习，最优先'), { important: true, urgent: true, quadrant: 'Q1' });
  // Q2：重要不紧急
  assert.deepEqual(inferQuadrant('看讲义，重要'), { important: true, urgent: false, quadrant: 'Q2' });
  // Q3：紧急不重要
  assert.deepEqual(inferQuadrant('回消息，紧急'), { important: false, urgent: true, quadrant: 'Q3' });
  // Q4：默认
  assert.deepEqual(inferQuadrant('刷会手机'), { important: false, urgent: false, quadrant: 'Q4' });
});

// ──────────────── inferSubject ────────────────

test('inferSubject：科目识别', () => {
  assert.equal(inferSubject('复习 Cache 替换'), '计组');
  assert.equal(inferSubject('特征值 特征向量'), '线代');
  assert.equal(inferSubject('词法分析 LL'), '编译原理');
  assert.equal(inferSubject('背英语单词'), '英语');
  assert.equal(inferSubject('随便看看'), '');
});

// ──────────────── parsePlan ────────────────

test('parsePlan：完整口述解析', () => {
  const tasks = parsePlan('复习 30 张卡片，最优先；番茄钟 25 分钟；看线代第三章讲义，重要');
  assert.equal(tasks.length, 3);

  assert.equal(tasks[0].type, 'review');
  assert.equal(tasks[0].quadrant, 'Q1');
  assert.equal(tasks[0].targetCount, 30);
  // "复习 30 张卡片" 无明确科目词（卡片是动作词不是科目），subject 为空
  assert.equal(tasks[0].subject, '');

  assert.equal(tasks[1].type, 'pomodoro');
  assert.equal(tasks[1].estimatedMinutes, 25);

  assert.equal(tasks[2].type, 'doc');
  assert.equal(tasks[2].quadrant, 'Q2');
  assert.equal(tasks[2].subject, '线代');
});

test('parsePlan：多行混合', () => {
  const tasks = parsePlan(
    '复习 20 张卡片（最优先）\n做 10 道题（重要）\n整理笔记\n看英语单词（紧急）'
  );
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].quadrant, 'Q1');
  assert.equal(tasks[1].type, 'exam');
  assert.equal(tasks[2].type, 'note');
  assert.equal(tasks[3].quadrant, 'Q3');
});

// ──────────────── parsePlanWithSummary ────────────────

test('parsePlanWithSummary：汇总统计', () => {
  const { tasks, summary } = parsePlanWithSummary('复习 30 张卡片，最优先；番茄 25 分钟；看线代讲义，重要；刷手机');
  assert.equal(tasks.length, 4);
  assert.equal(summary.total, 4);
  assert.equal(summary.byQuadrant.Q1, 1);
  assert.equal(summary.byQuadrant.Q2, 1);
  // 番茄(无优先级) + 刷手机(无优先级) = 2 个 Q4
  assert.equal(summary.byQuadrant.Q4, 2);
  assert.ok(summary.byType.review >= 1);
  assert.equal(summary.estimatedTotalMinutes, 25);
});

// 黄金路径：口述 → 任务 → 四象限 → 打卡数据
test('黄金路径：口述 → 解析 → 四象限分布', () => {
  const input = '复习 30 张卡片（最优先）\n看线代讲义（重要）\n回消息（紧急）\n刷手机';
  const { tasks, summary } = parsePlanWithSummary(input);
  // 四象限各 1 个
  assert.equal(summary.byQuadrant.Q1, 1);
  assert.equal(summary.byQuadrant.Q2, 1);
  assert.equal(summary.byQuadrant.Q3, 1);
  assert.equal(summary.byQuadrant.Q4, 1);
  // 类型
  assert.equal(tasks[0].type, 'review');
  assert.equal(tasks[1].type, 'doc');
  assert.equal(tasks[2].type, 'other'); // "回消息" 无动作关键词
});
