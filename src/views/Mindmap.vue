<script setup>
// 思维导图（借鉴 Progress AI，纯本地化：ECharts 多风格 + IndexedDB 持久化，随数据包同步）
// 支持：多风格切换（横向树/放射树/竖向树/桑基图/力导向）+ 手动建图 / 从知识图谱生成 / AI 从卡片生成 / 文字生成 / Agent 智能生成
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as echarts from 'echarts';
import ChartZoomBar from '../components/ChartZoomBar.vue';
import { stepZoom, ZOOM_MIN, ZOOM_MAX, readZoom } from '../composables/useTextZoom.js';
import { uid } from '../db.js';
import { listMindmaps, createMindmap, updateMindmap, deleteMindmap, listGraphEdges } from '../repo.js';
import { db } from '../db.js';
import { resolveGraph, edgesToForest } from '../algorithms/graph-resolve.js';
import { treeToFlat as treeToFlatPure, sankeyFromTree } from '../algorithms/mindmap-graph.js';
import { chatAI, hasAIKey, getAIConfig } from '../ai.js';
import { toast } from '../utils/toast.js';
import { logError } from '../utils/errorLog.js';
import { agentSystem } from '../agent/index.js';
import EmptyState from '../components/EmptyState.vue';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';

const route = useRoute();
const router = useRouter();

// 选中节点（显式跳转按钮）
const selSubject = ref(''); // 导图本身不带科目，跳的时候只按 label 搜索
async function jumpToNodeCard(label) {
  const q = String(label || '').trim();
  if (!q) return;
  try {
    const all = await db.cards.toArray();
    const exact = all.filter(c => String(c.front || '') === q);
    const loose = exact.length ? exact : all.filter(c => String(c.front || '').includes(q) || String(c.back || '').includes(q));
    if (loose.length === 1) router.push(`/cards?id=${encodeURIComponent(loose[0].id)}`);
    else if (loose.length > 1) router.push(`/cards?q=${encodeURIComponent(q)}`);
    else { toast(t('views.mindmap.jumpNotFound', undefined, { q }), 'warn'); router.push(`/cards?q=${encodeURIComponent(q)}`); }
  } catch (e) {
    logError(e, { component: 'Mindmap.vue:jumpToNodeCard', route: '/mindmap', info: `label=${q.slice(0,80)}` });
    toast(t('views.mindmap.jumpFailed', '跳转失败：') + e.message, 'error');
  }
}

const maps = ref([]);
const current = ref(null);
const dirty = ref(false);
const loading = ref(false);
const aiLoading = ref(false);
const selId = ref('');
const chartEl = ref(null);
const fsChartEl = ref(null);
let chart = null;
// P0 图表缩放：series.zoom 档位 + 大图模式；sankey 不支持 zoom（仍可用大图看大图）；档位按模块持久化
const chartZoom = ref(readZoom('mindmap'));
watch(chartZoom, (v) => { try { localStorage.setItem(`sxy_zoom_${'mindmap'}`, String(v)); } catch { /* 隐私模式忽略 */ } });
const fsOpen = ref(false);
const canChartZoom = computed(() => layout.value !== 'sankey');
function activeChartEl() { return fsOpen.value ? fsChartEl.value : chartEl.value; }

// ---- 多风格切换 ----
const layout = ref(localStorage.getItem('sxy_mm_layout') || 'tree-lr');
const LAYOUTS = computed(() => [
  { id: 'tree-lr', name: t('views.mindmap.layoutTreeLr'), icon: '→' },
  { id: 'tree-radial', name: t('views.mindmap.layoutTreeRadial'), icon: '✸' },
  { id: 'tree-tb', name: t('views.mindmap.layoutTreeTb'), icon: '↓' },
  { id: 'sankey', name: t('views.mindmap.layoutSankey'), icon: '⇉' },
  { id: 'force', name: t('views.mindmap.layoutForce'), icon: '⊛' },
]);
function setLayout(id) { layout.value = id; localStorage.setItem('sxy_mm_layout', id); render(); }

const list = async () => { maps.value = await listMindmaps(); };
const findNode = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) { const r = findNode(c, id); if (r) return r; }
  return null;
};
const toChart = node => ({ name: node.label, id: node.id, children: (node.children || []).map(toChart) });
const chartData = computed(() => (current.value ? toChart(current.value.root) : null));

