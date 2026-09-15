<script setup>
// Markdown 渲染：marked(GFM) + highlight.js 高亮 + KaTeX 公式 + 本地图片解析
// 性能：katex / highlight.js 改为按需动态 import（仅当源文本含对应语法时加载）
// 首屏 chunk 不再携带这两个重型库（合计约 +400KB），仅在内容需要时才拉取。
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { marked } from 'marked';
import { imgUrl, ensureImages, extractImageIds } from '../images.js';
import { sanitizeHtml } from '../utils/sanitize.js';
import { parseStructuredReply, structuredToMarkdown, isGraphReply, isQuizReply } from '../utils/ai-structured.js';
import AiGraphView from './AiGraphView.vue';
import AiQuizView from './AiQuizView.vue';

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

/** 文本节点转义（用于自建模板的文本内容，防把用户原文当标签解析） */
function escapeText(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  // 2.5) 强调扩展：==高亮==（黄底）/ !!标红!!（红字加粗）。
  //   放在行内代码之后 → 代码里的 == 已被占位符替换，不会被误处理；
  //   放在 marked 之前 → 由 marked 决定所在块级上下文，只是把标记换成行内 HTML。
  //   用 put() 走占位符管线，可同时绕过 marked 的转义与后续净化前的一致性处理。
  text = text.replace(/==([^=\n]+?)==/g, (m, s) => put(`<mark class="md-hl">${escapeText(s)}</mark>`));
  text = text.replace(/!!([^!\n]+?)!!/g, (m, s) => put(`<span class="md-red">${escapeText(s)}</span>`));

  // 3) 本地图片：![alt](sxy-img://id) → <img src="blobURL">
  // alt 来自用户输入，必须转义后再拼进属性，否则 `x" onerror="alert(1)` 可闭合标签注入
  text = text.replace(/!\[([^\]]*)\]\(sxy-img:\/\/([0-9a-fA-F-]+)\)/g, (m, alt, id) =>
    put(`<img src="${escapeAttr(imgUrl(id) || '')}" alt="${escapeAttr(alt)}" class="md-img" loading="lazy" decoding="async" />`));

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
// 当前内容的本地图片 id（灯箱顺序导航用；与渲染出的 <img> 顺序一致）
const imgIds = ref([]);
// 结构化 graph 回复（模型按协议返回）→ 交给图表组件而不是 v-html
const graphReply = ref(null);
// 结构化 quiz 回复（AI 出的题）→ 交给可点击作答的组件（round76 复习闭环）
const quizReply = ref(null);

async function update() {
  const src0 = props.content || '';

  // 结构化回复识别（严格门禁：只有「整段就是 JSON 且带 type/data」才认，
  // 卡片正文里夹带的 JSON 一律不动）。模型有时会把工具结果原样抄出来当回答，
  // 直接显示会给用户一坨 {"type":"list","data":{...}} —— 这里按类型渲染成可读内容。
  const parsed = parseStructuredReply(src0);
  if (isGraphReply(parsed)) {
    graphReply.value = { data: parsed.data, note: parsed.note };
    quizReply.value = null;
    html.value = '';
    imgIds.value = [];
    return;
  }
  if (isQuizReply(parsed)) {
    quizReply.value = { data: parsed.data, note: parsed.note };
    graphReply.value = null;
    html.value = '';
    imgIds.value = [];
    return;
  }
  graphReply.value = null;
  quizReply.value = null;
  const effective = parsed ? (structuredToMarkdown(parsed) ?? src0) : src0;

  const ids = extractImageIds(effective);
  await ensureImages(ids);
  imgIds.value = ids;
  const src = effective;
  // 按需加载：仅当源文本包含对应语法标记时才加载重型库
  // 这两个 await 是串行的（一般内容里两种语法都很少），可保证 render 时模块就位
  if (src.includes('$')) await loadKatex();
  if (src.includes('`')) await loadHljs();
  html.value = render(src);
}

