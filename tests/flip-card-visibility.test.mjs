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

// ---------- 2026-09-20 round124 审计补：堵两个漏检口 ----------
// 为什么补：
//   ① 上面三条只检查「.flip-face 自己那几块规则」。若有人用**别的选择器**（典型是
//      `:root[data-style='x'] .flip-scene .flip-inner > div { backface-visibility: hidden }`）
//      给同一个元素加回剔除，上面全部漏检 —— 而这正是历史上 bug 的真实形态
//      （styles.css 里那句全局 `.flip-face{backface-visibility:hidden}` 就属于此类）。
//   ② round122「文字发虚」修复的前提是**静止态必须是非 3D 上下文**。若有人把
//      `.flip-inner` 改回常驻 `preserve-3d` / 给 `.flip-scene` 加回常驻 `perspective`，
//      发虚会复发，但没有任何闸门拦得住。这里把「静止态 flat」也钉住。

test('FlipCard.vue：.flip-face 顶层只能有一块定义（防「重复定义打架」重演）', () => {
  // 为什么加：2026-09-20 之前 .flip-face 在同一文件里被定义了**两次**，
  // 第一块写 position:absolute/inset:0，第二块写 position:static/grid-area ——
  // 后者完全覆盖前者的定位，前者是死代码。这类「同元素重复定义」是历史 bug 的温床：
  // round123 的反面消失正是「styles.css 全局 .flip-face 与组件内 .flip-face 打架」造成的。
  // 合并后必须保持单块，避免后人再往旧块加属性（以为生效，实则被覆盖）。
  //
  // ⚠️ 注意：**媒体查询内的 .flip-face 是合法的响应式覆盖**（如 @media(max-width:720px)
  //    调整 min/max-height），必须排除，否则会误报。
  const css = stripComments(styleBlock(FLIP_CARD));
  // 先剥掉所有 @media 块（含嵌套花括号）
  let top = css;
  for (let i = 0; i < 8; i++) {
    const next = top.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    if (next === top) break;
    top = next;
  }
  const bodies = allRuleBodies(top, String.raw`\.flip-face(?![.\w-])`);
  assert.equal(
    bodies.length, 1,
    `顶层 .flip-face 应当只有 1 块定义（当前 ${bodies.length} 块）。`
    + '同元素重复定义会让「谁生效」依赖书写顺序，极易写出死代码/互相覆盖 —— '
    + '历史上 .flip-face 的双重定义正是反面消失的成因之一。请合并为单块'
    + '（媒体查询内的响应式覆盖不受此限）。',
  );
});

test('全仓：不得有任何选择器给翻转卡元素加回 backface 剔除（含主题/后代选择器写法）', () => {
  /** 收集 src 下所有样式来源：FlipCard.vue 的 scoped 块 + styles.css。 */
  const sources = [
    { name: 'FlipCard.vue', css: styleBlock(FLIP_CARD) },
    { name: 'styles.css', css: STYLES },
  ];
  const offenders = [];
  for (const { name, css } of sources) {
    const clean = stripComments(css);
    // 逐条 rule 检查：选择器里出现 flip-face 或 flip-inner 的子孙面元素，且声明了 backface-visibility
    const ruleRe = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(clean))) {
      const sel = m[1].trim();
      const body = m[2];
      if (!/backface-visibility\s*:/.test(body)) continue;
      // 命中翻转卡正反面元素的选择器（含 > div 这类后代写法）+ 通用通配
      const hitsFace = /\.flip-(face|back|front)/.test(sel)
        || /\.flip-(scene|inner)[^{]*>\s*div/.test(sel)
        || /\.flip-(scene|inner)\s/.test(sel);
      if (!hitsFace) continue;
      const val = (/backface-visibility\s*:\s*([\w-]+)/.exec(body) || [])[1];
      if (val && val !== 'visible') offenders.push(`${name}: ${sel} { backface-visibility: ${val} }`);
    }
  }
  assert.deepEqual(
    offenders, [],
    '有选择器给翻转卡正反面加回了 backface 剔除，会重演「翻面后整面消失」：\n'
    + offenders.join('\n'),
  );
});

test('FlipCard.vue：静止态必须是非 3D 上下文（文字清晰度的前提）', () => {
  const css = stripComments(styleBlock(FLIP_CARD));
  // .flip-inner 的基础规则必须是 flat；preserve-3d 只能出现在 .flip-3d 限定下
  const baseInner = allRuleBodies(css, String.raw`\.flip-inner(?![.\w-])`);
  assert.ok(baseInner.length > 0, '.flip-inner 基础规则丢失');
  for (const b of baseInner) {
    const ts = (/transform-style\s*:\s*([\w-]+)/.exec(b) || [])[1];
    if (ts !== undefined) {
      assert.equal(ts, 'flat',
        '.flip-inner 静止态必须是 transform-style: flat —— 常驻 preserve-3d 会建立 3D 上下文、'
        + '关闭次像素抗锯齿，重现「文字发虚」（2026-09-18 定案）；且会让 round123 的修复前提失效');
    }
  }
  // 3D 只能在 .flip-3d 限定下临时开启
  const at3d = allRuleBodies(css, String.raw`\.flip-inner\.flip-3d`);
  assert.ok(at3d.some((b) => /preserve-3d/.test(b)),
    '.flip-inner.flip-3d 必须临时开启 preserve-3d（翻转动画依赖真正的 3D 旋转）');
  // .flip-scene 的 perspective 也必须是 .flip-3d 限定的，不能出现在基础规则里
  const sceneBase = allRuleBodies(css, String.raw`\.flip-scene(?![.\w-])`);
  for (const b of sceneBase) {
    assert.ok(!/perspective\s*:/.test(b),
      '.flip-scene 静止态不得有 perspective —— 单独存在就会让文字 chromaMax 从 179 掉到 22'
      + '（2026-09-18 实测），重现「像蒙了一层雾」');
  }
  const scene3d = allRuleBodies(css, String.raw`\.flip-scene\.flip-3d`);
  assert.ok(scene3d.some((b) => /perspective\s*:/.test(b)),
    '.flip-scene.flip-3d 必须提供 perspective，否则翻转没有透视立体感');
});
