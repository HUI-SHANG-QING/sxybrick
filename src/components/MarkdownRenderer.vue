<script setup>
// Markdown 渲染：marked(GFM) + highlight.js 高亮 + KaTeX 公式 + 本地图片解析
import { ref, watch } from 'vue';
import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import { imgUrl, ensureImages, extractImageIds } from '../images.js';

const props = defineProps({ content: { type: String, default: '' } });

marked.setOptions({ breaks: true, gfm: true });

function render(src) {
  const stash = [];
  const put = (html) => { stash.push(html); return `@@MDS${stash.length - 1}@@`; };
  let text = src || '';

  // 1) 代码块优先保护
  text = text.replace(/```([\s\S]*?)```/g, (m, code) => {
    const nl = code.indexOf('\n');
    let lang = '', body = code;
    if (nl >= 0) { lang = code.slice(0, nl).trim(); body = code.slice(nl + 1); }
    const html = lang && hljs.getLanguage(lang)
      ? `<pre><code class="hljs language-${lang}">${hljs.highlight(body, { language: lang }).value}</code></pre>`
      : `<pre><code class="hljs">${hljs.highlightAuto(body).value}</code></pre>`;
    return put(html);
  });

  // 2) 行内代码保护
  text = text.replace(/`([^`\n]+)`/g, (m, code) =>
    put(`<code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`));

  // 3) 本地图片：![alt](sxy-img://id) → <img src="blobURL">
  text = text.replace(/!\[([^\]]*)\]\(sxy-img:\/\/([0-9a-fA-F-]+)\)/g, (m, alt, id) =>
    put(`<img src="${imgUrl(id) || ''}" alt="${alt}" class="md-img" />`));

  // 4) 公式保护
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
    try { return put(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false })); }
    catch { return m; }
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
    try { return put(katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false })); }
    catch { return m; }
  });

  // 5) Markdown 解析
  let html = marked.parse(text);

  // 6) 还原占位符
  html = html.replace(/@@MDS(\d+)@@/g, (m, i) => stash[Number(i)]);
  return html;
}

const html = ref('');

async function update() {
  await ensureImages(extractImageIds(props.content));
  html.value = render(props.content);
}

watch(() => props.content, update, { immediate: true });
</script>

<template>
  <div class="md-body" v-html="html"></div>
</template>

<style scoped>
.md-img { max-width: 100%; border-radius: 8px; }
</style>