// tests/round120-preview-size.test.mjs —— round120：卡片预览层放大到接近整页
//
// 用户报：卡片预览弹窗偏小（宽屏下只有半屏宽），长卡片要反复滚动，"看着也不清晰"。
// 实测确认：弹窗宽 min(720px, 92vw)，在 1262px 视口下只占 720px；文字本身清晰
//   （DPR=1 与 DPR=2 截图逐字可比对，无分辨率损失）。
// 修复：宽度放到 min(1180px, 97vw)、高度 94vh —— 接近整页但保留边距；
//   上限 1180px 是为了避免超宽屏上正文行长过长反而难读。
//
// .vue 无法在 node --test 挂载，沿用本项目的**源码形态闸门**兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARDS = readFileSync(new URL('../src/views/Cards.vue', import.meta.url), 'utf8');

test('预览层宽度要接近整页（原 720px 在宽屏只有半屏）', () => {
  assert.match(CARDS, /\.preview-wrap \{[\s\S]{0,400}?width: min\(1180px, 97vw\)/,
    '预览容器宽度应放大到 min(1180px, 97vw)');
  assert.match(CARDS, /\.preview-wrap \{[\s\S]{0,400}?max-height: 94vh/,
    '高度上限应放宽到 94vh');
  // 旧值不应残留，否则说明有另一处规则把它压回去
  assert.ok(!/width: min\(720px, 92vw\)/.test(CARDS), '不应再保留 720px 的旧宽度');
});

test('窄屏必须仍然自适应（不能因为放大而在手机上溢出）', () => {
  // 用 vw 上限 + min() 保证窄屏按视口收缩；实测 420px 窗口下 wrap=465px < viewport=504px，无横向滚动
  assert.match(CARDS, /min\(1180px, 97vw\)/, '必须保留 vw 上限，窄屏才会跟随视口收缩');
});

test('预览层的滚动与关闭能力不被放大改动影响', () => {
  assert.match(CARDS, /\.preview-body \{[\s\S]{0,200}?overflow-y: auto/,
    '内容区要保留纵向滚动（放大后仍可能超出视口高度）');
  assert.match(CARDS, /@click="closePreview"/, '关闭按钮要保留');
});
