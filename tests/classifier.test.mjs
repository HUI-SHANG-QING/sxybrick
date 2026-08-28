// 测试：自动分类器（TF-IDF + cosine，纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
const {
  tokenize, computeTf, computeIdf, buildTfidfVector,
  dot, norm, cosine, trainClassifier, predictCategory, classify, evaluateClassifier, toTrainSample,
} = await import('../src/utils/classifier.js');

// ──────────────── tokenize ────────────────

test('tokenize：英文单词分词 + 小写', () => {
  const f = tokenize('Cache and Memory');
  assert.ok(f.has('cache'));
  assert.ok(f.has('memory'));
  // 停用词 'and' 被过滤
  assert.ok(!f.has('and'));
});

test('tokenize：中文 bigram 切分', () => {
  const f = tokenize('矩阵的特征值');
  assert.ok(f.has('矩阵'));
  assert.ok(f.has('特征'));
  assert.ok(f.has('征值'));
  // 停用词 '的' 被过滤
  assert.ok(!f.has('的'));
});

test('tokenize：中英混合', () => {
  const f = tokenize('Cache 替换策略 LRU FIFO');
  assert.ok(f.has('cache'));
  assert.ok(f.has('替换'));
  assert.ok(f.has('lru'));
  assert.ok(f.has('fifo'));
});

test('tokenize：数字与符号处理', () => {
  const f = tokenize('第 3 章 存储系统');
  assert.ok(f.has('存储'));
  assert.ok(f.has('储系'));
  // 单数字 "3" 长度 <2 不保留
  assert.ok(!f.has('3'));
});

test('tokenize：空输入', () => {
  assert.equal(tokenize('').size, 0);
  assert.equal(tokenize(null).size, 0);
});

// ──────────────── TF-IDF ────────────────

test('computeTf：词频归一化', () => {
  const freq = new Map([['a', 2], ['b', 1]]);
  const tf = computeTf(freq, 3);
  assert.equal(tf.a, 2 / 3);
  assert.equal(tf.b, 1 / 3);
});

test('computeIdf：常见词 idf 低，罕见词 idf 高', () => {
  const docs = [
    { text: 'cache memory lru' },
    { text: 'cache memory fifo' },
    { text: 'cache 存储 系统' },
  ];
  const idf = computeIdf(docs);
  // cache 出现在全部 3 个文档，idf 最低
  assert.ok(idf.cache < idf.lru, `cache idf=${idf.cache} 应 < lru idf=${idf.lru}`);
  assert.ok(idf.cache < idf.存储, `cache idf=${idf.cache} 应 < 存储 idf=${idf.存储}`);
});

test('buildTfidfVector：加权向量', () => {
  const docs = [{ text: 'cache memory lru' }, { text: 'cache memory fifo' }];
  const idf = computeIdf(docs);
  const vocab = new Set(Object.keys(idf));
  const vec = buildTfidfVector('cache memory', idf, vocab);
  assert.ok(vec.cache > 0);
  assert.ok(vec.memory > 0);
  assert.ok(!('lru' in vec));
});

// ──────────────── 向量运算 ────────────────

test('dot：稀疏点积', () => {
  assert.equal(dot({ a: 1, b: 2 }, { b: 3, c: 4 }), 6);
  assert.equal(dot({ a: 1 }, {}), 0);
});

test('norm：L2 范数', () => {
  assert.equal(norm({ a: 3, b: 4 }), 5);
  assert.equal(norm({}), 0);
});

test('cosine：相似度', () => {
  assert.equal(cosine({ a: 1 }, { a: 1 }), 1);
  assert.equal(cosine({ a: 1 }, { b: 1 }), 0);
  assert.ok(Math.abs(cosine({ a: 1, b: 1 }, { a: 1, b: 1 }) - 1) < 1e-9);
  // 零向量
  assert.equal(cosine({}, { a: 1 }), 0);
});

// ──────────────── 训练 / 预测 ────────────────

const SAMPLE_DOCS = [
  { text: 'Cache 替换策略有 LRU 和 FIFO 随机替换', label: '计组' },
  { text: '主存 存储系统 层次结构 Cache 命中率', label: '计组' },
  { text: '矩阵的特征值 特征向量 线性相关 秩', label: '线代' },
  { text: '线性方程组的解 系数矩阵 增广矩阵 齐次', label: '线代' },
  { text: '编译原理 词法分析 语法分析 中间代码', label: '编译' },
  { text: '上下文无关文法 LL 分析 LR 分析 语法树', label: '编译' },
];

