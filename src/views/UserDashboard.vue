<script setup>
// P2·10 用户仪表盘（恐怖级操作监控可视化）
// 12 张图：活跃日热力(GitHub式 ECharts heatmap) + 24h时段曲线 + 模块占比饼 + 类型柱状
//         + 近期动作散点(2D交互) + 周极坐标雷达 + 168h热力(7*24) + 背诵评分分布
//         + 卡片CRUD堆叠区 + 同步/导出事件柱 + AI 调用词云 + 混合趋势图(模块×日)
// 最佳/最坏拍档 16 组合：A/B/C/D × 近7d/长90d × 最佳/最坏（默认 D-近7d-最佳）
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import 'echarts-wordcloud';
import {
  queryUserOps, bestWorstPartners, recordUserOp,
} from '../repo.js';
import { flushTelemetry, isAEnabled, isBEnabled } from '../utils/telemetry.js';
import { toast } from '../utils/toast.js';
import { t, locale } from '../i18n/index.js';
import { fmtLocaleDate, fmtLocaleDateTime, fmtLocaleNumber, weekdayNames, monthNames } from '../utils/locale-date.js';

// 字典前缀（视图内大量 t() 调用，抽出来避免写错模块名）
const T = (k, params) => t('views.userDashboard.' + k, undefined, params);

// 星期/月份名跟随界面语言；locale.value 被读取 ⇒ 切语言后自动重算并触发图表重渲染。
//
// ⚠️ 本页两种星期顺序并存，改任何一个都会让图表标签与数据错位：
//   WEEK_SUN（周日…周六）—— 365 天热力：格子起点被对齐到周日，y 轴下标 0 就是周日。
//   WEEK_MON（周一…周日）—— 雷达 / 168h 热力：代码用 (getDay()+6)%7 把周一算成 0。
const WEEK_SUN = computed(() => weekdayNames('short'));
const WEEK_MON = computed(() => { const w = WEEK_SUN.value; return [...w.slice(1), w[0]]; });
const MONTH_NAMES = computed(() => monthNames('short'));
// 365 热力 y 轴很窄：中文用 narrow（日/一/二）省空间；但英文 narrow 是 S,M,T,W,T,F,S
// （S 和 T 各出现两次，有歧义），所以英文回退 short。
const WEEK_SUN_AXIS = computed(() => (locale.value === 'en' ? WEEK_SUN.value : weekdayNames('narrow')));

const router = useRouter();
const rangeDays = ref(30);    // 全局范围 7 | 14 | 30 | 90 | 365
const busy = ref(false);
// 状态改为结构化字段，不再拼一整条中文串 —— 旧实现靠 status.split(' · ') 拆段渲染，
// 一旦文案里出现 ' · '（英文用逗号）就会错位，且无法本地化。
const stat = ref(null);       // { days, ops, modules, types, active365, total365 }
const today = new Date();
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 最佳/最坏拍档 16 组合选择
const partnerKind = ref('D');          // A 科目 | B Agent | C 知识对 | D 资产
const partnerRange = ref(7);           // 7 近期 / 90 长期
const partnerWorst = ref(false);       // false 最佳 / true 最坏
const partnerData = ref({ notEnough: true, title: '', desc: '', items: [] });
const partnerBusy = ref(false);
async function loadPartner() {
  partnerBusy.value = true;
  try {
    await flushTelemetry();
    partnerData.value = await bestWorstPartners({
      rangeDays: partnerRange.value, kind: partnerKind.value, worst: partnerWorst.value,
    });
  } catch (e) { toast(T('partner.loadFail', { msg: e.message }), 'error'); }
  finally { partnerBusy.value = false; }
}

// 拍档结论：repo 只回 code + params，文案在这里按当前语言组装
const partner = computed(() => {
  const i = partnerData.value?.i18n;
  if (!i) return { title: '—', desc: '', suggest: '' };
  const p = { ...i.params };
  // 日期类参数在视图层格式化（跟随界面语言，而非操作系统语言）
  if (p.createdAt != null) p.createdAt = fmtLocaleDate(p.createdAt);
  const base = 'views.userDashboard.partner.' + i.code + '.';
  return {
    title: t(base + 'title', undefined, p),
    desc: t(base + 'desc', undefined, p),
    suggest: t(base + 'suggest', undefined, p) || '',
  };
});
function onPartnerItemClick(item) {
  if (item.cardId) router.push(`/cards?id=${encodeURIComponent(item.cardId)}`);
}

// 12 图表容器 ref 与 chart 对象
// 注意：Vue 模板 ref 只认顶层绑定名，不能用 "obj.x.el" 这种点路径，否则 el.value 永远为 null → 图表空白。
// 因此为每个图表声明独立的顶层 ref，再挂到 chartHolders 注册表。
const heatmapEl = ref(null);
const hourLineEl = ref(null);
const modulePieEl = ref(null);
const typeBarEl = ref(null);
const actionDotEl = ref(null);
const weekRadarEl = ref(null);
const weekHeat168El = ref(null);
const rateDistEl = ref(null);
const cardCrudEl = ref(null);
const syncExportEl = ref(null);
const aiCloudEl = ref(null);
const mixTrendEl = ref(null);
const chartHolders = {
  heatmap:    { el: heatmapEl, c: null },
  hourLine:   { el: hourLineEl, c: null },
  modulePie:  { el: modulePieEl, c: null },
  typeBar:    { el: typeBarEl, c: null },
  actionDot:  { el: actionDotEl, c: null },
  weekRadar:  { el: weekRadarEl, c: null },
  weekHeat168:{ el: weekHeat168El, c: null },
  rateDist:   { el: rateDistEl, c: null },
  cardCrud:   { el: cardCrudEl, c: null },
  syncExport: { el: syncExportEl, c: null },
  aiCloud:    { el: aiCloudEl, c: null },
  mixTrend:   { el: mixTrendEl, c: null },
};
const heatmapCells = ref([]); // GitHub 式 365 天格子（CSS 绘制，ECharts 可选冗余）

