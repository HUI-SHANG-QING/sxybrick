<script setup>
// 每日规划/打卡视图（D8.2）：口述输入 → 自动解析 → 四象限图 → 任务打卡
import { ref, computed, onMounted, nextTick, onBeforeUnmount } from 'vue';
import * as echarts from 'echarts';
import { toast } from '../utils/toast.js';
import {
  createDailyPlan, listDailyPlan, updateDailyTask, deleteDailyTask,
  checkinDailyTask, getDailyReality, deleteDailyPlan,
} from '../repo.js';
import { parsePlanWithSummary } from '../utils/plan-parser.js';

const rawInput = ref('');
const parsing = ref(false);
const plan = ref(null);          // { plan, tasks }
const reality = ref(null);       // 跨模块真实数据
const busy = ref(false);

const quadEl = ref(null);
let quadChart = null;

const TYPE_LABEL = { review: '复习', pomodoro: '番茄', doc: '资料', exam: '做题', note: '笔记', other: '其他' };
const QUADRANT_LABEL = { Q1: '重要×紧急', Q2: '重要×非紧急', Q3: '非重要×紧急', Q4: '非重要×非紧急' };
const STATUS_LABEL = { pending: '待办', done: '已完成', partial: '部分完成', skipped: '已跳过' };
const TYPE_ICON = { review: '📖', pomodoro: '🍅', doc: '📚', exam: '📝', note: '📓', other: '📌' };

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

onMounted(async () => {
  await loadToday();
});
onBeforeUnmount(() => { quadChart?.dispose(); });

async function loadToday() {
  const r = await listDailyPlan();
  if (r) { plan.value = r; renderQuadrant(); }
  reality.value = await getDailyReality();
}

/** 口述 → 解析预览 → 入库 */
async function submitPlan() {
  const text = rawInput.value.trim();
  if (!text) { toast('先写下今天的规划', 'warning'); return; }
  parsing.value = true;
  try {
    // 先预览解析结果（用户可编辑），不立即入库
    const { tasks, summary: sum } = parsePlanWithSummary(text);
    preview.value = { text, tasks, summary: sum };
    await nextTick();
    renderPreviewQuadrant();
    toast(`解析出 ${tasks.length} 个任务`, 'success');
  } catch (e) {
    toast('解析失败：' + (e?.message || e), 'error');
  } finally {
    parsing.value = false;
  }
}

const preview = ref(null);       // 解析预览（未入库）
const previewQuadEl = ref(null);
let previewQuadChart = null;

function renderPreviewQuadrant() {
  if (!previewQuadEl.value || !preview.value) return;
  previewQuadChart?.dispose();
  previewQuadChart = echarts.init(previewQuadEl.value);
  previewQuadChart.setOption(quadrantOption(preview.value.tasks));
}

