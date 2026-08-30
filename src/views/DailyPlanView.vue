<script setup>
// 每日规划 · 打卡 · 多维图表视图
// 口述输入 → 智能解析(LLM 优先/离线回退) → 四象限 + 雷达 + 热力矩阵 + 风险 + 日程表 + 完成对比
// 交互：点击条目弹确认框，「确定」才标记完成；已完成条目绿色区分；可按日期回溯历史存档。
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted, nextTick, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import { toast } from '../utils/toast.js';
import { t } from '../i18n/index.js';
import {
  createDailyPlan, listDailyPlan, listDailyPlanSummary, updateDailyTask, deleteDailyTask,
  checkinDailyTask, deleteDailyPlan, addDailyTask, appendDailyTasksByText,
} from '../repo.js';
import { parsePlanSmart } from '../utils/plan-parser.js';
import { formatLunarDate } from '../utils/lunar.js';
import { getReminderSettings, saveReminderSettings, requestNotifyPermission } from '../utils/plan-reminder.js';
import { getDailySynergy, getCompletionHeatmap } from '../utils/planSynergy.js';
import {
  quadrantOption, radarOption, heatmapOption, riskOption,
  typeBreakdownOption, compareBarOption, trendOption, gaugeOption, checkinTimelineOption,
  buildScheduleBoard, emptyOption,
} from '../utils/planCharts.js';

// ──────────────── 常量 ────────────────
const STATUS_COLOR = { done: '#7ba87b', partial: '#d4a853', skipped: '#c9c4bd', pending: '#e07b3c' };
const TYPE_LABEL = { review: '复习', pomodoro: '番茄', doc: '资料', exam: '做题', note: '笔记', write: '写作', other: '其他' };
const QUADRANT_LABEL = { Q1: '重要×紧急', Q2: '重要×非紧急', Q3: '非重要×紧急', Q4: '非重要×非紧急' };
const STATUS_LABEL = { pending: '待办', done: '已完成', partial: '部分完成', skipped: '已跳过' };
const TYPE_ICON = { review: '📖', pomodoro: '🍅', doc: '📚', exam: '📝', note: '📓', write: '✍️', other: '📌' };

function dateStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function shiftDate(d, deltaDays) {
  const x = new Date(d);
  x.setDate(x.getDate() + deltaDays);
  return dateStr(x);
}
function relativeLabel(date) {
  const today = dateStr();
  if (date === today) return t('views.dailyPlan.today');
  if (date === shiftDate(new Date(), -1)) return t('views.dailyPlan.yesterday');
  if (date === shiftDate(new Date(), -2)) return t('views.dailyPlan.dayBeforeYesterday');
  if (date === shiftDate(new Date(), -3)) return t('views.dailyPlan.threeDaysAgo');
  return date;
}

// ──────────────── 状态 ────────────────
const today = dateStr();
const selectedDate = ref(today);
const rawInput = ref('');
const parsing = ref(false);
const busy = ref(false);
const plan = ref(null);          // { plan, tasks }
const synergy = ref(null);       // 跨模块真实数据 + 完成度 + 风险
const heat = ref([]);            // 84 天热力矩阵
const preview = ref(null);       // 解析预览（未入库）
const showAddTask = ref(false);
const addInput = ref('');
const historyList = ref([]);     // [{ date, total, done }]
const pendingTask = ref(null);   // 待确认的任务（弹窗）
const confirmStatus = ref('done');
const hoverTask = ref(null);     // 悬停放大的任务（屏幕中央完整内容卡）
const now = ref(new Date());     // 实时时钟（秒级刷新）
let clockTimer = null;

// 到点提醒设置（默认：视觉提醒开、声音/语音关——图书馆友好）
const remindSet = ref(getReminderSettings());
const notifyState = ref(typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported');
const notifyLabel = computed(() => {
  const s = notifyState.value;
  if (s === 'granted') return t('views.dailyPlan.notifyGranted');
  if (s === 'denied') return t('views.dailyPlan.notifyDenied');
  if (s === 'unsupported') return t('views.dailyPlan.notifyUnsupported');
  return t('views.dailyPlan.notifyDefault');
});
function patchRemind(patch) {
  remindSet.value = saveReminderSettings(patch);
  toast(t('views.dailyPlan.remindSaved'), 'success');
}
async function grantNotify() {
  const p = await requestNotifyPermission();
  notifyState.value = p;
  toast(
    p === 'granted' ? '系统通知已开启，到点会弹系统提醒 ✓'
      : p === 'denied' ? '通知被拒绝，请在浏览器地址栏左侧的权限设置中允许'
        : '浏览器不支持或未授权',
    p === 'granted' ? 'success' : 'warning',
  );
}

const useLLM = ref(localStorage.getItem('sxy_plan_use_llm') !== '0');
watch(useLLM, v => localStorage.setItem('sxy_plan_use_llm', v ? '1' : '0'));

const isToday = computed(() => selectedDate.value === today);
const canEdit = computed(() => isToday.value);

// ──────────────── 计算属性 ────────────────
const summary = computed(() => {
  if (!plan.value?.tasks?.length) return null;
  const byQuadrant = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  const byStatus = { pending: 0, done: 0, partial: 0, skipped: 0 };
  for (const t of plan.value.tasks) {
    byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] || 0) + 1;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  const total = plan.value.tasks.length;
  const doneRate = total ? Math.round((byStatus.done / total) * 100) : 0;
  return { total, byQuadrant, byStatus, doneRate };
});

const completion = computed(() => synergy.value?.completion || []);
const risks = computed(() => synergy.value?.risks || []);
const overallRate = computed(() => {
  if (!completion.value.length) return 0;
  const planned = completion.value.reduce((s, c) => s + c.plan, 0);
  const actual = completion.value.reduce((s, c) => s + c.actual, 0);
  return planned ? Math.min(100, Math.round((actual / planned) * 100)) : 0;
});

const timelineHeight = computed(() => {
  const n = (plan.value?.tasks || []).filter(t => t.scheduledHour != null || t.completedAt).length;
  return Math.max(120, (n || 1) * 26 + 50) + 'px';
});

// 课程表风格日程表数据（按小时网格排布）
const board = computed(() => buildScheduleBoard(plan.value?.tasks || []));

