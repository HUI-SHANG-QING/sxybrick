<script setup>
// 数据可视化：复习热力图 + 各科掌握度雷达图 + 14 天趋势 + 统计指标（本地）
import { ref, onMounted, onBeforeUnmount } from 'vue';
import * as echarts from 'echarts';
import 'echarts-wordcloud';
import { toast } from '../utils/toast.js';
import { getStats } from '../repo.js';
import { getLearningProfile } from '../agent/analytics.js';
import { degraded } from '../utils/perf.js';

const stats = ref(null);
const profile = ref(null);
const heatEl = ref(null);
const radarEl = ref(null);
const trendEl = ref(null);
const pieEl = ref(null);
const ratingEl = ref(null);
const abilityEl = ref(null);
const profileEl = ref(null);
const hourlyEl = ref(null);
const forgotEl = ref(null);
const tagEl = ref(null);
const wordEl = ref(null);
let charts = [];

function getChartTheme() {
  const t = document.documentElement.getAttribute('data-theme') || 'light';
  if (t === 'dark') return { text: '#8b98a5', border: '#161b22', empty: '#21262d', grid: '#30363d', axis: '#8b98a5', bar: '#3b82f6' };
  if (t === 'eye') return { text: '#5c6b5c', border: '#e6f2e6', empty: '#dceadc', grid: '#b8cfb9', axis: '#5c6b5c', bar: '#4c8352' };
  return { text: '#9aa5b1', border: '#ffffff', empty: '#ebedf0', grid: '#e3e8ee', axis: '#9aa5b1', bar: '#16202c' };
}

