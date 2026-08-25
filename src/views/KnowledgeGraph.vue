<script setup>
// 知识图谱：AI 从卡片里提取知识点和关联画成图；生成的关联可保存到本地库并随数据包同步。
import { ref, computed, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import { db } from '../db.js';
import { chatAI, hasAIKey } from '../ai.js';
import { listGraphEdges, createGraphEdge, deleteGraphEdge } from '../repo.js';

const generatedNodes = ref([]);
const generatedEdges = ref([]);
const savedNodes = ref([]);
const savedEdges = ref([]);
const loading = ref(false);
const activeId = ref('');
const mode = ref('generated'); // generated | saved
const W = 800, H = 560;

const nodes = computed(() => (mode.value === 'saved' ? savedNodes.value : generatedNodes.value));
const edges = computed(() => (mode.value === 'saved' ? savedEdges.value : generatedEdges.value));

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function layout(arr) {
  const n = arr.length;
  if (!n) return;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 60;
  arr.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    nd.x = cx + R * Math.cos(a);
    nd.y = cy + R * Math.sin(a);
  });
}

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
    layout(generatedNodes.value);
    activeId.value = '';
    mode.value = 'generated';
    if (!generatedNodes.value.length) toast('没解析出知识点', 'error');
  } catch (e) { toast(e.message, 'error'); }
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
  layout(savedNodes.value);
  if (list.length) mode.value = 'saved';
}

// 自动聚类章节：按科目把已保存的关联分组
const clusters = computed(() => {
  const m = new Map();
  for (const e of savedEdges.value) {
    const k = e.subject || '未分类';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return [...m.entries()].map(([subject, edges]) => ({ subject, edges }));
});

async function saveGenerated() {
  let n = 0, skipped = 0;
  for (const e of generatedEdges.value) {
    const fn = generatedNodes.value.find(x => x.id === e.from);
    const tn = generatedNodes.value.find(x => x.id === e.to);
    if (!fn || !tn) continue;
    const created = await createGraphEdge({ from: fn.label, to: tn.label, label: e.label, subject: fn.subject || tn.subject || '' });
    if (created) n++; else skipped++; // repo 层已去重：重复边返回 null，不会污染知识库
  }
  toast(skipped ? `已保存 ${n} 条关联，跳过 ${skipped} 条重复（可跨设备同步）` : `已保存 ${n} 条关联到知识库（可跨设备同步）`, 'success');
  await loadSaved();
}

async function removeEdge(id) {
  await deleteGraphEdge(id);
  await loadSaved();
}

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

onMounted(loadSaved);
</script>

<template>
  <div style="max-width:900px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">知识图谱</h2>
      <span style="flex:1"></span>
      <button v-if="savedEdges.length" class="chip" @click="mode = mode === 'saved' ? 'generated' : 'saved'">
        {{ mode === 'saved' ? '切换到 AI 生成' : '查看已保存图谱' }}
      </button>
      <button class="btn primary" :disabled="loading" @click="generate">{{ loading ? '生成中…' : '生成图谱' }}</button>
    </div>
    <p class="hint" style="margin:4px 0 12px">AI 从卡片挖出知识点和关联；可把生成的关联保存进知识库，随数据包同步。</p>

    <div v-if="!nodes.length && !loading" class="hint" style="text-align:center;padding:60px">点右上角「生成图谱」，AI 会自动分析你的卡片。</div>

    <div v-if="nodes.length" class="graph-box">
      <svg :viewBox="`0 0 ${W} ${H}`" width="100%">
        <g v-for="e in edges" :key="'e' + e.from + e.to + e.label">
          <line :x1="(nodeById(e.from)||{}).x" :y1="(nodeById(e.from)||{}).y" :x2="(nodeById(e.to)||{}).x" :y2="(nodeById(e.to)||{}).y"
            :stroke="activeId && (e.from === activeId || e.to === activeId) ? 'var(--accent)' : 'var(--line-strong)'" stroke-width="1.5" />
          <text v-if="e.label" :x="((((nodeById(e.from)||{}).x||0) + ((nodeById(e.to)||{}).x||0)) / 2)" :y="((((nodeById(e.from)||{}).y||0) + ((nodeById(e.to)||{}).y||0)) / 2)"
            text-anchor="middle" class="edge-label">{{ e.label }}</text>
        </g>
        <g v-for="n in nodes" :key="n.id" @click="activeId = n.id" style="cursor:pointer">
          <circle :cx="n.x" :cy="n.y" :r="18" :fill="activeId === n.id ? 'var(--accent)' : relatedIds().includes(n.id) ? 'var(--green)' : 'var(--panel-solid)'" stroke="var(--accent)" stroke-width="2" />
          <text :x="n.x" :y="n.y - 30" text-anchor="middle" class="node-label">{{ n.label.slice(0, 8) }}</text>
          <text v-if="n.subject" :x="n.x" :y="n.y + 38" text-anchor="middle" class="edge-label">{{ n.subject.slice(0, 6) }}</text>
        </g>
      </svg>
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
          <a style="color:var(--red);cursor:pointer;margin-left:8px" @click="removeEdge(e.id)">删</a>
        </div>
      </div>
    </div>

    <div v-if="activeId && nodeById(activeId)" class="hint" style="text-align:center;margin-top:10px">
      选中：{{ nodeById(activeId).label }}，相关节点已高亮。
    </div>
  </div>
</template>

<style scoped>
.graph-box { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; }
.node-label { font-size: 12px; fill: var(--ink); font-weight: 600; }
.edge-label { font-size: 10px; fill: var(--ink-2); }
.chip { font-size: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.saved-box { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; margin-top: 14px; }
.saved-title { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
.saved-edge { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.saved-edge:last-child { border-bottom: none; }
.saved-rel { color: var(--accent); font-size: 12px; }
.cluster { margin-bottom: 10px; padding: 8px 12px; background: var(--code-bg); border-radius: 8px; }
.cluster-title { font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
.cluster-count { font-size: 11px; color: var(--ink-2); margin-left: 6px; font-weight: 400; }
</style>