// 选中日期的公历/农历/星期信息（历史日期同样生效）
const dateInfo = computed(() => formatLunarDate(selectedDate.value + 'T00:00:00'));
// 实时时钟（HH:MM:SS，秒级跳动）
const timeText = computed(() => {
  const n = now.value;
  return [n.getHours(), n.getMinutes(), n.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
});

// ──────────────── 生命周期 ────────────────
onMounted(async () => {
  await loadPlan(today);
  loadHistoryList();
  clockTimer = setInterval(() => { now.value = new Date(); }, 1000);
  window.addEventListener('resize', handleResize);
});
onBeforeUnmount(() => {
  clearInterval(clockTimer);
  disposeAllCharts();
  window.removeEventListener('resize', handleResize);
});

// ──────────────── 数据加载 ────────────────
async function loadPlan(date) {
  selectedDate.value = date;
  try {
    const r = await listDailyPlan(date);
    plan.value = r;
    if (r) {
      await refreshAll();
      await refreshSynergy();
    } else {
      // 无计划：清空图表实例内容但保留空占位
      await nextTick();
      renderHeatEmpty();
    }
  } catch (e) {
    // 数据库异常兜底：提示而不是静默显示"没有内容"
    console.error('[plan] loadPlan failed', e);
    toast('加载计划失败：' + (e?.message || e), 'error');
    plan.value = null;
  }
  heat.value = await getCompletionHeatmap(84).catch(() => []);
  await nextTick();
  renderHeat();
}

async function loadHistoryList() {
  // 按日期合并去重（同一天多份计划合并 total/done），避免"全是今日"
  historyList.value = await listDailyPlanSummary(60).catch(() => []);
}

async function refreshSynergy() {
  try {
    synergy.value = await getDailySynergy(selectedDate.value, plan.value?.tasks || null);
  } catch (e) {
    console.warn('[plan] synergy failed', e);
    synergy.value = null;
  }
}

async function selectDate(d) {
  pendingTask.value = null;
  await loadPlan(d);
}

// ──────────────── 口述 → 解析预览 ────────────────
function fillExample() {
  rawInput.value = '09:00 复习线性代数第四章方程组基础解系与非齐次通解全部30张卡片 重要\n14:00 做10道408计算机组成原理存储系统真题大题 计组\n16:30 看数据结构二叉树遍历与哈夫曼树讲义并整理笔记\n19:00 背英语单词50个 重要';
}

async function submitPlan() {
  const text = rawInput.value.trim();
  if (!text) { toast('先写下今天的规划', 'warning'); return; }
  parsing.value = true;
  try {
    const result = await parsePlanSmart(text, { useLLM: useLLM.value });
    preview.value = { text, ...result };
    await nextTick();
    renderPreviewQuad();
    const src = result.source === 'llm' ? '✨ AI 解析' : '⚡ 离线解析';
    toast(`${src}出 ${result.tasks.length} 个任务`, 'success');
  } catch (e) {
    toast('解析失败：' + (e?.message || e), 'error');
  } finally {
    parsing.value = false;
  }
}

async function confirmPlan() {
  if (!preview.value) return;
  busy.value = true;
  try {
    // 直接把预览（LLM/离线解析）结果原样入库，保证 预览=入库 一致，刷新后内容不"缩水"
    const { plan: p, tasks } = await createDailyPlan({
      rawInput: preview.value.text,
      date: selectedDate.value,
      tasks: preview.value.tasks,
    });
    plan.value = { plan: p, tasks };
    rawInput.value = '';
    preview.value = null;
    await refreshAll();
    await refreshSynergy();
    await loadHistoryList();
    toast(`已入库 ${tasks.length} 个任务`, 'success');
  } catch (e) {
    toast('入库失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

function cancelPreview() { preview.value = null; disposePreviewQuad(); }

// ──────────────── 中途加任务 ────────────────
async function appendTasks() {
  const text = addInput.value.trim();
  if (!text || !plan.value?.plan?.id) { toast('请输入任务描述', 'warning'); return; }
  busy.value = true;
  try {
    const rows = await appendDailyTasksByText(plan.value.plan.id, text);
    plan.value.tasks = [...(plan.value.tasks || []), ...rows];
    addInput.value = '';
    showAddTask.value = false;
    await refreshAll();
    await refreshSynergy();
    await loadHistoryList();
    toast(`追加 ${rows.length} 个任务`, 'success');
  } catch (e) {
    toast('追加失败：' + (e?.message || e), 'error');
  } 
  finally {
    busy.value = false;
  }
}

async function addManualTask() {
  const text = addInput.value.trim();
  if (!text || !plan.value?.plan?.id) return;
  busy.value = true;
  try {
    const { parsePlan } = await import('../utils/plan-parser.js');
    const parsed = parsePlan(text);
    const rows = [];
    for (const p of parsed) rows.push(await addDailyTask(plan.value.plan.id, p));
    plan.value.tasks = [...(plan.value.tasks || []), ...rows];
    addInput.value = '';
    showAddTask.value = false;
    await refreshAll();
    await refreshSynergy();
    await loadHistoryList();
    toast(`已加 ${rows.length} 个任务`, 'success');
  } catch (e) {
    toast('添加失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

// ──────────────── 打卡 / 调整 ────────────────
// 点击条目 → 弹出确认框，点击「确定」才标记完成；历史模式禁止编辑
function openConfirm(task, status = 'done') {
  if (!canEdit.value) { toast('历史记录为只读，不可修改', 'warning'); return; }
  hoverTask.value = null;          // 打开确认弹窗前先收起悬停放大卡
  pendingTask.value = task;
  confirmStatus.value = status;
}

async function confirmAction() {
  const task = pendingTask.value;
  const status = confirmStatus.value;
  if (!task) return;
  busy.value = true;
  try {
    const note = status === 'done' ? '' : (prompt(`备注（${STATUS_LABEL[status]}原因，可留空）：`) || '');
    await checkinDailyTask(task.id, status, note);
    task.status = status;
    pendingTask.value = null;
    await refreshAll();
    await refreshSynergy();
    await loadHistoryList();
    toast(`已${STATUS_LABEL[status]}：${task.title.slice(0, 20)}`, 'success');
  } catch (e) {
    toast('打卡失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

async function toggleQuadrant(task) {
  if (!canEdit.value) return;
  const order = ['Q1', 'Q2', 'Q3', 'Q4'];
  const idx = order.indexOf(task.quadrant);
  const next = order[(idx + 1) % 4];
  await updateDailyTask(task.id, { quadrant: next, important: next === 'Q1' || next === 'Q2', urgent: next === 'Q1' || next === 'Q3' });
  task.quadrant = next;
  await refreshAll();
}

async function removeTask(task) {
  if (!canEdit.value) { toast('历史记录为只读，不可修改', 'warning'); return; }
  if (!(await confirmDialog('删除这个任务？'))) return;
  await deleteDailyTask(task.id);
  plan.value.tasks = plan.value.tasks.filter(t => t.id !== task.id);
  await refreshAll();
  await refreshSynergy();
  await loadHistoryList();
}

async function clearToday() {
  if (!canEdit.value) { toast('历史记录为只读，不可修改', 'warning'); return; }
  if (!plan.value?.plan?.id) return;
  if (!(await confirmDialog('删除这份规划及所有任务？'))) return;
  await deleteDailyPlan(plan.value.plan.id);
  plan.value = null;
  synergy.value = null;
  await loadHistoryList();
}

// ──────────────── 图表渲染 ────────────────
const quadEl = ref(null);
const previewQuadEl = ref(null);
const radarEl = ref(null);
const heatEl = ref(null);
const riskEl = ref(null);
const typeEl = ref(null);
const compareEl = ref(null);
const trendEl = ref(null);
const gaugeEl = ref(null);
const timelineEl = ref(null);

let quadChart = null, previewQuadChart = null, radarChart = null, heatChart = null;
let riskChart = null, typeChart = null, compareChart = null;
let trendChart = null, gaugeChart = null, timelineChart = null;

function initChart(refEl, old) {
  if (!refEl?.value) return null;
  old?.dispose();
  return echarts.init(refEl.value);
}

async function refreshAll() {
  await nextTick();
  renderQuadrant();
  renderRadar();
  renderRisk();
  renderType();
  renderCompare();
  renderTrend();
  renderGauge();
  renderTimeline();
}

function renderQuadrant() {
  if (!quadEl.value || !plan.value?.tasks?.length) return;
  quadChart = initChart(quadEl, quadChart);
  quadChart.setOption(quadrantOption(  (plan.value.tasks)));
}

function renderPreviewQuad() {
  if (!previewQuadEl.value || !preview.value) return;
  previewQuadChart = initChart(previewQuadEl, previewQuadChart);
  previewQuadChart.setOption(quadrantOption(preview.value.tasks));
}

function renderRadar() {
  if (!radarEl.value) return;
  radarChart = initChart(radarEl, radarChart);
  radarChart.setOption(completion.value.length ? radarOption(completion.value) : emptyOption('暂无完成数据'));
}

function renderRisk() {
  if (!riskEl.value) return;
  riskChart = initChart(riskEl, riskChart);
  riskChart.setOption(risks.value.length ? riskOption(risks.value) : emptyOption('暂无风险任务 🎉'));
}

function renderType() {
  if (!typeEl.value) return;
  typeChart = initChart(typeEl, typeChart);
  const tasks = plan.value?.tasks || [];
  typeChart.setOption(tasks.length ? typeBreakdownOption(tasks) : emptyOption('暂无任务'));
}

function renderCompare() {
  if (!compareEl.value) return;
  compareChart = initChart(compareEl, compareChart);
  compareChart.setOption(completion.value.length ? compareBarOption(completion.value) : emptyOption('暂无对比数据'));
}

function renderTrend() {
  if (!trendEl.value) return;
  trendChart = initChart(trendEl, trendChart);
  const trend = (heat.value || []).slice(-30);
  trendChart.setOption(trend.length ? trendOption(trend) : emptyOption('暂无趋势数据'));
}

function renderGauge() {
  if (!gaugeEl.value) return;
  gaugeChart = initChart(gaugeEl, gaugeChart);
  gaugeChart.setOption(gaugeOption(overallRate.value, '数字资产利用率'));
}

function renderTimeline() {
  if (!timelineEl.value) return;
  timelineChart = initChart(timelineEl, timelineChart);
  timelineChart.setOption(plan.value?.tasks?.length ? checkinTimelineOption(plan.value.tasks) : emptyOption('暂无排程/打卡数据'));
}

function renderHeat() {
  if (!heatEl.value || !heat.value.length) return;
  heatChart = initChart(heatEl, heatChart);
  heatChart.setOption(heatmapOption(heat.value));
}
function renderHeatEmpty() {
  if (!heatEl.value) return;
  heatChart = initChart(heatEl, heatChart);
  heatChart.setOption(emptyOption('暂无数据'));
}

function disposePreviewQuad() { previewQuadChart?.dispose(); previewQuadChart = null; }
function disposeAllCharts() {
  [quadChart, previewQuadChart, radarChart, heatChart, riskChart, typeChart, compareChart, trendChart, gaugeChart, timelineChart].forEach(c => c?.dispose());
}

// 响应式 resize
function handleResize() {
  [quadChart, previewQuadChart, radarChart, heatChart, riskChart, typeChart, compareChart, trendChart, gaugeChart, timelineChart].forEach(c => c?.resize());
}
</script>

<template>
  <div class="dp-page">
    <header class="dp-header">
      <div class="dp-title-row">
        <h2 style="margin:0">📅 每日规划 · 打卡 · 多维分析</h2>
        <span class="dp-mode" :class="canEdit ? 'm-edit' : 'm-history'">{{ canEdit ? '✏️ 编辑中' : '📖 历史只读' }}</span>
      </div>

      <!-- 日期导航：今天 / 昨天 / 前天 / 大前天 / 任意日期 -->
      <div class="dp-datebar">
        <button class="dp-day-chip" :class="{ active: selectedDate === today }" @click="selectDate(today)">今天</button>
        <button class="dp-day-chip" :class="{ active: selectedDate === shiftDate(new Date(),-1) }" @click="selectDate(shiftDate(new Date(),-1))">昨天</button>
        <button class="dp-day-chip" :class="{ active: selectedDate === shiftDate(new Date(),-2) }" @click="selectDate(shiftDate(new Date(),-2))">前天</button>
        <button class="dp-day-chip" :class="{ active: selectedDate === shiftDate(new Date(),-3) }" @click="selectDate(shiftDate(new Date(),-3))">大前天</button>
        <span class="dp-date-sep"></span>
        <input type="date" class="dp-date-input" :value="selectedDate" :max="today" @change="e => selectDate(e.target.value)" />
        <span v-if="!canEdit" class="dp-date-label">查看：{{ selectedDate }}</span>
      </div>

      <!-- 历史存档列表 -->
      <div v-if="historyList.length" class="dp-history">
        <span class="dp-history-title">📚 历史存档（点击回溯）：</span>
        <div class="dp-history-row">
          <button
            v-for="h in historyList" :key="h.date"
            class="dp-history-item"
            :class="{ active: h.date === selectedDate }"
            :title="`${relativeLabel(h.date)} · ${h.done}/${h.total} 完成`"
            @click="selectDate(h.date)"
          >
            <span class="dp-history-date">{{ relativeLabel(h.date) }}</span>
            <span class="dp-history-rate">{{ h.total ? Math.round((h.done / h.total) * 100) + '%' : '—' }}</span>
          </button>
        </div>
      </div>
    </header>

    <!-- 输入区（仅今天且无计划时） -->
    <div v-if="!plan && canEdit" class="dp-input">
      <textarea
        v-model="rawInput"
        class="input dp-textarea"
        rows="4"
        placeholder="例：复习 30 张卡片，最优先；下午 3 点做 10 道线代题；番茄钟 25 分钟；看第三章讲义，重要；整理错题本"
      />
      <div class="dp-input-actions">
        <label class="dp-llm-toggle" title="勾选后优先用 AI 解析（更准确），失败自动回退离线">
          <input type="checkbox" v-model="useLLM" /> ✨ AI 智能解析
        </label>
        <button class="btn" :disabled="parsing" @click="fillExample">✨ 载入示例</button>
        <button class="btn primary" :disabled="parsing" @click="submitPlan">
          {{ parsing ? '解析中…' : '🔍 解析规划' }}
        </button>
      </div>
    </div>

    <!-- 历史无记录提示 -->
    <div v-else-if="!plan && !canEdit" class="dp-empty">
      📭 {{ selectedDate }} 暂无规划记录。仅「今天」可新建规划。
    </div>

    <!-- 解析预览 -->
    <div v-if="preview" class="dp-preview">
      <div class="dp-preview-head">
        <span>解析预览（确认后入库，可编辑）</span>
        <span class="dp-source" :class="'src-' + preview.source">
          {{ preview.source === 'llm' ? '✨ AI' : '⚡ 离线' }}
        </span>
        <span style="flex:1"></span>
        <button class="btn primary" :disabled="busy" @click="confirmPlan">确认入库</button>
        <button class="btn" @click="cancelPreview">取消</button>
      </div>
      <div v-for="(t, i) in preview.tasks" :key="i" class="dp-task-row">
        <span class="dp-type">{{ TYPE_ICON[t.type] }} {{ TYPE_LABEL[t.type] }}</span>
        <span class="dp-title">{{ t.title }}</span>
        <span v-if="t.scheduledHour != null" class="dp-meta-item">⏰ {{ t.scheduledHour }}:00</span>
        <span :class="'dp-tag q-' + t.quadrant">{{ t.quadrant }}</span>
      </div>
      <div ref="previewQuadEl" class="dp-quad" style="height:300px"></div>
    </div>

    <!-- 计划区 -->
    <div v-else-if="plan" class="dp-plan">
      <div class="dp-plan-head">
        <div>
          <span class="dp-date">{{ relativeLabel(selectedDate) }} · {{ selectedDate }}</span>
          <span class="hint">共 {{ summary.total }} 个任务 · 完成率 {{ summary.doneRate }}% · 总达成 {{ overallRate }}%</span>
        </div>
        <div v-if="canEdit" style="display:flex;gap:8px">
          <button class="btn" @click="showAddTask = !showAddTask">➕ 中途加任务</button>
          <button class="btn" @click="rawInput=''; plan=null">重新规划</button>
          <button class="btn danger" @click="clearToday">删除</button>
        </div>
      </div>

      <!-- 中途加任务 -->
      <div v-if="showAddTask && canEdit" class="dp-add">
        <input v-model="addInput" class="input" placeholder="例：背 20 个英语单词，重要；下午   4 点整理笔记" @keyup.enter="appendTasks" />
        <button class="btn primary" :disabled="busy" @click="appendTasks">追加</button>
        <button class="btn" :disabled="busy" @click="addManualTask">单任务</button>
      </div>

      <!-- 跨模块真实数据 -->
      <div v-if="synergy" class="dp-reality">
        <span class="dp-reality-item">📖 今日复习 <b>{{ synergy.totals.reviews }}</b> 次</span>
        <span class="dp-reality-item">🍅 今日专注 <b>{{ synergy.totals.focusMinutes }}</b> 分</span>
        <span class="dp-reality-item">🃏 今日新建卡 <b>{{ synergy.totals.newCards }}</b> 张</span>
        <span class="dp-reality-item">❌ 今日错题 <b>{{ synergy.totals.wrongToday }}</b> 道</span>
        <span class="dp-reality-item">📝 今日模考 <b>{{ synergy.totals.exams }}</b> 套{{ synergy.totals.exams ? `·均分 ${synergy.totals.examAvg}` : '' }}</span>
      </div>

      <!-- 今日日程表（课程表风格 · 居中） -->
      <section class="dp-board-section">
        <!-- 日期信息栏：公历 + 农历 + 星期 + 实时时钟（秒级） -->
        <div class="dp-date-info" :title="isToday ? '今天' : '查看 ' + selectedDate">
          <div class="dp-date-info-main">
            <span class="dp-di-solar">📅 {{ dateInfo.solarText }}</span>
            <span class="dp-di-sub">
              <span class="dp-di-week">{{ dateInfo.weekdayText }}</span>
              <span class="dp-di-lunar">🌙 {{ dateInfo.lunarText }} · {{ dateInfo.ganzhiText }}</span>
            </span>
          </div>
          <div class="dp-di-clock-wrap">
            <div class="dp-di-clock">{{ timeText }}</div>
            <div class="dp-di-clock-label">实时时间</div>
          </div>
        </div>
        <!-- 到点提醒设置（默认静音：视觉提醒开、声音/语音关） -->
        <div class="dp-remind-bar">
          <span class="dp-remind-title">⏰ 到点提醒</span>
          <label class="dp-llm-toggle" title="总开关：到点弹出视觉提醒">
            <input type="checkbox" :checked="remindSet.enabled" @change="patchRemind({ enabled: $event.target.checked })" /> 开启
          </label>
          <button class="dp-remind-btn" :class="{ on: notifyState === 'granted' }" @click="grantNotify">{{ notifyLabel }}</button>
          <label class="dp-llm-toggle" title="默认关闭（图书馆友好）">
            <input type="checkbox" :checked="remindSet.sound" @change="patchRemind({ sound: $event.target.checked })" /> 🔊 提示音
          </label>
          <label class="dp-llm-toggle" title="默认关闭，开启后语音播报任务名">
            <input type="checkbox" :checked="remindSet.voice" @change="patchRemind({ voice: $event.target.checked })" /> 🗣️ 语音播报
          </label>
          <select class="dp-remind-select" :value="remindSet.advanceMin" title="提前提醒时间" @change="patchRemind({ advanceMin: Number($event.target.value) })">
            <option :value="0">到点提醒</option>
            <option :value="5">提前 5 分钟</option>
            <option :value="10">提前 10 分钟</option>
          </select>
          <span class="dp-remind-hint">🔕 默认静音 · 视觉提醒始终弹出</span>
        </div>
        <div class="dp-board-head">
          <div class="dp-chart-title">📚 今日课程表（点击条目 → 弹窗确认打卡）</div>
          <div class="dp-legend">
            <span class="lg lg-done">✓ 已完成</span>
            <span class="lg lg-q1">Q1 重要紧急</span>
            <span class="lg lg-q2">Q2 重要</span>
            <span class="lg lg-q3">Q3 紧急</span>
            <span class="lg lg-q4">Q4 其他</span>
          </div>
        </div>
        <div class="dp-board-wrap">
          <div class="dp-board">
            <div class="dp-board-track" :style="{ height: board.totalHeight + 'px' }">
              <div class="dp-board-hours">
                <div v-for="h in board.hours" :key="h" class="dp-board-hour" :style="{ height: board.rowH + 'px' }">{{ h }}:00</div>
              </div>
              <div class="dp-board-body">
                <div
                  v-for="b in board.placed" :key="b.task.id"
                  class="dp-board-block"
                  :class="['st-' + b.task.status, { editable: canEdit, hovering: hoverTask?.id === b.task.id }]"
                  :style="{ top: b.top + 'px', height: b.height + 'px', left: b.left, width: b.width, '--c': b.color }"
                  :title="b.task.title + (canEdit ? '（悬停看完整内容 / 点击标记完成）' : '（历史只读）')"
                  @click="openConfirm(b.task, 'done')"
                  @mouseenter="hoverTask = b.task"
                  @mouseleave="hoverTask = null"
                >
                  <div class="dp-board-block-head">
                    <span class="dp-board-time">{{ b.label }}</span>
                    <span class="dp-board-type">{{ TYPE_ICON[b.task.type] }}</span>
                  </div>
                  <div class="dp-board-title" :style="{ '-webkit-line-clamp': b.clamp }">
                    <span v-if="b.task.status === 'done'" class="dp-check">✓ </span>{{ b.task.title }}
                  </div>
                  <div class="dp-board-sub">
                    <span>{{ TYPE_LABEL[b.task.type] }}</span>
                    <span v-if="b.task.subject">· {{ b.task.subject }}</span>
                    <span v-if="b.task.targetCount">· {{ b.task.targetCount }} 项</span>
                    <span v-if="b.task.status !== 'done'" class="dp-board-status">待办</span>
                    <span v-else class="dp-board-status done">已完成</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="board.unscheduled.length" class="dp-board-unscheduled">
              <div class="dp-board-sub-title">⏳ 未排程（{{ board.unscheduled.length }}）</div>
              <div class="dp-unsched-chips">
                <span
                  v-for="t in board.unscheduled" :key="t.id"
                  class="dp-unsched-chip"
                  :class="['st-' + t.status, { editable: canEdit, hovering: hoverTask?.id === t.id }]"
                  :title="t.title + (canEdit ? '（悬停看完整内容 / 点击标记完成）' : '（历史只读）')"
                  @click="openConfirm(t, 'done')"
                  @mouseenter="hoverTask = t"
                  @mouseleave="hoverTask = null"
                ><span v-if="t.status==='done'" class="dp-check">✓ </span>{{ TYPE_ICON[t.type] }} {{ t.title }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 多维图表网格 -->
      <div class="dp-charts-grid">
        <div class="dp-chart-card">
          <div class="dp-chart-title">🎯 四象限（艾森豪威尔）</div>
          <div ref="quadEl" class="dp-chart" style="height:340px"></div>
        </div>
        <div class="dp-chart-card">
          <div class="dp-chart-title">🛰️ 多维完成率雷达</div>
          <div ref="radarEl" class="dp-chart" style="height:340px"></div>
        </div>
        <div class="dp-chart-card">
          <div class="dp-chart-title">📊 规划 vs 实际</div>
          <div ref="compareEl" class="dp-chart" style="height:340px"></div>
        </div>
        <div class="dp-chart-card">
          <div class="dp-chart-title">🥧 任务类型分布</div>
          <div ref="typeEl" class="dp-chart" style="height:340px"></div>
        </div>
        <div class="dp-chart-card">
          <div class="dp-chart-title">⚠️ 风险任务（{{ risks.length }}）</div>
          <div ref="riskEl" class="dp-chart" style="height:340px"></div>
        </div>
        <div class="dp-chart-card">
          <div class="dp-chart-title">📈 30 天完成率趋势</div>
          <div ref="trendEl" class="dp-chart" style="height:340px"></div>
        </div>
        <div class="dp-chart-card">
          <div class="dp-chart-title">🧭 数字资产利用率</div>
          <div ref="gaugeEl" class="dp-chart" style="height:340px"></div>
        </div>
      </div>

      <!-- 完成时序：计划时刻 vs 实际完成（是否按时间顺序） -->
      <div class="dp-chart-card" style="margin-top:12px">
        <div class="dp-chart-title">⏱️ 计划时刻 vs 实际完成（绿=准时，橙=滞后，红=未完成）</div>
        <div ref="timelineEl" class="dp-chart" :style="{ height: timelineHeight }"></div>
      </div>

      <!-- 84 天热力矩阵 -->
      <div class="dp-chart-card" style="margin-top:12px">
        <div class="dp-chart-title">🔥 最近 84 天完成率热力图（GitHub 风格）</div>
        <div ref="heatEl" class="dp-chart" style="height:200px"></div>
      </div>

      <!-- 风险任务详情 -->
      <div v-if="risks.length" class="dp-risk-list">
        <div class="dp-chart-title">⚠️ 今日风险任务清单</div>
        <div v-for="(r, i) in risks" :key="i" class="dp-risk-row" :class="'sev-' + r.severity">
          <span :class="'dp-risk-badge sev-' + r.severity">{{ r.severity.toUpperCase() }}</span>
          <span class="dp-type">{{ TYPE_ICON[r.task.type] }}</span>
          <span class="dp-title">{{ r.task.title }}</span>
          <span class="dp-risk-reason">{{ r.reason }}</span>
          <span :class="'dp-tag q-' + r.task.quadrant">{{ r.task.quadrant }}</span>
        </div>
      </div>

      <!-- 任务清单 -->
      <div class="dp-tasks">
        <div class="dp-chart-title">📋 任务清单</div>
        <div v-for="t in plan.tasks" :key="t.id" class="dp-task" :class="'st-' + t.status">
          <div class="dp-task-main">
            <span class="dp-type">{{ TYPE_ICON[t.type] }} {{ TYPE_LABEL[t.type] }}</span>
            <div class="dp-task-body">
              <div class="dp-title">
                <span v-if="t.status==='done'" class="dp-check">✓ </span>{{ t.title }}
                <span v-if="t.scheduledHour != null" class="dp-meta-item">⏰ {{ t.scheduledHour }}:00</span>
              </div>
              <div class="dp-meta">
                <span :class="'dp-tag q-' + t.quadrant" @click="canEdit && toggleQuadrant(t)" title="点击切换象限">{{ t.quadrant }} {{ QUADRANT_LABEL[t.quadrant] }}</span>
                <span v-if="t.targetCount" class="dp-meta-item">🎯 {{ t.targetCount }} 项</span>
                <span v-if="t.estimatedMinutes" class="dp-meta-item">⏱ {{ t.estimatedMinutes }} 分钟</span>
                <span v-if="t.subject" class="dp-meta-item">📚 {{ t.subject }}</span>
              </div>
              <div v-if="t.completionNote" class="dp-note">💬 {{ t.completionNote }}</div>
            </div>
          </div>
          <div v-if="canEdit" class="dp-task-actions">
            <button v-if="t.status !== 'done'" class="btn small primary" @click="openConfirm(t, 'done')">✓ 完成</button>
            <button v-if="t.status !== 'partial' && t.status !== 'done'" class="btn small" @click="openConfirm(t, 'partial')">◐ 部分</button>
            <button v-if="t.status !== 'skipped' && t.status !== 'done'" class="btn small" @click="openConfirm(t, 'skipped')">✗ 跳过</button>
            <button v-if="t.status !== 'pending'" class="btn small" @click="openConfirm(t, 'pending')">↩ 恢复</button>
            <button class="btn small" @click="removeTask(t)">🗑</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 悬停放大卡：任务文字过多时，鼠标悬停 → 屏幕中央完整显示；移开恢复 -->
    <div v-if="hoverTask" class="dp-zoom-pop">
      <div class="dp-zoom-head">
        <span class="dp-zoom-type">{{ TYPE_ICON[hoverTask.type] }} {{ TYPE_LABEL[hoverTask.type] }}</span>
        <span :class="'dp-tag q-' + hoverTask.quadrant">{{ hoverTask.quadrant }} {{ QUADRANT_LABEL[hoverTask.quadrant] }}</span>
        <span class="dp-zoom-status" :class="'st-' + hoverTask.status">{{ STATUS_LABEL[hoverTask.status] }}</span>
      </div>
      <div class="dp-zoom-title">{{ hoverTask.title }}</div>
      <div class="dp-zoom-meta">
        <span v-if="hoverTask.scheduledHour != null" class="dp-meta-item">⏰ {{ hoverTask.scheduledHour }}:00</span>
        <span v-if="hoverTask.targetCount" class="dp-meta-item">🎯 {{ hoverTask.targetCount }} 项</span>
        <span v-if="hoverTask.estimatedMinutes" class="dp-meta-item">⏱ {{ hoverTask.estimatedMinutes }} 分钟</span>
        <span v-if="hoverTask.subject" class="dp-meta-item">📚 {{ hoverTask.subject }}</span>
      </div>
      <div v-if="hoverTask.completionNote" class="dp-zoom-note">💬 {{ hoverTask.completionNote }}</div>
      <div class="dp-zoom-hint">移开鼠标恢复 · 点击可打卡</div>
    </div>

    <!-- 确认弹窗：点击条目后弹出，点「确定」才标记完成 -->
    <div v-if="pendingTask" class="dp-modal-mask" @click.self="pendingTask = null">
      <div class="dp-modal">
        <div class="dp-modal-title">确认打卡</div>
        <div class="dp-modal-task">
          <span class="dp-modal-type">{{ TYPE_ICON[pendingTask.type] }} {{ TYPE_LABEL[pendingTask.type] }}</span>
          <div class="dp-modal-name">{{ pendingTask.title }}</div>
          <div class="dp-modal-meta">
            <span :class="'dp-tag q-' + pendingTask.quadrant">{{ pendingTask.quadrant }}</span>
            <span v-if="pendingTask.scheduledHour != null" class="dp-meta-item">⏰ {{ pendingTask.scheduledHour }}:00</span>
          </div>
        </div>
        <div class="dp-modal-actions">
          <button class="btn" :class="{ 'sel': confirmStatus==='done' }" :disabled="busy" @click="confirmStatus='done'">✓ 完成</button>
          <button class="btn" :class="{ 'sel': confirmStatus==='partial' }" :disabled="busy" @click="confirmStatus='partial'">◐ 部分完成</button>
          <button class="btn" :class="{ 'sel': confirmStatus==='skipped' }" :disabled="busy" @click="confirmStatus='skipped'">✗ 跳过</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="pendingTask = null">取消</button>
          <button class="btn primary" :disabled="busy" @click="confirmAction">确定</button>
        </div>
        <div class="dp-modal-hint">选择上方状态后点「确定」生效（默认：完成）</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dp-page { max-width: 1080px; margin: 0 auto; padding-bottom: 40px; }
.dp-header { margin-bottom: 16px; }
.dp-title-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.dp-title-row h2 { font-size: 20px; }
.dp-mode { font-size: 12px; padding: 2px 10px; border-radius: 10px; font-weight: 600; }
.dp-mode.m-edit { background: #e6f2e6; color: #2e7d32; }
.dp-mode.m-history { background: #eef0f3; color: #5b6470; }

.dp-datebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dp-day-chip { padding: 6px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); cursor: pointer; font-size: 13px; color: var(--ink-2); transition: all .15s; }
.dp-day-chip:hover { border-color: var(--accent); }
.dp-day-chip.active { background: var(--accent, #3a7afe); color: #fff; border-color: transparent; }
.dp-date-sep { flex: 1; border-bottom: 1px dashed var(--line); }
.dp-date-input { padding: 5px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); }
.dp-date-label { font-size: 13px; color: var(--ink-2); }

.dp-history { margin-top: 10px; display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.dp-history-title { font-size: 12px; color: var(--ink-2); margin-top: 4px; }
.dp-history-row { display: flex; gap: 6px; flex-wrap: wrap; }
.dp-history-item { display: flex; flex-direction: column; align-items: center; padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); cursor: pointer; min-width: 64px; transition: all .15s; }
.dp-history-item:hover { border-color: var(--accent); }
.dp-history-item.active { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.dp-history-date { font-size: 12px; font-weight: 600; }
.dp-history-rate { font-size: 11px; color: #2e7d32; }

.dp-input { display: flex; flex-direction: column; gap: 10px; }
.dp-textarea { resize: vertical; min-height: 90px; }
.dp-input-actions { display: flex; align-items: center; gap: 12px; justify-content: flex-end; }
.dp-llm-toggle { font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 4px; cursor: pointer; }
.dp-empty { padding: 30px; text-align: center; color: var(--ink-2); border: 1px dashed var(--line); border-radius: 12px; background: var(--panel); }

.dp-preview, .dp-plan { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 16px; }
.dp-preview-head, .dp-plan-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dp-date { font-weight: 700; font-size: 15px; margin-right: 10px; }

.dp-source { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.dp-source.src-llm { background: #e6f2ff; color: #1e40af; }
.dp-source.src-offline { background: #f0efed; color: #6b5e50; }

.dp-add { display: flex; gap: 8px; margin-bottom: 12px; }
.dp-add .input { flex: 1; }

.dp-reality { display: flex; gap: 10px; flex-wrap: wrap; padding: 10px 14px; background: color-mix(in srgb, var(--accent) 5%, transparent); border-radius: 8px; margin-bottom: 14px; }
.dp-reality-item { font-size: 13px; }
.dp-reality-item b { font-size: 15px; }

.dp-charts-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 12px; }
.dp-chart-card { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2, var(--panel)); padding: 12px; }
.dp-chart-title { font-weight: 700; font-size: 13px; margin-bottom: 8px; color: var(--ink-2); }
.dp-chart { width: 100%; }

.dp-risk-list { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 12px 0; background: color-mix(in srgb, #e8735a 4%, var(--panel)); }
.dp-risk-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; font-size: 13px; }
.dp-risk-row.sev-high { background: #fde8e8; }
.dp-risk-row.sev-medium { background: #fef3c7; }
.dp-risk-row.sev-low { background: #e6f2e6; }
.dp-risk-badge { padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 700; color: #fff; }
.dp-risk-badge.sev-high { background: #e8735a; }
.dp-risk-badge.sev-medium { background: #d4a853; }
.dp-risk-badge.sev-low { background: #7ba87b; }
.dp-risk-reason { flex: 1; color: var(--ink-2); font-style: italic; font-size: 12px; }

.dp-quad { width: 100%; margin: 10px 0; }

.dp-task-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; font-size: 13px; }
.dp-task-row:hover { background: var(--panel-2, #f7f7f9); }

.dp-tasks { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.dp-task { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; transition: all .15s; }
.dp-task.st-done { border-left: 3px solid #7ba87b; opacity: 0.78; background: rgba(123,168,123,.06); }
.dp-task.st-partial { border-left: 3px solid #d4a853; }
.dp-task.st-skipped { border-left: 3px solid #c9c4bd; opacity: 0.55; }
.dp-task.st-pending { border-left: 3px solid #e07b3c; }

.dp-task-main { flex: 1; display: flex; gap: 10px; min-width: 0; }
.dp-type { font-size: 12px; color: var(--ink-2); flex-shrink: 0; }
.dp-task-body { flex: 1; min-width: 0; }
.dp-title { font-weight: 500; }
.dp-check { color: #2e7d32; font-weight: 700; }
.dp-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 12px; color: var(--ink-2); }
.dp-meta-item { background: var(--code-inline); padding: 1px 6px; border-radius: 4px; }
.dp-note { font-size: 12px; color: var(--ink-2); margin-top: 4px; font-style: italic; }
.dp-task-actions { display: flex; gap: 4px; flex-shrink: 0; }

.dp-tag { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; cursor: default; }
.dp-tag.q-Q1 { background: #fde8e8; color: #991b1b; }
.dp-tag.q-Q2 { background: #fef3c7; color: #92400e; }
.dp-tag.q-Q3 { background: #e6f2e6; color: #2e7d32; }
.dp-tag.q-Q4 { background: #f0efed; color: #6b5e50; }
.dp-meta .dp-tag { cursor: pointer; }

/* ── 到点提醒设置条 ── */
.dp-remind-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  max-width: 720px; margin: 0 auto 10px; padding: 8px 14px;
  border: 1px dashed var(--line); border-radius: 10px; background: var(--panel-2, #f7f7f9);
  font-size: 13px;
}
.dp-remind-title { font-weight: 700; }
.dp-remind-btn {
  padding: 3px 12px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--panel); color: var(--ink-2); font-size: 12px; cursor: pointer;
  transition: all .15s;
}
.dp-remind-btn:hover { border-color: var(--accent); }
.dp-remind-btn.on { background: rgba(46,125,50,.14); border-color: #2e7d32; color: #2e7d32; }
.dp-remind-select {
  padding: 3px 8px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--panel); color: var(--ink); font-size: 12px;
}
.dp-remind-hint { font-size: 11px; color: var(--ink-2); opacity: .75; }

/* ── 今日日程表（课程表风格 · 居中）── */
.dp-board-section { margin: 16px 0; }
/* 日期信息栏：公历 + 农历 + 星期 + 实时时钟 */
.dp-date-info {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  max-width: 720px; margin: 0 auto 10px; padding: 12px 18px;
  border-radius: 12px; border: 1px solid var(--line);
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--panel)), var(--panel));
  box-shadow: 0 1px 6px rgba(0,0,0,.04);
}
.dp-date-info-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dp-di-solar { font-size: 16px; font-weight: 700; color: var(--ink); }
.dp-di-sub { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); }
.dp-di-week { font-weight: 600; color: var(--accent, #3a7afe); }
.dp-di-clock-wrap { text-align: right; flex-shrink: 0; }
.dp-di-clock {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 30px; font-weight: 700; letter-spacing: 2px;
  color: var(--accent, #3a7afe); font-variant-numeric: tabular-nums; line-height: 1.1;
}
.dp-di-clock-label { font-size: 10px; color: var(--ink-2); margin-top: 2px; }
@media (max-width: 480px) {
  .dp-di-clock { font-size: 24px; }
  .dp-di-solar { font-size: 14px; }
}
.dp-board-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.dp-legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; }
.lg { padding: 2px 8px; border-radius: 8px; border-left: 3px solid; }
.lg-done { background: rgba(123,168,123,.14); border-color: #7ba87b; }
.lg-q1 { background: #fde8e8; border-color: #e8735a; }
.lg-q2 { background: #fef3c7; border-color: #d4a853; }
.lg-q3 { background: #e6f2e6; border-color: #7ba87b; }
.lg-q4 { background: #f0efed; border-color: #9a8c7e; }
.dp-board-wrap { display: flex; justify-content: center; }
.dp-board { width: 100%; max-width: 720px; }
.dp-board-track { display: flex; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--panel); box-shadow: 0 2px 10px rgba(0,0,0,.05); }
.dp-board-hours { width: 56px; flex-shrink: 0; border-right: 1px solid var(--line); background: var(--panel-2, #f7f7f9); }
.dp-board-hour { display: flex; align-items: flex-start; justify-content: flex-end; padding: 2px 6px; font-size: 11px; color: var(--ink-2); border-bottom: 1px dashed var(--line); box-sizing: border-box; }
.dp-board-body { position: relative; flex: 1; height: 100%; align-self: stretch; background-image: repeating-linear-gradient(to bottom, var(--line) 0, var(--line) 1px, transparent 1px, 56px); }
.dp-board-block { position: absolute; border-radius: 10px; border: 1.5px solid var(--c, #9a8c7e); background: color-mix(in srgb, var(--c, #9a8c7e) 15%, var(--panel)); box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 6px 12px; box-sizing: border-box; overflow: hidden; transition: transform .12s, box-shadow .12s; }
.dp-board-block.editable { cursor: pointer; }
.dp-board-block.editable:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.15); }
.dp-board-block.st-done { border-color: #2e7d32; background: rgba(46,125,50,.16); color: #1e5631; }
.dp-board-block.st-skipped { opacity: 0.5; }
.dp-board-block-head { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink-2); }
.dp-board-time { font-weight: 600; }
.dp-board-title { font-weight: 600; font-size: 13px; margin: 2px 0; line-height: 1.25; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.dp-board-sub { font-size: 11px; color: var(--ink-2); display: flex; gap: 4px; flex-wrap: wrap; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dp-board-status { padding: 0 6px; border-radius: 6px; background: rgba(0,0,0,.05); }
.dp-board-status.done { background: rgba(46,125,50,.14); color: #2e7d32; }
.dp-board-unscheduled { margin-top: 12px; padding: 10px 12px; border: 1px dashed var(--line); border-radius: 10px; background: var(--panel-2, #f7f7f9); }
.dp-board-sub-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.dp-unsched-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dp-unsched-chip { padding: 4px 10px; border-radius: 14px; background: #ffffff; border: 1px solid var(--line); font-size: 12px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
.dp-unsched-chip.editable { cursor: pointer; }
.dp-unsched-chip.editable:hover { border-color: var(--accent); }
.dp-unsched-chip.st-done { background: rgba(123,168,123,.14); border-color: #2e7d32; }
.dp-unsched-chip.st-skipped { opacity: 0.5; }

/* ── 悬停放大卡（屏幕中央完整内容）── */
.dp-zoom-pop {
  position: fixed; left: 50%; top: 46%; z-index: 900;
  transform: translate(-50%, -50%);
  width: min(480px, 90vw); max-height: 70vh; overflow: auto;
  padding: 18px 20px; border-radius: 16px;
  background: var(--panel); color: var(--ink);
  border: 1px solid var(--line);
  box-shadow: 0 18px 50px rgba(0,0,0,.28);
  animation: dpZoomIn .16s ease-out;
  pointer-events: none; /* 纯展示，不拦截点击，保持原有交互 */
}
@keyframes dpZoomIn {
  from { opacity: 0; transform: translate(-50%, -50%) scale(.92); }
  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
.dp-zoom-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.dp-zoom-type { font-size: 13px; color: var(--ink-2); font-weight: 600; }
.dp-zoom-status { margin-left: auto; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.dp-zoom-status.st-done { background: rgba(46,125,50,.14); color: #2e7d32; }
.dp-zoom-status.st-partial { background: rgba(212,168,83,.18); color: #92400e; }
.dp-zoom-status.st-skipped { background: #f0efed; color: #6b5e50; }
.dp-zoom-status.st-pending { background: rgba(224,123,60,.14); color: #b45309; }
.dp-zoom-title { font-size: 17px; font-weight: 700; line-height: 1.5; word-break: break-word; margin-bottom: 10px; }
.dp-zoom-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.dp-zoom-note { margin-top: 10px; padding: 8px 10px; background: var(--panel-2, #f7f7f9); border-radius: 8px; font-size: 13px; color: var(--ink-2); font-style: italic; }
.dp-zoom-hint { margin-top: 12px; font-size: 11px; color: var(--ink-2); opacity: .7; text-align: center; }

/* 悬停时任务块高亮（聚焦反馈） */
.dp-board-block.hovering { box-shadow: 0 6px 20px rgba(0,0,0,.22); border-color: var(--accent, #3a7afe); }
.dp-unsched-chip.hovering { border-color: var(--accent, #3a7afe); box-shadow: 0 2px 10px rgba(0,0,0,.15); }

/* ── 确认弹窗 ── */
.dp-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dp-modal { background: var(--panel); border-radius: 14px; padding: 20px; width: min(380px, 92vw); box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.dp-modal-title { font-weight: 700; font-size: 16px; margin-bottom: 12px; }
.dp-modal-task { padding: 12px 14px; background: var(--panel-2, #f7f7f9); border-radius: 10px; margin-bottom: 14px; }
.dp-modal-type { font-size: 12px; color: var(--ink-2); }
.dp-modal-name { font-weight: 600; font-size: 15px; margin: 4px 0; }
.dp-modal-meta { display: flex; gap: 8px; }
.dp-modal-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.sel { outline: 2px solid var(--accent, #3a7afe); }
.btn.ghost { background: var(--panel-2, #f0f0f0); }
.dp-modal-hint { margin-top: 10px; font-size: 12px; color: var(--ink-2); }

@media (max-width: 720px) {
  .dp-charts-grid { grid-template-columns: 1fr; }
  .dp-task { flex-direction: column; }
  .dp-task-actions { width: 100%; flex-wrap: wrap; }
  .dp-board-hours { width: 44px; }
}
</style>