// ---- 图片全屏灯箱：点击放大 / 滚轮缩放 / 拖拽平移 / 双击复位 / ←→ 切换 / ESC 退出 ----
const lb = ref({
  open: false,
  idx: 0,
  total: 0,
  zoom: 1,
  x: 0,
  y: 0,
  rotate: 0,   // 旋转角度（0/90/180/270）——手机竖拍的照片要能转正看
  native: false,
  error: false,
});
const stage = ref(null);   // 缩放/平移舞台（transform 目标）
const lbRoot = ref(null);  // 灯箱根节点（原生全屏时以它为 fullscreen 元素，
                           // 因为灯箱 Teleport 到 body，必须在自身上申请全屏才看得到）
let drag = null;

function openLightbox(e) {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.classList.contains('md-img')) return;
  // 打开前刷新 objectURL（LRU 缓存可能已淘汰旧 URL）
  ensureImages(imgIds.value);
  // 精确定位：按容器内 .md-img 的出现顺序找点击的是第几张（同图多张也正确）
  const host = e.currentTarget;
  const imgs = host ? [...host.querySelectorAll('img.md-img')] : [];
  const pos = imgs.indexOf(img);
  const idx = pos >= 0 ? pos : imgIds.value.length - 1;
  lb.value.open = true;
  lb.value.idx = idx;
  lb.value.total = imgs.length || imgIds.value.length;
  lb.value.native = false;
  lb.value.error = false;
  resetView();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('fullscreenchange', onFsChange, true);
  // 原生全屏优先（与 AI 助手全屏同一心智）：对灯箱自身申请全屏；
  // CSP/iframe/无权限失败时由 CSS fixed 铺满兜底，行为一致。
  nextTick(() => {
    const el = lbRoot.value;
    if (lb.value.open && el && el.requestFullscreen) {
      el.requestFullscreen().then(() => {
        if (lb.value.open) lb.value.native = true;
      }).catch(() => { /* 兜底 CSS 全屏已生效 */ });
    }
  });
}

function resetView() {
  lb.value.zoom = 1;
  lb.value.x = 0;
  lb.value.y = 0;
  lb.value.rotate = 0;
}

/** 旋转 90°（dir=1 顺时针 / -1 逆时针）。旋转后自适应缩放——转过 90° 后
 *  原来的平移与缩放锚点已无意义，继续沿用会让人以为"图片飞了"，且竖图转横后
 *  长边会超出视口被裁。改为回到居中并按容器尺寸适配。 */
function rotateBy(dir) {
  if (!lb.value.open) return;
  lb.value.rotate = ((lb.value.rotate + dir * 90) % 360 + 360) % 360;
  fitAfterRotate();
}

/** 旋转后按容器尺寸自适应（0.1x~1x，保持完整可见） */
function fitAfterRotate() {
  const el = stage.value?.querySelector('img');
  const host = stage.value;
  if (!el || !host) { lb.value.zoom = 1; lb.value.x = 0; lb.value.y = 0; return; }
  const nw = el.naturalWidth || el.width || 1;
  const nh = el.naturalHeight || el.height || 1;
  const swapped = lb.value.rotate % 180 !== 0;
  const w = swapped ? nh : nw;
  const h = swapped ? nw : nh;
  const availW = Math.max(1, host.clientWidth - 48);
  const availH = Math.max(1, host.clientHeight - 48);
  const fit = Math.min(availW / w, availH / h, 1);
  lb.value.zoom = Math.max(0.1, fit);
  lb.value.x = 0;
  lb.value.y = 0;
}

