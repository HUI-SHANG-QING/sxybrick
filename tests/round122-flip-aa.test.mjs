// tests/round122-flip-aa.test.mjs —— round122：修复卡片文字「发虚、像蒙了一层雾」
//
// 用户反馈（原话）：
//   「不是字体大小的问题，是字体看起来模糊，像是加了一层雾一样，
//     点击全屏里面的界面显示的内容就没有这种模糊的感觉，是正常的」
//
// 根因（CDP 真机量化定位，不是推测）：
//   `.flip-scene` 的 `perspective` + `.flip-inner` 的 `transform-style: preserve-3d`
//   会建立 **3D 渲染上下文**。Chrome 在 3D 上下文中**关闭 LCD 次像素抗锯齿**，改用
//   灰度抗锯齿 —— 笔画变细、边缘发虚，就是用户说的「一层雾」。
//   而「点击进入的内容全屏」（.content-fs-overlay）是 Teleport 到 body 的 fixed 层，
//   **不在** 3D 上下文里，所以清晰 —— 正好印证用户提供的对照。
//
// 量化证据（判据 = 文字边缘 RGB 色度 chromaMax；灰度 AA ≈22，次像素 AA ≈175+）：
//   实测 DPR 1 / 1.25 / 1.5 / 2 全档一致：
//     · 3D 上下文原样           chromaMax ≈ 22
//     · 去掉 perspective        chromaMax ≈ 179   ✅ 恢复次像素
//     · 去掉 preserve-3d        chromaMax ≈ 179   ✅ 恢复次像素
//     · 只去掉 backface-visibility  chromaMax ≈ 22  ❌ 无效
//     · 加 will-change          chromaMax ≈ 22    ❌ 无效
//   ⇒ 真凶是 perspective / preserve-3d 这一对，其余都是无关项。
//   ⇒ 另用「暗像素覆盖率 inkCover」做与颜色无关的交叉验证，确认笔画确实变粗了。
//
// 修法：**静止态 flat、仅翻转动画期（600ms）临时开启 3D**。
//   —— 翻转动画需要 preserve-3d 才能做出真正的 3D 旋转，所以不能长期 flat；
//      而用户 99.9% 的时间在看静止的卡，静止态恢复次像素抗锯齿即可彻底解决观感问题。
//   —— 正反面的显隐由模板上的 visibility 规则负责（.flip-inner.flipped .flip-front{visibility:hidden}），
//      不依赖 backface-visibility 的背面剔除，所以 flat 静止态**不会**出现正反面双影（已实测确认）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FLIP = readFileSync(new URL('../src/components/FlipCard.vue', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// 去掉 CSS 注释，避免把「警告文案里提到的属性名」误判成真实声明
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const STYLES_CODE = stripCssComments(STYLES);
const FLIP_CODE = stripCssComments(FLIP);

