// tests/calibration-feedback.test.mjs —— 校准闭环纯函数单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibratedRetention, calibrateFromStats,
  FEEDBACK_MIN, FEEDBACK_MAX, DEFAULT_GAIN, DEFAULT_MIN_SAMPLES,
} from '../src/algorithms/calibration-feedback.js';

test('bias=0：保持率不变', () => {
  assert.equal(calibratedRetention(0.9, 0), 0.9);
});

test('bias>0（高估记忆）：提高保持率（缩短间隔）', () => {
  // 0.9 + 0.5*0.10 = 0.95
  assert.equal(calibratedRetention(0.9, 0.10), 0.95);
});

test('bias<0（低估记忆）：降低保持率（延长间隔）', () => {
  // 0.9 + 0.5*(-0.10) = 0.85
  assert.equal(calibratedRetention(0.9, -0.10), 0.85);
});

test('越界夹取到 [0.80, 0.95]', () => {
  assert.equal(calibratedRetention(0.9, 0.50), FEEDBACK_MAX); // 0.9+0.25=1.15 → 0.95
  assert.equal(calibratedRetention(0.9, -0.50), FEEDBACK_MIN); // 0.9-0.25=0.65 → 0.80
});

test('bias 非法值/null：回退 base', () => {
  assert.equal(calibratedRetention(0.9, null), 0.9);
  assert.equal(calibratedRetention(0.9, undefined), 0.9);
  assert.equal(calibratedRetention(0.9, 'abc'), 0.9);
  assert.equal(calibratedRetention(0.85, null), 0.85);
});

test('增益参数可调', () => {
  assert.equal(calibratedRetention(0.9, 0.10, { gain: 1.0 }), 0.95); // 0.9+0.1=1.0 → clamp 0.95
  assert.equal(calibratedRetention(0.9, 0.04, { gain: 1.0 }), 0.94);
});

test('calibrateFromStats：样本不足回退，样本足够应用', () => {
  assert.equal(calibrateFromStats(0.9, { n: 10, bias: 0.10 }), 0.9); // 10 < 50 → 不校准
  assert.equal(calibrateFromStats(0.9, { n: DEFAULT_MIN_SAMPLES, bias: 0.10 }), 0.95);
  assert.equal(calibrateFromStats(0.9, null), 0.9);
});
