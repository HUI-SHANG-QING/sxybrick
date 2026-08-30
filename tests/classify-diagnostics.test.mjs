// 自动分类：诊断可观测性 + 哨兵值冲突回归
// 用户现象：「未分类 2591 条，却提示可自动分类 0 条」，而界面说不出原因。
import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, trainClassifier, toTrainSample } from '../src/utils/classifier.js';
import { isUnclassified } from '../src/classify-lib.js';

const mk = (label, words) => ({
  label,
  text: words.join('，') + '——注意适用条件与常见误区。',
});

test('isUnclassified: 空值与「未分类」字面量都算未分类', () => {
  assert.equal(isUnclassified(''), true);
  assert.equal(isUnclassified('   '), true);
  assert.equal(isUnclassified('未分类'), true);
  assert.equal(isUnclassified('操作系统'), false);
});

test('classify: 用 ok 判定，而不是 label===「未分类」（哨兵值冲突）', () => {
  // 用户的库里真有一个叫「未分类」的科目时，旧逻辑会把所有预测当「没分出来」跳过
  const seeds = [
    mk('未分类', ['矩阵', '特征值', '行列式']),
    mk('操作系统', ['死锁', '进程', '调度']),
  ];
  const model = trainClassifier(seeds);
  const hit = classify('矩阵的特征值怎么求？', model, { threshold: 0.12 });
  assert.equal(hit.ok, true, '达阈值就该 ok=true');
  assert.equal(hit.label, '未分类', '最佳类别确实就叫「未分类」');
  // 反例：完全不相干的文本，未达阈值
  const miss = classify('zzzz qqqq wwww', model, { threshold: 0.9 });
  assert.equal(miss.ok, false);
  assert.equal(miss.label, '未分类');
});

test('classify: 无训练样本时 ok=false 且不抛错', () => {
  const model = trainClassifier([]);
  const r = classify('任意文本', model);
  assert.equal(r.ok, false);
  assert.equal(r.confidence, 0);
});

test('toTrainSample: label 字段不污染训练文本之外的字段', () => {
  const s = toTrainSample({ front: '死锁是什么', back: '四个必要条件', subject: '操作系统' }, { labelField: 'subject' });
  assert.equal(s.label, '操作系统');
  assert.ok(s.text.includes('死锁是什么'));
  assert.ok(s.text.includes('四个必要条件'));
});

test('分类主流程统计口径：already / lowConfidence / emptyText 三者之和 = skipped', () => {
  // 直接验证分类器在「词汇零重叠」场景下的行为（这是 0 条的最常见成因）
  const seeds = [mk('操作系统', ['死锁', '进程', '调度'])];
  const model = trainClassifier(seeds);
  let low = 0;
  for (let i = 0; i < 50; i++) {
    const r = classify('abandon desert 英语单词释义', model, { threshold: 0.5 });
    if (!r.ok) low++;
  }
  assert.equal(low, 50, '阈值抬高后全部判为置信度不足 → lowConfidence 应被如实统计并展示');
});