// 兼容历史导图：早期版本保存的树节点没有 id，统一补齐（否则点击选中/力导向建边都拿不到 id）
function ensureNodeIds(node) {
  if (!node) return node;
  if (!node.id) node.id = uid();
  for (const c of node.children || []) ensureNodeIds(c);
  return node;
}

// 树 → 扁平 nodes/links（供桑基图、力导向用）。
// 实现抽到 algorithms/mindmap-graph.js：ECharts 的 graph/sankey 系列
// 是「节点带 id 时边只能按 id 匹配」，一旦用 name 建边就会静默丢掉全部连线，
// 这个坑必须有单测守住，不能埋在 SFC 里。
function treeToFlat(root) { return treeToFlatPure(root); }

function buildOption(data, style) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4a9eff';
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#333';
  const line = getComputedStyle(document.documentElement).getPropertyValue('--line-strong').trim() || '#999';
  if (style === 'tree-lr') return treeOption(data, 'LR', 'orthogonal', accent, ink, line);
  if (style === 'tree-tb') return treeOption(data, 'TB', 'orthogonal', accent, ink, line);
  if (style === 'tree-radial') return treeOption(data, 'LR', 'radial', accent, ink, line);
  if (style === 'sankey') {
    // ⚠️ ECharts sankey 在节点带 id 时会把 id 当成 label 文本（渲染出一串字母），
    // 与 graph/force 系列行为不同。sankeyFromTree 已处理成只用 name 作键。
    const { nodes: sankeyNodes, links: sankeyLinks } = sankeyFromTree(data);
    // 桑基图防堆叠：节点最小高度 minNodeHeight=6 防止一堆点挤成一条黑线；
    // 加大 nodeGap、迭代次数、容器边距，并让长标签截断避免横向重叠
    const count = Math.max(sankeyNodes.length, 1);
    const nodeGap = Math.min(28, Math.max(10, 600 / count));  // 节点越多间距越小，但不低于 10
    const minNodeHeight = 6;
    return {
      tooltip: { trigger: 'item' },
      animation: true,
      series: [{
        type: 'sankey',
        data: sankeyNodes,
        links: sankeyLinks,
        left: 96, right: 200, top: 40, bottom: 40,
        width: 'auto', height: 'auto',
        nodeWidth: 18,
        nodeGap,
        nodeAlign: 'justify',
        minNodeHeight,
        layoutIterations: 128,
        draggable: true,
        emphasis: { focus: 'adjacency' },
        label: {
          color: ink, fontSize: 12,
          position: 'right',
          distance: 8,
          width: 180, overflow: 'truncate', ellipsis: '…',
        },
        lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.55 },
        itemStyle: { color: accent, borderColor: 'transparent', borderWidth: 0, borderRadius: 3 },
      }],
    };
  }
  if (style === 'force') {
    const { nodes, links } = treeToFlat(data);
    return {
      tooltip: { trigger: 'item', formatter: p => p.data?.name || p.name },
      series: [{
        type: 'graph', layout: 'force',
        data: nodes.map(n => ({
          name: n.name, id: n.id, symbolSize: 18,
          itemStyle: { color: accent },
        })),
        links: links.map(l => ({ source: l.source, target: l.target })),
        force: { repulsion: 320, edgeLength: 110, gravity: 0.035, layoutAnimation: true },
        label: {
          show: true, color: ink, fontSize: 12, position: 'right',
          width: 140, overflow: 'truncate', ellipsis: '…',
        },
        lineStyle: { color: line, width: 1.2, curveness: 0.1 },
        roam: true, zoom: 1,
      }],
    };
  }
  return treeOption(data, 'LR', 'orthogonal', accent, ink, line);
}

