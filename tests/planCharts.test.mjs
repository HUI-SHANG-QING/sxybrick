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
