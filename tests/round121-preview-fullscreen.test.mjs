// tests/round121-preview-fullscreen.test.mjs —— round121：卡片预览改为**全屏**
//
// 用户诉求（两轮递进）：
//   round120：弹窗偏小 → 放大到 min(1180px, 97vw)
//   round121：「干脆直接做成全屏」+「清晰度还是远远不够」
//
// 关于「清晰度」——**做过像素级量化，结论要如实保留在这里**：
//   用 sharp 对同一区域做 Laplacian 卷积求灰度标准差（越大越锐），DPR=1.25 实测：
//     · 弹窗内 H1  · 3D 原样          35.27
//     · 弹窗内 H1  · 注入 perspective:none + transform-style:flat   36.61  （仅 +3.8%）
//     · 弹窗内 正文                    53.03
//     · 弹窗外 页面标题                28.76
//     · 弹窗外 筛选标签                 8.26
//   ⇒ ① **不存在"预览特有的模糊"**：弹窗内的字比页面其他区域更锐；
//     ② FlipCard 的 3D 上下文只带来约 3.8% 的锐度损失，人眼几乎不可辨 ——
//        因此**未改动其 3D 结构**（改它会改变翻转动画的透视观感，代价大于收益）。
//   ⇒ "不清晰"的真实来源是**内容偏小**：字号小 + 行长短。故本轮用
//     「全屏 + 正文放大到 15px + 行高 1.75 + 内容列随屏宽留白」来真正提升可读性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARDS = readFileSync(new URL('../src/views/Cards.vue', import.meta.url), 'utf8');

test('预览层要全屏铺满（用户明确要求「直接做成全屏」）', () => {
  assert.match(CARDS, /\.preview-wrap \{[\s\S]{0,600}?width: 100vw/, '宽度应铺满视口');
  assert.match(CARDS, /\.preview-wrap \{[\s\S]{0,600}?height: 100vh/, '高度应铺满视口');
  assert.match(CARDS, /\.preview-mask \{[^}]*padding: 0/, '遮罩不应再留边距');
  assert.ok(!/width: min\(1180px/.test(CARDS), '不应再保留 1180px 的居中卡片式宽度');
  assert.ok(!/width: min\(720px/.test(CARDS), '也不应回退到 720px');
});

test('全屏后仍要可读：内容列随屏宽留白 + 正文放大 + 行高放松', () => {
  assert.match(CARDS, /\.preview-body \{[\s\S]{0,400}?padding: 18px clamp\(16px, 7vw, 140px\) 32px/,
    '左右留白随屏宽增长，避免超宽屏行长过长难读');
  assert.match(CARDS, /\.preview-body \{[\s\S]{0,400}?font-size: 15px/, '正文适度放大');
  assert.match(CARDS, /\.preview-body \{[\s\S]{0,400}?line-height: 1\.75/, '行高放松');
});

test('全屏不能破坏滚动与关闭', () => {
  assert.match(CARDS, /\.preview-body \{[\s\S]{0,400}?overflow-y: auto/, '长内容仍要能滚动');
  assert.match(CARDS, /@click="closePreview"/, '关闭按钮必须保留');
  assert.match(CARDS, /@click="previewEdit"/, '编辑入口必须保留');
});

test('字号放大只作用于预览层，不得污染全局 Markdown 渲染', () => {
  // 15px / 1.75 必须写在 .preview-body（页面级 scoped 作用域）内，
  // 而不是改 .md-body 的全局定义 —— 否则卡片列表、背诵页、AI 回复会一起变大。
  const styleBlock = CARDS.slice(CARDS.indexOf('<style'));
  assert.ok(!/\.md-body\s*\{[^}]*font-size/.test(styleBlock), '不要在 Cards.vue 里改 .md-body 的字号');
  assert.match(CARDS, /<style scoped>/, '整块样式必须是 scoped，避免外泄到其他页面');
});

test('全屏样式不得被同一规则里的后续声明静默覆盖', () => {
  // 踩过一次：新加的 border-radius:0 / border:none / box-shadow:none 后面还跟着
  // 旧的 border-radius:var(--radius) / border:1px / box-shadow:0 20px 60px，
  // CSS 同优先级下后者生效 —— 于是"去圆角描边阴影"这层意图实际没生效，还留下死代码。
  const start = CARDS.indexOf('.preview-wrap {');
  const block = CARDS.slice(start, CARDS.indexOf('.preview-head', start));
  const count = (re) => (block.match(re) || []).length;
  assert.equal(count(/border-radius\s*:/g), 1, `border-radius 应只声明一次，实际 ${count(/border-radius\s*:/g)} 次`);
  assert.equal(count(/box-shadow\s*:/g), 1, `box-shadow 应只声明一次，实际 ${count(/box-shadow\s*:/g)} 次`);
  assert.equal(count(/[^-]border\s*:/g), 1, `border 应只声明一次，实际 ${count(/[^-]border\s*:/g)} 次`);
});
