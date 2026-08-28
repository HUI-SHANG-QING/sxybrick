import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleBoard } from '../src/utils/planCharts.js';

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
