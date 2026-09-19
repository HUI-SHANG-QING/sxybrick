// tests/round119-md-colors.test.mjs —— round119：卡片 Markdown 的 6 色强调体系
//
// 用户诉求：卡片 Markdown 应有主流学习笔记的强调色（红/蓝/绿…），并固定成一套用法。
//
// 就此固化一套 6 色体系（与配色用途写在 Makefile 式的说明里，避免各色混用）：
//   ==x==  黄底高亮  疑问 / 待查 / 待背
//   !!x!!  红        重点 / 考点 / 易错点 / 订正
//   @@x@@  蓝        定义 / 概念 / 公式 / 自己的理解
//   ++x++  绿        正确答案 / 解法 / 拓展 / 已掌握
//   ^^x^^  橙        高频考点 / 重要提醒
//   %%x%%  紫        总结 / 框架 / 难点 / 易混淆
//   规则：同一颜色始终代表同一类信息，全文颜色不超过 4~5 种。
//
// ⚠️ 本轮踩到一个自己引入的坑，已修并在此钉死：
//   内部占位符原为 `@@MDS0@@`，而新加的蓝色语法恰好也是 `@@…@@`
//   → 蓝色规则把上一批占位符当成自己的内容二次吞噬，
//     导致 `==高亮==` / `!!红!!` 被渲染成字符串 "MDS0"。
//   修法：占位符改用**用户打不出来的私用区字符**（U+E000/U+E001）包裹。
//   本文件把「占位符不得使用用户可输入符号」作为断言钉住，防止复发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MD = readFileSync(new URL('../src/components/MarkdownRenderer.vue', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../src/i18n/index.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------- 渲染规则

test('6 色强调语法齐备（黄/红/蓝/绿/橙/紫）', () => {
  const rules = [
    [/==\(\[\^=\\n\]\+\?\)==/, 'md-hl', '黄底高亮'],
    [/!!\(\[\^!\\n\]\+\?\)!!/, 'md-red', '红色重点'],
    [/\\\+\\\+\(\[\^\+\\n\]\+\?\)\\\+\\\+/, 'md-green', '绿色答案'],
    [/@@\(\[\^@\\n\]\+\?\)@@/, 'md-blue', '蓝色定义'],
    [/%%.*?%%/, 'md-purple', '紫色总结'],
    [/\\\^\\\^.*?\\\^\\\^/, 'md-orange', '橙色考点'],
  ];
  for (const [re, cls, label] of rules) {
    assert.match(MD, re, `缺 ${label} 的匹配规则（${cls}）`);
    assert.ok(MD.includes(`"${cls}"`), `规则应产出 class="${cls}"`);
  }
});

test('强调内容必须转义后再拼进 HTML（防用户原文被当标签解析）', () => {
  // 每一处 put(<span ...>) 里的插值都必须是 escapeText(...)
  const puts = MD.match(/put\(`<(?:mark|span)[^`]*`\)/g) || [];
  assert.ok(puts.length >= 6, `应有至少 6 条强调规则，实际 ${puts.length}`);
  for (const p of puts) {
    assert.match(p, /escapeText\(/, `未转义：${p.slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------- 占位符隔离（本轮踩坑点）

test('内部占位符必须用用户打不出的私用区字符（否则会被强调语法二次吞噬）', () => {
  assert.match(MD, /const PH_L = '\\uE000';/, '占位符左界应为 U+E000');
  assert.match(MD, /const PH_R = '\\uE001';/, '占位符右界应为 U+E001');
  assert.match(MD, /\\uE000MDS\(\\d\+\)\\uE001/, '还原时按同一格式匹配');
  // 只校验代码本身 —— 注释里会引用历史事故的 @@MDS0@@，不该被误判
  const putLine = MD.split('\n').find((l) => l.includes('stash.push(html)') && l.includes('return'));
  assert.ok(putLine, '应能找到 put() 的返回语句');
  assert.ok(!putLine.includes('@@'), `put() 不得再返回 @@ 包裹的占位符：${putLine.trim()}`);
});

// ---------------------------------------------------------------- 样式

test('6 色样式齐备，且走主题变量（深色/护眼主题自动换色）', () => {
  const need = [
    ['.md-body .md-hl', '黄底'],
    ['.md-body .md-red', '红'],
    ['.md-body .md-blue', '蓝'],
    ['.md-body .md-green', '绿'],
    ['.md-body .md-orange', '橙'],
    ['.md-body .md-purple', '紫'],
  ];
  for (const [sel, label] of need) {
    assert.ok(CSS.includes(sel), `缺 ${label} 样式：${sel}`);
  }
  // 颜色一律用变量 + 兜底值，保证任意主题下都能显示
  for (const v of ['--red', '--blue', '--green', '--amber', '--purple']) {
    assert.ok(CSS.includes(`var(${v},`), `${v} 应带兜底色值`);
  }
  assert.match(CSS, /--purple:\s*#[0-9a-f]{6};/i, ':root 应定义 --purple');
  assert.match(CSS, /--purple:\s*#[0-9a-f]{6};/i, '深色主题也应定义 --purple');
});

// ---------------------------------------------------------------- 用户可见的说明

test('编辑器里的语法提示要列全 6 色（用户靠它知道怎么用），并走 i18n', () => {
  assert.match(I18N, /mdSyntax:/, '应有 components.cardModal.mdSyntax 字典键');
  const zh = I18N.match(/mdSyntax: '([^']*)'/);
  assert.ok(zh, '字典里要有中文写法');
  for (const token of ['==', '!!', '@@', '++', '^^', '%%']) {
    assert.ok(zh[1].includes(token), `中文提示里应列出 ${token}`);
  }
});
