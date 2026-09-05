<script setup>
// 知识图谱：多风格可视化（力导向/圆形/同心圆/树状）+ AI 生成 + Agent 智能构建（A 镜头）
// 生成的关联可保存到本地库并随数据包同步。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { t } from '../i18n/index.js';
import FullscreenButton from '../components/FullscreenButton.vue';
import { useFullscreen } from '../composables/useFullscreen.js';
import { toast } from '../utils/toast.js';
import { logError } from '../utils/errorLog.js';
import { db } from '../db.js';
import { chatAI, hasAIKey, getAIConfig } from '../ai.js';
import { listGraphEdges, createGraphEdge, deleteGraphEdge } from '../repo.js';
import { agentSystem } from '../agent/index.js';
import { recommendGraphEdges } from '../intelligence.js';
import { resolveGraph } from '../algorithms/graph-resolve.js';
import { pruneDeadEdges } from '../algorithms/graphAuto.js';
import { T } from '../utils/telemetry.js';
import EmptyState from '../components/EmptyState.vue';
import ExportButton from '../components/ExportButton.vue';
import {
  exportGraphToJSON, exportGraphToGraphML, exportGraphToMarkdown,
} from '../utils/exporters.js';

const generatedNodes = ref([]);
const generatedEdges = ref([]);
const savedNodes = ref([]);
const savedEdges = ref([]);
const savedStats = ref({ total: 0, resolved: 0, missing: 0, bySubject: new Map() });
const loading = ref(false);
const activeId = ref('');
const activeLabel = ref('');
const activeSubject = ref('');
const mode = ref('generated');
const router = useRouter();

const graphExportFormats = computed(() => [
  { key: 'md', label: 'Markdown', hint: t('views.knowledgeGraph.exportMdHint'), mime: 'text/markdown', ext: 'md', build: exportGraphToMarkdown },
  { key: 'json', label: 'JSON', hint: t('views.knowledgeGraph.exportJsonHint'), mime: 'application/json', ext: 'json', build: exportGraphToJSON },
  { key: 'graphml', label: 'GraphML', hint: t('views.knowledgeGraph.exportGraphmlHint'), mime: 'application/xml', ext: 'graphml', build: exportGraphToGraphML },
]);
// 节点跳转：根据 label+subject 精确匹配卡片；1:1 命中直接带 id 打开弹窗，N:1 命中则用关键字搜索跳转
// Phase 6.6：资料节点（type=doc-card 边的 from，label 带 📄 前缀）跳转到资料库，而非卡片
const docNodeIds = computed(() => {
  const m = new Map();
  for (const e of savedEdges.value) {
    if (e.type === 'doc-card') m.set(e.from, e.docId || '');
  }
  return m;
});

async function jumpToNodeCard(label, subject) {
  if (!label) return;
  if (docNodeIds.value.has(label)) {
    toast(t('views.knowledgeGraph.jumpedToMaterials', undefined, { label: String(label).replace(/^📄\s*/, '') }), 'info');
    router.push('/materials');
    return;
  }
  const q = String(label).trim();
  const sub = String(subject || '').trim();
  try {
    const all = await db.cards.toArray();
    let pool = all;
    if (sub) pool = pool.filter(c => (c.subject || '') === sub);
    const exact = pool.filter(c => c.front === q);
    const loose = exact.length ? exact : pool.filter(c => String(c.front || '').includes(q) || String(c.back || '').includes(q));
    if (loose.length === 1) {
      router.push(`/cards?id=${encodeURIComponent(loose[0].id)}`);
    } else if (loose.length > 1) {
      const params = new URLSearchParams({ q });
      if (sub) params.set('subject', sub);
      router.push(`/cards?${params.toString()}`);
    } else {
      // 卡片库里没直接命中：带 q 搜索跳，让用户新建/关联
      const params = new URLSearchParams({ q });
      if (sub) params.set('subject', sub);
      toast(t('views.knowledgeGraph.notFoundCard', undefined, { q }), 'warn');
      router.push(`/cards?${params.toString()}`);
    }
  } catch (e) { logError(e, { component: 'KnowledgeGraph.vue:jumpToNodeCard', route: '/graph', info: `label=${q.slice(0,60)} sub=${sub}` }); throw e; }
}
// P2·#13 图谱关系自动推荐：基于卡片相似度的本地算法（零 LLM 开销）
const recommended = ref([]);
const recommendLoading = ref(false);

