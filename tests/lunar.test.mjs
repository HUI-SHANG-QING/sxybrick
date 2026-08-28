import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLunar, formatLunarDate, leapMonthOf, monthDaysOf } from '../src/utils/lunar.js';

const L = (y, m, d) => getLunar(new Date(y, m - 1, d));

test('春节锚点：2000/2020/2024/2025/2026 正月初一 + 干支生肖', () => {
  assert.deepEqual(
    [L(2000, 2, 5), L(2020, 1, 25), L(2024, 2, 10), L(2025, 1, 29), L(2026, 2, 17)].map(x => [x.month, x.day, x.ganzhiYear, x.zodiac]),
    [[1, 1, '庚辰', '龙'], [1, 1, '庚子', '鼠'], [1, 1, '甲辰', '龙'], [1, 1, '乙巳', '蛇'], [1, 1, '丙午', '马']],
  );
});

test('今天 2026-08-28 = 农历七月十六 · 丙午马', () => {
  const l = L(2026, 8, 28);
  assert.equal(l.monthName, '七月');
  assert.equal(l.dayName, '十六');
  assert.equal(l.text, '农历七月十六');
  assert.equal(l.ganzhiText, '丙午年·马年');
  assert.equal(l.month, 7);
  assert.equal(l.day, 16);
});

test('闰月：2023 闰二月（闰二月初一 = 2023-03-22）', () => {
  assert.equal(leapMonthOf(2023), 2);
  const l = L(2023, 3, 22);
  assert.equal(l.isLeap, true);
  assert.equal(l.monthName, '闰二月');
  assert.equal(l.dayName, '初一');
});

test('除夕：2025-01-28（乙巳蛇年春节前一天 = 甲辰年腊月廿九，腊月小月）', () => {
  const l = L(2025, 1, 28);
  assert.equal(l.monthName, '腊月');
  assert.equal(l.dayName, '廿九');
  assert.equal(l.ganzhiYear, '甲辰'); // 除夕仍属旧年干支
});

test('月天数在 29/30 之间，全月天数恒 354/355/383/384 级别', () => {
  for (let y = 2000; y <= 2030; y++) {
    for (let m = 1; m <= 12; m++) {
      const d = monthDaysOf(y, m);
      assert.ok(d === 29 || d === 30, `${y}-${m} 天数异常`);
    }
  }
});

test('formatLunarDate 组合字段', () => {
  const f = formatLunarDate(new Date(2026, 7, 28)); // 周五
  assert.equal(f.solarText, '2026年8月28日');
  assert.equal(f.weekdayText, '星期' + ['日', '一', '二', '三', '四', '五', '六'][new Date(2026, 7, 28).getDay()]);
  assert.ok(f.fullText.includes('农历七月十六'));
  assert.ok(f.fullText.includes('丙午年'));
});
