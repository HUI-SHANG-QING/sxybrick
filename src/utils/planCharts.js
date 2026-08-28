/**
 * 每日规划多维图表选项构建器（纯函数，返回 ECharts option 对象）
 *
 * 供 DailyPlanView 渲染以下多维图表，避免视图文件臃肿：
 *   1) quadrantOption      — 四象限散点图（艾森豪威尔矩阵）
 *   2) radarOption         — 多维完成率雷达图（规划 vs 实际）
 *   3) heatmapOption       — 84 天完成率热力矩阵（GitHub 风格）
 *   4) trendOption         — 30 天完成率趋势折线图
 *   5) riskOption         — 风险任务条形图（按严重度）
 *   6) scheduleOption     — 日程时间轴（按 scheduledHour 分布）
 *   7) typeBreakdownOption — 任务类型分布饼图
 *   8) compareBarOption    — 规划 vs 实际多维条形图
 *
 * 设计：纯函数 + 颜色常量集中管理，便于主题切换
 */

// ──────────────── 颜色常量 ────────────────

export const STATUS_COLOR = {
  done: '#7ba87b', partial: '#d4a853', skipped: '#c9c4bd', pending: '#e07b3c',
};
export const QUAD_COLOR = { Q1: '#e8735a', Q2: '#d4a853', Q3: '#7ba87b', Q4: '#9a8c7e' };
export const SEVERITY_COLOR = { high: '#e8735a', medium: '#d4a853', low: '#7ba87b' };
export const TYPE_COLOR = {
  review: '#5b8def', pomodoro: '#e07b3c', doc: '#7b5cb8',
  exam: '#e8735a', note: '#2e7d32', write: '#0ea5e9', other: '#9a8c7e',
};

const QUADRANT_LABEL = { Q1: '重要×紧急', Q2: '重要×非紧急', Q3: '非重要×紧急', Q4: '非重要×非紧急' };

// ──────────────── 1. 四象限散点图 ────────────────

export function quadrantOption(tasks = []) {
  const data = tasks.map(t => ({
    value: [t.important ? 1 : 0, t.urgent ? 1 : 0, t.title, t.status, t.quadrant],
    name: t.title,
    itemStyle: { color: STATUS_COLOR[t.status] || STATUS_COLOR.pending },
  }));
  return {
    grid: { left: 50, right: 20, top: 30, bottom: 50 },
    xAxis: {
      min: -0.5, max: 1.5, name: '重要', nameLocation: 'middle', nameGap: 30,
      axisLine: { lineStyle: { color: '#ccc' } }, splitLine: { show: false }, axisLabel: { show: false },
    },
    yAxis: {
      min: -0.5, max: 1.5, name: '紧急', nameLocation: 'middle', nameGap: 30,
      axisLine: { lineStyle: { color: '#ccc' } }, splitLine: { show: false }, axisLabel: { show: false },
    },
    series: [{
      type: 'scatter', symbolSize: 28, data,
      label: { show: false },
      tooltip: {
        formatter: p => {
          const v = p.data.value;
          return `${v[2]}<br/>状态：${statusLabel(v[3])}<br/>${v[4]} ${QUADRANT_LABEL[v[4]] || ''}`;
        },
      },
    }],
    graphic: [
      { type: 'text', left: '25%', top: '10%', style: { text: 'Q2 重要非紧急', fill: QUAD_COLOR.Q2, fontSize: 12 } },
      { type: 'text', left: '75%', top: '10%', style: { text: 'Q1 重要紧急', fill: QUAD_COLOR.Q1, fontSize: 12, align: 'right' } },
      { type: 'text', left: '25%', top: '88%', style: { text: 'Q4 不重要不紧急', fill: QUAD_COLOR.Q4, fontSize: 12 } },
      { type: 'text', left: '75%', top: '88%', style: { text: 'Q3 紧急不重要', fill: QUAD_COLOR.Q3, fontSize: 12, align: 'right' } },
    ],
  };
}

function statusLabel(s) {
  return { done: '已完成', partial: '部分完成', skipped: '已跳过', pending: '待办' }[s] || '待办';
}

