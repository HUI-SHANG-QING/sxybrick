// tests/agent-write-tools.test.mjs —— round76：AI 的写入能力（笔记 / 每日规划 / 打卡）
//
// 背景：此前 AI 有 12 个写工具（卡片、备忘、长期计划、AI 文档、图谱边、索引），但**没有一个能写
// 笔记或每日任务** —— 于是「帮我把这段整理成笔记」只能落成 AI 文档（另一个模块）、
// 「把这几张卡排进今天」根本做不到。本文件钉住新增 5 个写入工具的行为契约与**写入纪律**。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { toolRegistry, agentRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import '../src/agent/agents/index.js';
import { db } from '../src/db.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const WRITE_TOOLS = ['create_note', 'update_note', 'create_daily_plan', 'add_daily_task', 'checkin_daily_task'];

test('新增写入工具已注册且标记 writesData', () => {
  for (const n of WRITE_TOOLS) {
    const t = toolRegistry.get(n);
    assert.ok(t, `${n} 未注册`);
    assert.equal(!!t.writesData, true, `${n} 必须标记 writesData（写操作要被识别出来）`);
  }
});

test('写入工具描述必须写明「先确认再写」——否则模型会绕过用户直接改库', () => {
  for (const n of WRITE_TOOLS) {
    const d = toolRegistry.get(n).description;
    assert.match(d, /确认/, `${n} 的描述缺少「先确认再写」约定（未来编辑时别删）`);
  }
  // 会覆盖既有数据的那个工具，还须提示「旧计划进回收站」
  assert.match(toolRegistry.get('create_daily_plan').description, /覆盖重建|回收站/, '重建当天计划必须提前告知用户');
  // 打卡不得替用户猜
  assert.match(toolRegistry.get('checkin_daily_task').description, /不要替用户|务必先确认/, '打卡文案须阻止"替用户打勾"');
});

test('笔记：create_note 写入 → list_notes 可见 → update_note 改正文 → read_note 读到新内容', async () => {
  await db.notes.clear();
  const create = toolRegistry.get('create_note');
  const made = await create.execute({ title: '线代第四章', content: '# 第四章\n特征值与特征向量', category: '线性代数', tags: '特征值,思维导图' });
  assert.equal(made.ok, true);
  assert.ok(made.data.noteId, '必须回传 noteId（后续 update 要用 id，不能让模型凭记忆编）');
  assert.equal(made.data.chars > 0, true);

  const list = await toolRegistry.get('list_notes').execute({});
  assert.equal(list.data.total, 1, '刚写的笔记要能被 list_notes 看到（写读闭环）');
  assert.match(list.data.items[0].preview, /特征值/);

  const upd = await toolRegistry.get('update_note').execute({ id: made.data.noteId, content: '# 第四章（修订）\n已补公式推导' });
  assert.equal(upd.ok, true);
  assert.deepEqual(upd.data.changed, ['content'], '只应报告真正改动的字段');

  const read = await toolRegistry.get('read_note').execute({ id: made.data.noteId });
  assert.match(read.data.content, /已补公式推导/, '更新后的正文必须读得到');
  assert.match(read.data.content, /第四章/, '未传的字段（标题）不应被清空');

  // 按标题模糊定位也要能改（模型常常只有标题）
  const upd2 = await toolRegistry.get('update_note').execute({ title: '线代第四章', newTitle: '线代第四章·定稿' });
  assert.equal(upd2.ok, true);
  assert.equal(upd2.data.title, '线代第四章·定稿');
  await db.notes.clear();
});

test('笔记：空正文 / 无改动字段必须显式报错（不静默写库）', async () => {
  await db.notes.clear();
  const create = toolRegistry.get('create_note');
  const bad = await create.execute({ title: '空的' });
  assert.equal(bad.ok, false, '空正文必须报错');
  assert.equal((await db.notes.count()), 0, '报错时不得留下半条数据');

  await create.execute({ title: 'A', content: 'x' });
  const noPatch = await toolRegistry.get('update_note').execute({ title: 'A' });
  assert.equal(noPatch.ok, false, '没有任何待改字段时必须报错，而不是假装成功');
  await db.notes.clear();
});

