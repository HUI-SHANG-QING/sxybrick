// 复现 DailyPlanView 存储计划后的完整渲染数据流（Node + fake-indexeddb）
import 'fake-indexeddb/auto';
import './_env.mjs';
import { db } from '../src/db.js';
import { createDailyPlan, listDailyPlan } from '../src/repo.js';
import * as syn from '../src/utils/planSynergy.js';
import * as charts from '../src/utils/planCharts.js';
import { formatLunarDate } from '../src/utils/lunar.js';

const throws = [];
function guard(label, fn) {
  try { fn(); } catch (e) { throws.push(`${label} :: ${e.message}\n    ${(e.stack || '').split('\n').slice(1, 3).join('\n    ')}`); }
}

// 模拟视图里的 summary computed（已修：0 任务也返回完整对象）
function summaryOf(plan) {
  const tasks = plan?.tasks || [];
  const byQuadrant = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  const byStatus = { pending: 0, done: 0, partial: 0, skipped: 0 };
  for (const t of tasks) {
    byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] || 0) + 1;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  const total = tasks.length;
  const doneRate = total ? Math.round((byStatus.done / total) * 100) : 0;
  return { total, byQuadrant, byStatus, doneRate };
}

async function runScenario(name, opts = {}) {
  await db.dailyPlans.clear();
  await db.dailyTasks.clear();
  let plan = null;
  if (opts.rawInput) {
    const r = await createDailyPlan({ rawInput: opts.rawInput, tasks: opts.tasks });
    plan = { plan: r.plan, tasks: r.tasks };
  } else if (opts.seed) {
    // 直接种畸形数据
    await db.dailyPlans.put({ id: 'p1', date: opts.seed.date, updatedAt: Date.now(), rawInput: 'x' });
    await db.dailyTasks.bulkPut(opts.seed.tasks.map((t, i) => ({ id: 't' + i, planId: 'p1', ...t })));
    plan = await listDailyPlan(opts.seed.date);
  }

  const date = opts.seed?.date || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  const summary = summaryOf(plan);
  guard(`${name}: summary.total`, () => { const _ = summary.total; });
  guard(`${name}: summary.doneRate`, () => { const _ = summary.doneRate; });

  let synergy = null;
  guard(`${name}: getDailySynergy`, async () => { synergy = await syn.getDailySynergy(date, plan?.tasks || null); });
  // await the above
  try { synergy = await syn.getDailySynergy(date, plan?.tasks || null); } catch (e) { throws.push(`${name}: getDailySynergy(await) :: ${e.message}`); }

  const completion = synergy?.completion || [];
  const risks = synergy?.risks || [];
  const overallRate = (() => {
    if (!completion.length) return 0;
    const p = completion.reduce((s, c) => s + c.plan, 0);
    const a = completion.reduce((s, c) => s + c.actual, 0);
    return p ? Math.min(100, Math.round((a / p) * 100)) : 0;
  })();

  let heat = [];
  guard(`${name}: getCompletionHeatmap`, async () => { heat = await syn.getCompletionHeatmap(84); });
  try { heat = await syn.getCompletionHeatmap(84); } catch (e) { throws.push(`${name}: getCompletionHeatmap(await) :: ${e.message}`); }

  const board = charts.buildScheduleBoard(plan?.tasks || []);
  guard(`${name}: board fields`, () => { const _ = [board.totalHeight, board.hours, board.rowH, board.placed, board.unscheduled]; });
  for (const b of (board.placed || [])) {
    guard(`${name}: board placed item`, () => { const _ = [b.task.id, b.top, b.height, b.left, b.width, b.color, b.label, b.clamp]; });
  }

  guard(`${name}: formatLunarDate`, () => { const d = formatLunarDate(date + 'T00:00:00'); const _ = [d.solarText, d.weekdayText, d.lunarText, d.ganzhiText]; });

  // 图表 builders（渲染函数逐一调用）
  guard(`${name}: quadrantOption`, () => charts.quadrantOption(plan?.tasks || []));
  guard(`${name}: radarOption`, () => charts.radarOption(completion));
  guard(`${name}: riskOption`, () => charts.riskOption(risks));
  guard(`${name}: typeBreakdownOption`, () => charts.typeBreakdownOption(plan?.tasks || []));
  guard(`${name}: compareBarOption`, () => charts.compareBarOption(completion));
  guard(`${name}: trendOption`, () => charts.trendOption((heat || []).slice(-30)));
  guard(`${name}: gaugeOption`, () => charts.gaugeOption(overallRate));
  guard(`${name}: checkinTimelineOption`, () => charts.checkinTimelineOption(plan?.tasks || []));
  guard(`${name}: heatmapOption`, () => charts.heatmapOption(heat));

  console.log(`${name}: OK (tasks=${plan?.tasks?.length}, completion=${completion.length}, risks=${risks.length}, heat=${heat.length})`);
}

await runScenario('S1 fillExample 文本', { rawInput: '09:00 复习线性代数第四章方程组基础解系与非齐次通解全部30张卡片 重要\n14:00 做10道408计算机组成原理存储系统真题大题 计组\n16:30 看数据结构二叉树遍历与哈夫曼树讲义并整理笔记\n19:00 背英语单词50个 重要' });

await runScenario('S2 空任务计划（summary=null 场景）', { seed: { date: '2026-09-13', tasks: [] } });

await runScenario('S3 任务缺 title / quadrant', { seed: { date: '2026-09-13', tasks: [
  { title: undefined, type: 'review', quadrant: 'Q1', important: true, urgent: true, scheduledHour: 9, targetCount: 30, estimatedMinutes: 60, status: 'pending' },
  { title: '正常任务', type: 'exam', quadrant: undefined, scheduledHour: 14, status: 'pending' },
] } });

await runScenario('S4 任务 title 是数字', { seed: { date: '2026-09-13', tasks: [
  { title: 12345, type: 'review', quadrant: 'Q1', scheduledHour: 9, status: 'pending' },
] } });

await runScenario('S5 任务 scheduledHour 是字符串', { seed: { date: '2026-09-13', tasks: [
  { title: '字符串时间任务', type: 'pomodoro', quadrant: 'Q2', scheduledHour: '9', estimatedMinutes: '60', status: 'pending' },
] } });

console.log('\n===== 抛出的错误 =====');
if (!throws.length) console.log('（无）');
for (const t of throws) console.log('• ' + t + '\n');

try { await db.close(); } catch {}
process.exit(0);
