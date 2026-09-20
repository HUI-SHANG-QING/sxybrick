// tests/round121-preview-fullscreen.test.mjs —— round121：卡片预览改为**全屏**
//
// 用户诉求（两轮递进）：
//   round120：弹窗偏小 → 放大到 min(1180px, 97vw)
//   round121：「干脆直接做成全屏」+「清晰度还是远远不够」
//
// ⚠️ 关于「清晰度」——**round121 的结论是错的，round122 已推翻，这里如实记录**：
//   round121 当时用 sharp 做 Laplacian 灰度标准差，在 **DPR=1.25 下把整块 h1 外接矩形**
//   当采样区，得到「注入 perspective:none + flat 后仅 +3.8%」，于是下了两个错误判断：
//     ① 「不存在预览特有的模糊」 ②「3D 上下文损失可忽略，不该改」。
//   错在哪：h1 是块级元素、宽度撑满容器（1170px），而文字只占左侧约 234px —— 把大量空白
//   背景一起平均进去，把差异**稀释掉了**。正确做法是**只统计有笔画的列**。
//
//   重新量化（DPR 1/1.25/1.5/2 全档一致，判据 = 文字边缘的 RGB 色度 chromaMax）：
//     · 预览层原样（3D 上下文）  chromaMax ≈ 22    ← 灰度抗锯齿（笔画细、发虚）
//     · 去掉 3D 上下文            chromaMax ≈ 179   ← 次像素/LCD 抗锯齿
//     · 内容全屏（用户说清晰）    chromaMax ≈ 174
//   ⇒ 根因：`.flip-scene{preserve-3d 之下的 perspective}` + `.flip-inner{transform-style:preserve-3d}`
//     建立了 3D 渲染上下文，**Chrome 在 3D 上下文中会关闭 LCD 次像素抗锯齿**，改用灰度抗锯齿。
//     这就是用户说的「像蒙了一层雾」；而点击进入的内容全屏不在 3D 上下文里，所以清晰。
//   ⇒ 修法见 round122：静止态 flat、仅翻转动画期（600ms）临时开启 3D。翻转观感完全保留，
//     静止阅读时恢复次像素抗锯齿（chromaMax 22→179，约 8 倍色度，锐度显著提升）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARDS = readFileSync(new URL('../src/views/Cards.vue', import.meta.url), 'utf8');

test('预览层要全屏铺满（用户明确要求「直接做成全屏」）', () => {
  // ⚠️ 必须用 100% 而不是 100vw：100vw **包含竖直滚动条的宽度**，页面一旦有纵向滚动，
  //    容器就比可用宽度宽出十几像素 → 凭空多出一条横向滚动条（实测踩到过）。
  //    父级 .preview-mask 是 fixed + inset:0，其 100% 即视口可用宽高。
  assert.match(CARDS, /\.preview-wrap \{[\s\S]{0,900}?width: 100%/, '宽度应铺满父级（视口可用宽）');
  assert.match(CARDS, /\.preview-wrap \{[\s\S]{0,900}?height: 100%/, '高度应铺满');
  assert.match(CARDS, /\.preview-mask \{[^}]*padding: 0/, '遮罩不应再留边距');
  assert.ok(!/width:\s*100vw/.test(CARDS), '不要用 100vw（含滚动条宽度，会产生横向滚动）');
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