function closeLightbox() {
  if (!lb.value.open) return;
  lb.value.open = false;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('fullscreenchange', onFsChange, true);
  if (lb.value.native && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// 用户经浏览器菜单/快捷键退出了原生全屏 → 灯箱一并关闭（保持一致心智）
function onFsChange() {
  if (lb.value.open && lb.value.native && document.fullscreenElement !== lbRoot.value) {
    closeLightbox();
  }
}

function nav(d) {
  if (!lb.value.open || lb.value.total < 2) return;
  lb.value.idx = (lb.value.idx + d + lb.value.total) % lb.value.total;
  lb.value.error = false;
  resetView();
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setZoom(1.8); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateBy(e.shiftKey ? -1 : 1); }
}

function setZoom(z, cx, cy) {
  const nz = Math.min(4, Math.max(0.5, z));
  const el = stage.value;
  const S = el?.clientWidth ?? 0;
  const Sh = el?.clientHeight ?? 0;
  // 无锚点（快捷键/滚轮）→ 围绕舞台中心缩放
  if (cx == null || cy == null) { cx = S / 2; cy = Sh / 2; }
  // ⚠ 图片是 absolute + left/top:50% + translate:-50% -50% 居中，且 transform-origin:center。
  // 因此缩放不动点要按「相对舞台中心」的偏移算（d = 锚点 - 舞台中心），旧实现直接用 cx
  // 等于假设左上角原点 → 缩放整体漂移、不居中（2026-09-14 修复）。
  const k = nz / lb.value.zoom;
  const dx = cx - S / 2;
  const dy = cy - Sh / 2;
  lb.value.x = dx - (dx - lb.value.x) * k;
  lb.value.y = dy - (dy - lb.value.y) * k;
  lb.value.zoom = nz;
}

function onWheel(e) {
  if (!lb.value.open) return;
  e.preventDefault();
  // 居中缩放（浏览器式）：以舞台中心为锚点，不跟随光标
  setZoom(lb.value.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}

function onDbl(e) {
  if (!lb.value.open) return;
  if (lb.value.zoom > 1.01) resetView();
  else setZoom(2);
}

function onDown(e) {
  if (!lb.value.open || lb.value.zoom <= 1) return;
  drag = { sx: e.clientX, sy: e.clientY, ox: lb.value.x, oy: lb.value.y, moved: false };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
}

function onMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  lb.value.x = drag.ox + dx;
  lb.value.y = drag.oy + dy;
}

function onUp() { drag = null; }

function onImgError() { lb.value.error = true; }

watch(() => props.content, async () => {
  // 内容切换：重算图片序列；灯箱开着则关闭（其全屏 DOM 可能已随内容重渲染）
  if (lb.value.open) closeLightbox();
  lb.value.idx = 0;
  await update();
}, { immediate: true });
// ⚠️ 这段 watch 必须调用 update() 且 immediate ——
// html 只在 update() 里赋值，一旦漏调（或没有 immediate 首次不触发），
// 组件就永远渲染空串：卡片正反面、编辑预览、AI 回复、资料解析全部空白，
// 全屏因只剩黑底而表现为「黑屏」。2026-09-14 实测事故：灯箱改动把 update() 的调用整段删了。

onBeforeUnmount(() => {
  if (lb.value.open) closeLightbox();
  document.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <!-- 结构化 graph 回复 → 内联图表（知识图谱 / 关键路径等） -->
  <div v-if="graphReply" class="md-body md-graph">
    <AiGraphView :data="graphReply.data" :note="graphReply.note" />
  </div>
  <!-- 结构化 quiz 回复 → 可点击作答的题目（判分 + 解析 + 可选记入复习） -->
  <div v-else-if="quizReply" class="md-body md-quiz">
    <AiQuizView :data="quizReply.data" :note="quizReply.note" />
  </div>
  <div v-else class="md-body" v-html="html" @click="openLightbox"></div>
  <Teleport to="body">
    <div v-if="lb.open" ref="lbRoot" class="img-lb" :class="{ 'is-native': lb.native }" @click.self="closeLightbox" @wheel.prevent="onWheel">
      <div
        v-show="!lb.error"
        class="img-lb-stage"
        ref="stage"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @dblclick="onDbl"
      >
        <img
          class="img-lb-img"
          :src="imgUrl(imgIds[lb.idx])"
          alt="图片预览"
          draggable="false"
          :style="{ transform: `translate(${lb.x}px, ${lb.y}px) scale(${lb.zoom}) rotate(${lb.rotate}deg)` }"
          @error="onImgError"
        />
      </div>
      <div v-if="lb.error" class="img-lb-err">图片已不存在</div>
      <button class="img-lb-btn img-lb-close" title="关闭 (Esc)" @click="closeLightbox">×</button>
      <button v-if="lb.total > 1" class="img-lb-btn img-lb-prev" title="上一张 (←)" @click.stop="nav(-1)">‹</button>
      <button v-if="lb.total > 1" class="img-lb-btn img-lb-next" title="下一张 (→)" @click.stop="nav(1)">›</button>
      <div class="img-lb-bar">
        <span v-if="lb.total > 1" class="img-lb-count">{{ lb.idx + 1 }} / {{ lb.total }}</span>
        <span class="img-lb-zoom">{{ Math.round(lb.zoom * 100) }}%</span>
        <button class="img-lb-rot" title="逆时针旋转 90°（Shift+R）" @click.stop="rotateBy(-1)">↺</button>
        <button class="img-lb-rot" title="顺时针旋转 90°（R）" @click.stop="rotateBy(1)">↻</button>
        <span v-if="lb.rotate" class="img-lb-rot-deg">{{ lb.rotate }}°</span>
        <span class="img-lb-tip">滚轮缩放 · 拖拽移动 · R 旋转 · 双击复位 · Esc 退出</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.md-img { max-width: 100%; border-radius: 8px; cursor: zoom-in; }

/* 灯箱工具栏的旋转按钮 */
.img-lb-rot {
  background: rgba(255,255,255,0.14); color: #fff; border: 1px solid rgba(255,255,255,0.25);
  border-radius: 6px; padding: 2px 9px; font-size: 15px; line-height: 1.4; cursor: pointer;
}
.img-lb-rot:hover { background: rgba(255,255,255,0.24); }
.img-lb-rot-deg { color: #fff; opacity: .8; font-variant-numeric: tabular-nums; font-size: 12px; }

/* 图片全屏灯箱：非原生全屏时 fixed 铺满兜底；is-native 时由浏览器全屏接管尺寸 */
.img-lb {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: rgba(8, 10, 14, 0.92);
  display: flex;
  flex-direction: column;
  user-select: none;
  touch-action: none;
}
.img-lb.is-native {
  position: absolute;
  width: 100%;
  height: 100%;
}
.img-lb-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  cursor: grab;
}
.img-lb-stage:active { cursor: grabbing; }
.img-lb-img {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: 92%;
  max-height: 92%;
  transform-origin: center center;
  will-change: transform;
  /* 先以 (x,y) 平移再缩放：translate 用绝对像素，视觉锚点正确 */
  translate: -50% -50%;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  background: #1c1f26;
}
.img-lb-err {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9aa3b2;
  font-size: 15px;
}
.img-lb-btn {
  position: absolute;
  z-index: 2;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 50%;
  background: rgba(20, 24, 32, 0.66);
  color: #e8ecf3;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(6px);
  transition: background 0.15s ease;
}
.img-lb-btn:hover { background: rgba(56, 66, 86, 0.85); }
.img-lb-close { top: 14px; right: 14px; }
.img-lb-prev { left: 14px; top: 50%; transform: translateY(-50%); font-size: 26px; }
.img-lb-next { right: 14px; top: 50%; transform: translateY(-50%); font-size: 26px; }
.img-lb-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  color: #aab3c2;
  font-size: 12px;
  background: rgba(8, 10, 14, 0.7);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.img-lb-count { font-variant-numeric: tabular-nums; }
.img-lb-zoom { font-variant-numeric: tabular-nums; }
.img-lb-tip { margin-left: auto; opacity: 0.65; }
</style>