// ──────────────── 2. 多维完成率雷达图 ────────────────

/**
 * @param {Array} completion getDailySynergy().completion
 *   每项：{ dim, plan, actual, rate, unit }
 */
export function radarOption(completion = []) {
  if (!completion?.length) return emptyOption();
  const indicators = completion.map(c => ({
    name: c.dim, max: Math.max(c.plan, c.actual, 10) * 1.2,
  }));
  const planValues = completion.map(c => c.plan);
  const actualValues = completion.map(c => c.actual);
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, data: ['规划', '实际'] },
    radar: { indicator: indicators, radius: '62%', splitNumber: 4 },
    series: [{
      type: 'radar',
      data: [
        { value: planValues, name: '规划', areaStyle: { color: 'rgba(212,168,83,.18)' }, lineStyle: { color: '#d4a853' }, itemStyle: { color: '#d4a853' } },
        { value: actualValues, name: '实际', areaStyle: { color: 'rgba(123,168,123,.22)' }, lineStyle: { color: '#7ba87b' }, itemStyle: { color: '#7ba87b' } },
      ],
    }],
  };
}

// ──────────────── 3. 热力矩阵（GitHub 风格） ────────────────

/**
 * @param {Array} heat getCompletionHeatmap() 的结果（按日期升序）
 *   每项：{ date, total, done, rate }
 */
export function heatmapOption(heat = []) {
  if (!heat?.length) return emptyOption();
  // 按周分组：[星期0~6, 第n周, rate, date, total, done]
  const first = new Date(heat[0].date + 'T00:00:00');
  const startWeekday = first.getDay(); // 0=周日
  const cells = heat.map((d, i) => {
    const offset = i + startWeekday;
    const week = Math.floor(offset / 7);
    const dow = offset % 7;
    return [dow, week, d.rate, d.date, d.total, d.done];
  });
  const weekCount = Math.ceil((heat.length + startWeekday) / 7);
  const yLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const xLabels = Array.from({ length: weekCount }, (_, i) => `W${i + 1}`);
  return {
    tooltip: {
      formatter: p => {
        const [dow, week, rate, date, total, done] = p.data;
        return `${date}（周${yLabels[dow]}）<br/>完成率：${rate}%<br/>${done}/${total} 任务`;
      },
    },
    grid: { left: 30, right: 10, top: 10, bottom: 30, containLabel: true },
    xAxis: { type: 'category', data: xLabels, splitArea: { show: false }, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'category', data: yLabels, splitArea: { show: false }, axisLabel: { fontSize: 10 } },
    visualMap: {
      min: 0, max: 100, show: true, orient: 'horizontal', left: 'center', bottom: 0,
      inRange: { color: ['#f0efed', '#cfe8cf', '#7ba87b', '#2e7d32'] },
      text: ['100%', '0%'], textStyle: { fontSize: 10 },
    },
    series: [{
      type: 'heatmap', data: cells,
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,.3)' } },
      itemStyle: { borderColor: '#fff', borderWidth: 1, borderRadius: 2 },
    }],
  };
}

// ──────────────── 4. 完成率趋势折线 ────────────────

export function trendOption(trend = []) {
  if (!trend?.length) return emptyOption();
  return {
    tooltip: { trigger: 'axis', formatter: p => `${p[0].axisValue}<br/>完成率 ${p[0].data}%` },
    grid: { left: 36, right: 16, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: trend.map(t => t.date.slice(5)), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 } },
    series: [{
      type: 'line', smooth: true, data: trend.map(t => t.rate),
      areaStyle: { color: 'rgba(123,168,123,.18)' }, lineStyle: { color: '#7ba87b' }, itemStyle: { color: '#7ba87b' },
      markLine: { silent: true, data: [{ yAxis: 80, lineStyle: { color: '#7ba87b', type: 'dashed' } }] },
    }],
  };
}

// ──────────────── 5. 风险任务条形图 ────────────────

/**
 * @param {Array} risks getDailySynergy().risks
 *   每项：{ task, severity, reason }
 */
