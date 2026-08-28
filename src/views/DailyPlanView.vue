<script setup>
// 每日规划 · 打卡 · 多维图表视图（P4 重构版）
// 口述输入 → 智能解析(LLM 优先/离线回退) → 四象限 + 雷达 + 热力矩阵 + 风险 + 时间轴 + 完成对比
import { ref, computed, onMounted, nextTick, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import { toast } from '../utils/toast.js';
import {
  createDailyPlan, listDailyPlan, updateDailyTask, deleteDailyTask,
  checkinDailyTask, deleteDailyPlan, addDailyTask, appendDailyTasksByText,
} from '../repo.js';
import { parsePlanSmart } from '../utils/plan-parser.js';
import { getDailySynergy, getCompletionHeatmap } from '../utils/planSynergy.js';
import {
  quadrantOption, radarOption, heatmapOption, riskOption, scheduleOption,
  typeBreakdownOption, compareBarOption, emptyOption,
} from '../utils/planCharts.js';

// ──────────────── 常量 ────────────────

const TYPE_LABEL = { review: '复习', pomodoro: '番茄', doc: '资料', exam: '做题', note: '笔记', write: '写作', other: '其他' };
const QUADRANT_LABEL = { Q1: '重要×紧急', Q2: '重要×非紧急', Q3: '非重要×紧急', Q4: '非重要×非紧急' };
const STATUS_LABEL = { pending: '待办', done: '已完成', partial: '部分完成', skipped: '已跳过' };
const TYPE_ICON = { review: '📖', pomodoro: '🍅', doc: '📚', exam: '📝', note: '📓', write: '✍️', other: '📌' };

// ──────────────── 状态 ────────────────

const rawInput = ref('');
const parsing = ref(false);
const busy = ref(false);
const plan = ref(null);          // { plan, tasks }
const synergy = ref(null);       // 跨模块真实数据 + 完成度 + 风险
const heat = ref([]);            // 84 天热力矩阵
const preview = ref(null);       // 解析预览（未入库） { text, tasks, summary, source }
const showAddTask = ref(false);
const addInput = ref('');

// 智能解析开关（持久化）
const useLLM = ref(localStorage.getItem('sxy_plan_use_llm') !== '0');
watch(useLLM, v => localStorage.setItem('sxy_plan_use_llm', v ? '1' : '0'));

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

// ──────────────── 生命周期 ────────────────

onMounted(() => {
  loadToday();
  window.addEventListener('resize', handleResize);
});
onBeforeUnmount(() => {
  disposeAllCharts();
  window.removeEventListener('resize', handleResize);
});

// ──────────────── 数据加载 ────────────────

async function loadToday() {
  const r = await listDailyPlan();
  if (r) { plan.value = r; await refreshAll(); }
  await refreshSynergy();
  heat.value = await getCompletionHeatmap(84).catch(() => []);
  await nextTick();
  renderHeat();
}

async function refreshSynergy() {
  try {
    synergy.value = await getDailySynergy(undefined, plan.value?.tasks || null);
  } catch (e) {
    console.warn('[plan] synergy failed', e);
    synergy.value = null;
  }
}

// ──────────────── 口述 → 解析预览 ────────────────

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
    const { plan: p, tasks } = await createDailyPlan({ rawInput: preview.value.text });
    plan.value = { plan: p, tasks };
    rawInput.value = '';
    preview.value = null;
    await refreshAll();
    await refreshSynergy();
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
    toast(`追加 ${rows.length} 个任务`, 'success');
  } catch (e) {
    toast('追加失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

async function addManualTask() {
  const text = addInput.value.trim();
  if (!text || !plan.value?.plan?.id) return;
  busy.value = true;
  try {
    // 简单单任务手动加：用解析器抽字段
    const { parsePlan } = await import('../utils/plan-parser.js');
    const parsed = parsePlan(text);
    const rows = [];
    for (const p of parsed) rows.push(await addDailyTask(plan.value.plan.id, p));
    plan.value.tasks = [...(plan.value.tasks || []), ...rows];
    addInput.value = '';
    showAddTask.value = false;
    await refreshAll();
    await refreshSynergy();
    toast(`已加 ${rows.length} 个任务`, 'success');
  } catch (e) {
    toast('添加失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

// ──────────────── 打卡 / 调整 ────────────────

async function doCheckin(task, status) {
  busy.value = true;
  try {
    const note = status === 'done' ? '' : (prompt(`备注（${STATUS_LABEL[status]}原因，可留空）：`) || '');
    await checkinDailyTask(task.id, status, note);
    task.status = status;
    await refreshAll();
    await refreshSynergy();
    toast(`已${STATUS_LABEL[status]}：${task.title.slice(0, 20)}`, 'success');
  } catch (e) {
    toast('打卡失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

async function toggleQuadrant(task) {
  const order = ['Q1', 'Q2', 'Q3', 'Q4'];
  const idx = order.indexOf(task.quadrant);
  const next = order[(idx + 1) % 4];
  await updateDailyTask(task.id, { quadrant: next, important: next === 'Q1' || next === 'Q2', urgent: next === 'Q1' || next === 'Q3' });
  task.quadrant = next;
  await refreshAll();
}

async function removeTask(task) {
  if (!confirm('删除这个任务？')) return;
  await deleteDailyTask(task.id);
  plan.value.tasks = plan.value.tasks.filter(t => t.id !== task.id);
  await refreshAll();
  await refreshSynergy();
}

async function clearToday() {
  if (!plan.value?.plan?.id) return;
  if (!confirm('删除今天整份规划及所有任务？')) return;
  await deleteDailyPlan(plan.value.plan.id);
  plan.value = null;
  synergy.value = null;
}

// ──────────────── 图表渲染 ────────────────

// DOM refs
const quadEl = ref(null);
const previewQuadEl = ref(null);
const radarEl = ref(null);
const heatEl = ref(null);
const riskEl = ref(null);
const scheduleEl = ref(null);
const typeEl = ref(null);
const compareEl = ref(null);

// 图表实例
let quadChart = null, previewQuadChart = null, radarChart = null, heatChart = null;
let riskChart = null, scheduleChart = null, typeChart = null, compareChart = null;

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
  renderSchedule();
  renderType();
  renderCompare();
}

function renderQuadrant() {
  if (!quadEl.value || !plan.value?.tasks?.length) return;
  quadChart = initChart(quadEl, quadChart);
  quadChart.setOption(quadrantOption(plan.value.tasks));
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

function renderSchedule() {
  if (!scheduleEl.value) return;
  scheduleChart = initChart(scheduleEl, scheduleChart);
  const tasks = plan.value?.tasks || [];
  scheduleChart.setOption(tasks.length ? scheduleOption(tasks) : emptyOption('暂无日程'));
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

function renderHeat() {
  if (!heatEl.value || !heat.value.length) return;
  heatChart = initChart(heatEl, heatChart);
  heatChart.setOption(heatmapOption(heat.value));
}

function disposePreviewQuad() { previewQuadChart?.dispose(); previewQuadChart = null; }
function disposeAllCharts() {
  [quadChart, previewQuadChart, radarChart, heatChart, riskChart, scheduleChart, typeChart, compareChart].forEach(c => c?.dispose());
}

// 响应式 resize
function handleResize() {
  [quadChart, previewQuadChart, radarChart, heatChart, riskChart, scheduleChart, typeChart, compareChart].forEach(c => c?.resize());
}
</script>

<template>
  <div class="dp-page">
    <h2 style="margin:0 0 4px">📅 每日规划 · 打卡 · 多维分析</h2>
    <p class="hint" style="margin:0 0 16px">
      口述今日规划（如「复习 30 张卡片，最优先；下午 3 点做 10 道线代题；番茄钟 25 分钟」），
      智能解析为结构化任务 + 四象限，多维图表追踪，打卡后看「规划 vs 实绩」对比。
    </p>

    <!-- 输入区 -->
    <div v-if="!plan" class="dp-input">
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
        <button class="btn primary" :disabled="parsing" @click="submitPlan">
          {{ parsing ? '解析中…' : '🔍 解析规划' }}
        </button>
      </div>
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
        <span class="dp-tag q-{{ t.quadrant }}">{{ t.quadrant }}</span>
      </div>
      <div ref="previewQuadEl" class="dp-quad" style="height:300px"></div>
    </div>

    <!-- 今日计划 -->
    <div v-else-if="plan" class="dp-plan">
      <div class="dp-plan-head">
        <div>
          <span class="dp-date">{{ plan.plan.date }}</span>
          <span class="hint">共 {{ summary.total }} 个任务 · 完成率 {{ summary.doneRate }}% · 总达成 {{ overallRate }}%</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" @click="showAddTask = !showAddTask">➕ 中途加任务</button>
          <button class="btn" @click="rawInput=''; plan=null">重新规划</button>
          <button class="btn" @click="clearToday">删除今天</button>
        </div>
      </div>

      <!-- 中途加任务 -->
      <div v-if="showAddTask" class="dp-add">
        <input v-model="addInput" class="input" placeholder="例：背 20 个英语单词，重要；下午 4 点整理笔记" @keyup.enter="appendTasks" />
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
          <div class="dp-chart-title">⏰ 日程时间轴</div>
          <div ref="scheduleEl" class="dp-chart" style="height:340px"></div>
        </div>
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
          <span class="dp-risk-badge sev-{{ r.severity }}">{{ r.severity.toUpperCase() }}</span>
          <span class="dp-type">{{ TYPE_ICON[r.task.type] }}</span>
          <span class="dp-title">{{ r.task.title }}</span>
          <span class="dp-risk-reason">{{ r.reason }}</span>
          <span class="dp-tag q-{{ r.task.quadrant }}">{{ r.task.quadrant }}</span>
        </div>
      </div>

      <!-- 任务列表 + 打卡 -->
      <div class="dp-tasks">
        <div class="dp-chart-title">📋 任务清单</div>
        <div v-for="t in plan.tasks" :key="t.id" class="dp-task" :class="'st-' + t.status">
          <div class="dp-task-main">
            <span class="dp-type">{{ TYPE_ICON[t.type] }} {{ TYPE_LABEL[t.type] }}</span>
            <div class="dp-task-body">
              <div class="dp-title">
                {{ t.title }}
                <span v-if="t.scheduledHour != null" class="dp-meta-item">⏰ {{ t.scheduledHour }}:00</span>
              </div>
              <div class="dp-meta">
                <span class="dp-tag q-{{ t.quadrant }}" @click="toggleQuadrant(t)" title="点击切换象限">{{ t.quadrant }} {{ QUADRANT_LABEL[t.quadrant] }}</span>
                <span v-if="t.targetCount" class="dp-meta-item">🎯 {{ t.targetCount }} 项</span>
                <span v-if="t.estimatedMinutes" class="dp-meta-item">⏱ {{ t.estimatedMinutes }} 分钟</span>
                <span v-if="t.subject" class="dp-meta-item">📚 {{ t.subject }}</span>
              </div>
              <div v-if="t.completionNote" class="dp-note">💬 {{ t.completionNote }}</div>
            </div>
          </div>
          <div class="dp-task-actions">
            <button v-if="t.status !== 'done'" class="btn small primary" @click="doCheckin(t, 'done')">✓ 完成</button>
            <button v-if="t.status !== 'partial' && t.status !== 'done'" class="btn small" @click="doCheckin(t, 'partial')">◐ 部分</button>
            <button v-if="t.status !== 'skipped' && t.status !== 'done'" class="btn small" @click="doCheckin(t, 'skipped')">✗ 跳过</button>
            <button v-if="t.status !== 'pending'" class="btn small" @click="doCheckin(t, 'pending')">↩ 恢复</button>
            <button class="btn small" @click="removeTask(t)">🗑</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dp-page { max-width: 1100px; margin: 0 auto; }
.dp-input { display: flex; flex-direction: column; gap: 10px; }
.dp-textarea { resize: vertical; min-height: 90px; }
.dp-input-actions { display: flex; align-items: center; gap: 12px; justify-content: flex-end; }
.dp-llm-toggle { font-size: 12px; color: var(--ink-2); display: flex; align-items: center; gap: 4px; cursor: pointer; }

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
.dp-task.st-done { border-left: 3px solid #7ba87b; opacity: 0.7; }
.dp-task.st-partial { border-left: 3px solid #d4a853; }
.dp-task.st-skipped { border-left: 3px solid #c9c4bd; opacity: 0.55; }
.dp-task.st-pending { border-left: 3px solid #e07b3c; }

.dp-task-main { flex: 1; display: flex; gap: 10px; min-width: 0; }
.dp-type { font-size: 12px; color: var(--ink-2); flex-shrink: 0; }
.dp-task-body { flex: 1; min-width: 0; }
.dp-title { font-weight: 500; }
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

@media (max-width: 720px) {
  .dp-charts-grid { grid-template-columns: 1fr; }
  .dp-task { flex-direction: column; }
  .dp-task-actions { width: 100%; flex-wrap: wrap; }
}
</style>