async function autoRecommend() {
  if (recommendLoading.value) return;
  recommendLoading.value = true;
  try {
    const list = await recommendGraphEdges({ topN: 30 });
    recommended.value = list;
    if (!list.length) toast(t('views.knowledgeGraph.noRecommend'), 'info');
    else toast(t('views.knowledgeGraph.recommendAnalyzed', undefined, { n: list.length }), 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { recommendLoading.value = false; }
}

async function saveRecommended(idx) {
  const r = recommended.value[idx];
  if (!r) return;
  // R10：recommendGraphEdges 已返回 fromId/toId（卡片 id），直传避免文本匹配
  const created = await createGraphEdge({ from: r.from, to: r.to, fromCardId: r.fromId || '', toCardId: r.toId || '', label: r.label, subject: r.subject });
  if (created) {
    toast(t('views.knowledgeGraph.savedEdge', undefined, { from: r.from, rel: r.label, to: r.to }), 'success');
    recommended.value.splice(idx, 1);
    await loadSaved();
  } else {
    toast(t('views.knowledgeGraph.edgeExists'), 'info');
    recommended.value.splice(idx, 1);
  }
}

async function saveAllRecommended() {
  let n = 0, skip = 0;
  for (const r of [...recommended.value]) {
    const created = await createGraphEdge({ from: r.from, to: r.to, fromCardId: r.fromId || '', toCardId: r.toId || '', label: r.label, subject: r.subject });
    if (created) n++; else skip++;
  }
  recommended.value = [];
  await loadSaved();
  toast(t('views.knowledgeGraph.batchSaved', undefined, { n }) + (skip ? t('views.knowledgeGraph.batchSkipped', undefined, { skip }) : ''), 'success');
}

function fmtScore(s) { return `${(s * 100 | 0)}%`; }

// ---- 多风格 ----
const layout = ref(localStorage.getItem('sxy_kg_layout') || 'force');
const LAYOUTS = [
  { id: 'force', key: 'layoutForce', icon: '⊛' },
  { id: 'circular', key: 'layoutCircular', icon: '◯' },
  { id: 'concentric', key: 'layoutConcentric', icon: '◎' },
  { id: 'tree', key: 'layoutTree', icon: '⋗' },
];
function setLayout(id) { layout.value = id; localStorage.setItem('sxy_kg_layout', id); if (!chart) ensureChart(); render(); }

const chartEl = ref(null);
let chart = null;
// 全屏/非全屏：图表容器全屏后必须 resize（容器尺寸变了）
const { isFullscreen: kgFs, toggle: toggleKgFs } = useFullscreen(chartEl, () => { chart?.resize(); });

const nodes = computed(() => (mode.value === 'saved' ? savedNodes.value : generatedNodes.value));
const edges = computed(() => (mode.value === 'saved' ? savedEdges.value : generatedEdges.value));

// 主题色
function themeColor(key) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(key).trim();
  return v || (key.includes('accent') ? '#4a9eff' : key.includes('ink') ? '#333' : '#999');
}

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ').replace(/[*_#>`~|-]/g, '').replace(/\s+/g, ' ').trim();
}

// 边标签显示文本（round11b N-1）：
//   · auto 派生边带 labelKind → label 存的是语义 code，这里按当前语言翻译；
//   · AI / 用户手动建的边没有 labelKind → label 是内容本身（用户可以手打「前置」），必须原样显示；
//   · 旧落库的边没有 labelKind 且 label 是中文 → 兜底显示原 label，行为与修复前一致，
//     等下次图谱重建时被 bulkDelete 替换成带 labelKind 的新边。
const edgeLabelText = (e) => (e?.labelKind ? t('graph.labelKind.' + e.labelKind, e.label) : (e?.label || ''));