function buildCharts() {
  if (!stats.value) return;
  const theme = getChartTheme();
  charts.forEach(c => c.dispose());
  charts = [];

  if (heatEl.value) {
    const data = Object.entries(stats.value.heatmap).map(([d, v]) => [d, v]);
    const heat = echarts.init(heatEl.value);
    const end = new Date();
    const start = new Date(end.getTime() - 364 * 86400000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const maxV = Math.max(1, ...data.map(d => d[1]));
    heat.setOption({
      tooltip: { formatter: p => `${p.value[0]}：复习 ${p.value[1]} 次` },
      visualMap: {
        min: 0, max: maxV,
        left: 'center', bottom: 0,
        show: data.length > 0,
        itemWidth: 12, itemHeight: 12,
        textStyle: { color: theme.text, fontSize: 11 },
        inRange: { color: [theme.empty, '#9be9a8', '#40c463', '#30a14e', '#216e39'] },
      },
      calendar: {
        top: 34, left: 26, right: 10, bottom: 30,
        range: [fmt(start), fmt(end)],
        cellSize: ['auto', 13],
        splitLine: { show: false },
        itemStyle: { borderColor: theme.border, borderWidth: 2, borderRadius: 3 },
        yearLabel: { show: false },
        dayLabel: { firstDay: 1, margin: 8, nameMap: ['日', '一', '二', '三', '四', '五', '六'] },
        monthLabel: { margin: 10, nameMap: 'cn' },
      },
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
        axisName: { color: theme.text },
        splitLine: { lineStyle: { color: theme.grid } },
        axisLine: { lineStyle: { color: theme.grid } },
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
      xAxis: { type: 'category', data: stats.value.trend.map(t => t.date), axisLabel: { color: theme.axis }, axisLine: { lineStyle: { color: theme.grid } } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [{ type: 'bar', data: stats.value.trend.map(t => t.count), itemStyle: { color: theme.bar, borderRadius: [4, 4, 0, 0] } }],
      grid: { left: 36, right: 12, top: 20, bottom: 28 },
    });
    charts.push(trend);
  }

  // 各科卡片占比环形图
  if (pieEl.value) {
    const pie = echarts.init(pieEl.value);
    const pdata = Object.entries(stats.value.subjectCards || {}).map(([name, value]) => ({ name, value }));
    pie.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} 张 ({d}%)' },
      legend: { bottom: 0, textStyle: { color: theme.text } },
      series: [{
        type: 'pie', radius: ['38%', '62%'], center: ['50%', '44%'],
        label: { color: theme.text, formatter: '{b}\n{d}%' },
        data: pdata,
        itemStyle: { borderRadius: 6, borderColor: theme.border, borderWidth: 2 },
      }],
    });
    charts.push(pie);
  }

  // 自评分布
  if (ratingEl.value) {
    const rating = echarts.init(ratingEl.value);
    const d = stats.value.ratingDist || { 0: 0, 1: 0, 2: 0 };
    rating.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: ['没记住', '还模糊', '记住了'], axisLabel: { color: theme.axis }, axisLine: { lineStyle: { color: theme.grid } } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [{ type: 'bar', data: [
        { value: d[0], itemStyle: { color: '#ef4444' } },
        { value: d[1], itemStyle: { color: '#f59e0b' } },
        { value: d[2], itemStyle: { color: '#22c55e' } },
      ], borderRadius: [6, 6, 0, 0] }],
      grid: { left: 40, right: 12, top: 20, bottom: 28 },
    });
    charts.push(rating);
  }

  // 能力四维雷达
  if (abilityEl.value && stats.value.ability) {
    const ab = stats.value.ability;
    const ability = echarts.init(abilityEl.value);
    ability.setOption({
      tooltip: {},
      radar: {
        indicator: [
          { name: '掌握度', max: 100 }, { name: '正确率', max: 100 },
          { name: '稳定度', max: 100 }, { name: '覆盖率', max: 100 },
        ],
        radius: '62%',
        axisName: { color: theme.text },
        splitLine: { lineStyle: { color: theme.grid } },
        axisLine: { lineStyle: { color: theme.grid } },
      },
      series: [{ type: 'radar', data: [{ value: [ab.mastery, ab.correct, ab.stable, ab.coverage], name: '能力', areaStyle: { opacity: .25 } }] }],
    });
    charts.push(ability);
  }

  // 学习画像（跨模块统一打分，六维）
  if (profileEl.value && profile.value) {
    const p = profile.value;
    const pr = echarts.init(profileEl.value);
    pr.setOption({
      tooltip: {},
      radar: {
        indicator: [
          { name: '掌握度', max: 100 }, { name: '正确率', max: 100 }, { name: '稳定度', max: 100 },
          { name: '覆盖率', max: 100 }, { name: '活跃度', max: 100 }, { name: '纠正力', max: 100 },
        ],
        radius: '65%',
        axisName: { color: theme.text },
        splitLine: { lineStyle: { color: theme.grid } },
        axisLine: { lineStyle: { color: theme.grid } },
      },
      series: [{ type: 'radar', data: [{ value: [p.dimensions.mastery, p.dimensions.correct, p.dimensions.stable, p.dimensions.coverage, p.dimensions.activity, p.dimensions.correction], name: '学习画像', areaStyle: { opacity: .25 } }] }],
    });
    charts.push(pr);
  }

  // 24 小时复习时间分布
  if (hourlyEl.value) {
    const hourly = echarts.init(hourlyEl.value);
    hourly.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => i + '时'), axisLabel: { color: theme.axis } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [{ type: 'bar', data: stats.value.hourly, itemStyle: { color: theme.bar, borderRadius: [3, 3, 0, 0] } }],
      grid: { left: 32, right: 8, top: 20, bottom: 24 },
    });
    charts.push(hourly);
  }

  // 遗忘率曲线（近 30 天，越低越好）
  if (forgotEl.value) {
    const forgot = echarts.init(forgotEl.value);
    forgot.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: stats.value.forgotTrend.map(t => t.date), axisLabel: { color: theme.axis } },
      yAxis: { type: 'value', max: 100, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [{ type: 'line', data: stats.value.forgotTrend.map(t => t.rate), smooth: true, itemStyle: { color: '#ef4444' }, areaStyle: { opacity: .1 } }],
      grid: { left: 32, right: 12, top: 20, bottom: 24 },
    });
    charts.push(forgot);
  }

  // 标签 Top 10
  if (tagEl.value && stats.value.tagCounts && stats.value.tagCounts.length) {
    const tag = echarts.init(tagEl.value);
    const data = stats.value.tagCounts.slice().reverse();
    tag.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      yAxis: { type: 'category', data: data.map(t => t.name), axisLabel: { color: theme.axis } },
      series: [{ type: 'bar', data: data.map(t => t.count), itemStyle: { color: '#8b5cf6', borderRadius: [0, 4, 4, 0] } }],
      grid: { left: 60, right: 16, top: 10, bottom: 20 },
    });
    charts.push(tag);
  }

  // 标签词云
  if (wordEl.value && stats.value.tagCounts && stats.value.tagCounts.length) {
    const wc = echarts.init(wordEl.value);
    const colors = ['#6366F1', '#8B5CF6', '#EC4899', '#F59E0B', '#22C55E', '#3B82F6', '#EF4444'];
    wc.setOption({
      tooltip: { formatter: p => `${p.name}：${p.value} 张` },
      series: [{
        type: 'wordCloud',
        shape: 'circle',
        sizeRange: [14, 58],
        rotationRange: [0, 0],
        gridSize: 8,
        textStyle: { color: p => colors[p.dataIndex % colors.length] },
        emphasis: { textStyle: { fontWeight: 'bold' } },
        data: stats.value.tagCounts.map(t => ({ name: t.name, value: t.count })),
      }],
    });
    charts.push(wc);
  }
}

