// 测试：每日规划/打卡 黄金路径（fake-indexeddb 集成）
//   口述 → 解析 → 入库 → 任务打卡 → 跨模块真实数据 → 删除
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';
import {
  createDailyPlan, listDailyPlan, listDailyPlans, listDailyPlanSummary,
  updateDailyTask, checkinDailyTask, deleteDailyTask, deleteDailyPlan,
  getDailyReality,
} from '../src/repo.js';

after(async () => { try { await db.close(); } catch {} });

async function clearDaily() {
  await db.dailyPlans.clear();
  await db.dailyTasks.clear();
  await db.reviews.clear();
  await db.pomoSessions.clear();
  await db.docFiles.clear();
}

test('黄金路径：口述 → 解析 → 入库 → 打卡 → 对比 → 删除', async () => {
  await clearDaily();

  // 1) 创建每日计划（口述文本）
  const { plan, tasks } = await createDailyPlan({
    rawInput: '复习 30 张卡片，最优先；番茄钟 25 分钟；看线代讲义，重要',
  });
  assert.ok(plan.id);
  assert.equal(tasks.length, 3);

  // 2) 解析结果正确
  const reviewTask = tasks.find(t => t.type === 'review');
  const pomodoroTask = tasks.find(t => t.type === 'pomodoro');
  const docTask = tasks.find(t => t.type === 'doc');
  assert.equal(reviewTask.quadrant, 'Q1');
  assert.equal(reviewTask.targetCount, 30);
  assert.equal(pomodoroTask.estimatedMinutes, 25);
  assert.equal(docTask.quadrant, 'Q2');

  // 3) 列出今日计划
  const listed = await listDailyPlan();
  assert.ok(listed);
  assert.equal(listed.plan.id, plan.id);
  assert.equal(listed.tasks.length, 3);

  // 4) 打卡：完成任务
  await checkinDailyTask(reviewTask.id, 'done', '');
  const afterCheckin = await db.dailyTasks.get(reviewTask.id);
  assert.equal(afterCheckin.status, 'done');
  assert.ok(afterCheckin.completedAt);

  // 5) 中途调整：切换象限
  await updateDailyTask(docTask.id, { quadrant: 'Q1', important: true, urgent: true });
  const docAfter = await db.dailyTasks.get(docTask.id);
  assert.equal(docAfter.quadrant, 'Q1');

  // 6) 跨模块真实数据（模拟当天 reviews/pomoSessions）
  const today = new Date();
  const dayStart = new Date(today.toDateString()).getTime();
  await db.reviews.put({ id: 'r1', cardId: 'c1', reviewedAt: dayStart + 1000 });
  await db.pomoSessions.put({ id: 'p1', startedAt: dayStart + 2000, durationMs: 25 * 60000 });
  const reality = await getDailyReality();
  assert.equal(reality.reviewsToday, 1);
  assert.equal(reality.pomodoroMinutes, 25);

  // 7) 历史计划列表
  const history = await listDailyPlans();
  assert.ok(history.length >= 1);

  // 8) 删除任务 + 删除整天
  await deleteDailyTask(pomodoroTask.id);
  assert.equal(await db.dailyTasks.get(pomodoroTask.id), undefined);
  await deleteDailyPlan(plan.id);
  assert.equal(await db.dailyPlans.get(plan.id), undefined);
  const remainingTasks = await db.dailyTasks.where('planId').equals(plan.id).count();
  assert.equal(remainingTasks, 0);
});

test('createDailyPlan：空输入报错', async () => {
  await clearDaily();
  await assert.rejects(() => createDailyPlan({ rawInput: '   ' }), /请输入今日规划/);
});

test('checkinDailyTask：非法状态报错', async () => {
  await clearDaily();
  const { tasks } = await createDailyPlan({ rawInput: '复习 10 张卡片' });
  const t = tasks[0];
  await assert.rejects(() => checkinDailyTask(t.id, 'invalid'), /非法打卡状态/);
});

test('当天重复创建 → 覆盖重建（历史"全是今日"根因修复）', async () => {
  await clearDaily();
  const a = await createDailyPlan({ rawInput: '复习 10 张卡片' });
  const b = await createDailyPlan({ rawInput: '背 20 个单词，重要' });
  // 当天只剩 1 份 plan（旧的被删）
  const plans = await db.dailyPlans.where('date').equals(a.plan.date).toArray();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, b.plan.id);
  // 旧任务被清掉，只剩新任务
  const oldTasks = await db.dailyTasks.where('planId').equals(a.plan.id).count();
  assert.equal(oldTasks, 0);
  // 列表返回最新一份
  const listed = await listDailyPlan(a.plan.date);
  assert.equal(listed.plan.id, b.plan.id);
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].targetCount, 20);
});

test('tasks 透传：预览任务原样入库（预览=入库一致）', async () => {
  await clearDaily();
  const previewTasks = [
    { title: '做408题', type: 'exam', quadrant: 'Q1', important: true, urgent: true, scheduledHour: 14, targetCount: 10, subject: '计组', estimatedMinutes: 90 },
  ];
  const { plan, tasks } = await createDailyPlan({ rawInput: '做408题', tasks: previewTasks });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].scheduledHour, 14);
  assert.equal(tasks[0].type, 'exam');
  const stored = await db.dailyTasks.get(tasks[0].id);
  assert.equal(stored.scheduledHour, 14);
  assert.equal(stored.subject, '计组');
});

test('listDailyPlanSummary：按日期合并去重', async () => {
  await clearDaily();
  const d1 = '2026-08-26';
  const d2 = '2026-08-27';
  // d1 同一天两份（模拟历史堆积），d2 一份
  const p1 = await createDailyPlan({ rawInput: '复习 5 张卡片', date: d1 });
  const p2 = await createDailyPlan({ rawInput: '背 8 个单词', date: d1 });
  const p3 = await createDailyPlan({ rawInput: '做 3 道题', date: d2 });
  // 打卡一个任务
  await checkinDailyTask(p3.tasks[0].id, 'done', '');
  const sum = await listDailyPlanSummary(30);
  const d1sum = sum.find(s => s.date === d1);
  const d2sum = sum.find(s => s.date === d2);
  assert.ok(d1sum);
  assert.equal(d1sum.total, 1); // 覆盖后 d1 只剩一份
  assert.equal(d2sum.total, 1);
  assert.equal(d2sum.done, 1);
  assert.ok(sum[0].date === d2 || sum[0].date === d1); // 按 updatedAt 倒序
});
