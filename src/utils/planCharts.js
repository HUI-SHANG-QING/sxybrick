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

// ──────────────── 9. 完成时序图（计划时刻 vs 实际完成时刻） ────────────────
//
// 回答「是否按时间顺序完成」：每条任务一行，横轴为一天 0~24 小时；
// 圆点 = 计划时刻（scheduledHour），菱形 = 实际完成时刻（completedAt 的 HH:MM）。
// 两者越贴近 / 顺序一致 → 执行越贴合规划；滞后者一目了然。

export function checkinTimelineOption(tasks = []) {
  const rows = tasks.filter(t => t.scheduledHour != null || t.completedAt);
  if (!rows.length) return emptyOption('暂无排程/打卡数据');
  const cats = rows.map(t => t.title.slice(0, 14));
  const planned = [];
  const actual = [];
  rows.forEach((t, i) => {
    const y = i;
    if (t.scheduledHour != null) {
      planned.push({ value: [t.scheduledHour, y], name: t.title, itemStyle: { color: '#d4a853' } });
    }
    if (t.completedAt) {
      const d = new Date(t.completedAt);
      const h = d.getHours() + d.getMinutes() / 60;
      const late = t.scheduledHour != null && h > t.scheduledHour + 1; // 晚于计划 1h 算滞后
      actual.push({
        value: [h, y],
        name: t.title,
        itemStyle: { color: t.status === 'done' ? (late ? '#e07b3c' : '#7ba87b') : '#e8735a' },
        late,
      });
    }
  });
  return {
    tooltip: {
      formatter: p => {
        const t = rows[p.dataIndex];
        let s = `${t.title}<br/>`;
        if (t.scheduledHour != null) s += `计划：${t.scheduledHour}:00<br/>`;
        if (t.completedAt) s += `完成：${new Date(t.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        else s += '完成：未打卡';
        return s;
      },
    },
    legend: { bottom: 0, data: ['计划时刻', '实际完成'] },
    grid: { left: 130, right: 24, top: 16, bottom: 34 },
    xAxis: { type: 'value', min: 0, max: 24, name: '时刻', nameGap: 18, axisLabel: { formatter: '{value}:00', fontSize: 10 }, splitLine: { lineStyle: { color: '#eee' } } },
    yAxis: { type: 'category', data: cats, inverse: true, axisLabel: { fontSize: 10 }, axisLine: { lineStyle: { color: '#ccc' } } },
    series: [
      { name: '计划时刻', type: 'scatter', symbolSize: 14, data: planned, symbol: 'circle' },
      { name: '实际完成', type: 'scatter', symbolSize: 14, data: actual, symbol: 'diamond' },
    ],
  };
}

// ──────────────── 10. 完成度仪表盘（数字资产利用率） ────────────────

export function gaugeOption(rate = 0, label = '数字资产利用率') {
  const color = rate >= 80 ? '#7ba87b' : rate >= 50 ? '#d4a853' : '#e07b3c';
  return {
    series: [{
      type: 'gauge',
      startAngle: 220, endAngle: -40,
      min: 0, max: 100,
      progress: { show: true, width: 16, itemStyle: { color } },
      axisLine: { lineStyle: { width: 16, color: [[1, '#eee']] } },
      pointer: { width: 4, itemStyle: { color } },
      axisTick: { show: false },
      splitLine: { length: 10, lineStyle: { color: '#ccc' } },
      axisLabel: { distance: 12, color: '#666', fontSize: 10 },
      detail: { valueAnimation: true, formatter: '{value}%', fontSize: 26, color },
      title: { offsetCenter: [0, '70%'], color: '#666', fontSize: 12 },
      data: [{ value: Math.round(rate), name: label }],
    }],
  };
}

// ──────────────── 10. 课程表风格「今日日程表」数据模型 ────────────────
//
// 把任务按 scheduledHour 落到 06:00–23:00 的小时网格里，生成「课程表」格子数据：
//   - 逐小时为一格（背景横线由 CSS 绘制），任务以整格填充形式嵌入对应时间段；
//   - 同一时段多个任务自动分列并排（像课表不同课程），不互相遮挡；
//   - 无时间段 / 超出范围的任务进入 unscheduled。纯函数，可在 Node 单测。

/**
 * @param {Array} tasks 任务数组（含 scheduledHour/estimatedMinutes/quadrant/title/type/status）
 * @param {object} [opts] { startHour=6, endHour=23, rowH=56, defaultDur=60 }
 * @returns {{ startHour, endHour, hours:number[], rowH, laneCount, totalHeight:number, placed:[], unscheduled:[] }}
 */
export function buildScheduleBoard(tasks = [], opts = {}) {
  const startHour = opts.startHour ?? 6;
  const endHour = opts.endHour ?? 23;
  const rowH = opts.rowH ?? 56;
  const defaultDur = opts.defaultDur ?? 60;

  const hours = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  const maxBottom = (endHour - startHour + 1) * rowH;

  // 1) 计算每个任务的矩形区间
  const items = [];
  const unscheduled = [];
  for (const t of (tasks || [])) {
    const sh = t.scheduledHour;
    if (sh == null || sh < startHour || sh > endHour) {
      unscheduled.push(t);
      continue;
    }
    const durMin = t.estimatedMinutes || defaultDur;
    const top = (sh - startHour) * rowH;
    // 高度按分钟折算，但截断到网格底部（如 23:00 开始的 90min 任务只显示到 24:00）
    const height = Math.min(Math.max(34, Math.round((durMin / 60) * rowH)), Math.max(34, maxBottom - top));
    items.push({ task: t, top, height, bottom: top + height });
  }
  // 按开始时间排序，便于贪心分配列
  items.sort((a, b) => a.top - b.top);

  // 2) 贪心分配列（lane）：每个 lane 维护末尾 bottom，重叠则开新列 —— 像课表并排
  const laneEndAt = [];
  for (const it of items) {
    let lane = 0;
    while (lane < laneEndAt.length && laneEndAt[lane] > it.top) lane++;
    if (lane === laneEndAt.length) laneEndAt.push(0);
    laneEndAt[lane] = it.bottom;
    it.lane = lane;
  }
  const laneCount = Math.max(1, laneEndAt.length);

  const placed = items.map(it => ({
    task: it.task,
    top: it.top,
    height: it.height,
    lane: it.lane,
    // 注意：CSS calc 不支持乘法/除法（兼容性差），必须展开成纯百分比 + 加减
    left: `calc(${Math.round((it.lane / laneCount) * 10000) / 100}% + 5px)`,
    width: `calc(${Math.round((1 / laneCount) * 10000) / 100}% - 10px)`,
    color: QUAD_COLOR[it.task.quadrant] || QUAD_COLOR.Q4,
    label: `${fmtHour(it.task.scheduledHour)}–${fmtHour(it.task.scheduledHour + (it.task.estimatedMinutes || defaultDur) / 60)}`,
    // 标题显示行数随块高自适应（防长文字溢出）
    clamp: it.height <= 72 ? 1 : it.height <= 144 ? 2 : 3,
  }));

  return {
    startHour, endHour, hours, rowH, laneCount,
    totalHeight: (endHour - startHour + 1) * rowH,
    placed, unscheduled,
  };
}

/** 小时 → HH:MM；跨午夜（≥24）时标注"次日" */
function fmtHour(h) {
  const next = h >= 24;
  const hh = Math.floor(next ? h - 24 : h);
  const mm = Math.round(((next ? h - 24 : h) - hh) * 60);
  if (mm === 60) return fmtHour(hh + 1);
  return `${next ? '次日' : ''}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ──────────────── 工具：空图占位 ────────────────

export function emptyOption(msg = '暂无数据') {
  return {
    title: { text: msg, left: 'center', top: 'center', textStyle: { color: '#bbb', fontSize: 13, fontWeight: 'normal' } },
  };
}
