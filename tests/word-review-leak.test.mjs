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
  // v29+ 改为 showQWord computed 属性控制（支持 flashcard 翻面后隐藏词、quiz 随机方向）
  const m = src.match(/const showQWord\s*=\s*computed\(\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(m, '应存在 showQWord computed 属性');
  const body = m[1];
  // 看词写义（spell）仍需显示英文词——它是「看英文写中文」，不是答案泄露
  assert.ok(body.includes("'spell'"), 'spell 看词写义应保留显示英文词');
  assert.ok(!body.includes("'cloze'"), 'cloze 挖空拼写：题干不应再露完整单词');
  assert.ok(!body.includes("'sentenceCloze'"), 'sentenceCloze 例句挖空：题干不应再露完整单词');
  assert.ok(body.includes("'flashcard'"), '闪卡模式应包含在 showQWord（翻面前显示词）');
  assert.ok(!body.includes("'listenChoice'"), '听音模式题干不显示文字（只有播音按钮）');
});

test('例句挖空无例句时不得预填完整单词到输入框', () => {
  assert.ok(
    !/input\.value\s*=\s*c\.word/.test(src),
    'prepareSentenceCloze 无例句分支不得 input.value = c.word 预填答案',
  );
});

test('选择题 pickMeaning 方向正确：看词选义（choice/listenChoice/quiz-en2zh），看义选词（reverse/englishEnglish/collocations/quiz-zh2en）', () => {
  // v29+ quiz 模式改为随机方向（en2zh / zh2en），pickMeaning 写法变为
  // const pickMeaning = ['choice','listenChoice'].includes(mode.value) || (mode.value==='quiz' && quizDir.value==='en2zh');
  const m = src.match(/const pickMeaning\s*=\s*\[([^\]]*)\]\.includes\(mode\.value\)/);
  assert.ok(m, '应存在 pickMeaning = [...].includes(mode.value) 的基础写法');
  const list = m[1];
  assert.ok(list.includes("'choice'"), 'choice 看词选义 → pickMeaning=true');
  assert.ok(list.includes("'listenChoice'"), 'listenChoice 听音选义 → pickMeaning=true');
  assert.ok(!list.includes('reverseChoice'), 'reverseChoice 看义选词 → 不应在 pickMeaning 基础列表');
  assert.ok(!list.includes('englishEnglish'), 'englishEnglish 看英英选词 → 不应在 pickMeaning 基础列表');
  assert.ok(!list.includes('collocations'), 'collocations 看义选词 → 不应在 pickMeaning 基础列表');
  // quiz 随机方向：en2zh 时 pickMeaning=true，zh2en 时 pickMeaning=false
  assert.ok(/mode\.value\s*===\s*'quiz'/.test(src.match(/const pickMeaning[\s\S]*?options\.value\s*=\s*buildChoices/)?.[0] || ''),
    'quiz 模式应有随机方向判定');
});

test('看词写义（spell）答案比对中文释义，不比对英文单词', () => {
  // spell 模式题干已显示英文词，作答应比对 c.meaning（中文释义）；
  // 此前 submitText 一律比对 c.word，等于要求把已亮出的英文词重打一遍（答案泄露 + 问答不合理）。
  assert.ok(
    /mode\.value\s*===\s*'spell'\s*\?\s*String\(c\.meaning\s*\|\|\s*''\)\.trim\(\)\s*:\s*String\(c\.word\s*\|\|\s*''\)\.trim\(\)/.test(src),
    'spell 应比对 c.meaning（中文释义），其余模式比对 c.word',
  );
});
