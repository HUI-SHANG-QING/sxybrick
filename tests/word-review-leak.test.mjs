// tests/word-review-leak.test.mjs —— 单词背诵页「答案泄露」防回归
//
// 背景：cloze（填空拼写）与 sentenceCloze（例句挖空）两种模式的题干本该只显示各自的
// 挖空形式（q-cloze / q-sent），却因题干区把这两种 mode 一并列进「显示完整英文词」
// （class="q-word"）的列表，导致挖空旁边直接亮出完整单词 = 答案泄露；
// 且 sentenceCloze 无例句时还 `input.value = c.word` 预填答案，用户直接照抄提交。
//
// 修复（2026-09-02）：
//   1) q-word 的 mode 列表剔除 cloze / sentenceCloze；
//   2) prepareSentenceCloze 无例句时退化为「看释义拼单词」，输入框留空、绝不预填。
// 本测试用静态扫描锁死这两条约束，防止日后回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const src = readFileSync(join(SRC, 'views', 'WordReview.vue'), 'utf8');

test('题干 q-word 显示完整单词的模式列表，不含挖空类 cloze / sentenceCloze', () => {
  const m = src.match(/<div v-if="\[([^\]]*)\]\.includes\(mode\)" class="q-word">/);
  assert.ok(m, '应存在 q-word 的 mode 列表');
  const list = m[1];
  // 看词写义（spell）仍需显示英文词——它是「看英文写中文」，不是答案泄露
  assert.ok(list.includes("'spell'"), 'spell 看词写义应保留显示英文词');
  assert.ok(!list.includes('cloze'), 'cloze 挖空拼写：题干不应再露完整单词');
  assert.ok(!list.includes('sentenceCloze'), 'sentenceCloze 例句挖空：题干不应再露完整单词');
});

test('例句挖空无例句时不得预填完整单词到输入框', () => {
  assert.ok(
    !/input\.value\s*=\s*c\.word/.test(src),
    'prepareSentenceCloze 无例句分支不得 input.value = c.word 预填答案',
  );
});

test('选择题 pickMeaning 方向正确：看词选义（choice/listenChoice/quiz），看义选词（reverse/englishEnglish/collocations）', () => {
  // 修复（2026-08-29）：此前 pickMeaning 只对 reverseChoice/englishEnglish 为 true，
  // 导致 choice/listenChoice/quiz 题干显示英文词、选项也列英文词（题干=答案倒挂）。
  // 锁死正确写法：pickMeaning = [...看词选义...].includes(mode.value)。
  const m = src.match(/const pickMeaning\s*=\s*\[([^\]]*)\]\.includes\(mode\.value\);/);
  assert.ok(m, '应存在 pickMeaning = [...].includes(mode.value) 的写法');
  const list = m[1];
  assert.ok(list.includes("'choice'"), 'choice 看词选义 → pickMeaning=true');
  assert.ok(list.includes("'listenChoice'"), 'listenChoice 听音选义 → pickMeaning=true');
  assert.ok(list.includes("'quiz'"), 'quiz 看词选义 → pickMeaning=true');
  assert.ok(!list.includes('reverseChoice'), 'reverseChoice 看义选词 → 不应在 pickMeaning 列表');
  assert.ok(!list.includes('englishEnglish'), 'englishEnglish 看英英选词 → 不应在 pickMeaning 列表');
  assert.ok(!list.includes('collocations'), 'collocations 看义选词 → 不应在 pickMeaning 列表');
});

test('看词写义（spell）答案比对中文释义，不比对英文单词', () => {
  // spell 模式题干已显示英文词，作答应比对 c.meaning（中文释义）；
  // 此前 submitText 一律比对 c.word，等于要求把已亮出的英文词重打一遍（答案泄露 + 问答不合理）。
  assert.ok(
    /mode\.value\s*===\s*'spell'\s*\?\s*String\(c\.meaning\s*\|\|\s*''\)\.trim\(\)\s*:\s*c\.word/.test(src),
    'spell 应比对 c.meaning（中文释义），其余模式比对 c.word',
  );
});