function treeOption(data, orient, layout, accent, ink, line) {
  const isRadial = layout === 'radial';
  const isTB = orient === 'TB';
  // 防重叠：LR 默认 label 右对齐 160/140，TB 上下给 width+截断；径向留 distance
  const baseLabel = isRadial
    ? { position: 'radial', fontSize: 13, color: ink, distance: 6 }
    : isTB
      ? { position: 'top', verticalAlign: 'middle', align: 'center', fontSize: 13, color: ink, width: 120, overflow: 'truncate', ellipsis: '…' }
      : { position: 'left', verticalAlign: 'middle', align: 'right', fontSize: 13, color: ink, width: 160, overflow: 'truncate', ellipsis: '…' };
  const leavesLabel = isRadial
    ? { position: 'radial', distance: 8, fontSize: 13, color: ink }
    : isTB
      ? { position: 'bottom', verticalAlign: 'middle', align: 'center', width: 140, overflow: 'truncate', ellipsis: '…' }
      : { position: 'right', verticalAlign: 'middle', align: 'left', width: 200, overflow: 'truncate', ellipsis: '…' };
  return {
    tooltip: { trigger: 'item', formatter: p => p.data.name },
    series: [{
      type: 'tree', data: [data],
      left: isRadial ? '8%' : (isTB ? '4%' : '2%'),
      right: isRadial ? '8%' : (isTB ? '4%' : '18%'),
      top: isRadial ? '8%' : (isTB ? '4%' : '3%'),
      bottom: isRadial ? '8%' : (isTB ? '6%' : '3%'),
      symbol: 'circle', symbolSize: 10, orient, layout,
      roam: true, zoom: isRadial ? 0.9 : 1,
      nodePadding: isRadial ? 20 : 24,
      layerPadding: isRadial ? 90 : (isTB ? 160 : 200),
      label: baseLabel,
      leaves: { label: leavesLabel },
      emphasis: { focus: 'descendant' },
      expandAndCollapse: true, initialTreeDepth: 3,
      lineStyle: { color: line, width: 1.5, curveness: 0.4 },
      itemStyle: { color: accent, borderColor: 'transparent' },
    }],
  };
}

function render() {
  if (!chart || !chartData.value) return;
  const opt = buildOption(chartData.value, layout.value);
  // P0 图表缩放：注入 series.zoom（tree/graph 系列支持；sankey 忽略但大图模式仍可用）
  if (opt && opt.series) {
    const arr = Array.isArray(opt.series) ? opt.series : [opt.series];
    for (const s of arr) {
      if (s && (s.type === 'graph' || s.type === 'tree')) {
        s.zoom = chartZoom.value;
        s.scaleLimit = s.scaleLimit || { min: ZOOM_MIN, max: ZOOM_MAX };
      }
    }
  }
  chart.setOption(opt, true);
}

// P0 图表缩放：A−/A+ 步进 + 适应窗口复位
function applyZoom(dir) { chartZoom.value = stepZoom(chartZoom.value, dir); render(); }
function fitChart() { chartZoom.value = 1; render(); }

// 大图模式：销毁实例 → 切换到近全屏容器 → 重 init（矢量清晰，便于专注复习）
async function toggleFs() {
  if (chart) { chart.dispose(); chart = null; }
  fsOpen.value = !fsOpen.value;
  await nextTick();
  if (!chart) ensureChart();
  if (chart) render();
}

function openMap(m) {
  current.value = JSON.parse(JSON.stringify(m));
  // 补齐历史数据缺失的节点 id（影响点击选中 + 力导向/桑基建边）
  ensureNodeIds(current.value.root);
  dirty.value = false;
  selId.value = current.value.root?.id || '';
  nextTick(() => { if (!chart) ensureChart(); render(); });
}

function ensureChart() {
  if (chart) return chart;
  const el = activeChartEl();
  if (!el) return null;
  try { initChart(el); } catch (e) { logError(e, { component: 'Mindmap.vue', route: '/mindmap', info: 'ensureChart' }); }
  return chart;
}

function initChart(el) {
  chart = echarts.init(el);
  chart.off('click');
  chart.on('click', p => {
    // 统一处理三种系列的点击：
    // 1) tree 系列（横/竖/放射树）：单击会触发 ECharts 内置展开/折叠，不打断它，
    //    只把节点 id/name 同步到选中态；显式跳转用面板按钮
    // 2) sankey / graph (force) 风格：同样把 name/id 写入选中态 + 面板按钮跳转
    const d = p.data || {};
    const name = d.name || d.label;
    const id = d.id;
    if (id) selId.value = String(id);
    else if (name && current.value?.root) {
      // 用 name 反查树节点 id（桑基/力导向只带 name 没带 id）
      const hit = findNodeByName(current.value.root, name);
      if (hit) selId.value = hit.id;
    }
  });
  window.addEventListener('resize', onResize);
}
function findNodeByName(root, name) {
  if (!root) return null;
  if ((root.name || root.label) === name) return root;
  for (const c of root.children || []) {
    const h = findNodeByName(c, name);
    if (h) return h;
  }
  return null;
}
function onResize() { chart?.resize(); }
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart?.dispose(); });

