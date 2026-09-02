// 将论文 Markdown 渲染为自包含静态 HTML，供 GitHub Pages 部署到 /paper 与 /paper-en 子路径。
// 依赖：marked（已为项目依赖）、katex（CDN 客户端自动渲染，避免打包）。
// 用法：node paper/build-paper.mjs [outputBaseDir]   默认输出到 dist/
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 输出目录相对于仓库根（CI 中 cwd 即仓库根），而非脚本所在目录，避免写错位置。
const OUT_BASE = resolve(process.cwd(), process.argv[2] || 'dist');
const PAPER_DIR = __dirname;

const KATeX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
const KAtex_JS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
const KAtex_AUTO = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js';

const VARIANTS = [
  { md: 'paper-direction-a-ieee-zh.md', out: 'paper', lang: 'zh-CN', title: 'SxyBrick 方向 A 论文（中文）', alt: 'paper-en', altLabel: 'English' },
  { md: 'paper-direction-a-ieee.md', out: 'paper-en', lang: 'en', title: 'SxyBrick Direction A Paper (English)', alt: 'paper', altLabel: '中文' },
];

const PAGE_CSS = `
:root{--ink:#1f2328;--ink-2:#57606a;--line:#d8dee4;--accent:#8b2121;--bg:#fff;--panel:#f6f8fa;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif;line-height:1.75;font-size:16px;}
header{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 24px;display:flex;align-items:center;gap:16px;}
header .seal{font-family:"KaiTi","STKaiti","楷体",serif;font-weight:700;color:#fff;background:var(--accent);padding:4px 12px 6px;border-radius:5px;letter-spacing:2px;}
header a{color:var(--ink-2);text-decoration:none;font-size:14px;border-bottom:2px solid transparent;}
header a:hover{color:var(--accent);border-bottom-color:var(--accent);}
header .spacer{margin-left:auto;}
main{max-width:880px;margin:32px auto 80px;padding:0 24px;}
h1{font-size:1.9em;line-height:1.3;margin:.2em 0 .6em;}
h2{margin-top:1.8em;border-bottom:1px solid var(--line);padding-bottom:.3em;}
h3{margin-top:1.4em;}
img{max-width:100%;height:auto;display:block;margin:1.2em auto;border:1px solid var(--line);border-radius:6px;background:#fff;}
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px;}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;}
th{background:var(--panel);}
code{background:var(--panel);padding:2px 5px;border-radius:4px;font-size:.9em;}
pre{background:var(--panel);padding:14px;border-radius:8px;overflow:auto;}
pre code{background:none;padding:0;}
blockquote{margin:1.2em 0;padding:.4em 1em;border-left:4px solid var(--accent);color:var(--ink-2);background:var(--panel);}
hr{border:none;border-top:1px solid var(--line);margin:2em 0;}
.katex{font-size:1.05em;}
footer{max-width:880px;margin:0 auto 60px;padding:0 24px;color:var(--ink-2);font-size:13px;}
`;

function render(title, lang, alt, altLabel, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${KATeX_CSS}">
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
  <span class="seal">SxyBrick</span>
  <a href="../">应用主页</a>
  <span class="spacer"></span>
  <a href="../${alt}/">${altLabel} ↗</a>
</header>
<main>
${bodyHtml}
</main>
<footer>SxyBrick · 方向 A 论文静态版 · 由 GitHub Pages 自动部署 · 公式由 KaTeX 渲染</footer>
<script defer src="${KAtex_JS}"></script>
<script defer src="${KAtex_AUTO}" onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false})"></script>
</body>
</html>`;
}

let ok = true;
for (const v of VARIANTS) {
  const mdPath = join(PAPER_DIR, v.md);
  if (!existsSync(mdPath)) { console.error('[build-paper] 缺少', mdPath); ok = false; continue; }
  const md = readFileSync(mdPath, 'utf8');
  const body = marked.parse(md, { gfm: true, breaks: false });
  const html = render(v.title, v.lang, v.alt, v.altLabel, body);
  const outDir = join(OUT_BASE, v.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  // 复制图片
  const figSrc = join(PAPER_DIR, 'figures');
  if (existsSync(figSrc)) cpSync(figSrc, join(outDir, 'figures'), { recursive: true });
  console.log('[build-paper] 已生成', join(outDir, 'index.html'));
}

if (!ok) process.exit(1);
console.log('[build-paper] 完成 ->', OUT_BASE);
