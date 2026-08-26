<script setup>
// 知识图谱：多风格可视化（力导向/圆形/同心圆/树状）+ AI 生成 + Agent 智能构建（A 镜头）
// 生成的关联可保存到本地库并随数据包同步。
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { toast } from '../utils/toast.js';
import { logError } from '../utils/errorLog.js';
import { db } from '../db.js';
import { chatAI, hasAIKey, getAIConfig } from '../ai.js';
import { listGraphEdges, createGraphEdge, deleteGraphEdge } from '../repo.js';
import { agentSystem } from '../agent/index.js';
import { recommendGraphEdges } from '../intelligence.js';

const generatedNodes = ref([]);
const generatedEdges = ref([]);
const savedNodes = ref([]);
const savedEdges = ref([]);
const loading = ref(false);
const activeId = ref('');
const activeLabel = ref('');
const activeSubject = ref('');
const mode = ref('generated');
const router = useRouter();
// 节点跳转：根据 label+subject 精确匹配卡片；1:1 命中直接带 id 打开弹窗，N:1 命中则用关键字搜索跳转
async function jumpToNodeCard(label, subject) {
  if (!label) return;
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
      toast(`没找到名为「${q}」的卡片，已跳转搜索结果`, 'warn');
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
    if (!list.length) toast('暂无可推荐关联：卡片数量不足或已全部建立关联', 'info');
    else toast(`分析出 ${list.length} 条候选关联（基于卡片相似度，可一键保存）`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { recommendLoading.value = false; }
}

async function saveRecommended(idx) {
  const r = recommended.value[idx];
  if (!r) return;
  const created = await createGraphEdge({ from: r.from, to: r.to, label: r.label, subject: r.subject });
  if (created) {
    toast(`已保存：${r.from} ${r.label} ${r.to}`, 'success');
    recommended.value.splice(idx, 1);
    await loadSaved();
  } else {
    toast('该关联已存在，已从列表移除', 'info');
    recommended.value.splice(idx, 1);
  }
}

async function saveAllRecommended() {
  let n = 0, skip = 0;
  for (const r of [...recommended.value]) {
    const created = await createGraphEdge({ from: r.from, to: r.to, label: r.label, subject: r.subject });
    if (created) n++; else skip++;
  }
  recommended.value = [];
  await loadSaved();
  toast(`批量保存 ${n} 条${skip ? `，跳过 ${skip} 条重复` : ''}`, 'success');
}

function fmtScore(s) { return `${(s * 100 | 0)}%`; }

// ---- 多风格 ----
const layout = ref(localStorage.getItem('sxy_kg_layout') || 'force');
const LAYOUTS = [
  { id: 'force', name: '力导向', icon: '⊛' },
  { id: 'circular', name: '圆形', icon: '◯' },
  { id: 'concentric', name: '同心圆', icon: '◎' },
  { id: 'tree', name: '树状', icon: '⋗' },
];
function setLayout(id) { layout.value = id; localStorage.setItem('sxy_kg_layout', id); render(); }

const chartEl = ref(null);
let chart = null;

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

// 构建图数据：按 subject 分组（用于同心圆分层着色）
function buildGraphData(nds, eds) {
  const subjects = [...new Set(nds.map(n => n.subject).filter(Boolean))];
  const categories = [{ name: '未分类' }, ...subjects.map(s => ({ name: s }))];
  const catOf = (n) => n.subject ? categories.findIndex(c => c.name === n.subject) : 0;
  const nodeList = nds.map(n => ({
    id: n.id, name: n.label, category: catOf(n),
    symbolSize: 22, itemStyle: { color: palette[catOf(n) % palette.length] },
    label: { show: true, position: 'right', fontSize: 12 },
  }));
  const linkList = eds.map(e => ({ source: e.from, target: e.to, label: e.label ? { show: true, formatter: e.label, fontSize: 10 } : { show: false } }));
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
    const subjOf = new Map(nds.map(n => [n.label, n.subject || '']));
    const childrenOf = new Map();
    for (const e of eds) { if (!childrenOf.has(e.from)) childrenOf.set(e.from, []); childrenOf.get(e.from).push(e.to); }
    const all = new Set([...eds.map(e => e.from), ...eds.map(e => e.to)]);
    const inDeg = new Map(); for (const e of eds) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    const roots = [...all].filter(n => !inDeg.has(n));
    const rootLabel = (roots.length ? roots : [...all])[0];
    const build = (label, visited) => {
      if (visited.has(label)) return null;
      visited.add(label);
      const kids = (childrenOf.get(label) || []).map(k => build(k, new Set(visited))).filter(Boolean);
      return { name: label, value: { subject: subjOf.get(label) || '' }, children: kids };
    };
    const root = build(rootLabel, new Set()) || { name: rootLabel, value: { subject: '' } };
    return {
      tooltip: { trigger: 'item', formatter: p => {
        const subj = p.data?.value?.subject;
        const tip = `📚 ${p.data.name}${subj ? `\n🎓 科目：${subj}` : ''}\n💡 单击展开/折叠子节点；点下方「跳转卡片」按钮查看关联卡片。`;
        return tip.replace(/\n/g, '<br/>');
      } },
      series: [{
        type: 'tree', data: [root], left: '6%', right: '18%', top: '6%', bottom: '10%',
        symbol: 'circle', symbolSize: 14, orient: 'LR', layout: 'orthogonal',
        label: { position: 'left', verticalAlign: 'middle', align: 'right', fontSize: 12, color: themeColor('--ink') },
        leaves: { label: { position: 'right', verticalAlign: 'middle', align: 'left' } },
        emphasis: { focus: 'descendant' }, expandAndCollapse: true, initialTreeDepth: 2, animationDuration: 350, animationDurationUpdate: 600,
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
  if (!chart || !nodes.value.length) return;
  try {
    chart.setOption(buildOption(nodes.value, edges.value, layout.value), true);
  } catch (e) {
    logError(e, { component: 'KnowledgeGraph.vue', route: '/graph', info: `render layout=${layout.value}` });
    toast('图谱渲染失败：' + e.message, 'error');
  }
}

function initChart() {
  try {
    chart = echarts.init(chartEl.value);
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
    toast('初始化图谱失败：' + e.message, 'error');
  }
}
function onResize() { chart?.resize(); }
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart?.dispose(); });

async function generate() {
  if (!hasAIKey()) { toast('请先配置 AI 密钥', 'error'); return; }
  loading.value = true;
  try {
    const cards = await db.cards.toArray();
    if (!cards.length) { toast('还没有卡片，先去建几张吧', 'error'); return; }
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
    nextTick(() => { if (!chart) initChart(); render(); });
    if (!generatedNodes.value.length) toast('没解析出知识点', 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

// Agent 智能构建：走 graph-builder agent 的 ReAct 工具调用循环
// agent 会用 search_cards / list_subjects_and_tags 智能检索，用 link_cards 直接建立持久化关联（去重）
async function generateByAgent() {
  if (!hasAIKey()) { toast('请先配置 AI 密钥', 'error'); return; }
  loading.value = true;
  try {
    const { reply } = await agentSystem.runTask({
      userInput: '分析我的卡片库，提取核心知识点（8~20 个），建立它们之间的关联（依赖/前置/对比/属于），用 link_cards 持久化保存。完成后用 <final> 简述你构建了哪些主题与关联。',
      cfg: getAIConfig(),
      agentId: 'graph-builder',
    });
    toast('Agent 智能构建完成', 'success');
    await loadSaved();
    mode.value = 'saved';
    nextTick(() => { if (!chart) initChart(); render(); });
  } catch (e) { toast('Agent 构建失败：' + e.message, 'error'); }
  finally { loading.value = false; }
}

async function loadSaved() {
  const list = await listGraphEdges();
  const labelMap = new Map();
  const ensure = (label) => { if (!labelMap.has(label)) labelMap.set(label, `n${labelMap.size}`); return labelMap.get(label); };
  savedNodes.value = [...new Set(list.flatMap(e => [e.from, e.to]))].map((label, i) => ({ id: `n${i}`, label, subject: '' }));
  const idOf = {};
  savedNodes.value.forEach((n) => { idOf[n.label] = n.id; });
  savedEdges.value = list.map(e => ({ id: e.id, from: idOf[e.from] ?? ensure(e.from), to: idOf[e.to] ?? ensure(e.to), label: e.label, subject: e.subject || '' }));
  if (list.length) mode.value = 'saved';
  nextTick(() => { if (chart && savedNodes.value.length) render(); });
}

async function saveGenerated() {
  let n = 0, skipped = 0;
  for (const e of generatedEdges.value) {
    const fn = generatedNodes.value.find(x => x.id === e.from);
    const tn = generatedNodes.value.find(x => x.id === e.to);
    if (!fn || !tn) continue;
    const created = await createGraphEdge({ from: fn.label, to: tn.label, label: e.label, subject: fn.subject || tn.subject || '' });
    if (created) n++; else skipped++;
  }
  toast(skipped ? `已保存 ${n} 条关联，跳过 ${skipped} 条重复（可跨设备同步）` : `已保存 ${n} 条关联到知识库（可跨设备同步）`, 'success');
  await loadSaved();
}

async function removeEdge(id) {
  await deleteGraphEdge(id);
  await loadSaved();
}

const clusters = computed(() => {
  const m = new Map();
  for (const e of savedEdges.value) {
    const k = e.subject || '未分类';
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

onMounted(async () => { await loadSaved(); nextTick(() => { if (savedNodes.value.length && !chart) initChart(); render(); }); });
</script>

<template>
  <div style="max-width:980px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <h2 style="margin:0">知识图谱</h2>
      <span style="flex:1"></span>
      <button v-if="savedEdges.length" class="chip" @click="mode = mode === 'saved' ? 'generated' : 'saved'">
        {{ mode === 'saved' ? '切换到 AI 生成' : '查看已保存图谱' }}
      </button>
      <button class="btn" :disabled="loading" @click="autoRecommend" title="基于卡片相似度的本地算法，零 LLM 开销，零延迟">🔗 智能推荐关联</button>
      <button class="btn" :disabled="loading" @click="generateByAgent" title="走 graph-builder agent 工具调用循环，更懂卡片库且自动去重">🤖 Agent 智能构建</button>
      <button class="btn primary" :disabled="loading" @click="generate">{{ loading ? '生成中…' : 'AI 生成图谱' }}</button>
    </div>
    <p class="hint" style="margin:4px 0 10px">AI/Agent 从卡片挖出知识点和关联；多风格可视化；可保存进知识库随数据包同步。「🔗 智能推荐」用本地相似度算法，免 Key 免流量。</p>

    <div v-if="recommendLoading" class="hint" style="padding:12px;text-align:center">分析卡片相似度中…</div>
    <div v-if="recommended.length" class="rec-box">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <strong>智能推荐 {{ recommended.length }} 条关联</strong>
        <span class="hint">基于卡片内容/标签/科目相似度，可一键保存</span>
        <span style="flex:1"></span>
        <button class="btn small primary" @click="saveAllRecommended">💾 全部保存</button>
      </div>
      <div v-for="(r, i) in recommended" :key="`${r.from}-${r.to}-${r.label}`" class="rec-row">
        <div class="rec-main">
          <span class="rec-node">{{ r.from }}</span>
          <span class="rec-rel" :title="r.reason">{{ r.label }}</span>
          <span class="rec-node">{{ r.to }}</span>
          <span class="rec-score" :title="r.reason">相似度 {{ fmtScore(r.score) }}</span>
        </div>
        <div class="rec-reason">{{ r.reason }}</div>
        <div style="margin-top:4px">
          <button class="btn small primary" @click="saveRecommended(i)">保存</button>
          <button class="btn small" @click="recommended.splice(i, 1)">忽略</button>
        </div>
      </div>
    </div>

    <div v-if="nodes.length" class="kg-layout-bar">
      <span class="hint" style="margin-right:4px">风格：</span>
      <button v-for="l in LAYOUTS" :key="l.id" class="kg-style-chip" :class="{active: layout === l.id}" @click="setLayout(l.id)" :title="l.name">
        <span style="font-size:14px">{{ l.icon }}</span><span>{{ l.name }}</span>
      </button>
    </div>

    <div v-if="!nodes.length && !loading" class="hint" style="text-align:center;padding:60px">点右上角「AI 生成图谱」或「🤖 Agent 智能构建」，自动分析你的卡片。</div>

    <div v-if="nodes.length" class="graph-box">
      <div ref="chartEl" style="width:100%;height:58vh;min-height:400px"></div>
    </div>

    <div v-if="mode === 'generated' && generatedEdges.length" style="text-align:center;margin-top:10px">
      <button class="btn primary small" @click="saveGenerated">💾 保存这些关联到知识库</button>
    </div>

    <div v-if="mode === 'saved' && savedEdges.length" class="saved-box">
      <div class="saved-title">已保存的知识图谱（{{ savedEdges.length }} 条关联 · {{ clusters.length }} 个章节，可跨设备同步）</div>
      <div v-for="c in clusters" :key="c.subject" class="cluster">
        <div class="cluster-title">{{ c.subject }}<span class="cluster-count">{{ c.edges.length }} 条</span></div>
        <div v-for="e in c.edges" :key="e.id" class="saved-edge">
          <span>{{ nodeById(e.from)?.label || e.from }}</span>
          <span class="saved-rel">{{ e.label }}</span>
          <span>{{ nodeById(e.to)?.label || e.to }}</span>
          <a style="color:var(--red);cursor:pointer;margin-left:8px" @click="removeEdge(e.id)" aria-label="删除关联">删</a>
        </div>
      </div>
    </div>

    <div v-if="activeLabel" class="selected-node-bar" style="margin-top:10px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap">
      <span class="hint">
        <template v-if="activeId && nodeById(activeId)">选中节点：<b>{{ nodeById(activeId).label }}</b>，</template>
        <template v-else>当前节点：<b>{{ activeLabel }}</b>，</template>
        <span v-if="activeSubject" style="margin-right:6px">🎓 {{ activeSubject }}</span>
        可直接跳转到对应的知识卡片浏览。
      </span>
      <button class="btn primary small" @click="jumpToNodeCard(activeLabel, activeSubject)">🔗 跳转知识卡片</button>
      <button class="btn small" @click="activeLabel='';activeSubject='';activeId=''">清空选择</button>
    </div>
    <div v-else-if="activeId && nodeById(activeId)" class="hint" style="text-align:center;margin-top:10px">
      选中：{{ nodeById(activeId).label }}，相关节点已高亮。
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
.saved-title { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
.saved-edge { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.saved-edge:last-child { border-bottom: none; }
.saved-rel { color: var(--accent); font-size: 12px; }
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