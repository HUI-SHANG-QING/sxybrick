<script setup>
// 知识图谱：AI 从你的卡片里提取知识点和关联，画成图；节点可点击查看关联
import { ref } from 'vue';
import { toast } from '../utils/toast.js';
import { db } from '../db.js';
import { chatAI, hasAIKey } from '../ai.js';

const nodes = ref([]);
const edges = ref([]);
const loading = ref(false);
const activeId = ref('');
const W = 800, H = 560;

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    nodes.value = (obj.nodes || []).map(n => ({ id: String(n.id), label: String(n.label || n.id), subject: n.subject || '' }));
    edges.value = (obj.edges || []).map(e => ({ from: String(e.from), to: String(e.to), label: e.label || '' }));
    layout();
    activeId.value = '';
    if (!nodes.value.length) toast('没解析出知识点', 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

function layout() {
  const n = nodes.value.length;
  if (!n) return;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 60;
  nodes.value.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    nd.x = cx + R * Math.cos(a);
    nd.y = cy + R * Math.sin(a);
  });
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
</script>

<template>
  <div style="max-width:900px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">知识图谱</h2>
      <span style="flex:1"></span>
      <button class="btn primary" :disabled="loading" @click="generate">{{ loading ? '生成中…' : '生成图谱' }}</button>
    </div>
    <p class="hint" style="margin:4px 0 12px">AI 从你的卡片里挖出知识点和关联，点节点看它和谁相关。</p>

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
    <div v-if="activeId && nodeById(activeId)" class="hint" style="text-align:center;margin-top:10px">
      选中：{{ nodeById(activeId).label }}（{{ nodeById(activeId).subject }}），相关节点已高亮。
    </div>
  </div>
</template>

<style scoped>
.graph-box { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; }
.node-label { font-size: 12px; fill: var(--ink); font-weight: 600; }
.edge-label { font-size: 10px; fill: var(--ink-2); }
</style>