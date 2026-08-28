import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getReminderSettings, saveReminderSettings, dueTasksOf,
  isReminded, markReminded, dateStr,
} from '../src/utils/plan-reminder.js';

// Node 无 localStorage，注入内存版
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const task = (over = {}) => ({
  id: 't1', title: '复习线代', type: 'review', quadrant: 'Q1', status: 'pending',
  scheduledHour: 9, estimatedMinutes: 60, subject: '线代', targetCount: 30, ...over,
});

test('到点窗口内触发（09:00 任务，09:05 到期）', () => {
  const due = dueTasksOf([task()], new Date(2026, 7, 28, 9, 5), 0);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, 't1');
});

test('提前量：提前 5 分钟（08:57 触发 09:00 任务）', () => {
  const due = dueTasksOf([task()], new Date(2026, 7, 28, 8, 57), 5);
  assert.equal(due.length, 1);
});

test('错过窗口不提醒（09:30 打开，窗口 15 分钟已过）', () => {
  const due = dueTasksOf([task()], new Date(2026, 7, 28, 9, 30), 0);
  assert.equal(due.length, 0);
});

test('尚未到点不提醒', () => {
  const due = dueTasksOf([task()], new Date(2026, 7, 28, 8, 0), 0);
  assert.equal(due.length, 0);
});

test('done/skipped/无 scheduledHour 均不提醒', () => {
  const ts = [
    task({ id: 'a', status: 'done' }),
    task({ id: 'b', status: 'skipped' }),
    task({ id: 'c', scheduledHour: null }),
    task({ id: 'd', status: 'partial' }), // partial 仍提醒
  ];
  const due = dueTasksOf(ts, new Date(2026, 7, 28, 9, 0), 0);
  assert.deepEqual(due.map(t => t.id), ['d']);
});

test('去重：同一天同任务只提醒一次，跨天自动失效', () => {
  const date = dateStr(new Date(2026, 7, 28));
  assert.equal(isReminded(date, 't1'), false);
  markReminded(date, 't1');
  assert.equal(isReminded(date, 't1'), true);
  // 另一天 key 不同 → 不视为已提醒
  assert.equal(isReminded('2026-08-29', 't1'), false);
});

test('设置默认值：总开关开、声音/语音关、提前 0 分钟', () => {
  const s = getReminderSettings();
  assert.deepEqual(s, { enabled: true, sound: false, voice: false, advanceMin: 0 });
});

test('保存设置合并默认值', () => {
  const next = saveReminderSettings({ sound: true, advanceMin: 10 });
  assert.equal(next.enabled, true);
  assert.equal(next.sound, true);
  assert.equal(next.advanceMin, 10);
  assert.equal(getReminderSettings().voice, false);
});
