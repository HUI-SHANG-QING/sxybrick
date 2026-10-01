// tests/knowledge-budget.test.mjs —— 「喂给 LLM 的知识点」按实际长度喂（round132 定案）
//
// 背景：`genQuiz.js` 此前对每张卡硬砍「题干 120 字 / 答案 150 字」。那是卡片上限还只有
//   数千字时代的保守假设；卡片上限提到 50000（round129）后假设失效 ——
//   用户写满的长卡，AI 只看得到开头一小段（**写 50000 字与写 200 字，喂进去的一样多**）。
//   用户诉求（原文）：「卡片实际多少字，AI 出题就应该能看到多少字，而不是直接 50000 或 120」。
//
// 本闸门锁两件事：
//   ① 行为：装得下就一个字都不砍；装不下才收窄，且收窄得公平（短卡不动、长卡等比缩）。
//   ② 结构：`genQuiz.js` 必须真的走这条路，不得再出现 120 / 150 那对硬编码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitKnowledge, KNOWLEDGE_CHAR_BUDGET, KNOWLEDGE_MIN_BUDGET, pickKnowledgeCards, looksLikeContextOverflowError, nextBudget } from '../src/utils/knowledge-budget.js';
import { CARD_MAX_CHARS } from '../src/utils/card-limits.js';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ---------- ① 行为 ----------

test('round132：卡组总量在预算内 → 一个字都不砍（卡片写多少，AI 就看多少）', () => {
  const long = '知'.repeat(5000);
  const items = [
    { id: 'a', q: long, a: long },
    { id: 'b', q: '短题干', a: '短答案' },
  ];
  const out = fitKnowledge(items);
  assert.equal(out[0].q.length, 5000, '5000 字的题干必须原样喂进去（旧实现会砍到 120）');
  assert.equal(out[0].a.length, 5000, '答案同理（旧实现会砍到 150）');
  assert.equal(out[1].q, '短题干');
  assert.equal(out, items, '装得下时必须**原数组直接返回**（零拷贝、零改写）');
});

test('round132：单张写满上限的卡（50000 字）能被完整喂给 AI —— 这是本轮修复的核心', () => {
  const text = '知'.repeat(CARD_MAX_CHARS);
  const out = fitKnowledge([{ id: 'x', q: text, a: text }]);
  assert.equal(out[0].q.length, CARD_MAX_CHARS, '卡片上限内写满的题干必须完整可见');
  assert.equal(out[0].a.length, CARD_MAX_CHARS, '答案必须完整可见');
});

test('round132：装不下时短卡一字不动、长卡同等收窄，且预算被用满（水填式，不是摊薄）', () => {
  const budget = 1000;
  const items = [
    { id: 'short', q: 'A'.repeat(50), a: 'B'.repeat(50) },
    { id: 'huge1', q: 'C'.repeat(5000), a: 'D'.repeat(5000) },
    { id: 'huge2', q: 'E'.repeat(5000), a: 'F'.repeat(5000) },
  ];
  const out = fitKnowledge(items, budget);

  // 这是「水填式」与「每张都砍到 预算/张数」的分水岭：短卡必须毫发无损
  assert.equal(out[0].q, 'A'.repeat(50), '短卡题干必须原样保留');
  assert.equal(out[0].a, 'B'.repeat(50), '短卡答案必须原样保留');
  assert.equal(out[0], items[0], '短卡应按原引用返回');

  assert.ok(out[1].q.length < 5000, '超长卡确实被收窄了');
  const used = out.reduce((n, it) => n + it.q.length + it.a.length, 0);
  assert.ok(used <= budget, `收窄后总量 ${used} 必须 ≤ 预算 ${budget}`);
  // 关键差异点：短卡省下的额度必须**转移给长卡**，而不是白白摊薄掉。
  // 若实现退化为「每张按 预算/张数 摊一层」（与旧的固定 120 是同一种错，只是数字变大），
  // 这里只会得到 764（长卡各 166），本断言会红 —— 而长卡本可以在同样预算下多喂近 3 倍内容。
  assert.ok(
    used >= budget - items.length,
    `预算必须被用满（容差 ${items.length} 字）：实际 ${used} / ${budget} —— `
    + '偏少说明是按张数摊薄，长卡本可以多喂几倍的内容。',
  );
  assert.equal(out[1].q.length, out[2].q.length, '同样超长的卡必须被同等对待（公平性）');
});

