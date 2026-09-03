// tests/word-review-modes.test.mjs —— 13 种背诵模式契约护栏（round18）
// 用户报告三类缺陷：① 模式未按说明实现（出题方向倒挂/题干泄露答案）② 闪卡翻面后仍显英文
// ③ 部分模式题目区域空白（自适应两段式第二段选项不渲染）。
// WordReview.vue 的准备函数在 <script setup> 内不可单测，沿用 vue-template-guard 的
// 静态契约断言模式：编译 SFC 验证语法 + 逐模式断言关键实现锚点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';

const FILE = new URL('../src/views/WordReview.vue', import.meta.meta ? import.meta.url : import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = readFileSync(FILE, 'utf8');
const d = parse(SRC, { filename: FILE }).descriptor;

test('WordReview.vue SFC 可编译（语法零错）', () => {
  const s = compileScript(d, { id: 'test' });
  assert.ok(s.content.length > 1000);
  const t = compileTemplate({ source: d.template.content, filename: FILE, id: 'test' });
  assert.equal(t.errors.length, 0, `模板编译错误：${t.errors.join(' | ')}`);
});

const script = d.scriptSetup.content;
const tpl = d.template.content;

test('闪卡翻面：翻面后正面（英文词）必须翻走，只显示中文释义', () => {
  // showQWord 计算属性：flashcard 在 revealed 后不再显示词
  assert.match(script, /if\s*\(mode\.value === 'flashcard'\)\s*return !revealed\.value/, 'showQWord 必须对 flashcard 按 revealed 翻面');
  // 模板必须用 showQWord 驱动 q-word，而非硬编码模式清单
  assert.match(tpl, /v-if="showQWord"/, 'q-word 必须由 showQWord 驱动');
  assert.ok(!tpl.includes("['adaptive','flashcard','choice','spell','readAloud','quiz'].includes(mode)"), '不得再用硬编码模式清单控制 q-word');
});

test('自适应两段式：第二段强化选择题必须可渲染（此前选项区空白根因）', () => {
  assert.match(tpl, /\(mode==='adaptive' && adaptiveStage===2\)/, 'opts 选项块必须覆盖 adaptive 第二段');
  assert.match(script, /adaptiveStage\.value = 2/, '忘记时切第二段');
});

test('英英释义：题干必须是英文素材，不得泄露 word 或退化成中文 defs 直出', () => {
  assert.match(script, /function prepareEnglishEnglish/, 'prepareEnglishEnglish 必须存在');
  assert.match(script, /eeSynonymPrefix/, '同义词优先');
  assert.match(tpl, /v-if="mode === 'englishEnglish'"[\s\S]{0,200}\{\{ eePrompt \}\}/, '题干必须绑定 eePrompt');
  assert.ok(!/mode === 'englishEnglish'[\s\S]{0,260}defs\.map/.test(tpl), '英英题干不得直出 defs 中文释义');
});

test('词组搭配：题干 = 中文释义 + 目标词挖空的搭配提示，无数据时显式标注不空白', () => {
  assert.match(script, /function prepareCollocations/);
  assert.match(tpl, /v-if="mode === 'collocations'"[\s\S]{0,300}collocMeaning/, '搭配题干必须绑定 collocMeaning');
  assert.match(tpl, /collocPrompt/, '搭配提示必须绑定 collocPrompt');
  assert.match(tpl, /collocFallbackHint/, '无数据兜底提示');
});

test('出题方向：反向/英英/搭配选项必须是英文单词（pickMeaning=false）', () => {
  assert.match(script, /const pickMeaning = \['choice', 'listenChoice'\]\.includes\(mode\.value\)/, '只有看词选义/听音选义 pickMeaning=true');
  // pickMeaning=true 清单里绝不能混入 reverseChoice/englishEnglish/collocations（题干选项同侧倒挂）
  const pickLine = script.match(/const pickMeaning = \[[^\]]*\]\.includes\(mode\.value\)[^\n]*/)?.[0] || '';
  for (const m of ['reverseChoice', 'englishEnglish', 'collocations']) {
    assert.ok(!pickLine.includes(m), `pickMeaning=true 清单不得包含 ${m}（选项会与题干同侧）`);
  }
});

test('综合选择题：必须在看词选义/看义选词间随机', () => {
  assert.match(script, /quizDir\.value = Math\.random\(\) < 0\.5 \? 'en2zh' : 'zh2en'/);
  assert.match(tpl, /v-if="showQPromptZh"/, '看义方向题干必须渲染中文释义');
});

test('跟读朗读：进入题目自动朗读一遍', () => {
  assert.match(script, /\['listenChoice', 'listenSpell', 'readAloud'\]\.includes\(mode\.value\)/);
});

test('看词写义（spell）：答案比对中文释义', () => {
  assert.match(script, /mode\.value === 'spell' \? String\(c\.meaning \|\| ''\)\.trim\(\) : String\(c\.word \|\| ''\)\.trim\(\)/);
  assert.match(script, /typeMeaning/, '输入框提示写中文释义');
});

test('闪卡/跟读自评：自评后必须能看到释义（meaning-show 由 result 驱动）', () => {
  assert.match(script, /result\.value = \{ correct: rating >= 2, selfRated: true, rating \}/);
  assert.match(tpl, /mode==='readAloud' && result/);
});

test('i18n：模式提示键齐全（zh/en 双语）', () => {
  const dict = readFileSync(new URL('../src/i18n/views/wordReview.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8');
  for (const key of ['eeSynonymPrefix', 'eeFallbackHint', 'collocFallbackHint', 'flipHint', 'noMeaningHint', 'commitFailed']) {
    const n = (dict.match(new RegExp(`^\\s*${key}:`, 'gm')) || []).length;
    assert.ok(n >= 2, `键 ${key} 必须在 zh/en 双语段各出现一次（实际 ${n} 次）`);
  }
});