/** 确认入库 */
async function confirmPlan() {
  if (!preview.value) return;
  busy.value = true;
  try {
    const { plan: p, tasks } = await createDailyPlan({ rawInput: preview.value.text });
    plan.value = { plan: p, tasks };
    rawInput.value = '';
    preview.value = null;
    await renderQuadrant();
    toast(`已入库 ${tasks.length} 个任务`, 'success');
  } catch (e) {
    toast('入库失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

function cancelPreview() { preview.value = null; previewQuadChart?.dispose(); }

// ──────────────── 四象限图（ECharts scatter） ────────────────

function quadrantOption(tasks) {
  const data = tasks.map(t => ({
    value: [t.important ? 1 : 0, t.urgent ? 1 : 0, t.title, t.status],
    name: t.title,
    itemStyle: { color: statusColor(t.status) },
  }));
  return {
    grid: { left: 50, right: 20, top: 30, bottom: 50 },
    xAxis: {
      min: -0.5, max: 1.5, name: '重要', nameLocation: 'middle', nameGap: 30,
      axisLine: { lineStyle: { color: '#ccc' } },
      splitLine: { show: false },
      axisLabel: { show: false },
    },
    yAxis: {
      min: -0.5, max: 1.5, name: '紧急', nameLocation: 'middle', nameGap: 30,
      axisLine: { lineStyle: { color: '#ccc' } },
      splitLine: { show: false },
      axisLabel: { show: false },
    },
    series: [{
      type: 'scatter',
      symbolSize: 28,
      data,
      label: { show: false },
      tooltip: {
        formatter: p => `${p.data.value[2]}<br/>状态：${STATUS_LABEL[p.data.value[3]] || '待办'}`,
      },
    }],
    // 四象限标注
    graphic: [
      { type: 'text', left: '25%', top: '10%', style: { text: 'Q2 重要非紧急', fill: '#d4a853', fontSize: 12 } },
      { type: 'text', left: '75%', top: '10%', style: { text: 'Q1 重要紧急', fill: '#e8735a', fontSize: 12, align: 'right' } },
      { type: 'text', left: '25%', top: '88%', style: { text: 'Q4 不重要不紧急', fill: '#9a8c7e', fontSize: 12 } },
      { type: 'text', left: '75%', top: '88%', style: { text: 'Q3 紧急不重要', fill: '#7ba87b', fontSize: 12, align: 'right' } },
    ],
  };
}

function statusColor(status) {
  return { done: '#7ba87b', partial: '#d4a853', skipped: '#c9c4bd', pending: '#e07b3c' }[status] || '#e07b3c';
}

async function renderQuadrant() {
  await nextTick();
  if (!quadEl.value || !plan.value?.tasks?.length) return;
  quadChart?.dispose();
  quadChart = echarts.init(quadEl.value);
  quadChart.setOption(quadrantOption(plan.value.tasks));
}

// ──────────────── 打卡 ────────────────

async function doCheckin(task, status) {
  busy.value = true;
  try {
    const note = status === 'done' ? '' : (prompt(`备注（${STATUS_LABEL[status]}原因，可留空）：`) || '');
    await checkinDailyTask(task.id, status, note);
    task.status = status;
    await renderQuadrant();
    toast(`已${STATUS_LABEL[status]}：${task.title.slice(0, 20)}`, 'success');
  } catch (e) {
    toast('打卡失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = false;
  }
}

// ──────────────── 中途调整 ────────────────

async function toggleQuadrant(task) {
  const order = ['Q1', 'Q2', 'Q3', 'Q4'];
  const idx = order.indexOf(task.quadrant);
  const next = order[(idx + 1) % 4];
  await updateDailyTask(task.id, { quadrant: next, important: next === 'Q1' || next === 'Q2', urgent: next === 'Q1' || next === 'Q3' });
  task.quadrant = next;
  await renderQuadrant();
}

async function removeTask(task) {
  if (!confirm('删除这个任务？')) return;
  await deleteDailyTask(task.id);
  plan.value.tasks = plan.value.tasks.filter(t => t.id !== task.id);
  await renderQuadrant();
}

async function clearToday() {
  if (!plan.value?.plan?.id) return;
  if (!confirm('删除今天整份规划及所有任务？')) return;
  await deleteDailyPlan(plan.value.plan.id);
  plan.value = null;
}
</script>

<template>
  <div class="dp-page">
    <h2 style="margin:0 0 4px">📅 每日规划 · 打卡</h2>
    <p class="hint" style="margin:0 0 16px">
      口述你今天的规划（如「复习 30 张卡片，最优先；番茄钟 25 分钟；看线代讲义，重要」），
      自动解析成任务 + 四象限，逐个打卡，晚上看「规划 vs 实绩」对比。
    </p>

    <!-- 输入区 -->
    <div v-if="!plan" class="dp-input">
      <textarea
        v-model="rawInput"
        class="input dp-textarea"
        rows="4"
        placeholder="例：复习 30 张卡片，最优先；番茄钟 25 分钟；看线代第三章讲义，重要；做 10 道题；刷手机"
      />
      <div class="dp-input-actions">
        <button class="btn primary" :disabled="parsing" @click="submitPlan">
          {{ parsing ? '解析中…' : '🔍 解析规划' }}
        </button>
      </div>
    </div>

    <!-- 解析预览 -->
    <div v-if="preview" class="dp-preview">
      <div class="dp-preview-head">
        <span>解析预览（确认后入库，可编辑）</span>
        <span style="flex:1"></span>
        <button class="btn primary" :disabled="busy" @click="confirmPlan">确认入库</button>
        <button class="btn" @click="cancelPreview">取消</button>
      </div>
      <div v-for="(t, i) in preview.tasks" :key="i" class="dp-task-row">
        <span class="dp-type">{{ TYPE_ICON[t.type] }} {{ TYPE_LABEL[t.type] }}</span>
        <span class="dp-title">{{ t.title }}</span>
        <span class="dp-tag q-{{ t.quadrant }}">{{ t.quadrant }}</span>
      </div>
      <div ref="previewQuadEl" class="dp-quad" style="height:300px"></div>
    </div>

    <!-- 今日计划 -->
    <div v-else-if="plan" class="dp-plan">
      <div class="dp-plan-head">
        <div>
          <span class="dp-date">{{ plan.plan.date }}</span>
          <span class="hint">共 {{ summary.total }} 个任务 · 完成率 {{ summary.doneRate }}%</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" @click="rawInput=''; plan=null">重新规划</button>
          <button class="btn" @click="clearToday">删除今天</button>
        </div>
      </div>

      <!-- 跨模块真实数据 -->
      <div v-if="reality" class="dp-reality">
        <span class="dp-reality-item">📖 今日已复习 <b>{{ reality.reviewsToday }}</b> 次</span>
        <span class="dp-reality-item">🍅 今日专注 <b>{{ reality.pomodoroMinutes }}</b> 分钟</span>
        <span class="dp-reality-item">📚 今日资料 <b>{{ reality.docsToday }}</b> 份</span>
      </div>

      <!-- 四象限图 -->
      <div ref="quadEl" class="dp-quad" style="height:360px"></div>

      <!-- 任务列表 + 打卡 -->
      <div class="dp-tasks">
        <div v-for="t in plan.tasks" :key="t.id" class="dp-task" :class="'st-' + t.status">
          <div class="dp-task-main">
            <span class="dp-type">{{ TYPE_ICON[t.type] }} {{ TYPE_LABEL[t.type] }}</span>
            <div class="dp-task-body">
              <div class="dp-title">{{ t.title }}</div>
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
.dp-page { max-width: 960px; margin: 0 auto; }
.dp-input { display: flex; flex-direction: column; gap: 10px; }
.dp-textarea { resize: vertical; min-height: 90px; }
.dp-input-actions { display: flex; justify-content: flex-end; }

.dp-preview, .dp-plan { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 16px; }
.dp-preview-head, .dp-plan-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dp-date { font-weight: 700; font-size: 15px; margin-right: 10px; }

.dp-reality { display: flex; gap: 10px; flex-wrap: wrap; padding: 10px 14px; background: color-mix(in srgb, var(--accent) 5%, transparent); border-radius: 8px; margin-bottom: 14px; }
.dp-reality-item { font-size: 13px; }
.dp-reality-item b { font-size: 15px; }

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
  .dp-task { flex-direction: column; }
  .dp-task-actions { width: 100%; flex-wrap: wrap; }
}
</style>