test('round132：预算小到放不下时每卡仍至少留 1 字，不产生空内容', () => {
  const out = fitKnowledge([{ q: 'AAAA', a: 'BBBB' }], 1);
  assert.equal(out[0].q.length, 1, '至少留 1 字，让模型看得出这张卡"有东西"');
  assert.equal(out[0].a.length, 1);
});

test('round132：空列表 / 非法预算都安全返回，不抛错也不误砍', () => {
  assert.deepEqual(fitKnowledge([]), []);
  assert.deepEqual(fitKnowledge(null), []);
  const items = [{ q: 'x'.repeat(100), a: 'y'.repeat(100) }];
  assert.equal(fitKnowledge(items, 0), items, '预算为 0 属非法 → 退化为「不砍」');
  assert.equal(fitKnowledge(items, NaN), items);
  assert.equal(fitKnowledge(items, -5), items);
  assert.equal(fitKnowledge(items, Infinity), items);
});

test('round132：预算必须 ≥ 单张卡片上限 × 2（题干 + 答案都写满也要装得下）', () => {
  assert.ok(
    KNOWLEDGE_CHAR_BUDGET >= CARD_MAX_CHARS * 2,
    `预算 ${KNOWLEDGE_CHAR_BUDGET} 必须 ≥ 卡片上限 ${CARD_MAX_CHARS} × 2 —— `
    + '否则「一张合法卡片的内容」本身就喂不进去，修复失去意义。'
    + '（若将来调整 CARD_MAX_CHARS，这里会先红，提醒同步预算。）',
  );
});

// ---------- ② 结构：防止 genQuiz 再走回硬编码 ----------

test('round132：genQuiz.js 必须调用 fitKnowledge，且不得残留 120 / 150 硬砍', () => {
  const src = read(`${SRC}/utils/genQuiz.js`);
  assert.match(src, /fitKnowledge\s*\(/, 'genQuiz.js 必须走 fitKnowledge（按实际长度喂）');
  assert.doesNotMatch(
    src,
    /plain\(c\.front\)\.slice\(0,\s*120\)/,
    '不得残留旧的「题干砍 120」硬编码（卡片上限已 50000，该数字会把长卡砍成残废）',
  );
  assert.doesNotMatch(
    src,
    /plain\(c\.back\)\.slice\(0,\s*150\)/,
    '不得残留旧的「答案砍 150」硬编码',
  );
});

// ===== round136：出题选卡（F1）与预算减半自适应重试（F2）=====

test('pickKnowledgeCards：卡池 ≤ cap 原样返回（全量参与，行为与旧版一致）', () => {
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(pickKnowledgeCards(cards, 30), cards);
  assert.deepEqual(pickKnowledgeCards(cards, 3), cards);
});

test('pickKnowledgeCards：卡池 > cap 随机抽 cap 张——不重复、都来自卡池', () => {
  const cards = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}` }));
  const picked = pickKnowledgeCards(cards, 30, () => 0.42);
  assert.equal(picked.length, 30);
  assert.equal(new Set(picked.map((c) => c.id)).size, 30, '抽样不得重复（Fisher-Yates 不放回）');
  for (const c of picked) {
    assert.ok(cards.includes(c), '抽出的卡必须来自卡池（是引用不是新造）');
  }
});

test('pickKnowledgeCards：rng 可注入——同一 rng 结果确定（可测性）', () => {
  const cards = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` }));
  assert.deepEqual(pickKnowledgeCards(cards, 10, () => 0), pickKnowledgeCards(cards, 10, () => 0));
});

test('pickKnowledgeCards：边界——空池 / 非法 cap 不抛错', () => {
  assert.deepEqual(pickKnowledgeCards([], 30), []);
  assert.deepEqual(pickKnowledgeCards(null, 30), []);
  assert.deepEqual(pickKnowledgeCards([{ id: 'a' }], 0), []);
  assert.deepEqual(pickKnowledgeCards([{ id: 'a' }], NaN), []);
  assert.deepEqual(pickKnowledgeCards([{ id: 'a' }], -5), []);
});

