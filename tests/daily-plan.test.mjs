// 测试：每日规划/打卡 黄金路径（fake-indexeddb 集成）
//   口述 → 解析 → 入库 → 任务打卡 → 跨模块真实数据 → 删除
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';
import {
  createDailyPlan, listDailyPlan, listDailyPlans,
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
