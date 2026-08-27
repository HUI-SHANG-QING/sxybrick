<script setup>
// 数据可视化：复习热力图 + 各科掌握度雷达图 + 14 天趋势 + 统计指标（本地）
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import 'echarts-wordcloud';
import { toast } from '../utils/toast.js';
import { getStats } from '../repo.js';
import { getLearningProfile, getSubjectDiagnosis, getCalibration, getDueForecast } from '../agent/analytics.js';
import { getDailyCounts } from '../utils/streak.js';
import { degraded } from '../utils/perf.js';
import { goldenHours } from '../algorithms/golden-hours.js';

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
const calibEl = ref(null);     // 校准回测曲线
const calibration = ref(null); // { n, brier, ece, bias, verdict, note, buckets }
const forecastEl = ref(null);  // 到期洪峰预测
const forecast = ref(null);    // { byDay:[{date,count}], totalDue, backlog, peak, avgPerDay }
let charts = [];

// —— 2026-08-26 速赢区：趋势图可切换 7/14/30 天 + 本周 vs 上周对比 ——
const trendRange = ref(Number(localStorage.getItem('sxy_stats_range')) || 14);
const weekDelta = ref(null); // { thisWeek, lastWeek, diff, percent }
const trendData = ref([]);  // 当前 range 的每日数据

// 黄金时段：从 24h 复习分布推导「最集中的连续时段」建议
const goldenHint = computed(() => (stats.value ? goldenHours(stats.value.hourly).label : ''));

// 图表主题：直接读取 CSS 变量（随 data-theme × data-style 任意组合换肤，含三大新主题与未来的个人主题）
function getChartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    text: v('--ink-2', '#475569'),
    border: v('--panel', '#ffffff'),
    empty: v('--code-inline', '#eef2f6'),
    grid: v('--line', '#e3e8ee'),
    axis: v('--ink-2', '#475569'),
    bar: v('--accent', '#1d4ed8'),
    blue: v('--blue', '#2563eb'),
    green: v('--green', '#16a34a'),
    red: v('--red', '#dc2626'),
    amber: v('--amber', '#d97706'),
    tagInk: v('--tag-ink', '#4338ca'),
  };
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
    const data = trendData.value.length ? trendData.value : stats.value.trend;
    const xData = data.map(t => typeof t.date === 'number' ? fmtDate(t.date) : t.date);
    trend.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: xData, axisLabel: { color: theme.axis }, axisLine: { lineStyle: { color: theme.grid } } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [{ type: 'bar', data: data.map(t => t.count), itemStyle: { color: theme.bar, borderRadius: [4, 4, 0, 0] } }],
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
        { value: d[0], itemStyle: { color: theme.red } },
        { value: d[1], itemStyle: { color: theme.amber } },
        { value: d[2], itemStyle: { color: theme.green } },
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
      series: [{ type: 'line', data: stats.value.forgotTrend.map(t => t.rate), smooth: true, itemStyle: { color: theme.red }, areaStyle: { opacity: .1 } }],
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

  // 校准回测曲线：x=预测记忆概率，y=实际正确率；对角线=完美校准，点大小=样本量
  if (calibEl.value && calibration.value && calibration.value.buckets.length) {
    const calib = echarts.init(calibEl.value);
    const maxN = Math.max(...calibration.value.buckets.map(b => b.n), 1);
    calib.setOption({
      tooltip: {
        formatter: p => {
          const b = calibration.value.buckets[p.dataIndex];
          return b
            ? `预测 ${(b.predMean * 100).toFixed(0)}% · 实际 ${(b.actualRate * 100).toFixed(0)}%<br/>样本 ${b.n} 次${b.simulatedShare != null ? ` · 模拟补估 ${(b.simulatedShare * 100).toFixed(0)}%` : ''}`
            : `${p.data[0]}% / ${p.data[1]}%`;
        },
      },
      grid: { left: 44, right: 16, top: 24, bottom: 34 },
      xAxis: { type: 'value', min: 0, max: 100, name: '预测记忆 %', nameTextStyle: { color: theme.axis }, axisLabel: { color: theme.axis }, axisLine: { lineStyle: { color: theme.grid } } },
      yAxis: { type: 'value', min: 0, max: 100, name: '实际正确 %', nameTextStyle: { color: theme.axis }, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [
        {
          type: 'scatter',
          data: calibration.value.buckets.map(b => ({ value: [Number((b.predMean * 100).toFixed(1)), Number((b.actualRate * 100).toFixed(1))], n: b.n })),
          symbolSize: (val, params) => 8 + 22 * ((params?.data?.n) || 0) / maxN,
          itemStyle: { color: theme.blue, opacity: 0.85 },
          name: '实测',
        },
        {
          type: 'line', data: [[0, 0], [100, 100]], symbol: 'none',
          lineStyle: { color: theme.red, type: 'dashed', width: 1.5 }, name: '完美校准',
        },
      ],
    });
    charts.push(calib);
  }

  // 到期洪峰预测：未来 30 天每日到期卡量柱状图（峰值标红、今日标蓝）
  if (forecastEl.value && forecast.value) {
    const fc = forecast.value;
    const fchart = echarts.init(forecastEl.value);
    const todayIdx = 0;
    fchart.setOption({
      tooltip: { trigger: 'axis', formatter: p => `${p[0].name}：预计到期 ${p[0].value} 张` },
      grid: { left: 36, right: 12, top: 24, bottom: 40 },
      xAxis: {
        type: 'category', data: fc.byDay.map(b => b.date.slice(5)),
        axisLabel: { color: theme.axis, interval: 4 }, axisLine: { lineStyle: { color: theme.grid } },
      },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [{
        type: 'bar',
        data: fc.byDay.map((b, i) => ({
          value: b.count,
          itemStyle: {
            color: i === todayIdx ? theme.blue : (b.count === fc.peak.count && b.count > 0 ? theme.red : theme.bar),
            borderRadius: [4, 4, 0, 0],
          },
        })),
      }],
    });
    charts.push(fchart);
  }
}