test('looksLikeContextOverflowError：超长类命中（中英文网关措辞都要认）', () => {
  assert.equal(looksLikeContextOverflowError("This model's maximum context length is 65536 tokens"), true);
  assert.equal(looksLikeContextOverflowError('prompt is too long: 200000 tokens > 131072 maximum'), true);
  assert.equal(looksLikeContextOverflowError('上下文长度超出限制'), true);
  assert.equal(looksLikeContextOverflowError('输入过长，请缩减后重试'), true);
});

test('looksLikeContextOverflowError：重试也救不了的错误不命中（防白打请求）', () => {
  assert.equal(looksLikeContextOverflowError('请先在「AI 设置」里填入 API 密钥'), false, '鉴权类');
  assert.equal(looksLikeContextOverflowError('AI 请求失败'), false, '无特征的通用错误');
  assert.equal(looksLikeContextOverflowError('max_tokens too large'), false, '输出上限超限：砍输入无用');
  assert.equal(looksLikeContextOverflowError('Invalid token passed'), false, '鉴权类');
  assert.equal(looksLikeContextOverflowError('rate limit exceeded, retry after 20s'), false, '限流类');
  assert.equal(looksLikeContextOverflowError(''), false);
  assert.equal(looksLikeContextOverflowError(undefined), false);
});

test('nextBudget：逐次减半且不低于下限（200000 → … → 12500 稳定）', () => {
  let b = KNOWLEDGE_CHAR_BUDGET;
  const seq = [];
  while (b > KNOWLEDGE_MIN_BUDGET && seq.length < 10) {
    b = nextBudget(b);
    seq.push(b);
  }
  assert.deepEqual(seq, [100000, 50000, 25000, 12500]);
  assert.equal(nextBudget(12500), 12500, '到下限后稳定，不再下降');
  assert.equal(nextBudget(0), 12500, '非法入参回落下限');
  assert.equal(nextBudget(NaN), 12500, '非法入参回落下限');
});

test('genQuiz.js 结构闸：出题选卡与自适应降载必须走本模块（round136 F1/F2）', () => {
  const src = read(`${SRC}/utils/genQuiz.js`);
  assert.match(src, /pickKnowledgeCards\s*\(/, '出题选卡必须走 pickKnowledgeCards（随机抽样，F1）');
  assert.match(src, /looksLikeContextOverflowError\s*\(/, '超长类错误必须经 looksLikeContextOverflowError 识别（F2）');
  assert.match(src, /nextBudget\s*\(/, '预算减半必须走 nextBudget（F2）');
  assert.doesNotMatch(
    src,
    /cards\.slice\(0,\s*30\)/,
    '不得残留旧的「表序取前 30」硬编码（F1：改随机抽样）',
  );
});

test('round137 结构闸：F1 抽样必须在 F2 重试循环之外（重试不得换卡组）', () => {
  const src = read(`${SRC}/utils/genQuiz.js`);
  // 抽样（const picked = pickKnowledgeCards）必须出现在 for(;;) 之前——否则每次
  // 预算减半重试都会重新随机抽样，减半作用在不同卡组上，F2 语义落空且浪费请求。
  assert.match(
    src,
    /const picked = pickKnowledgeCards\s*\(\s*cards\s*,\s*30\s*\)\s*;[\s\S]{0,400}?for\s*\(\s*;\s*;\s*\)/,
    'pickKnowledgeCards 必须在重试循环外只执行一次（F1×F2 交互：重试复用同一卡池）',
  );
  // 反模式：循环体内不得再出现 pickKnowledgeCards 调用（重抽样）
  assert.doesNotMatch(
    src,
    /for\s*\(\s*;\s*;\s*\)[\s\S]{0,600}?pickKnowledgeCards\s*\(/,
    '重试循环体内不得再次调用 pickKnowledgeCards（会换掉卡组）',
  );
});
