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
import { fitKnowledge, KNOWLEDGE_CHAR_BUDGET } from '../src/utils/knowledge-budget.js';
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
