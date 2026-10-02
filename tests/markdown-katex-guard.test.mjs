// tests/markdown-katex-guard.test.mjs —— KaTeX 产物白名单/黑名单的误杀回归（round124 审计）
//
// 背景（真实事故）：round124 为修「导出预览卡顿」把 KaTeX 产物移出 DOMPurify，
//   改由 MarkdownRenderer 里的 katexGuard() 黑名单兜底。第一版黑名单里凭直觉写了 `svg`，
//   结果**误杀 4/16 种正常公式** —— KaTeX 的 `\sqrt`（根号）、`\underbrace`（下括号）、
//   `\overrightarrow`（箭头）都是**用 SVG 画的**，被判危险后整段降级成纯文本，
//   直接违反「画质不得下降」。
// 本测试做两件事：
//   ① 防漂移：直接从 src/components/MarkdownRenderer.vue **提取真实正则**来判定，
//      保证测试跑的就是生产代码的黑名单，而不是测试里另抄的一份；
//   ② 双侧守门：正常公式必须放行、危险形态必须拦截（不许为了放行 svg 而放水）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import katex from 'katex';

const SRC = readFileSync(new URL('../src/components/MarkdownRenderer.vue', import.meta.url), 'utf8');

/** 从源码里取出 `const NAME = /.../i;` 的真实正则字面量并实例化 */
function grabRegex(name) {
  const m = new RegExp(`const ${name} = (/[^\\n]+?/i);`).exec(SRC);
  assert.ok(m, `未能从 MarkdownRenderer.vue 解析出 ${name}（结构变了，本测试需同步）`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)();
}

const BAD_TAG = grabRegex('KATEX_BAD_TAG');
const BAD_ATTR = grabRegex('KATEX_BAD_ATTR');
const BAD_URI = grabRegex('KATEX_BAD_URI');

/** 与源码 katexGuard 相同的判定口径 */
const isDangerous = (html) => !html || BAD_TAG.test(html) || BAD_ATTR.test(html) || BAD_URI.test(html);

const render = (tex, displayMode = false) =>
  katex.renderToString(tex, { displayMode, throwOnError: false });

/** 源码行级断言：KATEX_BAD_TAG 那一行不得把 svg 列为禁用标签 */
test('防漂移：黑名单定义行不得包含 svg（它会被 KaTeX 的根号/箭头用到）', () => {
  const line = SRC.split('\n').find((l) => l.includes('const KATEX_BAD_TAG'));
  assert.ok(line, '找不到 KATEX_BAD_TAG 定义行');
  assert.doesNotMatch(
    line, /\|svg\|/i,
    '黑名单把 svg 列为禁用 ⇒ KaTeX 的 \\sqrt / \\underbrace / \\overrightarrow 会被整段降级为纯文本（round124 真实事故）',
  );
});

test('常用公式形态（含用 SVG 绘制的那几类）都不得被判为危险', () => {
  const CASES = [
    ['行内上标', 'x^2'],
    ['分式', '\\frac{a}{b}'],
    ['根号（SVG）', '\\sqrt{x}'],
    ['立方根（SVG）', '\\sqrt[3]{x}'],
    ['求和', '\\sum_{i=1}^{n} i'],
    ['积分', '\\int_0^1 f(x)dx'],
    ['矩阵', '\\begin{matrix}a&b\\\\c&d\\end{matrix}'],
    ['上下标组合', 'T_{avg} = h \\cdot T_c'],
    ['希腊字母', '\\alpha\\beta\\gamma'],
    ['箭头', 'a \\to b \\Rightarrow c'],
    ['花体', '\\mathcal{L}'],
    ['空心体', '\\mathbb{R}'],
    ['上划线', '\\overline{AB}'],
    ['下括弧（SVG）', '\\underbrace{a+b}_{x}'],
    ['向量箭头（SVG）', '\\overrightarrow{AB}'],
    ['自适应括号', '\\left( \\frac{1}{2} \\right)'],
    ['根号套分式', '\\sqrt{\\frac{a}{b}}'],
    ['极限', '\\lim_{n \\to \\infty} a_n'],
  ];
  const killed = [];
  for (const [name, tex] of CASES) {
    const html = render(tex);
    assert.ok(html && html.length > 0, `${name} 应能渲染出内容`);
    if (isDangerous(html)) killed.push(name);
  }
  assert.deepEqual(
    killed, [],
    `这些正常公式被 katexGuard 误判为危险、会被降级成纯文本：${killed.join('、')}。` +
    '（提示：KaTeX 用 SVG 画根号/箭头/下括号，svg 必须留在允许侧）',
  );
});

test('危险形态必须仍被拦截（不许为了放行 svg 而放水）', () => {
  const DANGER = [
    ['svg 挂事件', '<svg onload=alert(1)>'],
    ['svg 内嵌 script', '<svg><script>alert(1)</script></svg>'],
    ['foreignObject 嵌 HTML', '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>'],
    ['裸 script', '<script>alert(1)</script>'],
    ['img 挂事件', '<img src=x onerror=alert(1)>'],
    ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['style 标签', '<style>body{display:none}</style>'],
    ['form', '<form action="javascript:alert(1)">'],
    ['MathML 内嵌 img', '<math><mtext><img src=x onerror=alert(1)></mtext></math>'],
  ];
  const leaked = DANGER.filter(([, html]) => !isDangerous(html)).map(([n]) => n);
  assert.deepEqual(leaked, [], `这些危险形态未被拦截：${leaked.join('、')}`);
});

test('URI 规则只在「赋值位置」判定：公式正文里的 data: / javascript: 字样不误杀', () => {
  // 正常写法：这些字样出现在可见文本里（\text{}），不可执行，不该被降级
  for (const tex of ['\\text{data: ok}', '\\text{javascript: void}', '\\text{vbscript: x}']) {
    const html = render(tex);
    assert.equal(
      isDangerous(html), false,
      `公式正文含「${tex}」被误判为危险 —— URI 规则应只在 = "..." 这类赋值位置命中`,
    );
  }
  // 反面：真正的危险协议出现在赋值位置时必须命中
  assert.ok(isDangerous('<a href="javascript:alert(1)">x</a>'), 'href="javascript:" 必须被拦截');
  assert.ok(isDangerous("<a href='vbscript:x'>x</a>"), '单引号形式的危险协议也必须拦截');
  assert.ok(isDangerous('<img src=data:text/html,<script>x</script>>'), 'src=data:text/html 必须被拦截');
});

test('渲染结果确实带 SVG（证明上面「不误杀」的用例覆盖到了 SVG 分支）', () => {
  const dom = new JSDOM(`<body>${render('\\sqrt{x}')}</body>`);
  assert.ok(
    dom.window.document.body.querySelector('svg'),
    '\\sqrt 的输出应当含 <svg> —— 若哪天 KaTeX 改用别的画法，本测试的覆盖前提就变了，需要复核',
  );
});
