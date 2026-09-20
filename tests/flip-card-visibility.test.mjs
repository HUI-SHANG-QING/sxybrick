// 翻转卡「反面被背面剔除」回归闸门（2026-09-20 定案）
//
// 症状：卡片预览里点击翻面，反面内容（含顶部按钮条）出现约一秒后整面消失。
//
// 真因（真机 elementFromPoint 实测，非推断）：
//   .flip-inner 静止态是 `transform-style: flat`（为保文字次像素抗锯齿，2026-09-18 定案）。
//   flat 上下文里，父级 `.flip-inner.flipped{transform:rotateY(180deg)}` 与子级
//   `.flip-back{transform:rotateY(180deg)}` 的旋转会**相加成 360°** → 反面把"背"朝向观察者
//   → 配上 `backface-visibility: hidden` 就被整面剔除，只剩 .flip-inner 的底色。
//   动画期间 `.flip-3d` 打开 `preserve-3d`，两面各自独立旋转、可见 → 所以"只显示一秒"
//   正好等于 FLIP_3D_MS(600ms) 的自动关闭时刻。
//
// 修复要点（两条，缺一不可）：
//   1) `.flip-face` 必须 `backface-visibility: visible` —— 本组件靠 visibility 显隐，
//      不依赖背面剔除，剔除在这里只有副作用。
//   2) 全局 styles.css 不得再定义 `.flip-face{backface-visibility:hidden}` /
//      `.flip-back{...rotateY(180deg)}` / `.flip-inner.flipped{...}` 这类与 scoped 规则
//      打架的重复几何（历史上存在过，是叠加成因之一）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const FLIP_CARD = read(`${SRC}/components/FlipCard.vue`);
const STYLES = read(`${SRC}/styles.css`);

/** 取出 FlipCard.vue 的 <style scoped> 块（只看样式，避免误伤注释/文案）。 */
function styleBlock(src) {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src);
  return m ? m[1] : '';
}

/** 去掉 CSS 注释 —— 注释里会出现 `backface-visibility: hidden` 之类的反例文本，
 *  不剥离就会把说明文字误当成真实声明（本测试最初就踩了这个坑）。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 多块同名规则会有层叠：如果后面那块没写 backface-visibility，实际生效值来自更早那块。
 *  所以这里必须**遍历所有 .flip-face 块**，检查每一处 backface-visibility 声明。 */
function allRuleBodies(css, selectorRe) {
  const re = new RegExp(`(?:^|[},])\\s*${selectorRe}\\s*\\{([^}]*)\\}`, 'gm');
  const out = []; let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}

test('FlipCard.vue：.flip-face 必须关闭背面剔除（backface-visibility: visible）', () => {
  const css = stripComments(styleBlock(FLIP_CARD));
  const bodies = allRuleBodies(css, String.raw`\.flip-face`);
  assert.ok(bodies.length > 0, '.flip-face 规则丢失——正反面叠放的几何基础被改动');
  const decls = bodies
    .map((b) => /backface-visibility\s*:\s*([\w-]+)/.exec(b))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(
    decls.length > 0,
    '.flip-face 必须显式声明 backface-visibility（默认值也不安全，易被主题覆盖）',
  );
  for (const v of decls) {
    assert.equal(
      v, 'visible',
      'backface-visibility 必须是 visible：flat 上下文里父子双 180° 相加成 360°，'
      + 'hidden 会把反面整面剔除 → 翻面后反面消失（2026-09-20 实测回归）',
    );
  }
});

test('FlipCard.vue：反面的 rotateY(180deg) 必须保留（否则文字会镜像）', () => {
  // .flip-back 可能只有 transform 一条；也接受在 .flip-face 合并写法下的等价规则。
  const joined = stripComments(styleBlock(FLIP_CARD));
  assert.match(
    joined, /\.flip-back[^{]*\{[^}]*rotateY\(180deg\)/,
    '.flip-back 必须保留 rotateY(180deg)：删掉它会让「父 180° + 子 0°」净剩 180°，'
    + '反面文字整体左右镜像（2026-09-20 实测）',
  );
});

test('styles.css：不得残留会与 scoped 规则打架的 flip 几何定义', () => {
  const css = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  // 全局 .flip-face 的 backface-visibility（与 FlipCard.vue 抢「谁赢」）
  if (/\.flip-face[^{]*\{[^}]*backface-visibility/.test(css)) offenders.push('.flip-face{backface-visibility:...}');
  // 全局 .flip-back 的定位/旋转
  if (/\.flip-back[^{]*\{[^}]*\btransform\s*:\s*rotateY/.test(css)) offenders.push('.flip-back{transform:rotateY(...)}');
  if (/\.flip-back[^{]*\{[^}]*position\s*:\s*absolute/.test(css)) offenders.push('.flip-back{position:absolute}');
  // 全局 .flip-inner.flipped 的旋转
  if (/\.flip-inner\.flipped[^{]*\{[^}]*transform\s*:\s*rotateY/.test(css)) offenders.push('.flip-inner.flipped{transform:rotateY(...)}');
  assert.deepEqual(
    offenders, [],
    `styles.css 出现全局 flip 几何定义，会与 FlipCard.vue 的 scoped 规则打架`
    + `（历史上 .flip-face{backface-visibility:hidden} 就是反面消失的叠加成因）：\n${offenders.join('\n')}`,
  );
  // .no-anim 的降级属于「跨组件仍需要」的部分，必须保留
  assert.match(css, /\.no-anim\s+\.flip-inner\s*\{[^}]*transition\s*:\s*none/,
    '.no-anim .flip-inner{transition:none} 是刻意保留的降级路径，不要误删');
});

test('FlipCard.vue：显隐仍由 visibility 负责（不得回退到 backface 剔除）', () => {
  const css = styleBlock(FLIP_CARD);
  assert.match(css, /\.flip-inner\.flipped\s+\.flip-front\s*\{[^}]*visibility\s*:\s*hidden/,
    '翻面后必须用 visibility:hidden 藏正面');
  assert.match(css, /\.flip-inner:not\(\.flipped\)\s+\.flip-back\s*\{[^}]*visibility\s*:\s*hidden/,
    '未翻面时必须用 visibility:hidden 藏反面（既然关掉了 backface 剔除，这条就是唯一的防双影手段）');
});
