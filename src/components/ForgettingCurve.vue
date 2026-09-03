<template>
  <div class="fc-wrap">
    <div class="fc-head">
      <div class="fc-title">遗忘曲线 · {{ card?.subject || '未分类' }}</div>
      <div class="fc-stats">
        <span>当前可提取度 <b :class="rNow < target ? 'c-red' : 'c-green'">{{ (rNow*100).toFixed(0) }}%</b></span>
        <span>稳定度 S={{ s.toFixed(2) }} 天</span>
        <span>建议复习 {{ dueText }}</span>
      </div>
    </div>
    <div ref="el" class="fc-chart"></div>
    <div class="fc-tip">{{ tip }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  card: { type: Object, default: null },
  examAt: { type: Number, default: 0 },          // 目标考试时间戳
  reviews: { type: Array, default: () => [] },   // [{ reviewedAt, rating }]
  target: { type: Number, default: 0.9 },
});

const el = ref(null);
let chart = null;
const DAY = 86400000;

const s = computed(() => Math.max(0.5, props.card?.fsrs?.s ?? 1));
const elapsedFromLast = computed(() => {
  const last = props.card?.fsrs?.last ?? Date.now();
  return Math.max(0, (Date.now() - last) / DAY);
});
const rNow = computed(() => 1 / (1 + elapsedFromLast.value / (9 * s.value)));
const dueDays = computed(() => Math.max(0.01, 9 * s.value * (1 / props.target - 1)));

function fmt(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())}`;
}
const dueText = computed(() => {
  const days = dueDays.value;
  if (days < 1) return `${Math.round(days * 24)} 小时后`;
  if (days <= 30) return `${days.toFixed(1)} 天后`;
  return fmt(Date.now() + days * DAY);
});

const tip = computed(() => {
  if (props.examAt) {
    const daysToExam = (props.examAt - Date.now()) / DAY;
    if (daysToExam > 0 && daysToExam < dueDays.value) return '⚠️ 考前来不及自然复习窗口，已压缩复习到此节点之前。';
    if (rNow.value < props.target) return '低于目标保持率，今天就该复习这张卡。';
    return '当前留存充足，按节奏即可。';
  }
  return rNow.value < props.target ? '当前可提取度已低于 90% 目标，建议立即复习。' : '按当前节奏复习即可维持记忆。';
});

function patchColor(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith('var(')) {
    const name = v.slice(4, -1).trim();
    const c = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return c || v;
  }
  return v;
}

function buildOption() {
  const days = 30;
  const xs = [], ys = [], markers = [];
  for (let d = 0; d <= days; d += 0.5) {
    const R = 1 / (1 + (elapsedFromLast.value + d) / (9 * s.value));
    xs.push(d); ys.push(Number((R * 100).toFixed(1)));
  }
  // 历史复习点（相对今天）
  for (const r of props.reviews) {
    const dd = (r.reviewedAt - Date.now()) / DAY;
    const rl = props.card?.fsrs?.last ?? r.reviewedAt;
    const el2 = Math.max(0, (r.reviewedAt - rl) / DAY);
    const R = 1 / (1 + el2 / (9 * s.value));
    markers.push({
      value: [Number(dd.toFixed(1)), Number((R * 100).toFixed(1))],
      itemStyle: { color: r.rating >= 2 ? '#e2724f' : '#7bbf6a' },
    });
  }
  const ink = patchColor('var(--ink)');
  const line = patchColor('var(--accent)');
  return {
    grid: { left: 44, right: 16, top: 16, bottom: 32 },
    tooltip: { trigger: 'axis', formatter: p => {
      const x = p[0].data[0];
      return `第 ${x} 天<br/>可提取度 ${p[0].data[1]}%`;
    } },
    xAxis: { type: 'value', name: '天', min: 0, max: days, axisLabel: { color: ink }, axisLine: { lineStyle: { color: ink } } },
    yAxis: { type: 'value', name: '%', min: 0, max: 100, axisLabel: { color: ink }, splitLine: { lineStyle: { color: patchColor('var(--line)') } } },
    series: [
      {
        type: 'line', smooth: true, data: xs.map((x, i) => [x, ys[i]]),
        lineStyle: { color: line, width: 2.5 }, areaStyle: { color: line, opacity: 0.12 },
        showSymbol: false,
      },
      {
        type: 'line', markLine: {
          silent: true, symbol: 'none',
          data: [
            { yAxis: props.target * 100, lineStyle: { color: '#e2724f', type: 'dashed' }, label: { formatter: '目标 90%', color: '#e2724f' } },
            { xAxis: dueDays.value, lineStyle: { color: line, type: 'dotted' }, label: { formatter: '建议复习', color: line } },
          ],
        },
      },
      { type: 'scatter', data: markers, symbolSize: 8, name: '历史复习' },
    ],
  };
}

function render() {
  if (!el.value) return;
  if (!chart) chart = echarts.init(el.value);
  chart.setOption(buildOption(), true);
}

onMounted(() => {
  render();
  // E4：resize 监听必须挂载后注册、卸载时移除——此前写在 setup 顶层，永不移除，
  // 闭包持有已 dispose 的 chart（滚动条出现/窗口变化触发 resize 时对已销毁实例调
  // resize() 抛错，实例也因闭包无法被 GC，每进出一次泄漏一份）
  window.addEventListener('resize', onResize);
});
watch(() => [props.card, props.reviews, props.examAt], () => render(), { deep: true });
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  if (chart) chart.dispose();
  chart = null;
});
function onResize() { if (chart) chart.resize(); }
</script>

<style scoped>
.fc-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.fc-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.fc-title { font-weight: 700; color: var(--ink); }
.fc-stats { display: flex; gap: 14px; font-size: 13px; color: var(--ink-2); }
.fc-stats b { color: var(--ink); }
.fc-chart { width: 100%; height: 240px; }
.fc-tip { margin-top: 6px; font-size: 13px; color: var(--ink-2); }
.c-red { color: #e2724f; }
.c-green { color: #7bbf6a; }
</style>