async function newMap() {
  const m = await createMindmap({ title: t('views.mindmap.defaultTitle'), rootLabel: '中心主题' });
  await list();
  openMap(m);
}

// 从知识图谱关系生成导图（有向边 → 森林，防环）
// 走统一解析层：卡片ID 型 / 标签型 / 资料型三种边都能解析成人类可读节点，
// 否则老数据里的裸 UUID 会被当成节点名直接画进导图。
async function fromGraph() {
  const [rawEdges, cards] = await Promise.all([listGraphEdges(), db.cards.toArray()]);
  if (!rawEdges.length) { toast(t('views.mindmap.graphNoEdges'), 'error'); return; }
  const { edges, nodes } = resolveGraph(rawEdges, cards);
  const usable = edges.length ? edges : rawEdges; // 全是失效边时退回原样，至少不静默空转
  // round16 R16-2：resolveGraph 的边端点现在是稳定键（cardId 优先），
  // 必须用 nodes 的 id→label 映射把键翻译回人类可读名称，
  // 否则导图树上节点显示成 card_xxx 内部 id（P2-7 引入的静默回归，KnowledgeGraph 已适配、此处漏了）
  const labelMap = new Map((nodes || []).map(n => [n.id, n.label]));
  const { root } = edgesToForest(usable, { rootLabel: '📚 知识图谱', labelMap });
  if (!root) { toast(t('views.mindmap.graphNoUsable'), 'error'); return; }
  const withIds = n => ({ id: uid(), label: String(n.name || '主题').slice(0, 30), children: (n.children || []).map(withIds) });
  const mm = await createMindmap({ title: t('views.mindmap.defaultFromGraph'), root: withIds(root) });
  await list(); openMap(mm);
  const skipped = edges.length - usable.length;
  toast(skipped ? t('views.mindmap.genFromGraphSkipped', undefined, { skipped }) : t('views.mindmap.genFromGraph'), 'success');
}

// AI 从卡片生成导图（直接 LLM）
async function fromAI() {
  if (!hasAIKey()) { toast(t('views.mindmap.needKey'), 'error'); return; }
  aiLoading.value = true;
  try {
    const cards = await db.cards.toArray();
    if (!cards.length) { toast(t('views.mindmap.noCards'), 'error'); return; }
    const sample = cards.slice(0, 60).map(c => `[${c.subject || '未分类'}] ${String(c.front).slice(0, 80)}${c.back ? ' / ' + String(c.back).slice(0, 60) : ''}`).join('\n');
    const r = await chatAI([
      { role: 'system', content: '你是思维导图生成器。根据下面卡片提取知识主题，输出严格 JSON：{"title":"导图标题","root":{"label":"中心主题","children":[{"label":"子主题","children":[]}]}}。层级 2~3 层，节点总数 8~25 个。只输出 JSON。' },
      { role: 'user', content: sample },
    ]);
    const m = String(r).match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : r);
    if (!obj?.root?.label) throw new Error('AI 没返回有效结构');
    const withIds = n => ({ id: uid(), label: String(n.label || '主题').slice(0, 30), children: (n.children || []).slice(0, 40).map(withIds) });
    const mm = await createMindmap({ title: String(obj.title || t('views.mindmap.defaultFromAI')).slice(0, 40), root: withIds(obj.root) });
    await list(); openMap(mm);
    toast(t('views.mindmap.aiDone'), 'success');
  } catch (e) { toast(t('views.mindmap.genFailed', '生成失败：') + e.message, 'error'); }
  finally { aiLoading.value = false; }
}

