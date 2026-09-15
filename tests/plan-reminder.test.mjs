import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getReminderSettings, saveReminderSettings, dueTasksOf,
  isReminded, markReminded, dateStr,
} from '../src/utils/plan-reminder.js';

// Node 无 localStorage，注入内存版（含 length/key 枚举，供去重键清理测试使用）
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: i => Object.keys(store)[i] ?? null,
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

// ── 去重键清理（防 localStorage 无限膨胀） ──────────────────────────
const clearStore = () => { for (const k of Object.keys(store)) delete store[k]; };

test('去重键清理：写入当天键时清掉其他日期的同类键', () => {
  clearStore();
  // 模拟历史存量：三天各写两个任务键（每次写入都会顺手清掉更早的日期）
  markReminded('2026-08-25', 't1');
  markReminded('2026-08-25', 't2');
  markReminded('2026-08-26', 't1');
  assert.equal(isReminded('2026-08-25', 't1'), false, '写入 08-26 后 08-25 的键应被清掉');
  markReminded('2026-08-27', 't1');
  assert.equal(isReminded('2026-08-26', 't1'), false, '写入 08-27 后 08-26 的键应被清掉');
  // 当天键必须完整保留（清理不能把自己删掉）
  assert.equal(isReminded('2026-08-27', 't1'), true);
  markReminded('2026-08-27', 't2');
  assert.equal(isReminded('2026-08-27', 't1'), true);
  assert.equal(isReminded('2026-08-27', 't2'), true);
  // 总量恒定在「当前一天」：只剩 08-27 的两个键
  assert.equal(localStorage.length, 2, `期望仅剩当天 2 个键，实际 ${localStorage.length}`);
});

test('去重键清理：不误伤其他 localStorage 键（前缀含分隔下划线）', () => {
  clearStore();
  localStorage.setItem('sxy_card_search', '线代');
  localStorage.setItem('sxy_plan_filters', '{}');
  localStorage.setItem('sxy_plan_remindedX_keep', '1'); // 相似前缀但无分隔下划线 → 不应被删
  markReminded('2026-08-28', 't9');
  assert.equal(localStorage.getItem('sxy_card_search'), '线代');
  assert.equal(localStorage.getItem('sxy_plan_filters'), '{}');
  assert.equal(localStorage.getItem('sxy_plan_remindedX_keep'), '1');
  assert.equal(isReminded('2026-08-28', 't9'), true);
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
