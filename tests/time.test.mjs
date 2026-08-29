// 时刻解析与比较测试（P0 回归：提醒时间字符串比较 BUG）
//
// 历史缺陷：App.vue 用 `${d.getHours()}:${padStart(minutes)}` 拼串后与 "21:30" 作字典序比较。
// 小时未补零 → "9:05" >= "21:30" 恒为 true（"9" > "2"），
// 于是 21:30 的提醒在早上 9:05 就触发，并占掉当日唯一名额，真正的提醒永不触发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinutesOfDay, parseHm, hasReached, formatHm } from '../src/utils/time.js';

const at = (h, m) => new Date(2026, 7, 29, h, m, 0, 0);

// ---------- parseHm ----------

test('parseHm: 标准 HH:mm 与 H:mm 均可解析', () => {
  assert.equal(parseHm('21:30'), 21 * 60 + 30);
  assert.equal(parseHm('9:05'), 9 * 60 + 5);
  assert.equal(parseHm('09:05'), 9 * 60 + 5);
  assert.equal(parseHm('00:00'), 0);
  assert.equal(parseHm('23:59'), 23 * 60 + 59);
});

test('parseHm: 容忍空格与全角冒号', () => {
  assert.equal(parseHm('  21:30  '), 21 * 60 + 30);
  assert.equal(parseHm('21：30'), 21 * 60 + 30);
});

test('parseHm: 非法输入返回 null（不返回 0，避免 00:00 误判为已到点）', () => {
  for (const bad of ['', '   ', 'abc', '25:00', '12:60', '-1:00', '12', '12:', ':30', '1:2:3', null, undefined, NaN]) {
    assert.equal(parseHm(bad), null, `非法值 ${JSON.stringify(bad)} 应返回 null`);
  }
  assert.notEqual(parseHm(''), 0, '空串不得等价于 00:00');
});

// ---------- 核心回归：字符串比较会误判，分钟比较不会 ----------

test('P0 回归: 早上 9:05 不应判定「已到 21:30」', () => {
  // 这是原 BUG 的直接回归：字符串比较下 "9:05" >= "21:30" 为 true
  assert.ok('9:05' >= '21:30', '前置确认：字符串比较确实是 true（这正是原 BUG）');
  assert.equal(hasReached('21:30', at(9, 5)), false, '分钟比较下 9:05 未到 21:30');
});

test('P0 回归: 补零写法同样不误判', () => {
  assert.equal(hasReached('09:30', at(9, 5)), false, '9:05 未到 09:30');
  assert.equal(hasReached('09:30', at(9, 30)), true, '9:30 已到 09:30');
  assert.equal(hasReached('09:30', at(10, 0)), true, '10:00 已过 09:30');
});

test('P0 回归: 跨整点的误判场景（原 BUG 重灾区）', () => {
  // "9:05" vs "10:00"：字符串比 "9" > "1" → true（错）；实际 9:05 < 10:00
  assert.equal(hasReached('10:00', at(9, 5)), false);
  // "2:00" vs "19:00"：字符串 "2" > "1" → true（错）
  assert.equal(hasReached('19:00', at(2, 0)), false);
  assert.equal(hasReached('19:00', at(19, 0)), true);
  assert.equal(hasReached('19:00', at(20, 30)), true);
});

test('P0 回归: 逐分钟扫描全天，判定必须与真实时刻一致', () => {
  const TARGET = '21:30';
  const targetMin = 21 * 60 + 30;
  let flipped = false;
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 1) {
      const cur = h * 60 + m;
      const expected = cur >= targetMin;
      assert.equal(hasReached(TARGET, at(h, m)), expected, `${h}:${m} 判定错误`);
      if (expected) flipped = true;
    }
  }
  assert.equal(flipped, true, '全天扫描中应存在「已到点」的时刻');
});

test('hasReached: 非法目标时间一律返回 false（绝不误触发）', () => {
  for (const bad of ['', 'abc', '25:00', null, undefined]) {
    assert.equal(hasReached(bad, at(23, 59)), false, `${JSON.stringify(bad)} 不应触发`);
  }
});

test('hasReached: 默认取当前时间（不传 now 不抛错）', () => {
  assert.equal(typeof hasReached('00:00'), 'boolean', '00:00 必定已到（除极端时钟问题）');
  assert.equal(hasReached('23:59'), new Date().getHours() * 60 + new Date().getMinutes() >= 23 * 60 + 59);
});

// ---------- toMinutesOfDay / formatHm ----------

test('toMinutesOfDay: 正确换算', () => {
  assert.equal(toMinutesOfDay(at(0, 0)), 0);
  assert.equal(toMinutesOfDay(at(1, 5)), 65);
  assert.equal(toMinutesOfDay(at(23, 59)), 1439);
  assert.equal(toMinutesOfDay(new Date('bad')), NaN, '非法日期返回 NaN');
  assert.equal(toMinutesOfDay(null), NaN);
});

test('formatHm: 往返一致且补零', () => {
  assert.equal(formatHm(0), '00:00');
  assert.equal(formatHm(9 * 60 + 5), '09:05');
  assert.equal(formatHm(21 * 60 + 30), '21:30');
  assert.equal(formatHm(parseHm('21:30')), '21:30', 'parse → format 往返一致');
  assert.equal(formatHm(parseHm('9:05')), '09:05', '单位数小时应补零');
  assert.equal(formatHm(NaN), '');
});
