// tests/adaptive-retention.test.mjs —— 每科自适应目标保持率纯函数单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveRetention, subjectRetentionMap, retentionFor, RETENTION_MIN, RETENTION_MAX,
} from '../src/algorithms/adaptive-retention.js';

test('adaptiveRetention：掌握度端点与线性插值', () => {
  assert.equal(adaptiveRetention(0), RETENTION_MAX);   // 0.95
  assert.equal(adaptiveRetention(100), RETENTION_MIN); // 0.80
  assert.equal(adaptiveRetention(50), 0.88);           // 0.95 - 0.5*0.15 = 0.875 → 0.88
});

test('adaptiveRetention：无数据/非法值回退默认', () => {
  assert.equal(adaptiveRetention(null), 0.9);
  assert.equal(adaptiveRetention(undefined), 0.9);
  assert.equal(adaptiveRetention('abc'), 0.9);
  assert.equal(adaptiveRetention(null, 0.85), 0.85);
});

test('adaptiveRetention：越界夹取', () => {
  assert.equal(adaptiveRetention(-10), RETENTION_MAX); // 夹到 0 → 0.95
  assert.equal(adaptiveRetention(150), RETENTION_MIN); // 夹到 100 → 0.80
});

test('subjectRetentionMap：批量映射 + 空值过滤', () => {
  const map = subjectRetentionMap([
    { subject: '线性代数', mastery: 0 },
    { subject: '计算机网络', mastery: 100 },
    { subject: null, mastery: 50 }, // 跳过
  ]);
  assert.equal(map['线性代数'], 0.95);
  assert.equal(map['计算机网络'], 0.80);
  assert.equal(Object.keys(map).length, 2);
});

test('retentionFor：命中返回映射值，未命中回退默认', () => {
  const map = { '线性代数': 0.95 };
  assert.equal(retentionFor(map, '线性代数'), 0.95);
  assert.equal(retentionFor(map, '操作系统'), 0.9);
  assert.equal(retentionFor(map, null, 0.85), 0.85); // 无科目 → 未分类
});