test('每日规划：create_daily_plan 建计划 → add_daily_task 追加 → checkin_daily_task 打卡', async () => {
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
  const DAY = '2026-10-08';

  const plan = await toolRegistry.get('create_daily_plan').execute({
    rawInput: '9点复习线代 45 分钟，下午做计网错题 30 分钟',
    date: DAY,
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.data.planId, '必须回传 planId');
  assert.equal(plan.data.date, DAY);
  assert.equal(typeof plan.data.taskCount, 'number');

  const added = await toolRegistry.get('add_daily_task').execute({
    date: DAY, title: '背计网概念', type: 'review', estimatedMinutes: 20, scheduledHour: 21, subject: '计算机网络',
  });
  assert.equal(added.ok, true);
  assert.ok(added.data.taskId, '必须回传 taskId（打卡要用）');
  assert.equal(added.data.estimatedMinutes, 20);
  assert.equal(added.data.scheduledHour, 21);

  // 有 planId 时直接追加
  const added2 = await toolRegistry.get('add_daily_task').execute({ planId: plan.data.planId, title: '线代第二轮' });
  assert.equal(added2.ok, true);

  const day = await toolRegistry.get('list_daily_tasks').execute({ date: DAY });
  assert.equal(day.data.mode, 'day');
  assert.ok(day.data.total >= 2, '追加的任务要能在当天列表里看到');
  const target = day.data.items.find((x) => x.id === added.data.taskId);
  assert.ok(target, '能按 taskId 找到刚加的任务');
  assert.equal(target.status, 'pending');

  const done = await toolRegistry.get('checkin_daily_task').execute({ taskId: added.data.taskId, status: 'done', note: '过了一遍' });
  assert.equal(done.ok, true);
  assert.equal(done.data.status, 'done');
  const after2 = await toolRegistry.get('list_daily_tasks').execute({ date: DAY });
  assert.equal(after2.data.items.find((x) => x.id === added.data.taskId).status, 'done', '打卡后状态要落库');
  assert.equal(after2.data.items.find((x) => x.id === added.data.taskId).completionNote, '过了一遍');

  // 按标题模糊打卡（模型常常只有标题）
  const byTitle = await toolRegistry.get('checkin_daily_task').execute({ date: DAY, title: '线代第二轮', status: 'partial' });
  assert.equal(byTitle.ok, true);
  assert.equal(byTitle.data.status, 'partial');

  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
});

test('每日规划：当天没有计划时 add_daily_task 自动新建（「排进今天」要一次成功）', async () => {
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
  const DAY = '2026-10-09';
  assert.equal(await db.dailyPlans.where('date').equals(DAY).count(), 0, '前置：该日无计划');

  const r = await toolRegistry.get('add_daily_task').execute({ date: DAY, title: '临时加的任务' });
  assert.equal(r.ok, true);
  assert.ok(r.data.planId, '应自动建出当天计划并回传 planId');
  const day = await toolRegistry.get('list_daily_tasks').execute({ date: DAY });
  assert.equal(day.data.total, 1);
  assert.equal(day.data.items[0].title, '临时加的任务');
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
});

// round83 P3-3（经核实成立）：scheduledHour 曾只有 isFinite + floor，没有 0-23 钳制，
// 而同类参数 estimatedMinutes 有 clamp —— 同一类参数两套规则。模型传 25 会原样入库，
// 界面渲染出「25:00」、四象限时段排布错乱；且同步入口的域校验只管**导入**，管不到这条本地写路径。
test('scheduledHour 必须钳制到 0-23（与 estimatedMinutes 同纪律）', async () => {
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
  const DAY = '2026-11-02';
  const cases = [
    [25, 23],
    [-1, 0],
    [99.7, 23],
    [9.5, 9],
  ];
  for (const [given, expect] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await toolRegistry.get('add_daily_task').execute({
      date: DAY, title: '时段测试 ' + given, scheduledHour: given,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.scheduledHour, expect, `传入 ${given} 应钳为 ${expect}，实际 ${r.data.scheduledHour}`);
  }
  const noHour = await toolRegistry.get('add_daily_task').execute({ date: DAY, title: '不给时段' });
  assert.equal(noHour.data.scheduledHour, null, '未给/非法应为 null');
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
});

test('每日规划：非法状态 / 找不到任务 / 坏日期 必须显式报错（不静默写坏数据）', async () => {
  // 先清库：上一个用例若中途失败，残留数据会让「报错路径不得留下数据」的断言假红
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
  const check = toolRegistry.get('checkin_daily_task');
  const badStatus = await check.execute({ taskId: 'whatever', status: '搞定了' });
  assert.equal(badStatus.ok, false, '非法打卡状态必须报错');
  assert.ok(badStatus.error.length > 0);

  const missing = await check.execute({ date: '2026-10-10', title: '不存在的任务' });
  assert.equal(missing.ok, false, '找不到任务必须报错，而不是静默成功');

  const badDate = await check.execute({ date: '2026/10/10', title: 'x' });
  assert.equal(badDate.ok, false);

  const planBadDate = await toolRegistry.get('create_daily_plan').execute({ rawInput: '随便', date: '10-10' });
  assert.equal(planBadDate.ok, false);

  const emptyTitle = await toolRegistry.get('add_daily_task').execute({ title: '   ' });
  assert.equal(emptyTitle.ok, false, '空标题不得建任务');
  assert.equal(await db.dailyTasks.count(), 0, '报错路径不得留下数据');
});

test('接线：能写笔记/排任务的 Agent 都挂上了对应工具，且工具名都已注册', () => {
  const names = new Set(toolRegistry.list().map((t) => t.name));
  const expect = {
    tutor: ['create_note', 'update_note', 'create_daily_plan', 'add_daily_task', 'checkin_daily_task'],
    cardsmith: ['create_note'],
    planner: ['create_daily_plan', 'add_daily_task'],
    'smart-reviewer': ['add_daily_task', 'checkin_daily_task'],
  };
  for (const [agentId, tools] of Object.entries(expect)) {
    const agent = agentRegistry.get(agentId);
    assert.ok(agent, `${agentId} 未注册`);
    for (const t of tools) {
      assert.ok((agent.tools || []).includes(t), `${agentId} 缺少工具 ${t}（挂不上就等于 AI 不会用）`);
      assert.ok(names.has(t), `${agentId} 挂了不存在的工具 ${t}`);
    }
  }
});

// round85：三个工具出口的 scheduledHour 必须口径一致 —— 未排时段上报 **null，不是 0**。
// 根因（`Number(null) === 0`）：create_daily_plan / add_daily_task / list_daily_tasks 都写过
//   `Number.isFinite(Number(v)) ? Number(v) : null`，而 Number(null)=0 且 isFinite(0)=true
//   → 库里明明是 null（「没排时段」），模型却被告知「0 点」，于是回答用户「已安排在 00:00」。
// 这是「把 null 变成 0」；它的孪生兄弟是 `Number(x) || 默认值`（吞掉显式 0）。两者都靠
// 「域判断而非真值判断」根治。闸门同时钉住反向：**显式 0 点必须保住 0**。
test('scheduledHour：未排时段三个出口一律上报 null（不得被 Number(null)→0 说成 0 点）', async () => {
  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
  const DAY = '2026-11-07';

  // ① add_daily_task 出口（当天无计划 → 走「自动建计划」分支，顺带覆盖 createDailyPlan 的入口）
  const added = await toolRegistry.get('add_daily_task').execute({ date: DAY, title: '没排时段的任务' });
  assert.equal(added.ok, true);
  assert.equal(added.data.scheduledHour, null, 'add_daily_task 出口：null 不能被说成 0 点');

  // ② list_daily_tasks 出口
  const listed = await toolRegistry.get('list_daily_tasks').execute({ date: DAY });
  const row = (listed.data.items || []).find((x) => x.title === '没排时段的任务');
  assert.ok(row, '刚加的任务必须能在列表里找到');
  assert.equal(row.scheduledHour, null, 'list_daily_tasks 出口：null 不能被说成 0 点');

  // ③ create_daily_plan 出口（口述里没有时刻 → 解析结果就是 null）
  const planned = await toolRegistry.get('create_daily_plan').execute({ rawInput: '背单词', date: DAY });
  assert.equal(planned.ok, true);
  for (const x of planned.data.tasks) {
    assert.equal(x.scheduledHour, null, `create_daily_plan 出口：${x.title} 未给时间应为 null`);
  }

  // ④ 反向：显式 0 点（凌晨排程）必须保住 0，不得被当成「没排」——falsy 陷阱的另一面
  const midnight = await toolRegistry.get('add_daily_task').execute({ date: DAY, title: '零点任务', scheduledHour: 0 });
  assert.equal(midnight.data.scheduledHour, 0, '显式 0 点是合法值，不得被当成缺失');

  // ⑤ 数字串 / 越界值走同一份归一化（模型偶尔把 number 写成 "9"；同步域只认 number）
  const str = await toolRegistry.get('add_daily_task').execute({ date: DAY, title: '数字串', scheduledHour: '9' });
  assert.equal(str.data.scheduledHour, 9, "模型给 '9' 也应归一成数字 9");
  const over = await toolRegistry.get('add_daily_task').execute({ date: DAY, title: '越界', scheduledHour: 25 });
  assert.equal(over.data.scheduledHour, 23);

  for (const t of ['dailyPlans', 'dailyTasks']) await db[t].clear();
});