// 构建图数据：按 subject 分组（用于同心圆分层着色）
function buildGraphData(nds, eds) {
  const subjects = [...new Set(nds.map(n => n.subject).filter(Boolean))];
  const categories = [{ name: t('views.knowledgeGraph.catUncategorized') }, ...subjects.map(s => ({ name: s }))];
  const catOf = (n) => n.subject ? categories.findIndex(c => c.name === n.subject) : 0;
  const nodeList = nds.map(n => ({
    id: n.id, name: n.label, category: catOf(n),
    symbolSize: 22, itemStyle: { color: palette[catOf(n) % palette.length] },
    label: { show: true, position: 'right', fontSize: 12 },
  }));
  const linkList = eds.map(e => ({
    source: e.from, target: e.to,
    label: e.label ? { show: true, formatter: edgeLabelText(e), fontSize: 10 } : { show: false },
  }));
  return { nodes: nodeList, links: linkList, categories };
}
const palette = ['#4a9eff', '#f5a623', '#7ed321', '#bd10e0', '#f8e71c', '#50e3c2', '#b8e986', '#d0021b'];

function buildOption(nds, eds, style) {
  const data = buildGraphData(nds, eds);
  const base = {
    tooltip: { trigger: 'item', formatter: p => p.dataType === 'node' ? p.data.name : `${p.data.source} → ${p.data.target}` },
    legend: [{ data: data.categories.map(c => c.name), bottom: 6, textStyle: { color: themeColor('--ink-2'), fontSize: 11 } }],
  };
  if (style === 'tree') {
    // 树状：把有向边转成树（防环），用 ECharts tree 系列；每个节点携带 subject 便于后续跳转
    // round15 P2：edges.from/to 现在是节点键（cardId 优先，不再是 label 文本），
    // 树节点 name 必须回查 label 显示，不能直接用键。
    const subjOf = new Map(nds.map(n => [n.id, n.subject || '']));
    const nameOf = new Map(nds.map(n => [n.id, n.label]));
    const childrenOf = new Map();
    for (const e of eds) { if (!childrenOf.has(e.from)) childrenOf.set(e.from, []); childrenOf.get(e.from).push(e.to); }
    const all = new Set([...eds.map(e => e.from), ...eds.map(e => e.to)]);
    const inDeg = new Map(); for (const e of eds) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    const roots = [...all].filter(n => !inDeg.has(n));
    const forest = roots.length ? roots : [...all];
    const build = (key, visited) => {
      if (visited.has(key)) return null;
      visited.add(key);
      const kids = (childrenOf.get(key) || []).map(k => build(k, new Set(visited))).filter(Boolean);
      return { name: nameOf.get(key) || key, value: { subject: subjOf.get(key) || '' }, children: kids };
    };
    const rootsBuilt = forest.map(r => build(r, new Set())).filter(Boolean);
    // 多个不连通的树：用一个虚拟根包一层，避免只剩一个“N0”
    let root = rootsBuilt[0] || { name: t('views.knowledgeGraph.treeEmptyNode'), value: { subject: '' } };
    if (rootsBuilt.length > 1) {
      root = { name: t('views.knowledgeGraph.treeRootName'), value: { subject: '' }, children: rootsBuilt };
    }
    return {
      tooltip: { trigger: 'item', formatter: p => {
        const subj = p.data?.value?.subject;
        const tip = `${p.data.name}${subj ? t('views.knowledgeGraph.treeSubject', undefined, { subj }) : ''}${t('views.knowledgeGraph.treeTip')}`;
        return tip.replace(/\n/g, '<br/>');
      } },
      series: [{
        type: 'tree', data: [root],
        left: '2%', right: '22%', top: '4%', bottom: '8%',
        symbol: 'circle', symbolSize: 10, orient: 'LR', layout: 'orthogonal',
        roam: true, zoom: 1, nodePadding: 22, layerPadding: 180,
        label: {
          position: 'left', verticalAlign: 'middle', align: 'right',
          fontSize: 13, color: themeColor('--ink'),
          width: 160, overflow: 'truncate', ellipsis: '…',
        },
        leaves: { label: { position: 'right', verticalAlign: 'middle', align: 'left', width: 200, overflow: 'truncate' } },
        emphasis: { focus: 'descendant' },
        expandAndCollapse: true, initialTreeDepth: 2,
        animationDuration: 350, animationDurationUpdate: 600,
        lineStyle: { color: themeColor('--line-strong'), width: 1.5, curveness: 0.4 },
        itemStyle: { color: themeColor('--accent') },
      }],
    };
  }
  const seriesCfg = {
    type: 'graph', roam: true, data: data.nodes, links: data.links,
    categories: data.categories, edgeLabel: { color: themeColor('--ink-2') },
    lineStyle: { color: themeColor('--line-strong'), width: 1.4, curveness: 0.15, opacity: 0.7 },
    emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
  };
  if (style === 'force') Object.assign(seriesCfg, { layout: 'force', force: { repulsion: 220, edgeLength: 100, gravity: 0.06, layoutAnimation: true } });
  else if (style === 'circular') Object.assign(seriesCfg, { layout: 'circular', circular: { rotateLabel: true } });
  else if (style === 'concentric') {
    // ECharts graph 不支持原生 concentric，这里按节点连通度（度）分层手动放置 x/y
    const nMap = new Map(data.nodes.map(n => [n.id, n]));
    const deg = new Map();
    for (const n of data.nodes) deg.set(n.id, 0);
    for (const l of data.links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
    const maxDeg = Math.max(1, ...deg.values());
    // 根据度把节点分 4 层，0 层在中心
    const layers = [[], [], [], []];
    for (const n of data.nodes) {
      const d = deg.get(n.id) || 0;
      const lv = d === 0 ? 3 : Math.min(3, Math.floor((1 - d / maxDeg) * 4));
      layers[lv].push(n);
    }
    const W = 800, H = 560, cx = W / 2, cy = H / 2;
    const radii = [0, 120, 220, 320];
    layers.forEach((arr, li) => {
      if (!arr.length) return;
      if (li === 0) { arr[0].x = cx; arr[0].y = cy; return; }
      const step = (Math.PI * 2) / arr.length;
      arr.forEach((n, i) => {
        const ang = i * step;
        n.x = cx + radii[li] * Math.cos(ang);
        n.y = cy + radii[li] * Math.sin(ang);
        n.fixed = true;
      });
    });
    Object.assign(seriesCfg, { layout: 'none' });
  }
  return { ...base, series: [seriesCfg] };
}

function render() {
  if (!nodes.value.length) return;
  // 图表必须等 DOM 上的容器 div 真正出现后才能 init。
  // 过去的写法只在 onMounted 里判定「当时已有节点才 init」——
  // 首次进页面时库里还没有关联，容器 div 因 v-if 未渲染，initChart 直接被跳过；
  // 之后用户新建/保存了关联，loadSaved 里又是 `if (chart && ...)`，chart 仍为 null
  // → **图谱永远画不出来**，只剩下面一列文字边表。这里统一按需初始化。
  if (!chart) ensureChart();
  if (!chart) return;
  try {
    const opt = buildOption(nodes.value, edges.value, layout.value);
    chart.setOption(opt, true);
    // 全屏/容器刚出现的当帧布局可能未定型 → 0x0 画布。幂等 resize 兜底。
    chart.resize();
  } catch (e) {
    logError(e, { component: 'KnowledgeGraph.vue', route: '/graph', info: `render layout=${layout.value}` });
    toast(t('views.knowledgeGraph.renderFail') + e.message, 'error');
  }
}

/** 按需初始化 ECharts 实例（容器 div 由 v-if="nodes.length" 控制，出现时机晚于 mounted） */
function ensureChart() {
  if (chart) return chart;
  const el = chartEl.value;
  if (!el) return null;
  try {
    initChart(el);
  } catch (e) {
    logError(e, { component: 'KnowledgeGraph.vue', route: '/graph', info: 'ensureChart' });
  }
  return chart;
}

function initChart(el) {
  try {
    chart = echarts.init(el);
    chart.off('click');
    chart.on('click', p => {
      // graph 风格：单击直接跳转对应卡片 + 选中高亮
      if (p.seriesType === 'graph' && p.dataType === 'node') {
        const d = p.data || {};
        const label = d.name || d.label || ''; const subj = d.subject || '';
        activeId.value = String(d.id || '');
        activeLabel.value = label; activeSubject.value = subj;
        jumpToNodeCard(label, subj);
        return;
      }
      // tree 风格：ECharts 内置单击会展开/折叠，这里只把节点信息写入选中态，
      // 用户用面板里的「跳转卡片」按钮显式跳转，避免打断树形交互
      if (p.seriesType === 'tree' && p.data?.name) {
        const d = p.data;
        const label = String(d.name || '');
        const subj = String(d.value?.subject || '');
        activeLabel.value = label; activeSubject.value = subj;
        activeId.value = '';
      }
    });
    window.addEventListener('resize', onResize);
  } catch (e) {
    logError(e, { component: 'KnowledgeGraph.vue', route: '/graph', info: 'initChart' });
    toast(t('views.knowledgeGraph.initFail') + e.message, 'error');
  }
}
function onResize() { chart?.resize(); }
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart?.dispose(); });

