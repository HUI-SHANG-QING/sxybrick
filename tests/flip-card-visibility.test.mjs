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

// ---------- 2026-09-20 round125：翻转卡悬停「左右互逆」闸门 ----------
// 症状（用户反馈，仅国风主题）：卡片预览里鼠标悬停时，整张卡像被左右互相扭转。
//
// 真因：FlipCard 的两面**都带 .card-item class**（`flip-face flip-front card-item`），
//   而主题的 `:root[data-style='x'] .card-item:hover{transform:translateY(-2px)}` 会因此
//   作用到两面之上。两面在 flat 上下文里共享父级 `.flip-inner.flipped{rotateY(180deg)}`，
//   位移与旋转叠加；真正可见的那一面是「旋转 180° 后的镜像投影」，垂直位移在屏幕上表现为
//   水平位移 —— 所以观感不是「一起上浮」而是「左右互逆」。
//
// 修复判据（两件事都要成立，缺一不可）：
//   A) 必须存在一条规则把翻转卡两面的 hover transform 归零；
//   B) 那条规则的**特异性必须严格高于**主题的 `:root[data-style='x'] .card-item:hover`。
//      ⚠️ 这是本轮最容易翻车的点：`:root` 是**伪类、计入特异性**，所以
//      `:root[data-style='x'] .card-item:hover` 是 (0,3,0)，而最直觉的写法
//      `.flip-face.card-item:hover` 同样是 (0,3,0) —— 打平后按「后来居上」，
//      主题块在 styles.css 更靠后，于是主题赢、位移照旧。
//      2026-09-20 真机实测：`.flip-face.card-item:hover{transform:none}` 明明命中
//      （`matches(':hover')` 为真、规则出现在 matchedCSSRules 里），computed 却仍是
//      `matrix(1, 0, 0, 1, 0, -2)` —— 就是被这条「打平靠后」的规则顶掉了。
//      所以本条闸门**必须算出特异性并比较**，只检查「规则存在」是不够的（第一版就漏在这）。

