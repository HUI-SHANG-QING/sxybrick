<script setup>
// 思维导图（借鉴 Progress AI，纯本地化：ECharts 树 + IndexedDB 持久化，随数据包同步）
// 支持：手动建图 / 从知识图谱关系生成 / AI 从卡片生成；节点可增删改
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';
import { uid } from '../db.js';
import { listMindmaps, createMindmap, updateMindmap, deleteMindmap, listGraphEdges } from '../repo.js';
import { db } from '../db.js';
import { chatAI, hasAIKey } from '../ai.js';
import { toast } from '../utils/toast.js';

const maps = ref([]);
const current = ref(null);   // 当前导图行（{id,title,root,...}）
const dirty = ref(false);
const loading = ref(false);
const aiLoading = ref(false);
const selId = ref('');
const chartEl = ref(null);
let chart = null;

const list = async () => { maps.value = await listMindmaps(); };
const findNode = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) { const r = findNode(c, id); if (r) return r; }
  return null;
};
const toChart = node => ({ name: node.label, id: node.id, children: (node.children || []).map(toChart) });
const chartData = computed(() => (current.value ? toChart(current.value.root) : null));

function render() {
  if (!chart || !chartData.value) return;
  chart.setOption({
    tooltip: { trigger: 'item', formatter: p => p.data.name },
    series: [{
      type: 'tree', data: [chartData.value], left: '4%', right: '10%', top: '6%', bottom: '6%',
      symbol: 'circle', symbolSize: 12, orient: 'LR',
      label: { position: 'left', verticalAlign: 'middle', align: 'right', fontSize: 13 },
      leaves: { label: { position: 'right', verticalAlign: 'middle', align: 'left' } },
      emphasis: { focus: 'descendant' },
      expandAndCollapse: true, initialTreeDepth: -1,
      lineStyle: { color: 'var(--line-strong, #999)', width: 1.5 },
      itemStyle: { color: '#4a9eff', borderColor: 'transparent' },
    }],
  });
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
  // 根：没有入边的节点（挑出现最多的）
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

// AI 从卡片生成导图
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

// ---- 节点编辑（直接改 current.root，标记 dirty 后手动保存）----
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
  await updateMindmap(current.value.id, { title: current.value.title, root: current.value.root });
  dirty.value = false;
  await list();
  toast('导图已保存（可跨设备同步）', 'success');
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
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">思维导图</h2>
      <span style="flex:1"></span>
      <button class="btn primary" @click="newMap">＋ 新建导图</button>
      <button class="btn" @click="fromGraph">从知识图谱生成</button>
      <button class="btn" :disabled="aiLoading" @click="fromAI">{{ aiLoading ? 'AI 生成中…' : 'AI 生成' }}</button>
    </div>
    <p class="hint" style="margin:4px 0 12px">把知识点画成树状导图：可手动编辑，也可一键从「知识图谱」或 AI 生成；数据保存在本机并随数据包同步。</p>

    <div class="mm-body">
      <aside class="mm-list">
        <div v-if="!maps.length" class="hint" style="padding:10px">还没有导图。点右上角「＋ 新建导图」开始。</div>
        <div v-for="m in maps" :key="m.id" class="mm-item" :class="{ active: current?.id === m.id }">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="mm-title" @click="openMap(m)">{{ m.title }}</span>
            <a class="mm-del" @click="removeMap(m)">删</a>
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
          <p class="hint" style="margin:6px 0 0">提示：点节点选中后可编辑；点节点上的圆圈可折叠/展开分支；修改后记得点「保存」。</p>
        </template>
        <div v-else class="hint" style="text-align:center;padding:80px">从左侧选择导图，或新建一张。</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mm-wrap { max-width: 1200px; margin: 0 auto; }
.mm-body { display: grid; grid-template-columns: 220px 1fr; gap: 12px; }
.mm-list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; max-height: calc(100vh - 220px); overflow-y: auto; }
.mm-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; border: 1px solid transparent; }
.mm-item:hover { background: var(--code-inline); }
.mm-item.active { background: var(--code-bg); border-color: var(--accent); }
.mm-title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mm-del { color: var(--red); font-size: 12px; cursor: pointer; }
.mm-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.mm-main { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; min-height: 480px; }
.mm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mm-chart { width: 100%; height: 62vh; min-height: 420px; }
@media (max-width: 720px) { .mm-body { grid-template-columns: 1fr; } .mm-list { max-height: 160px; } .mm-chart { height: 50vh; } }
</style>