import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleBoard, riskOption, checkinTimelineOption, scheduleOption } from '../src/utils/planCharts.js';

const task = (over = {}) => ({
  id: 't' + Math.random().toString(36).slice(2),
  title: '任务', type: 'review', quadrant: 'Q1', status: 'pending',
  scheduledHour: null, estimatedMinutes: null, subject: '', targetCount: null,
  ...over,
});

test('有时间段任务落格：top/height/label 正确', () => {
  const t = task({ scheduledHour: 9, estimatedMinutes: 90 });
  const b = buildScheduleBoard([t], { startHour: 6, endHour: 23, rowH: 56 });
  assert.equal(b.placed.length, 1);
  assert.equal(b.placed[0].top, (9 - 6) * 56);       // 3 * 56
  assert.equal(b.placed[0].height, 84);              // 90/60*56 = 84
  assert.equal(b.placed[0].label, '09:00–10:30');
  assert.equal(b.unscheduled.length, 0);
});

test('无时间段 / 超出范围进入 unscheduled', () => {
  const a = task({ scheduledHour: null });
  const b2 = task({ scheduledHour: 24 });            // 超出 endHour 23
  const b = buildScheduleBoard([a, b2]);
  assert.equal(b.placed.length, 0);
  assert.equal(b.unscheduled.length, 2);
});

test('返回 rowH 与总高度', () => {
  const b = buildScheduleBoard([]);
  assert.equal(b.rowH, 56);
  assert.equal(b.totalHeight, (23 - 6 + 1) * 56);    // 18 * 56 = 1008
  assert.equal(b.hours.length, 18);
});

test('默认时长 60 分钟、排序按 top', () => {
  const t1 = task({ scheduledHour: 12 });
  const t2 = task({ scheduledHour: 8 });
  const b = buildScheduleBoard([t1, t2]);
  assert.deepEqual(b.placed.map(p => p.top), [(8 - 6) * 56, (12 - 6) * 56]);
});

test('象限色映射', () => {
  const t = task({ quadrant: 'Q2', scheduledHour: 10 });
  const b = buildScheduleBoard([t]);
  assert.equal(b.placed[0].color, '#d4a853');
});

test('left/width 为纯百分比加减（不依赖 calc 乘除，兼容所有浏览器）', () => {
  // 3 个同时段任务 → 3 列并排
  const ts = [0, 1, 2].map(() => task({ scheduledHour: 10, estimatedMinutes: 90 }));
  const b = buildScheduleBoard(ts);
  assert.equal(b.laneCount, 3);
  const l0 = b.placed[0].left, w0 = b.placed[0].width;
  assert.ok(!l0.includes('*') && !l0.includes('/'), 'left 不应含乘除: ' + l0);
  assert.ok(!w0.includes('*') && !w0.includes('/'), 'width 不应含乘除: ' + w0);
  assert.ok(l0.startsWith('calc(') && l0.includes('%'));
  assert.equal(b.placed[1].left, 'calc(33.33% + 5px)');
  assert.equal(b.placed[1].width, 'calc(33.33% - 10px)');
});

test('clamp 随块高自适应（矮块 1 行 / 中块 2 行 / 高块 3 行）', () => {
  const small = task({ scheduledHour: 10, estimatedMinutes: 30 });  // 34px
  const mid = task({ scheduledHour: 11, estimatedMinutes: 90 });    // 84px
  const tall = task({ scheduledHour: 13, estimatedMinutes: 180 });  // 168px
  const b = buildScheduleBoard([small, mid, tall]);
  const byTop = Object.fromEntries(b.placed.map(p => [p.top, p.clamp]));
  assert.equal(byTop[(10 - 6) * 56], 1);   // 34px → 1 行
  assert.equal(byTop[(11 - 6) * 56], 2);   // 84px → 2 行
  assert.equal(byTop[(13 - 6) * 56], 3);   // 168px → 3 行
});

test('跨午夜时长 label 标注「次日」，且高度截断到网格底部', () => {
  const t = task({ scheduledHour: 23, estimatedMinutes: 90 });
  const b = buildScheduleBoard([t]);
  assert.equal(b.placed[0].label, '23:00–次日00:30');
  // 23:00 起 top=952，网格底 1008；90min=84px 截断为 56px
  assert.equal(b.placed[0].height, 56);
  assert.equal(b.placed[0].top + b.placed[0].height, b.totalHeight);
});

// 回归（渲染崩溃 "is not a function"）：task.title 非字符串（同步/旧 schema 遗留的畸形数据）
// 时，构建器内部的 .slice 会抛 "X.slice is not a function" → 视图 ErrorBoundary 整块降级。
test('riskOption：title 非字符串不抛错（渲染健壮性）', () => {
  const risks = [
    { task: { title: 12345, quadrant: 'Q1', estimatedMinutes: 60 }, severity: 'high', reason: 'x' },
    { task: { title: null, quadrant: 'Q3' }, severity: 'low', reason: 'y' },
    { task: { title: undefined }, severity: 'medium', reason: 'z' },
  ];
  const opt = riskOption(risks);
  assert.ok(opt.series[0].data.every(d => typeof d.name === 'string'), 'name 必须被强制为字符串');
});