export function riskOption(risks = []) {
  if (!risks?.length) return emptyOption();
  const data = risks.slice().reverse().map(r => ({
    value: r.task.estimatedMinutes || 30,
    name: r.task.title.slice(0, 16),
    itemStyle: { color: SEVERITY_COLOR[r.severity] },
  }));
  return {
    tooltip: {
      formatter: p => {
        const r = risks[p.dataIndex];
        return `${r.task.title}<br/>[${r.severity.toUpperCase()}] ${r.reason}<br/>${r.task.quadrant}`;
      },
    },
    grid: { left: 120, right: 24, top: 10, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    yAxis: { type: 'category', data: data.map(d => d.name), axisLabel: { fontSize: 10 } },
    series: [{ type: 'bar', data, barWidth: 14 }],
  };
}

// ──────────────── 6. 日程时间轴（按小时分布） ────────────────

export function scheduleOption(tasks = []) {
  const scheduled = tasks.filter(t => t.scheduledHour != null);
  // 未排程的任务显示在右侧"未排程"区域，由视图处理
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, tasks: [] }));
  for (const t of scheduled) buckets[t.scheduledHour].tasks.push(t);
  const data = buckets.map(b => ({
    value: b.tasks.length,
    hour: b.hour,
    label: b.hour + ':00',
    tasks: b.tasks,
  }));
  return {
    tooltip: {
      formatter: p => {
        const b = buckets[p.dataIndex];
        if (!b.tasks.length) return `${b.hour}:00<br/>无任务`;
        return `${b.hour}:00<br/>${b.tasks.map(t => `·${t.title.slice(0, 20)}`).join('<br/>')}`;
      },
    },
    grid: { left: 36, right: 16, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: data.map(d => d.label), axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    series: [{
      type: 'bar', data, barWidth: '60%',
      itemStyle: {
        color: p => {
          const t = buckets[p.dataIndex]?.tasks?.[0];
          return t ? (QUAD_COLOR[t.quadrant] || '#9a8c7e') : '#eee';
        },
      },
    }],
  };
}

// ──────────────── 7. 任务类型分布饼图 ────────────────

export function typeBreakdownOption(tasks = []) {
  const byType = {};
  for (const t of tasks) byType[t.type] = (byType[t.type] || 0) + 1;
  const TYPE_LABEL = { review: '复习', pomodoro: '番茄', doc: '资料', exam: '做题', note: '笔记', write: '写作', other: '其他' };
  const data = Object.entries(byType).map(([type, value]) => ({
    value, name: TYPE_LABEL[type] || type, itemStyle: { color: TYPE_COLOR[type] || '#9a8c7e' },
  }));
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie', radius: ['38%', '62%'],
      label: { formatter: '{b}\n{d}%', fontSize: 10 },
      data,
    }],
  };
}

// ──────────────── 8. 多维完成对比条形图 ────────────────

/**
 * @param {Array} completion getDailySynergy().completion
 */
export function compareBarOption(completion = []) {
  if (!completion?.length) return emptyOption();
  const labels = completion.map(c => `${c.icon} ${c.dim}`);
  const plan = completion.map(c => c.plan);
  const actual = completion.map(c => c.actual);
  return {
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: ps => {
        const i = ps[0].dataIndex;
        const c = completion[i];
        return `${c.icon} ${c.dim}<br/>规划 ${c.plan} ${c.unit}<br/>实际 ${c.actual} ${c.unit}<br/>达成率 ${c.rate}%`;
      },
    },
    legend: { data: ['规划', '实际'], bottom: 0 },
    grid: { left: 44, right: 16, top: 16, bottom: 32 },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    series: [
      { name: '规划', type: 'bar', data: plan, itemStyle: { color: '#d4a853' }, barGap: '20%' },
      { name: '实际', type: 'bar', data: actual, itemStyle: { color: '#7ba87b' } },
    ],
  };
}

// ──────────────── 工具：空图占位 ────────────────

export function emptyOption(msg = '暂无数据') {
  return {
    title: { text: msg, left: 'center', top: 'center', textStyle: { color: '#bbb', fontSize: 13, fontWeight: 'normal' } },
  };
}