async function generate() {
  if (!hasAIKey()) { toast(t('views.knowledgeGraph.noAiKey'), 'error'); return; }
  loading.value = true;
  try {
    const cards = await db.cards.toArray();
    if (!cards.length) { toast(t('views.knowledgeGraph.noCards'), 'error'); return; }
    const sample = cards.slice(0, 80).map(c => `[${c.subject || '未分类'}] ${plain(c.front)} / ${plain(c.back)}（标签:${(c.tags || []).join(',')}）`).join('\n');
    const r = await chatAI([
      { role: 'system', content: '你是知识图谱生成器。从下面卡片提取 8~20 个核心知识点作为节点，并找出知识点之间的关联作为边（关系如：属于/依赖/前置/对比）。输出严格 JSON：{"nodes":[{"id":"1","label":"知识点","subject":"科目"}],"edges":[{"from":"1","to":"2","label":"关系"}]}。只输出 JSON。' },
      { role: 'user', content: sample },
    ]);
    const m = String(r).match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : r);
    generatedNodes.value = (obj.nodes || []).map(n => ({ id: String(n.id), label: String(n.label || n.id), subject: n.subject || '' }));
    generatedEdges.value = (obj.edges || []).map(e => ({ from: String(e.from), to: String(e.to), label: e.label || '' }));
    activeId.value = ''; mode.value = 'generated';
    nextTick(() => { if (!chart) ensureChart(); render(); });
    if (!generatedNodes.value.length) toast(t('views.knowledgeGraph.noNodes'), 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

// Agent 智能构建：走 graph-builder agent 的 ReAct 工具调用循环
// agent 会用 search_cards / list_subjects_and_tags 智能检索，用 link_cards 直接建立持久化关联（去重）
async function generateByAgent() {
  if (!hasAIKey()) { toast(t('views.knowledgeGraph.noAiKey'), 'error'); return; }
  loading.value = true;
  try {
    const { reply } = await agentSystem.runTask({
      userInput: '分析我的卡片库，提取核心知识点（8~20 个），建立它们之间的关联（依赖/前置/对比/属于），用 link_cards 持久化保存。完成后用 <final> 简述你构建了哪些主题与关联。',
      cfg: getAIConfig(),
      agentId: 'graph-builder',
    });
    toast(t('views.knowledgeGraph.agentDone'), 'success');
    await loadSaved();
    mode.value = 'saved';
    nextTick(() => { if (!chart) ensureChart(); render(); });
  } catch (e) { toast(t('views.knowledgeGraph.agentFail') + e.message, 'error'); }
  finally { loading.value = false; }
}

/**
 * 载入已保存图谱。
 *
 * ⚠️ 修复要点：过去这里把 e.from/e.to 直接当成「显示文本」，
 * 于是 graphAuto 写的卡片 UUID 边全变成裸 ID 节点、subject 全空（挤在「未分类」），
 * 与 AI/推荐建的 label 型节点是两套 ID 空间，永远连不通——看着有几千条边，其实是散点。
 * 现在统一走 resolveGraph()：优先用 fromCardId/toCardId 反查卡片正文，
 * 查不到才用字面量，并顺带把 subject 从卡片上补回来。
 */
async function loadSaved() {
  const [list, cards] = await Promise.all([listGraphEdges(), db.cards.toArray()]);
  const { nodes, edges, stats } = resolveGraph(list, cards);
  savedNodes.value = nodes;
  savedEdges.value = edges;
  savedStats.value = stats;
  if (list.length) mode.value = 'saved';
  nextTick(() => { if (savedNodes.value.length) render(); });
}

// 失效关联（两端卡片已不存在 / 历史脏数据）：可一键清理
const deadCount = computed(() => savedStats.value?.missing || 0);
async function pruneDead() {
  try {
    const r = await pruneDeadEdges();
    toast(r.removed ? t('views.knowledgeGraph.prunedEdges', undefined, { n: r.removed }) : t('views.knowledgeGraph.prunedNone'), r.removed ? 'success' : 'info');
    await loadSaved();
  } catch (e) { toast(t('views.knowledgeGraph.pruneFail') + (e?.message || e), 'error'); }
}

async function saveGenerated() {
  let n = 0, skipped = 0;
  // R10：AI 生成的节点只有 label，保存时把 label 解析为真实卡片 id，边存 cardId 直连
  const all = await db.cards.toArray();
  const labelToId = new Map();
  for (const c of all) {
    const f = String(c.front || '').replace(/[*_#>`~|-]/g, '').trim().toLowerCase();
    if (f && !labelToId.has(f)) labelToId.set(f, c.id); // 首次精确命中即用，避免覆盖
  }
  const resolveId = (label) => labelToId.get(String(label || '').replace(/[*_#>`~|-]/g, '').trim().toLowerCase()) || '';
  for (const e of generatedEdges.value) {
    const fn = generatedNodes.value.find(x => x.id === e.from);
    const tn = generatedNodes.value.find(x => x.id === e.to);
    if (!fn || !tn) continue;
    const created = await createGraphEdge({
      from: fn.label, to: tn.label,
      fromCardId: resolveId(fn.label), toCardId: resolveId(tn.label),
      label: e.label, subject: fn.subject || tn.subject || '',
    });
    if (created) n++; else skipped++;
  }
  toast(skipped ? t('views.knowledgeGraph.savedSkip', undefined, { n, skip }) : t('views.knowledgeGraph.savedAll', undefined, { n }), 'success');
  await loadSaved();
  try { T.graphSave(savedEdges.value.length); } catch {}
}

async function removeEdge(id) {
  await deleteGraphEdge(id);
  await loadSaved();
}

const clusters = computed(() => {
  const m = new Map();
  for (const e of savedEdges.value) {
    const k = e.subject || t('views.knowledgeGraph.catUncategorized');
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return [...m.entries()].map(([subject, edges]) => ({ subject, edges }));
});

const relatedIds = () => {
  if (!activeId.value) return [];
  const s = new Set([activeId.value]);
  for (const e of edges.value) {
    if (e.from === activeId.value) s.add(e.to);
    if (e.to === activeId.value) s.add(e.from);
  }
  return s;
};
function nodeById(id) { return nodes.value.find(n => n.id === id); }

onMounted(async () => { await loadSaved(); nextTick(() => { if (savedNodes.value.length) render(); }); });
// 切换「AI 生成 / 已保存」后容器可能刚出现，需补一次初始化
watch(mode, () => nextTick(() => { if (nodes.value.length) render(); }));
</script>

<template>
  <div style="max-width:980px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.knowledgeGraph.title') }}</h2>
      <span style="flex:1"></span>
      <button v-if="savedEdges.length" class="chip" @click="mode = mode === 'saved' ? 'generated' : 'saved'">
        {{ mode === 'saved' ? t('views.knowledgeGraph.switchToGenerated') : t('views.knowledgeGraph.viewSaved') }}
      </button>
      <button class="btn" :disabled="loading" @click="autoRecommend" :title="t('views.knowledgeGraph.recommendTitle')">{{ t('views.knowledgeGraph.recommendBtn') }}</button>
      <button class="btn" :disabled="loading" @click="generateByAgent" :title="t('views.knowledgeGraph.agentTitle')">{{ t('views.knowledgeGraph.agentBtn') }}</button>
      <button class="btn primary" :disabled="loading" @click="generate">{{ loading ? t('views.knowledgeGraph.generating') : t('views.knowledgeGraph.aiGenerate') }}</button>
    </div>
    <p class="hint" style="margin:4px 0 10px">{{ t('views.knowledgeGraph.introHint') }}</p>

    <div v-if="recommendLoading" class="hint" style="padding:12px;text-align:center">{{ t('views.knowledgeGraph.analyzing') }}</div>
    <div v-if="recommended.length" class="rec-box">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <strong>{{ t('views.knowledgeGraph.recTitle', undefined, { n: recommended.length }) }}</strong>
        <span class="hint">{{ t('views.knowledgeGraph.recHint') }}</span>
        <span style="flex:1"></span>
        <button class="btn small primary" @click="saveAllRecommended">{{ t('views.knowledgeGraph.saveAll') }}</button>
      </div>
      <div v-for="(r, i) in recommended" :key="`${r.from}-${r.to}-${r.label}`" class="rec-row">
        <div class="rec-main">
          <span class="rec-node">{{ r.from }}</span>
          <span class="rec-rel" :title="r.reason">{{ r.label }}</span>
          <span class="rec-node">{{ r.to }}</span>
          <span class="rec-score" :title="r.reason">{{ t('views.knowledgeGraph.similarity') }} {{ fmtScore(r.score) }}</span>
        </div>
        <div class="rec-reason">{{ r.reason }}</div>
        <div style="margin-top:4px">
          <button class="btn small primary" @click="saveRecommended(i)">{{ t('views.knowledgeGraph.save') }}</button>
          <button class="btn small" @click="recommended.splice(i, 1)">{{ t('views.knowledgeGraph.ignore') }}</button>
        </div>
      </div>
    </div>

    <div v-if="nodes.length" class="kg-layout-bar">
      <span class="hint" style="margin-right:4px">{{ t('views.knowledgeGraph.styleLabel') }}</span>
      <button v-for="l in LAYOUTS" :key="l.id" class="kg-style-chip" :class="{active: layout === l.id}" @click="setLayout(l.id)" :title="t('views.knowledgeGraph.' + l.key)">
        <span style="font-size:14px">{{ l.icon }}</span><span>{{ t('views.knowledgeGraph.' + l.key) }}</span>
      </button>
      <span style="flex:1"></span>
      <FullscreenButton :active="kgFs" @toggle="toggleKgFs" />
    </div>

    <EmptyState v-if="!nodes.length && !loading" icon="🕸️" :title="t('views.knowledgeGraph.emptyTitle')" :message="t('views.knowledgeGraph.emptyMsg')" />

    <!-- chartEl 同时承担内联渲染与全屏目标：requestFullscreen 让它直接占满屏幕；iframe/CSP 拦下时退化 .fake-fullscreen（CSS 铺满）。ECharts onChange resize 兜底。 -->
    <div v-if="nodes.length" class="graph-box">
      <div ref="chartEl" style="width:100%;height:58vh;min-height:400px"></div>
    </div>

    <div v-if="mode === 'generated' && generatedEdges.length" style="text-align:center;margin-top:10px">
      <button class="btn primary small" @click="saveGenerated">{{ t('views.knowledgeGraph.saveGenerated') }}</button>
    </div>

    <div v-if="deadCount" class="dead-box">
      <span>
        {{ t('views.knowledgeGraph.deadPrefix') }}<b>{{ deadCount }}</b>{{ t('views.knowledgeGraph.deadSuffix') }}
      </span>
      <button class="btn small" @click="pruneDead">{{ t('views.knowledgeGraph.pruneBtn') }}</button>
    </div>

    <div v-if="mode === 'saved' && savedEdges.length" class="saved-box">
      <div class="saved-title-row">
        <span class="saved-title">{{ t('views.knowledgeGraph.savedTitle', undefined, { edges: savedEdges.length, clusters: clusters.length }) }}</span>
        <ExportButton
          :data="savedEdges"
          :count="savedEdges.length"
          filename-prefix="knowledge-graph"
          :label="t('views.knowledgeGraph.exportLabel')"
          :formats="graphExportFormats"
        />
      </div>
      <div v-for="c in clusters" :key="c.subject" class="cluster">
        <div class="cluster-title">{{ c.subject }}<span class="cluster-count">{{ t('views.knowledgeGraph.clusterCount', undefined, { n: c.edges.length }) }}</span></div>
        <div v-for="e in c.edges" :key="e.id" class="saved-edge">
          <span>{{ nodeById(e.from)?.label || e.from }}</span>
          <span class="saved-rel">{{ edgeLabelText(e) }}</span>
          <span>{{ nodeById(e.to)?.label || e.to }}</span>
          <a style="color:var(--red);cursor:pointer;margin-left:8px" @click="removeEdge(e.id)" :aria-label="t('views.knowledgeGraph.deleteEdgeAria')">{{ t('views.knowledgeGraph.deleteEdge') }}</a>
        </div>
      </div>
    </div>

    <div v-if="activeLabel" class="selected-node-bar" style="margin-top:10px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap">
      <span class="hint">
        <template v-if="activeId && nodeById(activeId)">{{ t('views.knowledgeGraph.selectedNodePrefix') }}<b>{{ nodeById(activeId).label }}</b>{{ t('views.knowledgeGraph.selectedNodeSuffix') }}</template>
        <template v-else>{{ t('views.knowledgeGraph.currentNodePrefix') }}<b>{{ activeLabel }}</b>{{ t('views.knowledgeGraph.currentNodeSuffix') }}</template>
        <span v-if="activeSubject" style="margin-right:6px">🎓 {{ activeSubject }}</span>
        {{ t('views.knowledgeGraph.jumpHint') }}
      </span>
      <button class="btn primary small" @click="jumpToNodeCard(activeLabel, activeSubject)">{{ t('views.knowledgeGraph.jumpCard') }}</button>
      <button class="btn small" @click="activeLabel='';activeSubject='';activeId=''">{{ t('views.knowledgeGraph.clearSelection') }}</button>
    </div>
    <div v-else-if="activeId && nodeById(activeId)" class="hint" style="text-align:center;margin-top:10px">
      {{ t('views.knowledgeGraph.selectedPrefix') }}{{ nodeById(activeId).label }}{{ t('views.knowledgeGraph.selectedSuffix') }}
    </div>
  </div>
</template>

<style scoped>
.kg-layout-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.kg-style-chip { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; font-size: 12px; cursor: pointer; transition: .12s; }
.kg-style-chip:hover { border-color: var(--accent); }
.kg-style-chip.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.graph-box { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; }
.chip { font-size: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.saved-box { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; margin-top: 14px; }
.saved-title-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.saved-title { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.saved-edge { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.saved-edge:last-child { border-bottom: none; }
.saved-rel { color: var(--accent); font-size: 12px; }
.dead-box { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2);
  border: 1px solid var(--line); border-left: 3px solid var(--warn, #f5a623); border-radius: 8px;
  background: var(--panel); padding: 10px 12px; margin-top: 12px; }
.cluster { margin-bottom: 10px; padding: 8px 12px; background: var(--code-bg); border-radius: 8px; }
.cluster-title { font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
.cluster-count { font-size: 11px; color: var(--ink-2); margin-left: 6px; font-weight: 400; }
@media (max-width: 720px) { .graph-box > div { height: 46vh !important; } }
.rec-box { border: 1px solid var(--accent); border-radius: var(--radius); background: var(--panel); padding: 12px; margin-bottom: 12px; }
.rec-row { padding: 8px 10px; border-bottom: 1px dashed var(--line); }
.rec-row:last-child { border-bottom: none; }
.rec-main { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.rec-node { background: var(--code-bg); padding: 2px 8px; border-radius: 4px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-rel { color: var(--accent); font-size: 12px; font-weight: 600; }
.rec-score { font-size: 11px; color: var(--ink-2); margin-left: auto; }
.rec-reason { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
</style>