async function loadAll() {
  busy.value = true;
  try {
    await flushTelemetry();
    const to = Date.now();
    const from = to - rangeDays.value * 24 * 3600 * 1000;
    const from365 = to - 365 * 24 * 3600 * 1000;
    const [
      byDay, byHour, byModule, byType, byDayHour, rawAll,
      byDay365, rawMix,
    ] = await Promise.all([
      queryUserOps({ from, to, groupBy: 'day' }),
      queryUserOps({ from, to, groupBy: 'hour' }),
      queryUserOps({ from, to, groupBy: 'module' }),
      queryUserOps({ from, to, groupBy: 'type' }),
      queryUserOps({ from, to, groupBy: 'dayHour' }),
      queryUserOps({ from, to, groupBy: null }),
      queryUserOps({ from: from365, to, groupBy: 'day' }),
      // mixTrend：分 module × 日
      (async () => {
        const rows = await queryUserOps({ from, to, groupBy: null });
        const map = new Map(); // `${date}::${module}` -> count
        for (const o of rows) {
          const d = new Date(o.t);
          const key = `${iso(d)}::${o.module || T('misc')}`;
          map.set(key, (map.get(key) || 0) + 1);
        }
        const modules = new Set();
        for (const k of map.keys()) modules.add(k.split('::')[1]);
        const mlist = [...modules];
        // 按日期序列（rangeDays 天补齐 + 每个 module 一列）
        const dates = [];
        const cur = new Date(from); cur.setHours(0, 0, 0, 0);
        const today0 = new Date(today); today0.setHours(0, 0, 0, 0);
        while (cur <= today0) { dates.push(iso(cur)); cur.setDate(cur.getDate() + 1); }
        const series = mlist.map(m => ({
          name: m,
          type: 'line',
          stack: null,
          smooth: true,
          symbol: 'none',
          emphasis: { focus: 'series' },
          data: dates.map(d => map.get(`${d}::${m}`) || 0),
        }));
        return { dates, series };
      })(),
    ]);

    const totalCount = rawAll.length;

    // 补全日序列（如果某天没数据也显示 0）
    const dateMap = new Map(byDay.map(x => [x.date, x.count]));
    const cur = new Date(from); cur.setHours(0, 0, 0, 0);
    const today0 = new Date(today); today0.setHours(0, 0, 0, 0);
    const datesFull = [];
    while (cur <= today0) { const k = iso(cur); datesFull.push({ date: k, count: dateMap.get(k) || 0 }); cur.setDate(cur.getDate() + 1); }

    // GitHub 365 热力（CSS 格子 + ECharts heatmap 两种都提供，前者移动端更丝滑）
    const d365 = new Map(byDay365.map(x => [x.date, x.count]));
    const start365 = new Date(today); start365.setHours(0, 0, 0, 0); start365.setDate(start365.getDate() - 364);
    const st = start365.getDay();
    start365.setDate(start365.getDate() - st);
    const ccc = [];
    const cc = new Date(start365);
    while (cc <= today0) { const k = iso(cc); ccc.push({ date: k, count: d365.get(k) || 0, future: cc > today0 }); cc.setDate(cc.getDate() + 1); }
    heatmapCells.value = ccc;
    const total365 = ccc.reduce((s, x) => s + x.count, 0);
    const activeDays365 = ccc.filter(x => x.count > 0).length;
    stat.value = {
      days: rangeDays.value,
      ops: totalCount,
      modules: byModule.length,
      types: byType.length,
      active365: activeDays365,
      total365,
    };

    await nextTick();

    // —— 图 1：ECharts 一年热力图（x=周, y=周几）
    renderChart('heatmap', {
      // 旧实现显示的是「星期名 + 周序号」（如"周三 12"），看不出是哪一天；
      // buildHeatSeries 的第 4 位才是真实日期，这里改用它。
      tooltip: {
        position: 'top',
        formatter: p => (Array.isArray(p) && p[0]) ? T('tipHeat', { date: p[0].data[3] || '', n: p[0].data[2] }) : '',
      },
      grid: { left: 70, right: 10, top: 40, bottom: 40 },
      // 关键修复：series 的格子坐标 x 是「列号字符串 '0'..'52'」（buildHeatSeries），
      // category 轴 data 必须与之一一对应，否则 ECharts 匹配不上 → 格子全不渲染
      // （此前 data 直接放 buildHeatXLabels 的月份名，与列号永远对不上 = 只有坐标轴空白）。
      // 故 data 用列号字符串数组，月份标签改由 axisLabel.formatter 按列索引查 buildHeatXLabels。
      xAxis: { type: 'category', data: Array.from({ length: Math.ceil(ccc.length / 7) }, (_, i) => String(i)), splitArea: { show: false }, axisLabel: { color: '#888', fontSize: 10, formatter: (v, i) => buildHeatXLabels(ccc)[i] || '' } },
      yAxis: { type: 'category', data: WEEK_SUN_AXIS.value, axisLabel: { color: '#888', fontSize: 10 }, splitArea: { show: false } },
      visualMap: { min: 0, max: 20, calculable: false, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: ['#ebedf0','#c6f0d0','#5cd66a','#2cbe4e','#006d32'] }, textStyle: { color: '#888' } },
      series: [{ type: 'heatmap', data: buildHeatSeries(ccc), label: { show: false } }],
      title: { text: T('chart.heatmap'), left: 'center', top: 4, textStyle: { fontSize: 13, color: 'var(--ink)', fontWeight: 600 } },
    });

    // —— 图 2：24h 时段曲线（可交互 tooltip，叠加 3 日对比：全范围平均 / 近 7d / 近 1d）
    const hourAll = new Map(byHour.map(x => [x.hour, x.count]));
    const byHour7 = await queryUserOps({ from: to - 7 * 86400000, to, groupBy: 'hour' });
    const byHour1 = await queryUserOps({ from: to - 1 * 86400000, to, groupBy: 'hour' });
    const h7 = new Map(byHour7.map(x => [x.hour, x.count]));
    const h1 = new Map(byHour1.map(x => [x.hour, x.count]));
    const hours = Array.from({ length: 24 }, (_, i) => `${pad(i)}:00`);
    const factorAll = rangeDays.value || 1;
    renderChart('hourLine', {
      grid: { left: 36, right: 12, top: 36, bottom: 22 },
      title: { text: T('chart.hour'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { bottom: 0, textStyle: { color: 'var(--ink-2)', fontSize: 10 } },
      xAxis: { type: 'category', boundaryGap: false, data: hours, axisLabel: { color: '#888', fontSize: 10, interval: 2 } },
      yAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
      series: [
        { name: T('legend.avgRange', { n: rangeDays.value }), type: 'line', smooth: true, areaStyle: {}, data: hours.map((_, i) => Math.round((hourAll.get(i) || 0) / factorAll * 10) / 10), itemStyle: { color: '#4a9eff' } },
        { name: T('legend.avg7'), type: 'line', smooth: true, data: hours.map((_, i) => Math.round((h7.get(i) || 0) / 7 * 10) / 10), itemStyle: { color: '#22c55e' } },
        { name: T('legend.last24'), type: 'line', smooth: true, data: hours.map((_, i) => h1.get(i) || 0), itemStyle: { color: '#f59e0b' }, lineStyle: { type: 'dashed' } },
      ],
    });

    // —— 图 3：模块使用占比（饼 + 玫瑰中心文字）
    const pieTop = byModule.slice(0, 10).map(x => ({ name: x.key, value: x.count }));
    renderChart('modulePie', {
      title: { text: T('chart.modulePie'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      tooltip: { trigger: 'item', formatter: T('tipPie') },
      legend: { orient: 'vertical', right: 6, top: 30, textStyle: { color: 'var(--ink-2)', fontSize: 10 }, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['38%', '68%'], center: ['38%', '58%'], roseType: 'radius',
        label: { show: true, formatter: '{b}\n{d}%', fontSize: 10 },
        itemStyle: { borderRadius: 4 },
        data: pieTop,
      }],
    });

    // —— 图 4：操作类型 Top15 柱状
    const typeTop = byType.slice(0, 15);
    renderChart('typeBar', {
      title: { text: T('chart.typeBar'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      grid: { left: 120, right: 16, top: 36, bottom: 10 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
      yAxis: { type: 'category', data: typeTop.map(x => x.key).reverse(), axisLabel: { color: '#888', fontSize: 10 } },
      series: [{
        type: 'bar', data: typeTop.map(x => x.count).reverse(),
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
          { offset: 0, color: '#60a5fa' }, { offset: 1, color: '#818cf8' }]), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: 'var(--ink-2)', fontSize: 10 },
      }],
    });

    // —— 图 5：近期动作散点（2D：x = 时间，y = module 序，点大 = 类别量，color = type 簇）
    const moduleIdx = new Map(byModule.map((x, i) => [x.key, i]));
    const cluster = [
      ['review_rate','review_flip','review_skip','page_view','open_app'],
      ['card_new','card_edit','card_delete','card_mark_wrong'],
      ['ai_call','agent_tool_call'],
      ['export','sync','pomodoro_end','exam_end','feynman_round','health_scan','graph_save','mindmap_save','privacy_record'],
      ['dom_click_btn','dom_click_chip','dom_click_card','dom_click_asset','dom_click_weak','dom_click_shortcut','dom_click_pill','dom_change_select','dom_change_check','dom_click_custom'],
    ];
    const clusterColor = ['#ef4444','#3b82f6','#8b5cf6','#16a34a','#f59e0b'];
    function colorOf(type) {
      for (let i = 0; i < cluster.length; i++) if (cluster[i].includes(type)) return clusterColor[i];
      return '#94a3b8';
    }
    // 为了不爆渲染，散点最多 1500 条：按时间均匀采样
    const dotRaw = rawAll.slice().sort((a, b) => a.t - b.t);
    const MAX_DOT = 1500;
    const step = Math.max(1, Math.floor(dotRaw.length / MAX_DOT));
    const dotSample = [];
    for (let i = 0; i < dotRaw.length; i += step) dotSample.push(dotRaw[i]);
    const clusterLegend = [
      T('legend.study'), T('legend.card'), T('legend.ai'), T('legend.business'), T('legend.dom'),
    ];
    renderChart('actionDot', {
      title: { text: T('chart.actionDot', { shown: dotSample.length, total: dotRaw.length }), left: 'center', top: 4, textStyle: { fontSize: 12, fontWeight: 600, color: 'var(--ink)' } },
      grid: { left: 90, right: 16, top: 38, bottom: 54 },
      legend: { bottom: 4, textStyle: { color: 'var(--ink-2)', fontSize: 10 }, data: clusterLegend },
      tooltip: {
        formatter(p) {
          const o = p.data?.[3]; if (!o) return '';
          // 时间走 fmtLocaleDateTime 而非 toLocaleString：后者跟随操作系统语言，
          // 用户在 App 里选了英文、系统是中文时仍会显示中文习惯的日期。
          const head = T('tipDot', {
            time: fmtLocaleDateTime(o.t), module: o.module || T('misc'), type: o.type || '',
          });
          return o.category ? head + T('tipDotCategory', { category: String(o.category).slice(0, 30) }) : head;
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#888', fontSize: 10 },
        splitLine: { lineStyle: { color: 'var(--line)' } },
      },
      yAxis: {
        type: 'category',
        data: [...moduleIdx.keys()],
        axisLabel: { color: '#888', fontSize: 10 },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, bottom: 10, height: 18 },
      ],
      series: clusterLegend.map((name, ci) => ({
        name, type: 'scatter',
        symbolSize: (val, param) => { const o = param.data[3]; return 5 + Math.min(10, (o?.payload ? 3 : 0)); },
        data: dotSample.filter(o => clusterColor[ci] === colorOf(o.type)).map(o => [o.t, o.module || T('misc'), 0, o]),
        itemStyle: { color: clusterColor[ci], opacity: 0.72 },
      })),
    });

    // —— 图 6：周极坐标雷达（周一~周日 × 不同 module 使用强度）
    // 周一…周日：与下面 (getDay()+6)%7（周一=0）的算法配套，顺序不能改成周日起
    const dayOrder = WEEK_MON.value;
    const modRadar = byModule.slice(0, 6).map(x => x.key);
    // 重新 rawAll，把日期转为 idx 映射
    const radarData = modRadar.map(m => {
      const v = new Array(7).fill(0);
      for (const o of rawAll) {
        if ((o.module || T('misc')) !== m) continue;
        const wd = (new Date(o.t).getDay() + 6) % 7;
        v[wd]++;
      }
      return { name: m, value: v };
    });
    const radMax = Math.max(1, ...radarData.flatMap(x => x.value));
    renderChart('weekRadar', {
      title: { text: T('chart.weekRadar'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      legend: { bottom: 0, textStyle: { color: 'var(--ink-2)', fontSize: 10 }, type: 'scroll' },
      tooltip: {},
      radar: {
        indicator: dayOrder.map(d => ({ name: d, max: radMax })),
        center: ['50%', '55%'],
        radius: '62%',
        axisName: { color: 'var(--ink-2)', fontSize: 11 },
      },
      series: [{ type: 'radar', emphasis: { lineStyle: { width: 3 } }, data: radarData.map(r => ({ name: r.name, value: r.value, areaStyle: { opacity: 0.18 } })) }],
    });

    // —— 图 7：168h 热力（7 天 × 24 小时）
    const wh = new Map();
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) wh.set(`${d}-${h}`, 0);
    // 以周一为 0 的逻辑：(getDay() + 6) % 7
    // byDayHour: key = YYYY-MM-DD-HH, value = count
    for (const [k, v] of byDayHour.entries()) {
      const [yyyy, mm, dd, hh] = k.split('-');
      const d = (new Date(Number(yyyy), Number(mm) - 1, Number(dd)).getDay() + 6) % 7;
      wh.set(`${d}-${Number(hh)}`, (wh.get(`${d}-${Number(hh)}`) || 0) + v);
    }
    const series7 = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) series7.push([`${pad(h)}:00`, dayOrder[d], wh.get(`${d}-${h}`) || 0]);
    renderChart('weekHeat168', {
      title: { text: T('chart.week168'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      tooltip: { formatter: p => T('tipHeat168', { day: p.data[1], hour: p.data[0], n: p.data[2] }) },
      grid: { left: 56, right: 16, top: 38, bottom: 40 },
      xAxis: { type: 'category', data: Array.from({length:24},(_,i)=>`${pad(i)}:00`), splitArea: { show: true }, axisLabel: { color: '#888', fontSize: 9, interval: 1 } },
      yAxis: { type: 'category', data: dayOrder, splitArea: { show: true }, axisLabel: { color: '#888', fontSize: 11 } },
      visualMap: { min: 0, max: 8, calculable: false, orient: 'horizontal', left: 'center', bottom: 4, inRange: { color: ['#f1f5f9','#bae6fd','#0ea5e9','#1e3a8a'] }, textStyle: { color: '#888', fontSize: 10 } },
      series: [{ type: 'heatmap', data: series7, label: { show: false }, itemStyle: { borderWidth: 1, borderColor: '#fff' } }],
    });

    // —— 图 8：背诵评分分布（没记住/模糊/记住了）
    const rates = { 0: 0, 1: 0, 2: 0 };
    for (const o of rawAll) if (o.type === 'review_rate') { const k = Number(o.category)||0; rates[Math.max(0, Math.min(2, k))]++; }
    renderChart('rateDist', {
      title: { text: T('chart.rateDist'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      grid: { left: 40, right: 10, top: 36, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: [T('legend.rateForgot'), T('legend.rateVague'), T('legend.rateKnown')], axisLabel: { color: 'var(--ink-2)', fontSize: 12 } },
      yAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
      series: [{
        type: 'bar',
        data: [
          { value: rates[0], itemStyle: { color: '#ef4444', borderRadius: [8, 8, 0, 0] } },
          { value: rates[1], itemStyle: { color: '#f59e0b', borderRadius: [8, 8, 0, 0] } },
          { value: rates[2], itemStyle: { color: '#22c55e', borderRadius: [8, 8, 0, 0] } },
        ],
        label: { show: true, position: 'top', color: 'var(--ink-2)', fontSize: 11 },
      }],
    });

    // —— 图 9：卡片 CRUD 堆叠区域（new/edit/delete/mark_wrong）
    const crudTypes = ['card_new','card_edit','card_delete','card_mark_wrong'];
    // 图例显示本地化名（旧实现直接把 card_new 这类原始事件名当图例，用户看不懂）
    const crudLabels = [T('legend.crudNew'), T('legend.crudEdit'), T('legend.crudDelete'), T('legend.crudWrong')];
    const crudColors = ['#22c55e','#3b82f6','#ef4444','#f59e0b'];
    const crudMap = {}; for (const t of crudTypes) crudMap[t] = new Map(datesFull.map(d => [d.date, 0]));
    for (const o of rawAll) if (crudMap[o.type]) { const k = iso(new Date(o.t)); if (crudMap[o.type].has(k)) crudMap[o.type].set(k, crudMap[o.type].get(k)+1); }
    renderChart('cardCrud', {
      title: { text: T('chart.cardCrud'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      grid: { left: 36, right: 12, top: 36, bottom: 30 },
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { color: 'var(--ink-2)', fontSize: 10 } },
      xAxis: { type: 'category', boundaryGap: false, data: datesFull.map(d => d.date.slice(5)), axisLabel: { color: '#888', fontSize: 10, interval: Math.floor(datesFull.length / 10) } },
      yAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
      series: crudTypes.map((t, i) => ({
        name: crudLabels[i], type: 'line', stack: 'card', areaStyle: { opacity: 0.5 }, smooth: true, symbol: 'none',
        itemStyle: { color: crudColors[i] },
        data: datesFull.map(d => crudMap[t].get(d.date) || 0),
      })),
    });

    // —— 图 10：同步 / 导出 / AI 事件（三类柱状对比）
    const evKeys = [
      ['export',   '#818cf8'],
      ['sync',     '#0ea5e9'],
      ['ai_call',  '#8b5cf6'],
      ['pomodoro_end','#ef4444'],
      ['exam_end', '#f59e0b'],
      ['feynman_round', '#14b8a6'],
    ];
    const evLabels = [
      T('legend.evExport'), T('legend.evSync'), T('legend.evAi'),
      T('legend.evPomodoro'), T('legend.evExam'), T('legend.evFeynman'),
    ];
    const evMap = {}; evKeys.forEach(([k]) => { evMap[k] = new Map(datesFull.map(d => [d.date, 0])); });
    for (const o of rawAll) if (evMap[o.type]) { const k = iso(new Date(o.t)); if (evMap[o.type].has(k)) evMap[o.type].set(k, evMap[o.type].get(k)+1); }
    renderChart('syncExport', {
      title: { text: T('chart.events'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      grid: { left: 36, right: 12, top: 36, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { color: 'var(--ink-2)', fontSize: 10 } },
      xAxis: { type: 'category', data: datesFull.map(d => d.date.slice(5)), axisLabel: { color: '#888', fontSize: 10, interval: Math.floor(datesFull.length / 10) } },
      yAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
      series: evKeys.map(([name, color], i) => ({
        name: evLabels[i] || name, type: 'bar', stack: null, emphasis: { focus: 'series' },
        itemStyle: { color, borderRadius: [3, 3, 0, 0] },
        data: datesFull.map(d => evMap[name].get(d.date) || 0),
      })),
    });

    // —— 图 11：AI 调用词云（agentId / category）
    const aiRaw = rawAll.filter(o => o.type === 'ai_call' || o.type === 'agent_tool_call');
    const aiMap = new Map();
    for (const o of aiRaw) {
      const k = (o.payload?.agentId) || o.category || 'chat';
      aiMap.set(k, (aiMap.get(k) || 0) + 1);
    }
    const cloudData = [...aiMap.entries()].map(([name, value]) => ({ name: String(name).slice(0, 24), value }));
    renderChart('aiCloud', {
      title: { text: T('chart.aiCloud'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      tooltip: {},
      series: [{
        type: 'wordCloud', shape: 'circle', left: 'center', top: 30, width: '96%', height: '80%',
        sizeRange: [12, 44], rotationRange: [-45, 45], gridSize: 6, drawOutOfBound: false,
        textStyle: { fontWeight: 600, color: () => `hsl(${Math.floor(Math.random() * 360)} 70% 50%)` },
        emphasis: { textStyle: { fontWeight: 800, textShadowBlur: 4 } },
        data: cloudData,
      }],
    });

    // —— 图 12：模块 × 日 混合趋势（多线，可单查模块）
    renderChart('mixTrend', {
      title: { text: T('chart.mixTrend'), left: 'center', top: 4, textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
      grid: { left: 36, right: 130, top: 36, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { orient: 'vertical', right: 6, top: 36, textStyle: { color: 'var(--ink-2)', fontSize: 10 }, type: 'scroll' },
      dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
      xAxis: { type: 'category', boundaryGap: false, data: rawMix.dates.map(d => d.slice(5)), axisLabel: { color: '#888', fontSize: 10, interval: Math.floor(rawMix.dates.length / 10) } },
      yAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
      series: rawMix.series,
    });

    recordUserOp('dashboard_view', { rangeDays: rangeDays.value, totalOps: totalCount }, { category: String(rangeDays.value) });
  } catch (e) {
    toast(T('loadFail', { msg: e.message }), 'error');
    console.error(e);
  } finally {
    busy.value = false;
  }
}

// —— 工具函数：ECharts heatmap 周列 x 轴 + data 构建
function buildHeatXLabels(cells) {
  // 按每 4 周标一次月份，53 周列
  const cols = Math.ceil(cells.length / 7);
  const labels = new Array(cols).fill('');
  let lastMonth = -1;
  for (let i = 0; i < cols; i++) {
    const dayIdx = i * 7;
    if (dayIdx >= cells.length) break;
    const m = cells[dayIdx].date.split('-')[1];
    if (m !== lastMonth) { labels[i] = MONTH_NAMES.value[Number(m) - 1] || ''; lastMonth = m; }
  }
  return labels;
}
function buildHeatSeries(cells) {
  // x = 第几周（0..52）, y = 周几（0..6）, value = count
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.future) continue;
    const x = Math.floor(i / 7);
    const y = i % 7;
    // x 轴格式：对齐 ECharts category，需要字符串 label（周序号）。我们直接用索引做字符串。
    out.push([String(x), WEEK_SUN_AXIS.value[y], c.count, c.date]);
  }
  return out;
}

// —— 空数据检测：无 series 或所有 series 数据全 0 / 空数组
function isOptionEmpty(option) {
  if (!option || !Array.isArray(option.series) || option.series.length === 0) return true;
  return option.series.every(s => {
    const d = s.data;
    if (!Array.isArray(d) || d.length === 0) return true;
    // 散点 / 词云：有点位即视为非空（散点第三维是 0 占位，词云按 value 聚合）
    if (s.type === 'scatter' || s.type === 'wordCloud') return false;
    let sum = 0;
    for (const x of d) {
      if (Array.isArray(x)) sum += Number(x[2]) || 0;          // heatmap [x,y,v,...]
      else if (x && typeof x === 'object') {
        if ('value' in x) {
          const v = x.value;
          if (Array.isArray(v)) for (const n of v) sum += Number(n) || 0;  // radar 数组
          else sum += Number(v) || 0;                                        // pie / 散点对象
        }
      } else sum += Number(x) || 0;                            // 纯数字 line / bar
    }
    return sum === 0;
  });
}
// —— 空状态 option：保留原标题，叠加居中"暂无数据"提示 + 空坐标系骨架
function buildEmptyOption(original) {
  const ori = original || {};
  const oriTitle = ori.title;
  const oriTitleText = (oriTitle && typeof oriTitle === 'object' && oriTitle.text) ? oriTitle.text : '';
  const titles = [];
  if (oriTitleText) titles.push({
    text: oriTitleText, left: 'center', top: 4,
    textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' },
  });
  titles.push({
    text: T('emptyTitle'), subtext: T('emptySub'),
    left: 'center', top: 'center',
    textStyle: { color: '#999', fontSize: 16, fontWeight: 600 },
    subtextStyle: { color: '#bbb', fontSize: 12 },
  });
  return {
    title: titles,
    grid: { left: 40, right: 16, top: 40, bottom: 30 },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#ccc', fontSize: 10 },
      splitLine: { lineStyle: { color: 'var(--line)' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#ccc', fontSize: 10 },
      splitLine: { lineStyle: { color: 'var(--line)' } },
    },
    series: [],
  };
}

// —— 通用 ECharts render：懒初始化 + resize + CSS var 适配主题
function renderChart(key, option) {
  const h = chartHolders[key];
  if (!h?.el?.value) return;
  if (!h.c) h.c = echarts.init(h.el.value);
  // 空数据检测：注入骨架空状态
  if (isOptionEmpty(option)) option = buildEmptyOption(option);
  // 透传 CSS var 颜色：如果用了 "var(--ink)" 等，ECharts 无法解析；替换为 computedStyle 真实值。
  const css = getComputedStyle(document.documentElement);
  const patchCSSVar = (v) => {
    if (typeof v !== 'string') return v;
    return v.replace(/var\(--([a-zA-Z0-9-]+)\)/g, (m, name) => {
      const real = css.getPropertyValue('--' + name).trim();
      return real || '#334155';
    });
  };
  const patched = JSON.parse(JSON.stringify(option || {}), (k, v) => (typeof v === 'string' ? patchCSSVar(v) : v));
  h.c.setOption(patched, true);
}
let _ro = null;
function onResize() { for (const h of Object.values(chartHolders)) if (h.c) h.c.resize(); }
onMounted(() => {
  loadAll(); loadPartner();
  _ro = new ResizeObserver(onResize);
  for (const h of Object.values(chartHolders)) if (h.el?.value) _ro.observe(h.el.value);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  if (_ro) _ro.disconnect();
  for (const h of Object.values(chartHolders)) if (h.c) { h.c.dispose(); h.c = null; }
});

watch(rangeDays, () => loadAll());
watch([partnerKind, partnerRange, partnerWorst], () => loadPartner());
// 图表标题/轴/图例是 setOption 时写死进 ECharts 的普通字符串，
// 不像模板那样能被 Vue 响应式重渲染 —— 切语言必须重跑一次 loadAll 才会生效。
watch(locale, () => loadAll());

// CSS 热力颜色（GitHub 风格）
function heatColor(n) {
  if (!n) return 'var(--code-bg)';
  if (n >= 15) return '#006d32';
  if (n >= 8) return '#2cbe4e';
  if (n >= 3) return '#5cd66a';
  return '#c6f0d0';
}
const cssColor = computed(() => (name, fallback = '#334155') => {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const css = getComputedStyle(document.documentElement);
  const v = css.getPropertyValue(name).trim();
  return v || fallback;
});
const countsBanner = computed(() => {
  const arr = heatmapCells.value;
  const all = arr.reduce((s, x) => s + x.count, 0);
  const active = arr.filter(x => x.count > 0).length;
  // 连续活跃（含今天）
  let streak = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].future) continue; if (arr[i].count > 0) streak++; else break; }
  const longest = (() => {
    let cur = 0, mx = 0;
    for (const x of arr) { if (x.future) continue; if (x.count > 0) { cur++; mx = Math.max(mx, cur); } else cur = 0; }
    return mx;
  })();
  return { all, active, streak, longest };
});
</script>

<template>
  <div class="udb-root">
    <header class="udb-head">
      <div>
        <h2 style="margin:0">{{ T('title') }}</h2>
        <p class="hint" style="margin:4px 0 0">{{ T('levelA') }} {{ isAEnabled() ? T('on') : T('off') }}
          · {{ T('levelB') }} {{ isBEnabled() ? T('on') : T('off') }}
          · {{ T('localOnly') }}</p>
      </div>
      <div class="udb-head-right">
        <div class="chip-row">
          <span class="field-label" style="margin:0">{{ T('rangeLabel') }}</span>
          <button v-for="r in [7,14,30,90,365]" :key="r" class="chip" :class="{ on: rangeDays === r }" @click="rangeDays = r">{{ T('rangeDays', { n: r }) }}</button>
        </div>
        <button class="btn small" :disabled="busy" @click="loadAll">{{ T('refresh') }}</button>
      </div>
    </header>

    <!-- 4 个核心 KPI 卡 -->
    <section class="udb-kpis">
      <div class="kpi-card">
        <div class="kpi-k">{{ T('kpiOps365') }}</div>
        <div class="kpi-v">{{ fmtLocaleNumber(countsBanner.all) }}</div>
        <div class="kpi-sub">{{ T('kpiOps365Sub', { active: countsBanner.active, pct: (countsBanner.active / 3.65).toFixed(1) }) }}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-k">{{ T('kpiStreak') }}</div>
        <div class="kpi-v">{{ T('kpiStreakVal', { n: countsBanner.streak }) }}</div>
        <div class="kpi-sub">{{ T('kpiStreakSub', { n: countsBanner.longest }) }}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-k">{{ T('kpiRange', { n: rangeDays }) }}</div>
        <div class="kpi-v">{{ stat ? T('summary', { days: stat.days, ops: stat.ops }) : '—' }}</div>
        <div class="kpi-sub">{{ stat
          ? [T('summaryModules', { n: stat.modules }), T('summaryTypes', { n: stat.types }), T('active365', { days: stat.active365, ops: stat.total365 })].join(' · ')
          : T('kpiRangeLoading') }}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-k">{{ T('kpiLab') }}</div>
        <div class="kpi-v">{{ T('kpiLabVal') }}</div>
        <div class="kpi-sub">{{ T('kpiLabSub') }}</div>
      </div>
    </section>

    <!-- CSS 365 天 GitHub 式热力（更符合移动端滑动） -->
    <section class="panel">
      <h3 style="margin:0 0 8px">{{ T('heat365Title') }}</h3>
      <div class="heat365-wrap">
        <div class="heat-months">
          <span v-for="(l, i) in MONTH_NAMES" :key="i">{{ l }}</span>
        </div>
        <div class="heat365-grid" :title="T('heat365Tip')">
          <div v-for="c in heatmapCells" :key="c.date" class="heat-cell"
               :style="{ background: heatColor(c.count), opacity: c.future ? 0.15 : 1 }"
               :title="T('heatCellTip', { date: c.date, n: c.count })"></div>
        </div>
        <div class="heat-legend">
          <span class="hint">{{ T('legendLess') }}</span>
          <span class="legend-cell" style="background:var(--code-bg)"></span>
          <span class="legend-cell" style="background:#c6f0d0"></span>
          <span class="legend-cell" style="background:#5cd66a"></span>
          <span class="legend-cell" style="background:#2cbe4e"></span>
          <span class="legend-cell" style="background:#006d32"></span>
          <span class="hint">{{ T('legendMore') }}</span>
        </div>
      </div>
    </section>

    <!-- 12 图表网格：2 列自适应 -->
    <section class="panel chart-panel">
      <div ref="heatmapEl" class="chart-box tall" :class="{ 'is-loading': busy }"></div>
    </section>
    <section class="chart-grid">
      <div class="panel chart-panel"><div ref="hourLineEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="modulePieEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="typeBarEl" class="chart-box tall" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="actionDotEl" class="chart-box tall" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="weekRadarEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="weekHeat168El" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="rateDistEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel"><div ref="cardCrudEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel wide2"><div ref="syncExportEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel wide2"><div ref="mixTrendEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
      <div class="panel chart-panel wide2"><div ref="aiCloudEl" class="chart-box" :class="{ 'is-loading': busy }"></div></div>
    </section>

    <!-- 最佳 / 最坏 拍档 16 组合 -->
    <section class="panel partner-panel">
      <div class="partner-head">
        <div>
          <h3 style="margin:0">{{ T('partner.head') }}</h3>
          <p class="hint" style="margin:4px 0 0">{{ T('partner.hint') }}</p>
        </div>
      </div>

      <div class="row">
        <span class="field-label" style="margin:0">{{ T('partner.kindLabel') }}</span>
        <button class="chip" :class="{ on: partnerKind === 'A' }" @click="partnerKind = 'A'">{{ T('partner.kindA') }}</button>
        <button class="chip" :class="{ on: partnerKind === 'B' }" @click="partnerKind = 'B'">{{ T('partner.kindB') }}</button>
        <button class="chip" :class="{ on: partnerKind === 'C' }" @click="partnerKind = 'C'">{{ T('partner.kindC') }}</button>
        <button class="chip" :class="{ on: partnerKind === 'D' }" @click="partnerKind = 'D'">{{ T('partner.kindD') }}</button>
        <span class="field-label" style="margin-left:8px">{{ T('partner.rangeLabel') }}</span>
        <button class="chip" :class="{ on: partnerRange === 7 }" @click="partnerRange = 7">{{ T('partner.range7') }}</button>
        <button class="chip" :class="{ on: partnerRange === 90 }" @click="partnerRange = 90">{{ T('partner.range90') }}</button>
        <span class="field-label" style="margin-left:8px">{{ T('partner.polarityLabel') }}</span>
        <button class="chip" :class="{ on: !partnerWorst }" @click="partnerWorst = false">{{ T('partner.best') }}</button>
        <button class="chip" :class="{ on: partnerWorst }" @click="partnerWorst = true">{{ T('partner.worst') }}</button>
      </div>

      <div v-if="partnerBusy" class="hint" style="padding:16px;text-align:center">{{ T('partner.busy') }}</div>
      <div v-else class="partner-body">
        <div class="partner-summary" :class="{ dim: partnerData.notEnough }">
          <div class="partner-title">{{ partner.title }}</div>
          <div class="partner-desc">{{ partner.desc }}</div>
          <div v-if="partner.suggest" class="partner-suggest">💡 {{ partner.suggest }}</div>
        </div>
        <ul class="partner-list" v-if="partnerData.items && partnerData.items.length">
          <li v-for="(item, i) in partnerData.items" :key="i" class="partner-item" @click="onPartnerItemClick(item)">
            <span class="rank">{{ i + 1 }}</span>
            <span class="p-name">{{ item.key }}</span>
            <span class="p-count">{{ item.count !== 0 ? T('partner.times', { n: item.count }) : T('partner.zombie') }}</span>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.udb-root { padding: 4px 2px 40px; }
.udb-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  flex-wrap: wrap; margin-bottom: 14px;
}
.udb-head-right { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.chip-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.udb-kpis {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 14px;
}
.kpi-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px;
}
.kpi-k { font-size: 12px; color: var(--ink-2); font-weight: 600; }
.kpi-v { font-size: 26px; font-weight: 800; color: var(--accent); margin: 6px 0 4px; letter-spacing: -0.5px; }
.kpi-sub { font-size: 12px; color: var(--ink-2); line-height: 1.5; }

.panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 14px; margin-bottom: 12px;
}

/* 365 CSS 热力 */
.heat365-wrap { overflow-x: auto; padding-bottom: 8px; }
.heat-months {
  display: grid; grid-template-columns: 24px repeat(53, 12px); gap: 3px;
  margin-left: 0; font-size: 10px; color: var(--ink-2);
}
.heat-months > span { text-align: center; }
.heat-months > span:first-child { visibility: hidden; }
.heat365-grid {
  display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 12px);
  grid-auto-columns: 12px; gap: 3px; margin-top: 2px;
}
.heat-cell {
  width: 12px; height: 12px; border-radius: 2px; border: 1px solid rgba(0,0,0,.06);
}
.heat-legend { display: flex; align-items: center; gap: 4px; margin-top: 8px; font-size: 11px; }
.legend-cell { width: 12px; height: 12px; border-radius: 2px; }

/* 图表网格 */
.chart-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;
}
.chart-panel { margin-bottom: 0; }
.chart-box { width: 100%; height: 300px; position: relative; }
.chart-box.tall { height: 380px; }
/* 加载骨架：数据返回前显示 shimmer 占位，避免图表空白观感 */
.chart-box.is-loading::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 8px;
  background: linear-gradient(90deg, var(--code-bg) 25%, var(--line) 37%, var(--code-bg) 63%);
  background-size: 400% 100%;
  animation: udb-shimmer 1.4s ease infinite;
}
@keyframes udb-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
.wide2 { grid-column: span 2; }
@media (max-width: 900px) {
  .chart-grid { grid-template-columns: 1fr; }
  .wide2 { grid-column: span 1; }
  .chart-box { height: 260px; }
  .chart-box.tall { height: 320px; }
}

/* 拍档 */
.partner-panel { padding: 14px 16px; }
.partner-head { margin-bottom: 12px; }
.partner-body {
  display: grid; grid-template-columns: 1.1fr 1.4fr; gap: 14px; margin-top: 8px;
}
@media (max-width: 780px) { .partner-body { grid-template-columns: 1fr; } }
.partner-summary {
  border: 1px dashed var(--line); border-radius: 10px; padding: 14px;
  background: linear-gradient(180deg, var(--code-inline), var(--panel));
}
.partner-summary.dim { opacity: 0.7; }
.partner-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.partner-desc { color: var(--ink); font-size: 14px; margin-bottom: 8px; line-height: 1.6; }
.partner-suggest {
  font-size: 13px; color: var(--accent); background: var(--tag-bg); border-radius: 8px;
  padding: 8px 10px; line-height: 1.6;
}
.partner-list { list-style: none; padding: 0; margin: 0; max-height: 300px; overflow-y: auto; }
.partner-item {
  display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; cursor: pointer;
  transition: background .12s;
}
.partner-item:hover { background: var(--code-inline); }
.partner-item + .partner-item { border-top: 1px solid var(--line); }
.rank {
  width: 24px; height: 24px; flex: none; border-radius: 50%;
  background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
}
.p-name { flex: 1; min-width: 0; word-break: break-all; font-size: 14px; }
.p-count { font-size: 12px; color: var(--ink-2); font-weight: 600; }

.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.hint { color: var(--ink-2); font-size: 12px; }
</style>
