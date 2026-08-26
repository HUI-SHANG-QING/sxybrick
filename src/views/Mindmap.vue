<script setup>
// 思维导图（借鉴 Progress AI，纯本地化：ECharts 多风格 + IndexedDB 持久化，随数据包同步）
// 支持：多风格切换（横向树/放射树/竖向树/桑基图/力导向）+ 手动建图 / 从知识图谱生成 / AI 从卡片生成 / 文字生成 / Agent 智能生成
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';
import { uid } from '../db.js';
import { listMindmaps, createMindmap, updateMindmap, deleteMindmap, listGraphEdges } from '../repo.js';
import { db } from '../db.js';
import { chatAI, hasAIKey, getAIConfig } from '../ai.js';
import { toast } from '../utils/toast.js';
import { agentSystem } from '../agent/index.js';

const maps = ref([]);
const current = ref(null);
const dirty = ref(false);
const loading = ref(false);
const aiLoading = ref(false);
const selId = ref('');
const chartEl = ref(null);
let chart = null;

// ---- 多风格切换 ----
const layout = ref(localStorage.getItem('sxy_mm_layout') || 'tree-lr');
const LAYOUTS = [
  { id: 'tree-lr', name: '横向树', icon: '→' },
  { id: 'tree-radial', name: '放射树', icon: '✸' },
  { id: 'tree-tb', name: '竖向树', icon: '↓' },
  { id: 'sankey', name: '桑基图', icon: '⇉' },
  { id: 'force', name: '力导向', icon: '⊛' },
];
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

// 树 → 扁平 nodes/links（供桑基图、力导向用）
function treeToFlat(root) {
  const nodes = [];
  const links = [];
  const seen = new Set();
  const walk = (node, parentName) => {
    if (!node) return;
    const name = node.name || node.label;
    if (!seen.has(name)) { nodes.push({ name, id: node.id }); seen.add(name); }
    if (parentName) links.push({ source: parentName, target: name, value: 1 });
    for (const c of node.children || []) walk(c, name);
  };
  walk(root, null);
  return { nodes, links };
}

function buildOption(data, style) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4a9eff';
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#333';
  const line = getComputedStyle(document.documentElement).getPropertyValue('--line-strong').trim() || '#999';
  if (style === 'tree-lr') return treeOption(data, 'LR', 'orthogonal', accent, ink, line);
  if (style === 'tree-tb') return treeOption(data, 'TB', 'orthogonal', accent, ink, line);
  if (style === 'tree-radial') return treeOption(data, 'LR', 'radial', accent, ink, line);
  if (style === 'sankey') {
    const { nodes, links } = treeToFlat(data);
    return {
      tooltip: { trigger: 'item' },
      series: [{
        type: 'sankey', data: nodes, links,
        left: '4%', right: '8%', top: '6%', bottom: '6%',
        label: { color: ink, fontSize: 12 },
        lineStyle: { color: accent, opacity: 0.35, curveness: 0.5 },
        itemStyle: { color: accent, borderColor: 'transparent' },
      }],
    };
  }
  if (style === 'force') {
    const { nodes, links } = treeToFlat(data);
    return {
      tooltip: { trigger: 'item', formatter: p => p.data?.name || p.name },
      series: [{
        type: 'graph', layout: 'force',
        data: nodes.map(n => ({ name: n.name, symbolSize: 18, itemStyle: { color: accent } })),
        links: links.map(l => ({ source: l.source, target: l.target })),
        force: { repulsion: 280, edgeLength: 90, gravity: 0.04, layoutAnimation: true },
        label: { show: true, color: ink, fontSize: 12, position: 'right' },
        lineStyle: { color: line, width: 1.2, curveness: 0.1 },
        roam: true,
      }],
    };
  }
  return treeOption(data, 'LR', 'orthogonal', accent, ink, line);
}

function treeOption(data, orient, layout, accent, ink, line) {
  const isRadial = layout === 'radial';
  return {
    tooltip: { trigger: 'item', formatter: p => p.data.name },
    series: [{
      type: 'tree', data: [data],
      left: '4%', right: (orient === 'LR' ? '12%' : '4%'), top: '6%', bottom: '6%',
      symbol: 'circle', symbolSize: 12, orient, layout,
      label: isRadial
        ? { position: 'radial', fontSize: 13, color: ink }
        : { position: orient === 'LR' ? 'left' : 'top', verticalAlign: 'middle', align: 'center', fontSize: 13, color: ink },
      leaves: { label: isRadial ? { position: 'radial' } : { position: orient === 'LR' ? 'right' : 'bottom', verticalAlign: 'middle', align: 'center' } },
      emphasis: { focus: 'descendant' },
      expandAndCollapse: true, initialTreeDepth: -1,
      lineStyle: { color: line, width: 1.5, curveness: 0.4 },
      itemStyle: { color: accent, borderColor: 'transparent' },
    }],
  };
}