test('FlipCard.vue scoped：翻转卡 hover 必须按面区分 —— 正面归零、背面保住 rotateY(180deg)', () => {
  // ⭐ 这条闸门在 round125 写错了，round127 重写。原断言是「两面 hover 都必须 transform: none」，
  //    它把一个**错误的修法写成了规范**，直接导致了「悬停卡片背面 → 内容整块左右镜像」的新 bug。
  //
  // 错在哪（真机取证，CSS.getMatchedStylesForNode，hover 态按优先级低→高）：
  //   [5] .card-item:hover                                   → translateY(-2px)   ← styles.css:117 全局规则
  //   [7] .flip-back[data-v-…]                               → rotateY(180deg)    ← 背面的命根子
  //   [8] .flip-scene .flip-face.card-item[data-v-…]:hover   → none               ← round125 加的，赢
  // computed = none ⇒ 只剩父级 .flip-inner.flipped 的 180° ⇒ **净 180° = 整块镜像**：
  // 文字左右反读、.back-top 按钮顺序倒过来（「看回问题」x 从 118 跳到 1186）、图片也镜像。
  //
  // 根本原因：`transform` 是**单值属性**，「把位移归零」和「保住 rotateY」是一对矛盾，
  // 写 `none` 必然把 `.flip-back` 自身那 180° 一起清掉。而背面能正常显示，
  // 全靠「父级 180° + 自身 180° = 净 360°」（静止态 .flip-inner 是 flat，父子 transform 相加）。
  //
  // ✅ 正确规范：**按面分别写回各自应有的 transform**
  //    - 正面本来无 transform → `none`
  //    - 背面必须保住 → `rotateY(180deg)`
  //
  // ⚠️ 本条闸门**必须读源码文本**（无法只靠"存在一条 hover 规则"判断），
  //    因为正确与错误写法都"有一条 hover 规则"，区别在**值**。
  const scoped = stripComments(styleBlock(FLIP_CARD));
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  const hits = [];
  let m;
  while ((m = ruleRe.exec(scoped))) {
    const sel = m[1].trim();
    const body = m[2];
    if (!/:hover/.test(sel)) continue;
    // 目标规则形如 `.flip-scene .flip-front.card-item:hover` / `.flip-back.card-item:hover`
    // 注意：**不能筛 `.flip-face`** —— 正确写法恰恰是不用 .flip-face 这个共用类
    // （用了就会同时命中背面，正是 round125 的原始错误）。这里按 front/back 筛。
    if (!/\.flip-(front|back)/.test(sel)) continue;
    const val = (/transform\s*:\s*([^;]+)/.exec(body) || [])[1];
    if (val === undefined) continue;
    hits.push({ sel, val: val.trim() });
  }

  assert.ok(
    hits.length >= 2,
    'FlipCard.vue 的 scoped 样式里必须有**两条** hover 规则：一条给 .flip-front、一条给 .flip-back。'
    + `当前只找到 ${hits.length} 条 —— 少了哪一面，那一面就会被主题的 .card-item:hover 位移带偏。`,
  );

  const front = hits.filter((h) => /\.flip-front/.test(h.sel));
  const back = hits.filter((h) => /\.flip-back/.test(h.sel));

  assert.ok(front.length > 0, '缺少给 .flip-front 的 hover 规则（正面需要把主题位移归零）');
  assert.ok(back.length > 0, '缺少给 .flip-back 的 hover 规则（背面需要保住 rotateY(180deg)）');

  for (const { sel, val } of front) {
    assert.equal(
      val, 'none',
      `正面 hover 必须把 transform 归零（当前 \`${sel} { transform: ${val} }\`）：`
      + '主题的 `.card-item:hover{translateY(-2px)}` 会让正面额外上浮，与父级翻面旋转叠加。',
    );
  }

  // ⭐⭐ 核心断言：背面 hover 必须**原样写回** rotateY(180deg)，绝不能是 none
  for (const { sel, val } of back) {
    const norm = val.replace(/\s+/g, '');
    assert.match(
      norm, /^rotateY\(180deg\)(!important)?$/i,
      `背面 hover 的 transform 必须是 \`rotateY(180deg)\`，当前是 \`${val}\`。\n`
      + '⚠️ 写成 `none` 会把背面自身赖以正常显示的 180° 清掉 —— 只剩父级的 180°，'
      + '净角度变成 180° ⇒ **整块内容镜像**（文字反读、按钮顺序倒过来、图片镜像）。'
      + '这是 round125 真实踩过的坑，不是理论风险。\n'
      + '若确实要压过 `:root[data-style=x]` 主题规则，可加 `!important`（已验证必需）。',
    );
  }

  // 反面：绝不允许出现「.flip-face 通用选择器的 hover 归零」——它会同时命中背面
  // （.flip-back 也带 .flip-face），正是 round125 的原始错误。
  const generic = hits.filter((h) => /\.flip-face/.test(h.sel) && !/\.flip-(front|back)/.test(h.sel));
  assert.deepEqual(
    generic.map((g) => g.sel), [],
    '出现了「只写 .flip-face（不区分 front/back）」的 hover 规则：\n'
    + generic.map((g) => `  ${g.sel} { transform: ${g.val} }`).join('\n')
    + '\n这种写法会同时命中 .flip-back，把它的 rotateY(180deg) 一起覆盖掉 → 背面整块镜像。'
    + '必须拆成 .flip-front / .flip-back 两条分别写。',
  );

  // ---- B) styles.css 里不得出现同类规则（沿用 round125 结论，理由仍成立）----
  const globalCss = stripComments(STYLES);
  const gRe = /([^{}]+)\{([^}]*)\}/g;
  const dupes = [];
  let g;
  while ((g = gRe.exec(globalCss))) {
    const sel = g[1].trim();
    const body = g[2];
    if (!/:hover/.test(sel)) continue;
    if (!/\.flip-face/.test(sel)) continue;
    if (!/transform\s*:/.test(body)) continue;
    dupes.push(sel);
  }
  assert.deepEqual(
    dupes, [],
    'styles.css 里出现了「翻转卡 hover 改 transform」的同类规则，与 FlipCard.vue 的 scoped 规则重复：\n'
    + dupes.join('\n')
    + '\n重复定义会重新引入「谁生效看书写顺序」的不确定性（round123/124 的老毛病），'
    + '且 styles.css 里赢不了主题的 (0,4,0) 特异性。请只保留 scoped 里那两条。',
  );
});

test('所有主题：不得再给翻转卡所在的 .card-item:hover 加位移（防后人补主题时遗漏）', () => {
  // 主题自带 .card-item:hover 是合法的（作用于卡片列表），这里只拦「专门给翻转卡加位移」。
  const css = stripComments(STYLES);
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  const offenders = [];
  let m;
  while ((m = ruleRe.exec(css))) {
    const sel = m[1].trim();
    const body = m[2];
    if (!/:hover/.test(sel)) continue;
    if (!/\.flip-scene[^{]*\.card-item/.test(sel)) continue;
    const val = (/transform\s*:\s*([^;]+)/.exec(body) || [])[1];
    if (val === undefined) continue;
    if (/^none$/.test(val.trim())) continue;
    offenders.push(`${sel} { transform: ${val.trim()} }`);
  }
  assert.deepEqual(
    offenders, [],
    '有规则给「翻转卡内的 .card-item」在悬停时加了位移，会与翻转 transform 打架：\n'
    + offenders.join('\n'),
  );
});
