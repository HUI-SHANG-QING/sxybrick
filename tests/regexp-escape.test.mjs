// tests/regexp-escape.test.mjs —— round14 P2-D：用户数据进 RegExp 必转义
// 覆盖：
//   1) escapeRegExp 转义全部元字符（. * + ? ^ $ { } ( ) | [ ] \）
//   2) sentenceCloze 场景：含括号/星号的词构造 RegExp 不再抛 SyntaxError 且正确挖空
//   3) 未转义时确实崩溃（验证 P2-D 根因真实存在，转义是必要修复）
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegExp } from '../src/utils/regexp.js';

test('escapeRegExp：转义全部正则元字符', () => {
  assert.equal(escapeRegExp('a.b'), 'a\\.b');
  assert.equal(escapeRegExp('a*b'), 'a\\*b');
  assert.equal(escapeRegExp('a+b'), 'a\\+b');
  assert.equal(escapeRegExp('a?b'), 'a\\?b');
  assert.equal(escapeRegExp('(see)'), '\\(see\\)');
  assert.equal(escapeRegExp('a[b]'), 'a\\[b\\]');
  assert.equal(escapeRegExp('a{b}'), 'a\\{b\\}');
  assert.equal(escapeRegExp('a^b'), 'a\\^b');
  assert.equal(escapeRegExp('a$b'), 'a\\$b');
  assert.equal(escapeRegExp('a|b'), 'a\\|b');
  assert.equal(escapeRegExp('a\\b'), 'a\\\\b');
  assert.equal(escapeRegExp(null), '', 'null 安全');
  assert.equal(escapeRegExp(undefined), '', 'undefined 安全');
});

test('P2-D 场景：含元字符的词在 sentenceCloze 不崩溃且正确挖空', () => {
  // 未转义时确实抛 SyntaxError 的输入（P2-D 根因：未配对元字符 / 裸量词）
  assert.throws(() => new RegExp('(see', 'gi'), SyntaxError, '未配对左括号应抛 SyntaxError');
  assert.throws(() => new RegExp('a)', 'gi'), SyntaxError, '未配对右括号应抛 SyntaxError');
  assert.throws(() => new RegExp('*see', 'gi'), SyntaxError, '裸 * 应抛 SyntaxError');
  assert.throws(() => new RegExp('+ing', 'gi'), SyntaxError, '裸 + 应抛 SyntaxError');
  assert.throws(() => new RegExp('[abc', 'gi'), SyntaxError, '未配对 [ 应抛 SyntaxError');

  // 配对元字符不抛但语义错乱（RegExp('(see)') 是捕获组，只匹配 see 不含括号）——
  // 转义后按字面匹配，整词（含括号）正确挖空
  const literalCases = [
    { word: '(see)', sentence: 'Please (see) page 2 for details.' },
    { word: 'a (b)', sentence: 'This is a (b) test case.' },
    { word: '100%', sentence: 'The score reached 100% today.' },
  ];
  for (const { word, sentence } of literalCases) {
    const re = new RegExp(escapeRegExp(word), 'gi'); // 不再抛
    const out = sentence.replace(re, '____');
    assert.ok(!out.includes(word), `词 "${word}" 应被整体挖空（含括号）：${out}`);
    assert.ok(out.includes('____'), `应出现占位符：${out}`);
  }

  // 未配对元字符词：转义后安全（P2-D 崩溃路径的回归锚点）
  const brokenCases = [
    { word: '(see', sentence: 'Please (see page 2).' },
    { word: 'a)', sentence: 'a) test sentence here.' },
  ];
  for (const { word, sentence } of brokenCases) {
    const re = new RegExp(escapeRegExp(word), 'gi'); // 不再抛
    const out = sentence.replace(re, '____');
    assert.ok(out.includes('____'), `未配对词 "${word}" 转义后应能挖空：${out}`);
  }

  // 普通词不受影响
  const re = new RegExp(escapeRegExp('make sense of'), 'gi');
  assert.equal("I can't make sense of this passage.".replace(re, '____'), "I can't ____ this passage.");
});

test('P2-D 场景：大小写不敏感挖空（原句含大小写变体）', () => {
  const word = 'Achieve';
  const sentence = 'You can achieve your goals with hard work.';
  const re = new RegExp(escapeRegExp(word), 'gi');
  const out = sentence.replace(re, '____');
  assert.ok(!out.toLowerCase().includes('achieve'), '大小写变体也应挖空');
  assert.equal(out, 'You can ____ your goals with hard work.');
});
