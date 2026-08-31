// tests/locale-date.test.mjs —— 跟随界面语言的日期/时间格式化
// 背景：此前 8+ 处硬编码 toLocaleString('zh-CN')/toLocaleTimeString('zh-CN')，
// 切到英文界面后日期仍是「2026/8/30」这种中文习惯。统一收口到 src/utils/locale-date.js。
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { locale } from '../src/i18n/index.js';
import {
  intlTag, fmtLocaleDate, fmtLocaleTime, fmtLocaleDateTime, fmtLocaleNumber,
  fmtLocaleRelative, weekdayNames, monthNames,
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

// ---------------------------------------------------------------------------
// 相对时间（Workspace 的"刚刚 / N 分钟前"曾硬编码拼接，切英文后仍整块中文）
// ---------------------------------------------------------------------------
const NOW = new Date(2026, 7, 26, 14, 0, 0).getTime(); // 2026-08-26 周三 14:00
const ago = (ms) => fmtLocaleRelative(NOW - ms, NOW);

test('相对时间：中英文都能产出，且不是手拼的"N 分钟前"', () => {
  locale.value = 'zh-CN';
  assert.match(ago(5 * 60_000), /分钟/, `实际：${ago(5 * 60_000)}`);
  locale.value = 'en';
  assert.match(ago(5 * 60_000), /minute/i, `实际：${ago(5 * 60_000)}`);
  locale.value = 'zh-CN';
});

test('相对时间：45 秒内显示"现在/now"，不出现"0 分钟前"', () => {
  locale.value = 'zh-CN';
  for (const ms of [0, 1_000, 30_000, 44_000]) {
    assert.doesNotMatch(ago(ms), /0\s*分钟/, `ms=${ms} 实际：${ago(ms)}`);
  }
  locale.value = 'en';
  for (const ms of [0, 30_000]) {
    assert.doesNotMatch(ago(ms), /0\s*minute/, `ms=${ms} 实际：${ago(ms)}`);
  }
  locale.value = 'zh-CN';
});

test('相对时间：进位阈值不留"60 分钟前"/"24 小时前"', () => {
  locale.value = 'zh-CN';
  assert.doesNotMatch(ago(59 * 60_000), /60\s*分钟/, `实际：${ago(59 * 60_000)}`);
  assert.doesNotMatch(ago(23.5 * 3_600_000), /24\s*小时/, `实际：${ago(23.5 * 3_600_000)}`);
  locale.value = 'zh-CN';
});

test('相对时间：跨天走"昨天/yesterday"而非小时数', () => {
  locale.value = 'zh-CN';
  assert.match(ago(23.5 * 3_600_000), /昨天/, `实际：${ago(23.5 * 3_600_000)}`);
  locale.value = 'en';
  assert.match(ago(23.5 * 3_600_000), /yesterday/i, `实际：${ago(23.5 * 3_600_000)}`);
  locale.value = 'zh-CN';
});

test('相对时间：未来时刻也能表达（时钟回拨/倒计时场景）', () => {
  locale.value = 'zh-CN';
  assert.match(fmtLocaleRelative(NOW + 2 * 3_600_000, NOW), /后/);
  locale.value = 'en';
  assert.match(fmtLocaleRelative(NOW + 2 * 3_600_000, NOW), /in\s/i);
  locale.value = 'zh-CN';
});

test('相对时间：非法输入返回 "—"，且参考时刻缺失时回落到真实时间不抛错', () => {
  for (const bad of [undefined, null, 0, NaN, '', 'abc']) {
    assert.equal(fmtLocaleRelative(bad, NOW), '—', `输入 ${String(bad)} 应返回 —`);
  }
  assert.doesNotThrow(() => fmtLocaleRelative(NOW));
  assert.doesNotThrow(() => fmtLocaleRelative(NOW, 'not-a-number'));
});

// ---------------------------------------------------------------------------
// 星期 / 月份名（UserDashboard 图表轴标签，下标顺序一旦错位图表就全错）
// ---------------------------------------------------------------------------
test('weekdayNames：下标 0 = 周日，与 Date.getDay() 对齐', () => {
  locale.value = 'zh-CN';
  const zh = weekdayNames();
  assert.equal(zh.length, 7);
  assert.equal(zh[0], '周日');
  assert.equal(zh[1], '周一');
  assert.equal(zh[6], '周六');
  locale.value = 'en';
  const en = weekdayNames();
  assert.equal(en[0], 'Sun');
  assert.equal(en[1], 'Mon');
  locale.value = 'zh-CN';
  // 与 getDay() 交叉校验：2026-08-30 是周日
  assert.equal(weekdayNames()[new Date(2026, 7, 30).getDay()], '周日');
});

test('weekdayNames：英文必须用 short，narrow 有歧义（UserDashboard 图表轴踩过的坑）', () => {
  locale.value = 'en';
  // narrow 是 S,M,T,W,T,F,S —— Sunday/Saturday 都是 S，Tuesday/Thursday 都是 T
  assert.equal(new Set(weekdayNames('narrow')).size, 5, '英文 narrow 确实有 2 组重复（这是 ICU 行为，不是 bug）');
  // 因此图表轴一律用 short
  assert.equal(new Set(weekdayNames('short')).size, 7, '英文 short 必须 7 个互不重复');
  locale.value = 'zh-CN';
  // 中文 narrow（日/一/二…）没有歧义，可以用在窄轴上
  assert.equal(new Set(weekdayNames('narrow')).size, 7);
});

test('monthNames：下标 0 = 1 月，长度 12', () => {
  locale.value = 'zh-CN';
  const zh = monthNames();
  assert.equal(zh.length, 12);
  assert.match(zh[0], /^1/);
  assert.match(zh[11], /^12/);
  locale.value = 'en';
  const en = monthNames();
  assert.equal(en[0], 'Jan');
  assert.equal(en[11], 'Dec');
  locale.value = 'zh-CN';
});
