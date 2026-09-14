<script setup>
// AI/Agent 返回的结构化 graph 结果 → 内联 ECharts 图。
//
// 用户诉求（2026-09-14）：知识图谱、关键路径这类结果应该是**图**，而不是一坨 JSON。
// 前端契约：模型按约定返回 { type:'graph', data:{ nodes:[{id,name,category}], links:[{source,target,label}] , kind? } }
// （协议说明写在 agent/agents/base.js 的 PROTOCOL 里，工具/模型据此输出）。
//
// 工程要点（沿用本项目 ECharts 的既有教训）：
//   · echarts 是重依赖 → **动态 import**，只有真的出图时才加载（AI 气泡里大多是纯文本）；
//   · v-if 容器：init 必须发生在容器已挂载且**有尺寸**之后，否则得到 0x0 画布（白块）；
//   · dispose 后必须把 el._chart 置空，否则复用已销毁实例 → setOption 静默失效；
//   · 数据变化只 setOption（不重复 init）；组件卸载时 dispose 并摘掉 resize 监听。
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { normalizeGraphData } from '../utils/ai-structured.js';

const props = defineProps({
  data: { type: Object, required: true },
  note: { type: String, default: '' },
});

const el = ref(null);
const failed = ref(false);
const truncated = ref(false); // 节点数超护栏被截断时提示（2026-09-14 审计 P2）
let resizeObserver = null;

// 力导向布局节点数护栏：模型按协议返回超大图时，上千节点会让 force layout 卡死主线程
// （repulsion O(n²)）。只渲染前 MAX_NODES 个节点及其内部边，并在图上明确告知被截断。
const MAX_NODES = 120;

async function ensureChart() {
  const dom = el.value;
  if (!dom || dom._chart) return dom?._chart || null;
  // 容器尚未布局（display:none / 0 宽）时 init 会得到 0x0 画布，等下一帧再试
  if (!dom.offsetWidth) return null;
  let echarts;
  try {
    echarts = await import('echarts');
  } catch {
    failed.value = true;
    return null;
  }
  if (!dom.isConnected) return null;
  dom._chart = (echarts.default || echarts).init(dom, null, { renderer: 'canvas' });
  return dom._chart;
}

function buildOption(g) {
  const cats = [...new Set(g.nodes.map((n) => n.category).filter(Boolean))];
  const directed = g.kind.includes('path') || g.kind.includes('direct') || g.kind.includes('prereq');
  return {
    tooltip: {
      confine: true,
      formatter: (p) => {
        if (p.dataType === 'edge') {
          // 无 label 时也给出端点信息，避免悬浮显示空白框（2026-09-14 审计 P3）
          const l = p.data.label ? `（${p.data.label}）` : '';
          return `${p.data.source} → ${p.data.target}${l}`;
        }
        return p.data.name;
      },
    },
    legend: cats.length ? [{ data: cats, bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } }] : undefined,
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      // 有向场景（关键路径/前置关系）画箭头，无向场景画普通连线
      edgeSymbol: directed ? ['none', 'arrow'] : ['none', 'none'],
      edgeSymbolSize: directed ? [0, 8] : 0,
      force: { repulsion: 220, edgeLength: [60, 140], gravity: 0.06 },
      label: { show: true, fontSize: 12, position: 'right' },
      edgeLabel: { show: true, fontSize: 10, formatter: (p) => p.data.label || '' },
      lineStyle: { color: 'source', opacity: 0.55, curveness: 0.08, width: 1.4 },
      categories: cats.map((c) => ({ name: c })),
      data: g.nodes.map((n) => ({
        id: n.id, name: n.name,
        // value=0（或缺失）时用真实 0 —— 旧写法 `n.value || 1` 把 0 当成 1，气泡大小失真
        symbolSize: Math.max(18, Math.min(48, 18 + (Number(n.value) || 0) * 4)),
        category: n.category ? cats.indexOf(n.category) : undefined,
      })),
      links: g.links.map((l) => ({ source: l.source, target: l.target, label: l.label || '' })),
    }],
  };
}

async function draw() {
  let g = normalizeGraphData(props.data);
  if (!g) { failed.value = true; return; }
  // 节点数护栏：只保留前 MAX_NODES 个节点及其两端都在保留集内的边。
  // 截断只影响展示（超大图本来也看不清），数据完整性与其余协议内容不受影响。
  if (g.nodes.length > MAX_NODES) {
    const keep = new Set(g.nodes.slice(0, MAX_NODES).map((n) => n.id));
    g = { ...g, nodes: g.nodes.filter((n) => keep.has(n.id)), links: g.links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
    truncated.value = true;
  }
  await nextTick();
  const chart = await ensureChart()
    // 容器刚渲染出来可能还没尺寸：重试一次
    || (await new Promise((r) => setTimeout(r, 60)), await ensureChart());
  if (!chart) return;
  chart.setOption(buildOption(g), true);
  // init 时容器若为 0 宽，这里补一次 resize 让图真正可见
  chart.resize();
}

onMounted(() => {
  draw();
  // 容器尺寸变化（侧栏折叠 / 窗口缩放 / 气泡变宽）时跟随重绘
  if (typeof ResizeObserver !== 'undefined' && el.value) {
    resizeObserver = new ResizeObserver(() => { el.value?._chart?.resize(); });
    resizeObserver.observe(el.value);
  }
});

watch(() => props.data, () => { draw(); });

onBeforeUnmount(() => {
  if (resizeObserver) { try { resizeObserver.disconnect(); } catch { /* ignore */ } resizeObserver = null; }
  const dom = el.value;
  if (dom?._chart) {
    try { dom._chart.dispose(); } catch { /* ignore */ }
    dom._chart = null; // ⚠️ 必须置空：否则复用已销毁实例会让后续 setOption 静默失效
  }
});
</script>

<template>
  <div class="ai-graph">
    <div v-if="failed" class="ai-graph-err">图表渲染失败，以下为原始结构：{{ JSON.stringify(data).slice(0, 500) }}</div>
    <div v-else ref="el" class="ai-graph-canvas"></div>
    <div v-if="note" class="ai-graph-note">{{ note }}</div>
    <div v-if="truncated" class="ai-graph-note">节点过多，已截断显示前 {{ MAX_NODES }} 个（其余省略）。</div>
  </div>
</template>

<style scoped>
.ai-graph { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; margin: 8px 0; }
.ai-graph-canvas { width: 100%; height: 380px; }
.ai-graph-note { font-size: 12.5px; color: var(--ink-2); padding: 4px 6px 2px; line-height: 1.7; }
.ai-graph-err { font-size: 12px; color: var(--ink-2); padding: 8px; word-break: break-all; }
</style>