// Agent 智能生成：走专业 agent（A 镜头）的 ReAct 工具调用循环，比裸 chatAI 更懂卡片库
async function fromAgent() {
  if (!hasAIKey()) { toast(t('views.mindmap.needKey'), 'error'); return; }
  aiLoading.value = true;
  try {
    const { reply } = await agentSystem.runTask({
      userInput: '分析我的卡片库，提取核心知识主题，构建一份层次清晰（2~3 层，8~25 节点）的思维导图。务必只输出严格 JSON：{"title":"导图标题","root":{"label":"中心主题","children":[{"label":"子主题","children":[]}]}}',
      cfg: getAIConfig(),
      agentId: 'cardsmith',
    });
    const m = String(reply).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Agent 未返回 JSON 结构');
    const obj = JSON.parse(m[0]);
    if (!obj?.root?.label) throw new Error('Agent 没返回有效结构');
    const withIds = n => ({ id: uid(), label: String(n.label || '主题').slice(0, 30), children: (n.children || []).slice(0, 40).map(withIds) });
    const mm = await createMindmap({ title: String(obj.title || t('views.mindmap.defaultFromAgent')).slice(0, 40), root: withIds(obj.root) });
    await list(); openMap(mm);
    toast(t('views.mindmap.agentDone'), 'success');
  } catch (e) { toast(t('views.mindmap.agentFailed', 'Agent 生成失败：') + e.message, 'error'); }
  finally { aiLoading.value = false; }
}

// ---- 文字 → 思维导图（AI 从用户输入文本生成）----
const textOpen = ref(false);
const textInput = ref('');
const textLoading = ref(false);
function openTextGen() { textInput.value = ''; textOpen.value = true; }
async function fromText() {
  const txt = textInput.value.trim();
  if (!txt) { toast(t('views.mindmap.textEmpty'), 'error'); return; }
  if (!hasAIKey()) { toast(t('views.mindmap.needKey'), 'error'); return; }
  textLoading.value = true;
  try {
    const r = await chatAI([
      { role: 'system', content: '你是思维导图生成器。根据用户输入的文字提取知识结构，输出严格 JSON：{"title":"导图标题","root":{"label":"中心主题","children":[{"label":"子主题","children":[{"label":"细节"}]}]}}。层级 2~4 层，节点总数 8~30 个，要忠于原文层次。只输出 JSON。' },
      { role: 'user', content: txt.slice(0, 8000) },
    ]);
    const m = String(r).match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : r);
    if (!obj?.root?.label) throw new Error('AI 没返回有效结构');
    const withIds = n => ({ id: uid(), label: String(n.label || '主题').slice(0, 30), children: (n.children || []).slice(0, 40).map(withIds) });
    const mm = await createMindmap({ title: String(obj.title || t('views.mindmap.defaultFromText')).slice(0, 40), root: withIds(obj.root) });
    await list(); openMap(mm); textOpen.value = false;
    toast(t('views.mindmap.textDone'), 'success');
  } catch (e) { toast(t('views.mindmap.genFailed', '生成失败：') + e.message, 'error'); }
  finally { textLoading.value = false; }
}

// ---- 节点编辑 ----
function markDirty() { dirty.value = true; render(); }
function addChild() {
  const target = findNode(current.value?.root, selId.value) || current.value?.root;
  if (!target) return;
  target.children = target.children || [];
  target.children.push({ id: uid(), label: '新节点', children: [] });
  selId.value = target.children[target.children.length - 1].id;
  markDirty();
}
function renameSel() {
  const node = findNode(current.value?.root, selId.value);
  if (!node) return;
  const name = prompt(t('views.mindmap.renamePrompt', '修改节点文字：'), node.label);
  if (name != null && name.trim()) { node.label = name.trim().slice(0, 30); markDirty(); }
}
function removeSel() {
  const root = current.value?.root;
  if (!root) return;
  if (selId.value === root.id) { toast(t('views.mindmap.rootCantDelete'), 'error'); return; }
  const remove = (node) => {
    if (!node) return false;
    if ((node.children || []).some(c => c.id === selId.value)) { node.children = node.children.filter(c => c.id !== selId.value); return true; }
    return (node.children || []).some(remove);
  };
  if (remove(root)) { selId.value = root.id; markDirty(); }
}
async function saveMap() {
  if (!current.value) return;
  try {
    await updateMindmap(current.value.id, { title: current.value.title, root: current.value.root });
    dirty.value = false;
    await list();
    const count = (function countNodes(n){ if (!n) return 0; return 1 + ((n.children||[]).reduce((s,c)=>s+countNodes(c),0)); })(current.value.root);
    try { T.mindmapSave(count); } catch {}
    toast(t('views.mindmap.savedToast'), 'success');
  } catch (e) { toast(t('views.mindmap.saveFailed', '保存失败：') + e.message, 'error'); }
}
async function removeMap(m) {
  if (!(await confirmDialog(t('views.mindmap.confirmDelete', undefined, { title: m.title })))) return;
  await deleteMindmap(m.id);
  if (current.value?.id === m.id) { current.value = null; selId.value = ''; }
  await list();
}
const selectedLabel = computed(() => findNode(current.value?.root, selId.value)?.label || '');

