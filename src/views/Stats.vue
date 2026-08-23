<script setup>
// 数据可视化：复习热力图 + 各科掌握度雷达图 + 14 天趋势 + 统计指标（本地）
import { ref, onMounted, onBeforeUnmount } from 'vue';
import * as echarts from 'echarts';
import { toast } from '../utils/toast.js';
import { getStats } from '../repo.js';
import { degraded } from '../utils/perf.js';

const stats = ref(null);
const heatEl = ref(null);
const radarEl = ref(null);
const trendEl = ref(null);
let charts = [];

function buildCharts() {
  if (!stats.value) return;
  charts.forEach(c => c.dispose());
  charts = [];

  if (heatEl.value) {
    const data = Object.entries(stats.value.heatmap).map(([d, v]) => [d, v]);
    const heat = echarts.init(heatEl.value);
    const end = new Date();
    const start = new Date(end.getTime() - 364 * 86400000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    heat.setOption({
      tooltip: { formatter: p => `${p.value[0]}：复习 ${p.value[1]} 次` },
      visualMap: { min: 0, max: Math.max(5, ...data.map(d => d[1])), show: false, inRange: { color: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'] } },
      calendar: { range: [fmt(start), fmt(end)], cellSize: [12, 12], itemStyle: { borderColor: '#fff', borderWidth: 2 }, yearLabel: { show: false }, dayLabel: { firstDay: 1 } },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
    });
    charts.push(heat);
  }

  if (radarEl.value && stats.value.mastery.length) {
    const radar = echarts.init(radarEl.value);
    radar.setOption({
      tooltip: {},
      radar: {
        indicator: stats.value.mastery.map(m => ({ name: m.subject, max: 100 })),
        radius: '65%',
      },
      series: [{
        type: 'radar',
        data: [{ value: stats.value.mastery.map(m => m.mastery), name: '掌握度 %', areaStyle: { opacity: .25 } }],
      }],
    });
    charts.push(radar);
  }

  if (trendEl.value) {
    const trend = echarts.init(trendEl.value);
    trend.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: stats.value.trend.map(t => t.date) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{ type: 'bar', data: stats.value.trend.map(t => t.count), itemStyle: { color: '#16202c', borderRadius: [4, 4, 0, 0] } }],
      grid: { left: 36, right: 12, top: 20, bottom: 28 },
    });
    charts.push(trend);
  }
}

async function load() {
  try {
    stats.value = await getStats();
    if (degraded.value) setTimeout(buildCharts, 300);
    else buildCharts();
  } catch (e) { toast(e.message, 'error'); }
}

function onResize() { charts.forEach(c => c.resize()); }

onMounted(() => { load(); window.addEventListener('resize', onResize); });
onBeforeUnmount(() => { charts.forEach(c => c.dispose()); window.removeEventListener('resize', onResize); });
</script>

<template>
  <div>
    <h2>复习数据</h2>

    <div class="stat-cards">
      <div class="stat"><div class="num">{{ stats?.totalCards ?? '-' }}</div><div class="hint">总卡片数</div></div>
      <div class="stat"><div class="num">{{ stats?.totalReviews ?? '-' }}</div><div class="hint">总复习次数</div></div>
      <div class="stat"><div class="num">{{ stats?.todayReviews ?? '-' }}</div><div class="hint">今日复习</div></div>
      <div class="stat"><div class="num">{{ stats?.avgMastery ?? '-' }}%</div><div class="hint">平均掌握度</div></div>
      <div class="stat"><div class="num">{{ stats?.dueToday ?? '-' }}</div><div class="hint">待复习</div></div>
    </div>

    <div class="panel">
      <div class="hint" style="margin-bottom:8px">复习热力图（近一年）</div>
      <div ref="heatEl" style="height:150px"></div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">各科掌握度雷达图（近 90 天自评）</div>
        <div ref="radarEl" style="height:300px"></div>
        <div v-if="stats && !stats.mastery.length" class="hint" style="text-align:center">暂无复习记录</div>
      </div>
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">近 14 天复习趋势</div>
        <div ref="trendEl" style="height:300px"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat-cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 22px; text-align: center; }
.stat .num { font-size: 24px; font-weight: 700; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
</style>