// tests/golden-hours.test.mjs —— 黄金时段纯函数单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenHours } from '../src/algorithms/golden-hours.js';

test('空分布：无数据标记', () => {
  const r = goldenHours(new Array(24).fill(0));
  assert.equal(r.hasData, false);
  assert.equal(r.peakHour, null);
  assert.equal(r.bestWindow, null);
  assert.equal(r.total, 0);
});

test('明确峰值：单小时峰值识别', () => {
  const hourly = new Array(24).fill(1);
  hourly[9] = 10; // 9 点峰值
  const r = goldenHours(hourly);
  assert.equal(r.peakHour, 9);
  assert.equal(r.hasData, true);
});

test('连续窗口：找复习最集中的 3 小时窗口', () => {
  const hourly = new Array(24).fill(0);
  hourly[8] = 5; hourly[9] = 8; hourly[10] = 7; // 8-10 点窗口 sum=20
  hourly[19] = 3; hourly[20] = 4; hourly[21] = 3; // 19-21 窗口 sum=10
  const r = goldenHours(hourly, { windowSize: 3 });
  assert.equal(r.bestWindow.start, 8);
  assert.equal(r.bestWindow.end, 10);
  assert.equal(r.bestWindow.count, 20);
});

test('跨午夜窗口：环形求和', () => {
  const hourly = new Array(24).fill(0);
  hourly[22] = 6; hourly[23] = 7; hourly[0] = 5; // 22-0 点窗口 sum=18
  hourly[10] = 4; hourly[11] = 4; hourly[12] = 4; // 10-12 sum=12
  const r = goldenHours(hourly, { windowSize: 3 });
  assert.equal(r.bestWindow.start, 22);
  assert.equal(r.bestWindow.end, 0);
  assert.equal(r.bestWindow.count, 18);
  assert.match(r.label, /22:00–1:00/); // 结束小时（含）= 0+1 = 1 点
});

test('label 文案：含峰值小时与建议时段', () => {
  const hourly = new Array(24).fill(0);
  hourly[7] = 10; hourly[8] = 6; hourly[9] = 5;
  const r = goldenHours(hourly, { windowSize: 3 });
  assert.match(r.label, /7:00/);
  assert.match(r.label, /黄金时段/);
});