test('checkinTimelineOption：title 非字符串不抛错（渲染健壮性）', () => {
  const tasks = [
    { title: 12345, scheduledHour: 9, status: 'pending' },
    { title: null, scheduledHour: 14, status: 'done', completedAt: new Date().toISOString() },
  ];
  const opt = checkinTimelineOption(tasks);
  assert.ok(opt.yAxis.data.every(c => typeof c === 'string'), 'yAxis 分类必须为字符串');
});

// ── round66：脏 scheduledHour / estimatedMinutes 的展示侧护栏 ──
// 背景：`sh < 6 || sh > 23` 这类范围守卫**对 NaN 恒为 false**，脏值会直接穿透 →
// top 算成 NaN → 整块课程表布局错乱；estimatedMinutes 为 'abc' 时 `|| defaultDur` 同样短路失效。
test('buildScheduleBoard：脏 scheduledHour 不得落格（NaN 会穿透范围守卫）', () => {
  for (const bad of [NaN, '9:00', 'abc', undefined, {}]) {
    const b = buildScheduleBoard([task({ scheduledHour: bad })]);
    assert.equal(b.placed.length, 0, `scheduledHour=${String(bad)} 不应落格`);
    assert.equal(b.unscheduled.length, 1);
  }
  // 越界值原本就走 unscheduled —— 回归防护，修复不得放宽
  const out = buildScheduleBoard([task({ scheduledHour: 25 })]);
  assert.equal(out.placed.length, 0);
  assert.equal(out.unscheduled.length, 1);
});

test('buildScheduleBoard：脏 estimatedMinutes 回落默认时长，top/height/label 必须有限', () => {
  for (const bad of ['abc', NaN, -5, 0, {}]) {
    const b = buildScheduleBoard([task({ scheduledHour: 9, estimatedMinutes: bad })], { rowH: 56, defaultDur: 60 });
    assert.equal(b.placed.length, 1, `时长=${String(bad)} 仍应落格`);
    const p = b.placed[0];
    assert.ok(Number.isFinite(p.top), 'top 必须有限');
    assert.ok(Number.isFinite(p.height), 'height 必须有限');
    assert.equal(p.label, '09:00–10:00', `应回落 60 分钟默认时长，实际 ${p.label}`);
  }
});

test('buildScheduleBoard：字符串数字的点钟 / 时长按数值解析（不误伤合法数据）', () => {
  const b = buildScheduleBoard([task({ scheduledHour: '9', estimatedMinutes: '90' })], { rowH: 56 });
  assert.equal(b.placed.length, 1);
  assert.equal(b.placed[0].top, 3 * 56);
  assert.equal(b.placed[0].height, 84);
  assert.equal(b.placed[0].label, '09:00–10:30');
});

test('scheduleOption：脏 scheduledHour 不得抛 TypeError（buckets 索引越界）', () => {
  assert.doesNotThrow(() => scheduleOption([
    task({ scheduledHour: 25 }), task({ scheduledHour: '9:00' }), task({ scheduledHour: 9.5 }),
  ]));
  const opt = scheduleOption([
    task({ scheduledHour: 9 }), task({ scheduledHour: 25 }), task({ scheduledHour: '9:00' }),
  ]);
  const data = opt.series[0].data;
  assert.equal(data.length, 24);
  assert.equal(data[9].value, 1, '合法 9 点应入桶');
  assert.equal(data.reduce((s, d) => s + d.value, 0), 1, '脏值不得进入任何桶');
});

test('scheduleOption：小数点位（9.5）不得击穿桶索引', () => {
  assert.doesNotThrow(() => scheduleOption([task({ scheduledHour: 9.5 })]));
  const opt = scheduleOption([task({ scheduledHour: 9.5 })]);
  assert.equal(opt.series[0].data.reduce((s, d) => s + d.value, 0), 0, '非整数不应入桶（桶按整点）');
});

test('checkinTimelineOption：脏计划时刻不得产出 NaN / 越界坐标（点会"视觉消失"）', () => {
  const rows = [
    task({ scheduledHour: '9:00' }),
    task({ scheduledHour: NaN }),
    task({ scheduledHour: 25 }),
    task({ scheduledHour: 9, completedAt: Date.now() }), // 合法对照
  ];
  const opt = checkinTimelineOption(rows);
  const planned = opt.series[0].data;
  assert.equal(planned.length, 1, '只有合法那条产生计划点');
  assert.equal(planned[0].value[0], 9);
  for (const p of opt.series[1].data) {
    assert.ok(Number.isFinite(p.value[0]), '实际打卡点坐标必须有限');
    assert.ok(p.value[0] >= 0 && p.value[0] <= 24, '坐标必须在轴范围内');
  }
});