function render() {
  if (!chart || !chartData.value) return;
  chart.setOption(buildOption(chartData.value, layout.value), true);
}

function openMap(m) {
  current.value = JSON.parse(JSON.stringify(m));
  dirty.value = false;
  selId.value = m.root?.id || '';
  nextTick(() => { if (!chart) initChart(); render(); });
}

function initChart() {
  chart = echarts.init(chartEl.value);
  chart.on('click', p => { if (p.data?.id) selId.value = p.data.id; });
  window.addEventListener('resize', onResize);
}
function onResize() { chart?.resize(); }
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart?.dispose(); });

async function newMap() {
  const m = await createMindmap({ title: '新导图', rootLabel: '中心主题' });
  await list();
  openMap(m);
}

// 从知识图谱关系生成导图（有向边 → 树，防环）
async function fromGraph() {
  const edges = await listGraphEdges();
  if (!edges.length) { toast('知识图谱还没有保存关联，先去「图谱」页生成并保存', 'error'); return; }
  const childrenOf = new Map();
  for (const e of edges) {
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
  }
  const allNames = new Set([...edges.map(e => e.from), ...edges.map(e => e.to)]);
  const inDeg = new Map();
  for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  const roots = [...allNames].filter(n => !inDeg.has(n));
  const rootLabel = (roots.length ? roots : [...allNames])[0];
  const build = (label, visited) => {
    if (visited.has(label)) return null;
    visited.add(label);
    const kids = (childrenOf.get(label) || []).map(k => build(k, new Set(visited))).filter(Boolean);
    return { id: uid(), label, children: kids };
  };
  const root = build(rootLabel, new Set()) || { id: uid(), label: rootLabel, children: [] };
  const m = await createMindmap({ title: `${rootLabel} 知识导图`, root });
  await list(); openMap(m);
  toast('已从知识图谱生成导图', 'success');
}

// AI 从卡片生成导图（直接 LLM）
async function fromAI() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  aiLoading.value = true;
  try {
    const cards = await db.cards.toArray();
    if (!cards.length) { toast('还没有卡片', 'error'); return; }
    const sample = cards.slice(0, 60).map(c => `[${c.subject || '未分类'}] ${String(c.front).slice(0, 80)}${c.back ? ' / ' + String(c.back).slice(0, 60) : ''}`).join('\n');
    const r = await chatAI([
      { role: 'system', content: '你是思维导图生成器。根据下面卡片提取知识主题，输出严格 JSON：{"title":"导图标题","root":{"label":"中心主题","children":[{"label":"子主题","children":[]}]}}。层级 2~3 层，节点总数 8~25 个。只输出 JSON。' },
      { role: 'user', content: sample },
    ]);
    const m = String(r).match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : r);
    if (!obj?.root?.label) throw new Error('AI 没返回有效结构');
    const withIds = n => ({ id: uid(), label: String(n.label || '主题').slice(0, 30), children: (n.children || []).slice(0, 40).map(withIds) });
    const mm = await createMindmap({ title: String(obj.title || 'AI 生成导图').slice(0, 40), root: withIds(obj.root) });
    await list(); openMap(mm);
    toast('AI 已生成导图', 'success');
  } catch (e) { toast('生成失败：' + e.message, 'error'); }
  finally { aiLoading.value = false; }
}

// Agent 智能生成：走专业 agent（A 镜头）的 ReAct 工具调用循环，比裸 chatAI 更懂卡片库
async function fromAgent() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
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
    const mm = await createMindmap({ title: String(obj.title || 'Agent 智能导图').slice(0, 40), root: withIds(obj.root) });
    await list(); openMap(mm);
    toast('Agent 已智能生成导图', 'success');
  } catch (e) { toast('Agent 生成失败：' + e.message, 'error'); }
  finally { aiLoading.value = false; }
}

// ---- 文字 → 思维导图（AI 从用户输入文本生成）----
const textOpen = ref(false);
const textInput = ref('');
const textLoading = ref(false);
function openTextGen() { textInput.value = ''; textOpen.value = true; }
async function fromText() {
  const txt = textInput.value.trim();
  if (!txt) { toast('请先输入文字内容', 'error'); return; }
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
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
    const mm = await createMindmap({ title: String(obj.title || '文本导图').slice(0, 40), root: withIds(obj.root) });
    await list(); openMap(mm); textOpen.value = false;
    toast('已从文字生成导图', 'success');
  } catch (e) { toast('生成失败：' + e.message, 'error'); }
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
  const name = prompt('修改节点文字：', node.label);
  if (name != null && name.trim()) { node.label = name.trim().slice(0, 30); markDirty(); }
}
function removeSel() {
  const root = current.value?.root;
  if (!root) return;
  if (selId.value === root.id) { toast('根节点不能删除', 'error'); return; }
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
    toast('导图已保存（可跨设备同步）', 'success');
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}
async function removeMap(m) {
  if (!confirm(`删除导图「${m.title}」？`)) return;
  await deleteMindmap(m.id);
  if (current.value?.id === m.id) { current.value = null; selId.value = ''; }
  await list();
}
const selectedLabel = computed(() => findNode(current.value?.root, selId.value)?.label || '');