async function load() {
  try {
    const [s, p] = await Promise.all([getStats(), getLearningProfile()]);
    stats.value = s; profile.value = p;
    if (degraded.value) setTimeout(buildCharts, 300);
    else buildCharts();
  } catch (e) { toast(e.message, 'error'); }
}

function onResize() { charts.forEach(c => c.resize()); }

let themeObserver = null;
onMounted(() => {
  load(); window.addEventListener('resize', onResize);
  themeObserver = new MutationObserver(() => { if (stats.value) buildCharts(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
});
onBeforeUnmount(() => { charts.forEach(c => c.dispose()); window.removeEventListener('resize', onResize); themeObserver?.disconnect(); });
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

    <div v-if="profile" class="panel profile-panel">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div class="profile-score">
          <div class="ps-num">{{ profile.score }}</div>
          <div class="hint">学习画像 · {{ profile.level }}</div>
        </div>
        <div class="hint" style="flex:1;min-width:220px;font-size:13px">{{ profile.summary }}</div>
      </div>
    </div>

    <div class="panel">
      <div class="hint" style="margin-bottom:8px">复习热力图（近一年）</div>
      <div ref="heatEl" style="height:210px"></div>
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

    <div class="grid2">
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">各科卡片占比</div>
        <div ref="pieEl" style="height:280px"></div>
      </div>
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">自评分布（全部复习）</div>
        <div ref="ratingEl" style="height:280px"></div>
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">学习画像雷达（六维）</div>
        <div ref="profileEl" style="height:260px"></div>
      </div>
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">复习时间分布（24 小时）</div>
        <div ref="hourlyEl" style="height:260px"></div>
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">遗忘率趋势（近 30 天，越低越好）</div>
        <div ref="forgotEl" style="height:260px"></div>
      </div>
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">标签 Top 10</div>
        <div ref="tagEl" style="height:260px"></div>
      </div>
    </div>

    <div class="panel">
      <div class="hint" style="margin-bottom:8px">标签词云</div>
      <div ref="wordEl" style="height:300px"></div>
    </div>
  </div>
</template>

<style scoped>
.stat-cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 22px; text-align: center; }
.stat .num { font-size: 24px; font-weight: 700; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.profile-panel { background: linear-gradient(135deg, var(--panel), var(--code-bg)); }
.profile-score { text-align: center; min-width: 120px; }
.ps-num { font-size: 42px; font-weight: 700; color: var(--accent); line-height: 1; }
@media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
</style>