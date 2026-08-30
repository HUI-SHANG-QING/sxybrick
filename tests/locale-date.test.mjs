// tests/locale-date.test.mjs —— 跟随界面语言的日期/时间格式化
// 背景：此前 8+ 处硬编码 toLocaleString('zh-CN')/toLocaleTimeString('zh-CN')，
// 切到英文界面后日期仍是「2026/8/30」这种中文习惯。统一收口到 src/utils/locale-date.js。
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { locale } from '../src/i18n/index.js';
import {
  intlTag, fmtLocaleDate, fmtLocaleTime, fmtLocaleDateTime, fmtLocaleNumber,
} from '../src/utils/locale-date.js';

const TS = new Date(2026, 7, 30, 19, 48, 0).getTime(); // 2026-08-30 19:48 本地时间

test('intlTag：随 locale 切换', () => {
  locale.value = 'zh-CN';
  assert.equal(intlTag(), 'zh-CN');
  locale.value = 'en';
  assert.equal(intlTag(), 'en-US');
  locale.value = 'zh-CN';
});

test('中英文日期格式不同（英文界面不再显示中文习惯）', () => {
  locale.value = 'zh-CN';
  const zh = fmtLocaleDate(TS);
  locale.value = 'en';
  const en = fmtLocaleDate(TS);
  assert.notEqual(zh, en, '中英文必须产出不同格式');
  assert.match(zh, /^2026[/年]/, `中文日期应为 年优先，实际：${zh}`);
  assert.match(en, /^8\//, `英文日期应为 月/日/年，实际：${en}`);
  locale.value = 'zh-CN';
});

test('时间：中文 24 小时制、英文 12 小时制带 AM/PM', () => {
  locale.value = 'zh-CN';
  const zh = fmtLocaleTime(TS);
  assert.match(zh, /19:48/, `实际：${zh}`);
  locale.value = 'en';
  const en = fmtLocaleTime(TS);
  assert.match(en, /PM/i, `英文应带 PM，实际：${en}`);
  locale.value = 'zh-CN';
});

test('日期时间：都不为 "—"，且中英文有差异', () => {
  locale.value = 'zh-CN';
  const zh = fmtLocaleDateTime(TS);
  locale.value = 'en';
  const en = fmtLocaleDateTime(TS);
  assert.notEqual(zh, '—');
  assert.notEqual(en, '—');
  assert.notEqual(zh, en);
  locale.value = 'zh-CN';
});

test('非法/缺失输入统一返回 "—"，绝不渲染 1970-01-01', () => {
  for (const bad of [undefined, null, 0, NaN, '', 'abc', -1]) {
    assert.equal(fmtLocaleDate(bad), '—', `输入 ${String(bad)} 应返回 —`);
    assert.equal(fmtLocaleTime(bad), '—');
    assert.equal(fmtLocaleDateTime(bad), '—');
  }
  assert.equal(fmtLocaleDate(new Date(0)), '—', 'ts=0 代表"未设置"，不能显示 1970');
});

test('数字：中文与英文分组符按 locale 走', () => {
  locale.value = 'zh-CN';
  const zh = fmtLocaleNumber(1234567);
  locale.value = 'en';
  const en = fmtLocaleNumber(1234567);
  assert.equal(zh, '1,234,567');
  assert.equal(en, '1,234,567');
  assert.equal(fmtLocaleNumber(NaN), '—');
  assert.equal(fmtLocaleNumber('abc'), '—');
  locale.value = 'zh-CN';
});

test('Date 实例也可直接传入', () => {
  assert.ok(fmtLocaleDate(new Date(TS)) !== '—');
});