onMounted(async () => {
  await list();
  // 搜索结果跳转：URL ?id=xxx 自动定位并打开对应导图
  const id = route.query?.id ? String(route.query.id) : '';
  const target = id ? maps.value.find(m => m.id === id) : null;
  if (target) { await nextTick(); openMap(target); }
  else if (maps.value.length) openMap(maps.value[0]);
});
</script>

<template>
  <div class="mm-wrap">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.mindmap.heading') }}</h2>
      <span style="flex:1"></span>
      <button class="btn primary" @click="newMap">{{ t('views.mindmap.new') }}</button>
      <button class="btn" @click="fromGraph">{{ t('views.mindmap.fromGraph') }}</button>
      <button class="btn" :disabled="aiLoading" @click="fromAI">{{ aiLoading ? t('views.mindmap.genLoading') : t('views.mindmap.aiFromCards') }}</button>
      <button class="btn" :disabled="aiLoading" @click="fromAgent" :title="t('views.mindmap.agentTooltip')">{{ t('views.mindmap.agentGen') }}</button>
      <button class="btn" @click="openTextGen">{{ t('views.mindmap.textGen') }}</button>
    </div>
    <p class="hint" style="margin:4px 0 10px">{{ t('views.mindmap.hint') }}</p>

    <div v-if="current" class="mm-layout-bar">
      <span class="hint" style="margin-right:4px">{{ t('views.mindmap.styleLabel') }}</span>
      <button v-for="l in LAYOUTS" :key="l.id" class="mm-style-chip" :class="{active: layout === l.id}" @click="setLayout(l.id)" :title="l.name">
        <span style="font-size:14px">{{ l.icon }}</span><span>{{ l.name }}</span>
      </button>
      <span style="flex:1"></span>
      <ChartZoomBar :zoom="chartZoom" :can-zoom="canChartZoom" @zoom-in="applyZoom(1)" @zoom-out="applyZoom(-1)" @fit="fitChart" @toggle-fullscreen="toggleFs" />
    </div>

    <div class="mm-body">
      <aside class="mm-list">
        <EmptyState v-if="!maps.length" icon="🗺️" :title="t('views.mindmap.emptyTitle')" :message="t('views.mindmap.emptyMsg')" />
        <div v-for="m in maps" :key="m.id" class="mm-item" :class="{ active: current?.id === m.id }">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="mm-title" @click="openMap(m)">{{ m.title }}</span>
            <a class="mm-del" @click="removeMap(m)" :aria-label="t('views.mindmap.delAria')">{{ t('views.mindmap.delText') }}</a>
          </div>
          <div class="mm-meta">{{ new Date(m.updatedAt).toLocaleDateString() }}</div>
        </div>
      </aside>

      <section class="mm-main">
        <template v-if="current">
          <div class="mm-toolbar">
            <input v-model="current.title" class="input" style="max-width:220px" :placeholder="t('views.mindmap.titlePlaceholder')" @input="dirty = true" />
            <span v-if="selectedLabel" class="hint" style="margin-left:4px">{{ t('views.mindmap.selected') }}{{ selectedLabel }}</span>
            <span style="flex:1"></span>
            <button class="btn small" @click="addChild">{{ t('views.mindmap.addChild') }}</button>
            <button class="btn small" @click="renameSel">{{ t('views.mindmap.rename') }}</button>
            <button class="btn small" style="color:var(--red)" @click="removeSel">{{ t('views.mindmap.removeNode') }}</button>
            <button class="btn small primary" :disabled="!dirty" @click="saveMap">{{ dirty ? t('views.mindmap.save') : t('views.mindmap.saved') }}</button>
          </div>
          <div v-if="current && !fsOpen" ref="chartEl" class="mm-chart"></div>
          <div v-if="selectedLabel" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:8px">
            <span class="hint">
              {{ t('views.mindmap.currentNode') }}<b>{{ selectedLabel }}</b>
              <span class="hint" style="margin-left:4px">{{ t('views.mindmap.nodeHint') }}</span>
            </span>
            <button class="btn small primary" @click="jumpToNodeCard(selectedLabel)">{{ t('views.mindmap.jumpCard') }}</button>
          </div>
          <p class="hint" style="margin:6px 0 0">{{ t('views.mindmap.editHint') }}</p>
        </template>
        <EmptyState v-else icon="🗺️" :title="t('views.mindmap.pickTitle')" :message="t('views.mindmap.pickMsg')" />
      </section>
    </div>

    <!-- 文字 → 思维导图 弹窗 -->
    <div v-if="textOpen" class="mm-mask" @click.self="textOpen = false">
      <div class="mm-modal">
        <div class="mm-modal-title">{{ t('views.mindmap.textModalTitle') }}</div>
        <p class="hint" style="margin:4px 0 8px">{{ t('views.mindmap.textModalHint') }}</p>
        <textarea v-model="textInput" class="input mm-textarea" :placeholder="t('views.mindmap.textPlaceholder')" ></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <button class="btn" @click="textOpen = false">{{ t('views.mindmap.cancel') }}</button>
          <button class="btn primary" :disabled="textLoading" @click="fromText">{{ textLoading ? t('views.mindmap.genLoading') : t('views.mindmap.genMap') }}</button>
        </div>
      </div>
    </div>

    <!-- 大图模式：近全屏铺满，重新在更大容器里 init ECharts（矢量清晰，便于专注复习） -->
    <teleport to="body">
      <div v-if="fsOpen" class="mm-fs-mask" @click.self="toggleFs" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:95;display:flex;align-items:center;justify-content:center;padding:16px">
        <div class="mm-fs-panel" style="width:min(1400px,96vw);height:min(92vh,1000px);background:var(--panel);border-radius:14px;box-shadow:0 16px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden">
          <div class="mm-fs-bar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line)">
            <strong style="font-size:14px">{{ t('views.mindmap.heading') }}</strong>
            <span style="flex:1"></span>
            <ChartZoomBar :zoom="chartZoom" :fullscreen="true" :can-zoom="canChartZoom" @zoom-in="applyZoom(1)" @zoom-out="applyZoom(-1)" @fit="fitChart" @toggle-fullscreen="toggleFs" />
          </div>
          <div ref="fsChartEl" style="flex:1;width:100%;min-height:0"></div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.mm-wrap { max-width: 1200px; margin: 0 auto; }