onMounted(async () => {
  await list();
  if (maps.value.length) openMap(maps.value[0]);
});
</script>

<template>
  <div class="mm-wrap">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <h2 style="margin:0">思维导图</h2>
      <span style="flex:1"></span>
      <button class="btn primary" @click="newMap">＋ 新建</button>
      <button class="btn" @click="fromGraph">从知识图谱</button>
      <button class="btn" :disabled="aiLoading" @click="fromAI">{{ aiLoading ? '生成中…' : 'AI 从卡片' }}</button>
      <button class="btn" :disabled="aiLoading" @click="fromAgent" title="走专业 agent 的工具调用循环，更懂你的卡片库">🤖 Agent 生成</button>
      <button class="btn" @click="openTextGen">📝 文字生成</button>
    </div>
    <p class="hint" style="margin:4px 0 10px">把知识点画成多风格导图：横向树/放射树/竖向树/桑基图/力导向；可手动编辑，也可一键从知识图谱、AI、Agent 或输入文字生成。</p>

    <div v-if="current" class="mm-layout-bar">
      <span class="hint" style="margin-right:4px">风格：</span>
      <button v-for="l in LAYOUTS" :key="l.id" class="mm-style-chip" :class="{active: layout === l.id}" @click="setLayout(l.id)" :title="l.name">
        <span style="font-size:14px">{{ l.icon }}</span><span>{{ l.name }}</span>
      </button>
    </div>

    <div class="mm-body">
      <aside class="mm-list">
        <div v-if="!maps.length" class="hint" style="padding:10px">还没有导图。点右上角「＋ 新建」开始。</div>
        <div v-for="m in maps" :key="m.id" class="mm-item" :class="{ active: current?.id === m.id }">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="mm-title" @click="openMap(m)">{{ m.title }}</span>
            <a class="mm-del" @click="removeMap(m)" aria-label="删除导图">删</a>
          </div>
          <div class="mm-meta">{{ new Date(m.updatedAt).toLocaleDateString() }}</div>
        </div>
      </aside>

      <section class="mm-main">
        <template v-if="current">
          <div class="mm-toolbar">
            <input v-model="current.title" class="input" style="max-width:220px" placeholder="导图标题" @input="dirty = true" />
            <span v-if="selectedLabel" class="hint" style="margin-left:4px">选中：{{ selectedLabel }}</span>
            <span style="flex:1"></span>
            <button class="btn small" @click="addChild">＋ 子节点</button>
            <button class="btn small" @click="renameSel">重命名</button>
            <button class="btn small" style="color:var(--red)" @click="removeSel">删除节点</button>
            <button class="btn small primary" :disabled="!dirty" @click="saveMap">{{ dirty ? '保存' : '已保存' }}</button>
          </div>
          <div ref="chartEl" class="mm-chart"></div>
          <p class="hint" style="margin:6px 0 0">提示：点节点选中后可编辑；切换上方风格按钮看不同呈现；修改后记得点「保存」。</p>
        </template>
        <div v-else class="hint" style="text-align:center;padding:80px">从左侧选择导图，或新建一张。</div>
      </section>
    </div>

    <!-- 文字 → 思维导图 弹窗 -->
    <div v-if="textOpen" class="mm-mask" @click.self="textOpen = false">
      <div class="mm-modal">
        <div class="mm-modal-title">📝 文字 → 思维导图</div>
        <p class="hint" style="margin:4px 0 8px">粘贴一段文字（笔记/讲义/文章），AI 会自动提取层次结构生成导图。</p>
        <textarea v-model="textInput" class="input mm-textarea" placeholder="在此粘贴文字内容，例如：&#10;第一章 绪论&#10;1.1 研究背景：……&#10;1.2 研究意义：……" ></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <button class="btn" @click="textOpen = false">取消</button>
          <button class="btn primary" :disabled="textLoading" @click="fromText">{{ textLoading ? '生成中…' : '生成导图' }}</button>
        </div>
      </div>
    </div>
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
.mm-main { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; min-height: 480px; }
.mm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mm-chart { width: 100%; height: 60vh; min-height: 420px; }
.mm-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 90; display: flex; align-items: center; justify-content: center; padding: 16px; }
.mm-modal { width: 560px; max-width: 100%; background: var(--panel); border-radius: 14px; padding: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.mm-modal-title { font-size: 16px; font-weight: 700; }
.mm-textarea { width: 100%; min-height: 220px; resize: vertical; font-family: inherit; line-height: 1.6; }
@media (max-width: 720px) {
  .mm-body { grid-template-columns: 1fr; }
  .mm-list { max-height: 150px; }
  .mm-chart { height: 48vh; }
  .mm-modal { width: 100%; }
}
</style>