async function load() {
  try {
    const [s, p, diag, calib, fc] = await Promise.all([getStats(), getLearningProfile(), getSubjectDiagnosis(), getCalibration(), getDueForecast(30)]);
    stats.value = s; profile.value = p; diagnosis.value = diag; calibration.value = calib; forecast.value = fc;
    // 速赢区：加载趋势数据 + 计算本周 vs 上周对比
    await loadTrendByRange(trendRange.value);
    await computeWeekDelta();
    if (degraded.value) setTimeout(buildCharts, 300);
    else buildCharts();
  } catch (e) { toast(e.message, 'error'); }
}
const diagnosis = ref([]); // D1 单科诊断

// 速赢区：根据 range 重新加载趋势数据并重绘趋势图
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
async function loadTrendByRange(range) {
  trendData.value = await getDailyCounts(range);
  // 仅重绘趋势图，避免重建所有图表
  const trend = charts.find(c => c.getDom() === trendEl.value);
  if (trend) {
    const theme = getChartTheme();
    trend.setOption({
      xAxis: { data: trendData.value.map(t => fmtDate(t.date)) },
      series: [{ data: trendData.value.map(t => t.count) }],
    });
  }
}
// 本周 vs 上周对比：取近 14 天每日复习量，前 7 = 上周，后 7 = 本周
async function computeWeekDelta() {
  const daily = await getDailyCounts(14);
  const lastWeek = daily.slice(0, 7).reduce((s, d) => s + d.count, 0);
  const thisWeek = daily.slice(7, 14).reduce((s, d) => s + d.count, 0);
  const diff = thisWeek - lastWeek;
  const percent = lastWeek === 0 ? (thisWeek > 0 ? 100 : 0) : Math.round(diff / lastWeek * 100);
  weekDelta.value = { thisWeek, lastWeek, diff, percent };
}
watch(trendRange, (r) => { localStorage.setItem('sxy_stats_range', String(r)); loadTrendByRange(r); });

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
      <div class="stat"><div class="num">{{ stats?.todayReviews ?? '-' }}</div><div class="hint">今日复习（张）</div></div>
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

    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div class="hint">校准回测 · 预测记忆概率 vs 实际正确率</div>
        <div v-if="calibration && calibration.n" class="hint" style="font-size:12px">
          样本 {{ calibration.n }} · Brier {{ calibration.brier }} · ECE {{ calibration.ece }} ·
          偏差 {{ (calibration.bias > 0 ? '+' : '') + calibration.bias }}
        </div>
      </div>
      <div v-if="calibration && calibration.n" ref="calibEl" style="height:280px"></div>
      <div v-else class="hint" style="text-align:center;padding:24px 0">
        {{ calibration?.note || '暂无校准数据' }}
      </div>
      <div v-if="calibration && calibration.n" class="hint" style="margin-top:6px">
        {{ calibration.verdict }} —— {{ calibration.note }}
      </div>
    </div>

    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div class="hint">到期洪峰预测 · 未来 30 天（按当前复习节奏模拟）</div>
        <div v-if="forecast" class="hint" style="font-size:12px">
          逾期待补 {{ forecast.backlog }} · 30 天累计 {{ forecast.totalDue }} ·
          日均 {{ forecast.avgPerDay }} · 峰值 {{ forecast.peak.date.slice(5) }}（{{ forecast.peak.count }} 张）
        </div>
      </div>
      <div v-if="forecast && forecast.totalDue" ref="forecastEl" style="height:260px"></div>
      <div v-else class="hint" style="text-align:center;padding:24px 0">暂无到期卡片</div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="hint" style="margin-bottom:8px">各科掌握度雷达图（近 90 天自评）</div>
        <div ref="radarEl" style="height:300px"></div>
        <div v-if="stats && !stats.mastery.length" class="hint" style="text-align:center">暂无复习记录</div>
      </div>
      <div class="panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <div class="hint">复习趋势</div>
          <div class="range-switch">
            <button v-for="r in [7, 14, 30]" :key="r" class="chip" :class="{ on: trendRange === r }" @click="trendRange = r">{{ r }} 天</button>
          </div>
        </div>
        <div v-if="weekDelta" class="week-delta">
          <div class="wd-cell">
            <div class="wd-num">{{ weekDelta.thisWeek }}</div>
            <div class="hint">本周复习</div>
          </div>
          <div class="wd-arrow" :class="{ up: weekDelta.diff > 0, down: weekDelta.diff < 0 }">
            <span v-if="weekDelta.diff > 0">↑</span>
            <span v-else-if="weekDelta.diff < 0">↓</span>
            <span v-else>＝</span>
            <span class="wd-pct">{{ weekDelta.percent }}%</span>
          </div>
          <div class="wd-cell">
            <div class="wd-num">{{ weekDelta.lastWeek }}</div>
            <div class="hint">上周复习</div>
          </div>
        </div>
        <div ref="trendEl" style="height:260px;margin-top:8px"></div>
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
        <div v-if="goldenHint" class="hint" style="margin-top:8px;color:var(--amber)">⏰ {{ goldenHint }}</div>
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

    <!-- D1 单科诊断：每科体检 + 处方 -->
    <div class="panel">
      <div class="hint" style="margin-bottom:10px;font-weight:600">单科诊断（掌握度 · 待背 · 错题 · 易混 → 处置建议）</div>
      <div v-if="!diagnosis.length" class="hint">暂无卡片数据。</div>
      <div v-for="d in diagnosis" :key="d.subject" class="diag-row">
        <span class="diag-subj">{{ d.subject }}</span>
        <span class="hint">卡片 {{ d.cards }} · 待背 {{ d.due }} · 错题 {{ d.marked }} · 易混 {{ d.pairN }} 组 · 掌握度 {{ d.mastery }}%</span>
        <span style="flex:1"></span>
        <span class="diag-advice">{{ d.advice }}</span>
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
.profile-panel { background: linear-gradient(135deg, var(--panel), var(--code-bg)); }
.profile-score { text-align: center; min-width: 120px; }
.ps-num { font-size: 42px; font-weight: 700; color: var(--accent); line-height: 1; }
@media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
.diag-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.diag-row:last-child { border-bottom: none; }
.diag-subj { font-weight: 700; min-width: 110px; }
.diag-advice { color: var(--amber); font-size: 13px; max-width: 420px; }

/* —— 速赢区：周对比卡 + 范围切换器 —— */
.range-switch { display: flex; gap: 4px; }
.range-switch .chip { padding: 3px 10px; font-size: 12px; }
.week-delta {
  display: flex; align-items: center; justify-content: space-around;
  background: var(--code-bg);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-top: 4px;
}
.wd-cell { text-align: center; min-width: 80px; }
.wd-num { font-size: 24px; font-weight: 700; color: var(--ink); line-height: 1.1; }
.wd-arrow {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  font-size: 18px; font-weight: 600; color: var(--ink-2);
}
.wd-arrow.up { color: var(--green); }
.wd-arrow.down { color: var(--red); }
.wd-pct { font-size: 12px; font-weight: 600; }
</style>