.mm-layout-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.mm-style-chip { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; font-size: 12px; cursor: pointer; transition: .12s; }
.mm-style-chip:hover { border-color: var(--accent); }
.mm-style-chip.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.mm-body { display: grid; grid-template-columns: 220px 1fr; gap: 12px; }
.mm-list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; max-height: calc(100vh - 260px); overflow-y: auto; }
.mm-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; border: 1px solid transparent; }
.mm-item:hover { background: var(--code-inline); }
.mm-item.active { background: var(--code-bg); border-color: var(--accent); }
.mm-title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mm-del { color: var(--red); font-size: 12px; cursor: pointer; }
.mm-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.mm-main { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; min-height: 560px; display: flex; flex-direction: column; }
.mm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mm-chart { width: 100%; height: 68vh; min-height: 560px; flex: 1; }
.mm-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 90; display: flex; align-items: center; justify-content: center; padding: 16px; }
.mm-modal { width: 560px; max-width: 100%; background: var(--panel); border-radius: 14px; padding: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.mm-modal-title { font-size: 16px; font-weight: 700; }
.mm-textarea { width: 100%; min-height: 220px; resize: vertical; font-family: inherit; line-height: 1.6; }
@media (max-width: 720px) {
  .mm-body { grid-template-columns: 1fr; }
  .mm-list { max-height: 150px; }
  .mm-chart { height: 58vh; min-height: 420px; }
  .mm-modal { width: 100%; }
}
</style>