test('静止态不得建立 3D 渲染上下文（否则文字被强制灰度抗锯齿 → 发虚）', () => {
  // .flip-scene 的 perspective 必须只在 .flip-3d 期间存在
  const sceneBlock = FLIP_CODE.slice(FLIP_CODE.indexOf('.flip-scene {'), FLIP_CODE.indexOf('.flip-scene.flip-3d'));
  assert.ok(!/perspective\s*:/.test(sceneBlock),
    '.flip-scene 静止态不得声明 perspective（会建立 3D 上下文、关闭次像素抗锯齿）');
  assert.match(FLIP_CODE, /\.flip-scene\.flip-3d \{[^}]*perspective\s*:/,
    'perspective 应改为只在 .flip-3d（翻转动画期）生效');

  // .flip-inner 默认必须是 flat
  assert.match(FLIP_CODE, /\.flip-inner \{[\s\S]{0,900}?transform-style:\s*flat/,
    '.flip-inner 静止态应为 transform-style: flat');
  assert.match(FLIP_CODE, /\.flip-inner\.flip-3d \{[^}]*transform-style:\s*preserve-3d/,
    'preserve-3d 应改为只在 .flip-3d（翻转动画期）生效');
});

test('全局 styles.css 不得再偷偷加回 3D 上下文（会被其他主题/规则重新引入）', () => {
  // 踩过的坑：styles.css 里另有一份 .flip-inner { transform-style: preserve-3d }，
  // 且 progress 主题又给 .card-item（= 翻转卡的正/反面）加了 preserve-3d + will-change。
  // 只改组件内部的话，这些外部规则会把 3D 上下文重新引入，修复失效。
  // ⚠️ 断言前必须剥掉注释 —— 我们的警告文案里就写着这些属性名，否则会误报。
  const globalFlip = STYLES_CODE.slice(STYLES_CODE.indexOf('翻转卡'), STYLES_CODE.indexOf('/* Markdown'));
  assert.ok(!/transform-style:\s*preserve-3d/.test(globalFlip),
    'styles.css 的翻转卡段落不得声明 transform-style: preserve-3d');
  assert.ok(!/^\.flip-scene \{[^}]*perspective/m.test(STYLES_CODE),
    'styles.css 不得再给 .flip-scene 单独加 perspective');

  // progress 主题给 .card-item 加了 preserve-3d + will-change（这是它**有意为之**的
  // 「3D 鼠标跟踪倾斜」特性，卡片列表里要保留）。但 .card-item 同时也是翻转卡的正/反面，
  // 那里必须排除，否则 3D 上下文把正文压成灰度抗锯齿。
  const progressCardItem = STYLES_CODE.slice(
    STYLES_CODE.indexOf(":root[data-style='progress'] .card-item,"),
    STYLES_CODE.indexOf(":root[data-style='progress'] .card-item:hover,"),
  );
  assert.match(progressCardItem, /transform-style:\s*preserve-3d/,
    'progress 的 3D 倾斜特性本身要保留（卡片列表用）');
  assert.match(STYLES_CODE, /\.flip-scene \.card-item \{[\s\S]{0,200}?transform-style:\s*flat/,
    'progress 主题必须显式把翻转卡内的 .card-item 排除出 3D 上下文');
  assert.match(STYLES_CODE, /\.flip-scene \.card-item \{[\s\S]{0,200}?will-change:\s*auto/,
    'progress 主题必须把翻转卡内的 .card-item 的 will-change 关掉');
});

test('翻转动画能力必须保留：3D 只在翻转期间开启', () => {
  assert.match(FLIP, /const flip3d = ref\(false\)/, '应有 flip3d 开关');
  assert.match(FLIP, /watch\(flipped,[\s\S]{0,300}?flip3d\.value = true/,
    '每次翻转都应开启 3D');
  assert.match(FLIP, /clearTimeout\(flip3dTimer\)[\s\S]{0,200}?setTimeout\(\(\) => \{ flip3d\.value = false; \}/,
    '动画结束后应回落 flat');
  // 模板两个容器都要绑定
  assert.match(FLIP, /class="flip-scene" :class="\{ 'flip-3d': flip3d \}"/, 'flip-scene 要绑定 flip-3d');
  assert.match(FLIP, /class="flip-inner" :class="\{ flipped, 'flip-3d': flip3d \}"/, 'flip-inner 要绑定 flip-3d');
  // 卸载时清理定时器，避免泄漏
  assert.match(FLIP, /onBeforeUnmount\(\(\) => \{[\s\S]{0,200}?clearTimeout\(flip3dTimer\)/,
    'onBeforeUnmount 应清理 flip3dTimer');
  // 翻转本身的过渡与终态 transform 不能动
  assert.match(FLIP, /\.flip-inner\.flipped \{ transform: rotateY\(180deg\)/, '翻转终态必须保留');
});

test('正反面显隐不能依赖 backface-visibility（flat 静止态下会双影）', () => {
  // 静止态是 flat，backface-visibility 的背面剔除在 2D 上下文里不可靠；
  // 实际负责显隐的是这两条 visibility 规则 —— 必须保留。
  assert.match(FLIP, /\.flip-inner\.flipped \.flip-front \{ visibility: hidden; \}/,
    '翻转后应隐藏正面（靠 visibility，不靠 backface 剔除）');
  assert.match(FLIP, /\.flip-inner:not\(\.flipped\) \.flip-back \{ visibility: hidden; \}/,
    '未翻转时应隐藏背面');
});