test('trainClassifier：类别中心向量 + labels', () => {
  const model = trainClassifier(SAMPLE_DOCS);
  assert.deepEqual(model.labels.sort(), ['线代', '编译', '计组'].sort());
  assert.ok(Object.keys(model.centroids).length === 3);
  assert.ok(model.vocab.size > 0);
});

test('predictCategory：同领域文本归类正确', () => {
  const model = trainClassifier(SAMPLE_DOCS);
  const r1 = predictCategory('Cache 主存 命中率 替换算法', model, { k: 1 });
  assert.equal(r1[0].label, '计组');
  const r2 = predictCategory('特征值 特征向量 相似矩阵 对角化', model, { k: 1 });
  assert.equal(r2[0].label, '线代');
  const r3 = predictCategory('语法分析 词法分析 LL(1)', model, { k: 1 });
  assert.equal(r3[0].label, '编译');
});

test('predictCategory：top-k 排序正确', () => {
  const model = trainClassifier(SAMPLE_DOCS);
  const r = predictCategory('矩阵 特征值 Cache 替换', model, { k: 3 });
  assert.equal(r.length, 3);
  // 分数递减
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score);
});

test('classify：阈值判定', () => {
  const model = trainClassifier(SAMPLE_DOCS);
  // 明确匹配
  const c1 = classify('Cache 替换策略 LRU FIFO 命中率 主存', model);
  assert.equal(c1.label, '计组');
  assert.ok(c1.confidence > 0.12);
  // 完全无关 → 未分类 + 建议（选无"方程/矩阵/Cache"等重叠字符的领域）
  const c2 = classify('中国历史 唐朝 皇帝 封建制度 科举', model);
  assert.equal(c2.label, '未分类');
  assert.ok(c2.suggestions.length >= 1);
});

test('evaluateClassifier：留一法准确率', () => {
  const r = evaluateClassifier(SAMPLE_DOCS);
  assert.ok(r.accuracy >= 0.8, `准确率应 ≥0.8，实际 ${r.accuracy}`);
  assert.equal(r.correct, 6); // 该数据集领域区分明显，应该全对
  assert.equal(r.total, 6);
});

// ──────────────── toTrainSample ────────────────

test('toTrainSample：从实体提取训练样本', () => {
  const s = toTrainSample({ front: 'Cache', back: 'LRU', subject: '计组' });
  assert.equal(s.label, '计组');
  assert.match(s.text, /Cache/);
  assert.match(s.text, /LRU/);
});

// ──────────────── 黄金路径 ────────────────

test('黄金路径：train → classify → 写回 subject', () => {
  // 1) 已有卡片作为 seed 训练
  const seeds = [
    { front: 'Cache 替换策略', back: 'LRU FIFO', subject: '计组' },
    { front: '主存 层次结构', back: 'Cache', subject: '计组' },
    { front: '特征值', back: '特征向量', subject: '线代' },
    { front: '线性方程组', back: '增广矩阵', subject: '线代' },
  ].map(s => toTrainSample(s, { labelField: 'subject', textField: 'front' }));
  const model = trainClassifier(seeds);

  // 2) 新卡片自动分类
  const newCard = { front: 'Cache 命中率 替换算法 主存', back: '...' };
  const pred = classify(newCard.front, model);
  assert.equal(pred.label, '计组');

  // 3) 写回 subject
  const finalCard = { ...newCard, subject: pred.label };
  assert.equal(finalCard.subject, '计组');
});

test('黄金路径：多领域混合自动归入', () => {
  const docs = SAMPLE_DOCS;
  const model = trainClassifier(docs);
  const testCases = [
    ['存储 主存 Cache 命中 替换', '计组'],
    ['矩阵 特征值 特征向量 相似', '线代'],
    ['词法 语法 编译 文法', '编译'],
  ];
  for (const [text, expected] of testCases) {
    const c = classify(text, model);
    assert.equal(c.label, expected, `"${text}" 应归 ${expected}，实际 ${c.label}`);
  }
});
