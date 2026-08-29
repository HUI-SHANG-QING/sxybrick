<script setup>
// Markdown 渲染：marked(GFM) + highlight.js 高亮 + KaTeX 公式 + 本地图片解析
// 性能：katex / highlight.js 改为按需动态 import（仅当源文本含对应语法时加载）
// 首屏 chunk 不再携带这两个重型库（合计约 +400KB），仅在内容需要时才拉取。
import { ref, watch } from 'vue';
import { marked } from 'marked';
import { imgUrl, ensureImages, extractImageIds } from '../images.js';
import { sanitizeHtml } from '../utils/sanitize.js';

const props = defineProps({ content: { type: String, default: '' } });

marked.setOptions({ breaks: true, gfm: true });

// 懒加载重型依赖：使用模块级缓存，避免重复加载
// null=未加载，false=加载失败，object=已加载的模块
let katexMod = null;
let hljsMod = null;

async function loadKatex() {
  if (katexMod === null) {
    try { katexMod = (await import('katex')).default; }
    catch (e) { console.warn('[MarkdownRenderer] katex 加载失败', e); katexMod = false; }
  }
  return katexMod;
}

async function loadHljs() {
  if (hljsMod === null) {
    try { hljsMod = (await import('highlight.js')).default; }
    catch (e) { console.warn('[MarkdownRenderer] highlight.js 加载失败', e); hljsMod = false; }
  }
  return hljsMod;
}

/** HTML 属性值转义（防闭合属性注入） */
function escapeAttr(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render(src) {
  const stash = [];
  const put = (html) => { stash.push(html); return `@@MDS${stash.length - 1}@@`; };
  let text = src || '';

  // 1) 代码块优先保护
  text = text.replace(/```([\s\S]*?)```/g, (m, code) => {
    const nl = code.indexOf('\n');
    let lang = '', body = code;
    if (nl >= 0) { lang = code.slice(0, nl).trim(); body = code.slice(nl + 1); }
    let html;
    if (hljsMod && lang && hljsMod.getLanguage(lang)) {
      html = `<pre><code class="hljs language-${lang}">${hljsMod.highlight(body, { language: lang }).value}</code></pre>`;
    } else if (hljsMod) {
      html = `<pre><code class="hljs">${hljsMod.highlightAuto(body).value}</code></pre>`;
    } else {
      // hljs 尚未加载：纯文本转义后保护，等待下一轮渲染再高亮
      const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html = `<pre><code class="hljs pending">${esc}</code></pre>`;
    }
    return put(html);
  });

  // 2) 行内代码保护
  text = text.replace(/`([^`\n]+)`/g, (m, code) =>
    put(`<code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`));

  // 3) 本地图片：![alt](sxy-img://id) → <img src="blobURL">
  // alt 来自用户输入，必须转义后再拼进属性，否则 `x" onerror="alert(1)` 可闭合标签注入
  text = text.replace(/!\[([^\]]*)\]\(sxy-img:\/\/([0-9a-fA-F-]+)\)/g, (m, alt, id) =>
    put(`<img src="${escapeAttr(imgUrl(id) || '')}" alt="${escapeAttr(alt)}" class="md-img" />`));

  // 4) 公式保护（仅当 katex 已加载时才渲染，否则保留原始 $$..$$ / $..$）
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
    if (katexMod) {
      try { return put(katexMod.renderToString(tex.trim(), { displayMode: true, throwOnError: false })); }
      catch { return m; }
    }
    return m;
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
    if (katexMod) {
      try { return put(katexMod.renderToString(tex.trim(), { displayMode: false, throwOnError: false })); }
      catch { return m; }
    }
    return m;
  });

  // 5) Markdown 解析
  let html = marked.parse(text);

  // 6) 还原占位符
  html = html.replace(/@@MDS(\d+)@@/g, (m, i) => stash[Number(i)] ?? '');

  // 7) 净化（P0 安全）：本组件是 v-html 出口，marked@4 已无内置 sanitize，
  //    而卡片内容可来自 apkg 导入 / AI 生成 / 资料解析，必须净化后再交给 v-html。
  //    放在占位符还原之后，可同时覆盖 marked 产物与自建模板（图片 alt 等）。
  return sanitizeHtml(html);
}

const html = ref('');

async function update() {
  await ensureImages(extractImageIds(props.content));
  const src = props.content || '';
  // 按需加载：仅当源文本包含对应语法标记时才加载重型库
  // 这两个 await 是串行的（一般内容里两种语法都很少），可保证 render 时模块就位
  if (src.includes('$')) await loadKatex();
  if (src.includes('`')) await loadHljs();
  html.value = render(src);
}

watch(() => props.content, update, { immediate: true });
</script>

<template>
  <div class="md-body" v-html="html"></div>
</template>

<style scoped>
.md-img { max-width: 100%; border-radius: 8px; }
</style>