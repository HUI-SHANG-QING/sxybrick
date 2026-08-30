<script setup>
// 学习数字孪生 Dashboard：聚合卡片/复习/计划/导图/图谱/番茄/成就为一幅总览，最大化数字资产价值
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { getStats, weakCards, listPlans, listMindmaps, listGraphEdges, countPomoToday, listAchievements, listDocs, listExams } from '../repo.js';
import { db } from '../db.js';
import { hasAIKey, getAIConfig, chatAI } from '../ai.js';
import { toast } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import { t } from '../i18n/index.js';

const router = useRouter();
const stats = ref(null);
const weak = ref([]);
const plans = ref([]);
const assets = ref({});
const coachMsg = ref('');
const coachLoading = ref(false);
const trendEl = ref(null);
let trendChart = null;

const todayDue = computed(() => stats.value?.dueToday || 0);
const todayDone = computed(() => stats.value?.todayReviews || 0);
const avgMastery = computed(() => stats.value?.avgMastery || 0);

async function load() {
  const [s, w, p, mm, ge, pomo, ach, docs, exams] = await Promise.all([
    getStats(), weakCards(3), listPlans(),
    listMindmaps(), listGraphEdges(), countPomoToday(),
    listAchievements(), listDocs(), listExams(),
  ]);
  stats.value = s;
  weak.value = w;
  plans.value = (p || []).filter(x => x.status === 'active').slice(0, 4);
  const reviewsCount = await db.reviews.count();
  assets.value = {
    cards: s.totalCards, reviews: reviewsCount, plans: p?.length || 0,
    mindmaps: mm.length, graphEdges: ge.length, pomoToday: pomo,
    achievements: ach.length, docs: docs.length, exams: exams.length,
  };
  renderTrend();
}

function renderTrend() {
  if (!trendEl.value || !stats.value?.trend) return;
  if (!trendChart) trendChart = echarts.init(trendEl.value);
  const trend = stats.value.trend;
  trendChart.setOption({
    grid: { left: 28, right: 8, top: 8, bottom: 20 },
    tooltip: { trigger: 'axis', formatter: p => `${p[0].name}<br/>${t('views.dashboard.trendTip', undefined, { v: p[0].value })}` },
    xAxis: { type: 'category', data: trend.map(x => x.date), axisLabel: { color: '#888', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#888', fontSize: 10 }, splitLine: { lineStyle: { color: 'var(--line)' } } },
    series: [{ type: 'bar', data: trend.map(x => x.count), itemStyle: { color: '#4a9eff', borderRadius: [3, 3, 0, 0] } }],
  });
}

// 图表实例必须随组件销毁（2026-08-29 修复）：
//   Dashboard 是根路由，此前全程只 init 不 dispose → 每次进出首页泄漏一个 ECharts 实例
//   （canvas + zrender 状态，约 3~5MB），反复进出会耗尽浏览器 canvas 配额导致整页崩溃。
onBeforeUnmount(() => {
  try { trendChart?.dispose(); } catch { /* 容器已先卸载时忽略 */ }
  trendChart = null;
});

// 365 天热力图（GitHub 式）
const heatCells = computed(() => {
  if (!stats.value?.heatmap) return [];
  const cells = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 从 364 天前到今天，按周列排
  const start = new Date(today); start.setDate(start.getDate() - 364);
  // 对齐到周日开始
  const startDay = start.getDay();
  const gridStart = new Date(start); gridStart.setDate(gridStart.getDate() - startDay);
  const cur = new Date(gridStart);
  while (cur <= today) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    const n = stats.value.heatmap[key] || 0;
    cells.push({ key, count: n, future: cur > today });
    cur.setDate(cur.getDate() + 1);
  }
  return cells;
});
function heatColor(n) {
  if (!n) return 'var(--code-bg)';
  if (n >= 10) return '#2cbe4e';
  if (n >= 5) return '#5cd66a';
  if (n >= 2) return '#94e8a8';
  return '#c6f0d0';
}

// AI 教练每日总结
async function askCoach() {
  if (!hasAIKey()) { toast(t('views.dashboard.toastFillKey'), 'error'); return; }
  coachLoading.value = true;
  try {
    const s = stats.value;
    const weakList = weak.value.map(w => w.front?.slice(0, 30)).join('、');
    const prompt = `你是学习教练。基于今日数据：总卡片${s.totalCards}，今日已复习${todayDone.value}张，今日到期${todayDue.value}张，平均掌握度${s.avgMastery}%，能力四维(掌握/正确/稳定/覆盖)=${s.ability.mastery}/${s.ability.correct}/${s.ability.stable}/${s.ability.coverage}。薄弱点：${weakList}。请用 2-3 句给出今日下一步建议（要具体、可执行）。`;
    const r = await chatAI([{ role: 'user', content: prompt }], getAIConfig());
    coachMsg.value = String(r).slice(0, 400);
  } catch (e) { toast(t('views.dashboard.coachFail') + e.message, 'error'); }
  finally { coachLoading.value = false; }
}

function go(path) { router.push(path); }
// 无标签卡 → 跳卡片库仅显示无标签卡（?untagged=1）
function goUntagged() { router.push('/cards?untagged=1'); }
// 点击科目 → 跳卡片库自动筛选该科目（?subject=X）
function goSubject(name) { router.push(`/cards?subject=${encodeURIComponent(name)}`); }
// 点击薄弱点具体一张卡 → 打开该卡（?id=X）
function goWeak(w) { router.push(`/cards?id=${encodeURIComponent(w.id)}`); }
// 点击具体计划 → 跳计划页定位该计划（?id=X）
function goPlan(p) { router.push(`/plans?id=${encodeURIComponent(p.id)}`); }
const abilityItems = computed(() => stats.value ? [
  { label: t('views.dashboard.abilityMastery'), v: stats.value.ability.mastery },
  { label: t('views.dashboard.abilityCorrect'), v: stats.value.ability.correct },
  { label: t('views.dashboard.abilityStable'), v: stats.value.ability.stable },
  { label: t('views.dashboard.abilityCoverage'), v: stats.value.ability.coverage },
] : []);

onMounted(async () => { await load(); if (hasAIKey()) askCoach(); });
</script>

<template>
  <div class="ds-wrap">
    <!-- Hero：今日聚焦 -->
    <div class="ds-hero">
      <div class="ds-hero-main">
        <div class="ds-due">{{ todayDue }}</div>
        <div class="ds-due-label">{{ t('views.dashboard.dueLabel') }}</div>
        <button class="btn primary ds-go" @click="go('/review')">{{ todayDue ? t('views.dashboard.startReview') : t('views.dashboard.startReviewNone') }} →</button>
      </div>
      <div class="ds-hero-side">
        <div class="ds-mini"><span class="ds-mini-n">{{ todayDone }}</span><span class="ds-mini-l">{{ t('views.dashboard.doneLabel') }}</span></div>
        <div class="ds-mini"><span class="ds-mini-n">{{ avgMastery }}%</span><span class="ds-mini-l">{{ t('views.dashboard.masteryLabel') }}</span></div>
        <div class="ds-mini"><span class="ds-mini-n">{{ assets.pomoToday }}</span><span class="ds-mini-l">{{ t('views.dashboard.pomoLabel') }}</span></div>
      </div>
    </div>

    <!-- AI 教练 -->
    <div class="ds-coach">
      <span class="ds-coach-badge">{{ t('views.dashboard.coachBadge') }}</span>
      <span v-if="coachLoading" class="hint">{{ t('views.dashboard.coachAnalyzing') }}</span>
      <span v-else-if="coachMsg" class="ds-coach-msg">{{ coachMsg }}</span>
      <button v-else class="chip" @click="askCoach">{{ t('views.dashboard.coachGet') }}</button>
    </div>

    <!-- 数字资产网格 -->
    <h3 class="ds-sec">{{ t('views.dashboard.assetsTitle') }}</h3>
    <div class="ds-grid">
      <div class="ds-asset" @click="go('/cards')"><span class="ds-asset-n">{{ assets.cards }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetCards') }}</span></div>
      <div class="ds-asset" @click="go('/wrong')"><span class="ds-asset-n">{{ weak.length }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetWeak') }}</span></div>
      <div class="ds-asset" @click="go('/plans')"><span class="ds-asset-n">{{ assets.plans }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetPlans') }}</span></div>
      <div class="ds-asset" @click="go('/mindmap')"><span class="ds-asset-n">{{ assets.mindmaps }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetMindmap') }}</span></div>
      <div class="ds-asset" @click="go('/graph')"><span class="ds-asset-n">{{ assets.graphEdges }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetGraph') }}</span></div>
      <div class="ds-asset" @click="go('/docs')"><span class="ds-asset-n">{{ assets.docs }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetDocs') }}</span></div>
      <div class="ds-asset" @click="go('/exam')"><span class="ds-asset-n">{{ assets.exams }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetExam') }}</span></div>
      <div class="ds-asset" @click="go('/achievements')"><span class="ds-asset-n">{{ assets.achievements }}</span><span class="ds-asset-l">{{ t('views.dashboard.assetAch') }}</span></div>
    </div>

    <div class="ds-row">
      <!-- 能力四维 -->
      <div class="ds-card">
        <h3 class="ds-sec" style="margin-top:0">{{ t('views.dashboard.abilityTitle') }}</h3>
        <div v-for="a in abilityItems" :key="a.label" class="ds-bar">
          <div class="ds-bar-head"><span>{{ a.label }}</span><span>{{ a.v }}%</span></div>
          <div class="ds-bar-track"><div class="ds-bar-fill" :style="{ width: a.v + '%' }"></div></div>
        </div>
      </div>
      <!-- 近 14 天趋势 -->
      <div class="ds-card">
        <h3 class="ds-sec" style="margin-top:0">{{ t('views.dashboard.trendTitle') }}</h3>
        <div ref="trendEl" class="ds-trend"></div>
      </div>
    </div>

    <!-- 365 热力图 -->
    <div class="ds-card">
      <h3 class="ds-sec" style="margin-top:0">{{ t('views.dashboard.heatTitle') }}</h3>
      <div class="ds-heat">
        <span v-for="c in heatCells" :key="c.key" class="ds-heat-cell"
          :style="{ background: c.future ? 'transparent' : heatColor(c.count) }"
          :title="t('views.dashboard.heatCellTitle', undefined, { key: c.key, count: c.count })"></span>
      </div>
      <div class="ds-heat-legend"><span>{{ t('views.dashboard.heatLess') }}</span><span class="ds-heat-cell" style="background:var(--code-bg)"></span><span class="ds-heat-cell" style="background:#c6f0d0"></span><span class="ds-heat-cell" style="background:#94e8a8"></span><span class="ds-heat-cell" style="background:#5cd66a"></span><span class="ds-heat-cell" style="background:#2cbe4e"></span><span>{{ t('views.dashboard.heatMore') }}</span></div>
    </div>

    <div class="ds-row">
      <!-- 各科掌握度 -->
      <div class="ds-card">
        <h3 class="ds-sec" style="margin-top:0">{{ t('views.dashboard.masteryBySubject') }}</h3>
        <div v-if="stats?.mastery?.length">
          <div v-for="m in stats.mastery" :key="m.subject" class="ds-bar" :title="t('views.dashboard.subjectTitle', undefined, { subject: m.subject })" @click="goSubject(m.subject)">
            <div class="ds-bar-head"><span>{{ m.subject }}</span><span>{{ m.mastery }}% · {{ m.reviews }}{{ t('views.dashboard.reviewsUnit') }}</span></div>
            <div class="ds-bar-track"><div class="ds-bar-fill" :style="{ width: m.mastery + '%' }"></div></div>
          </div>
        </div>
        <EmptyState v-else compact icon="📊" :title="t('views.dashboard.emptyMasteryTitle')" :message="t('views.dashboard.emptyMasteryMsg')" />
      </div>
      <!-- 薄弱点 + 今日计划 -->
      <div class="ds-card">
        <h3 class="ds-sec" style="margin-top:0">{{ t('views.dashboard.weakTitle') }}</h3>
        <div v-if="weak.length">
          <div v-for="w in weak" :key="w.id" class="ds-weak" :title="t('views.dashboard.weakTitleTip')" @click.stop="goWeak(w)">
            <span class="ds-weak-front">{{ String(w.front).slice(0, 28) }}</span>
            <span class="ds-weak-fail">{{ t('views.dashboard.weakFail', undefined, { n: w.failCount }) }}</span>
          </div>
        </div>
        <EmptyState v-else compact icon="📊" :title="t('views.dashboard.emptyWeakTitle')" :message="t('views.dashboard.emptyWeakMsg')" />
        <h3 class="ds-sec">{{ t('views.dashboard.plansTitle') }}</h3>
        <div v-if="plans.length">
          <div v-for="p in plans" :key="p.id" class="ds-weak" :title="t('views.dashboard.planTitleTip')" @click.stop="goPlan(p)">
            <span class="ds-weak-front">{{ String(p.title).slice(0, 24) }}</span>
            <span class="ds-weak-fail">{{ p.status }}</span>
          </div>
        </div>
        <EmptyState v-else compact icon="📊" :title="t('views.dashboard.emptyPlanTitle')" :message="t('views.dashboard.emptyPlanMsg')" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ds-wrap { max-width: 1100px; margin: 0 auto; }
.ds-sec { font-size: 14px; color: var(--ink-2); margin: 18px 0 10px; font-weight: 600; }
.ds-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.ds-hero-main { background: linear-gradient(135deg, var(--accent), #2cbe4e); border-radius: 16px; padding: 22px; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ds-due { font-size: 52px; font-weight: 800; line-height: 1; }
.ds-due-label { font-size: 13px; opacity: .9; margin: 4px 0 12px; }
.ds-go { background: #fff !important; color: var(--accent) !important; border: none; font-weight: 600; }
.ds-hero-side { display: grid; grid-template-rows: 1fr 1fr 1fr; gap: 10px; }
.ds-mini { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; }
.ds-mini-n { font-size: 22px; font-weight: 700; color: var(--accent); }
.ds-mini-l { font-size: 12px; color: var(--ink-2); }
.ds-coach { background: var(--panel); border: 1px solid var(--accent); border-radius: 12px; padding: 12px 16px; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ds-coach-badge { background: var(--accent); color: #fff; font-size: 12px; padding: 3px 10px; border-radius: 999px; font-weight: 600; }
.ds-coach-msg { font-size: 13px; color: var(--ink); line-height: 1.6; }
.ds-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 10px; }
.ds-asset { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 8px; text-align: center; cursor: pointer; transition: .15s; }
.ds-asset:hover { border-color: var(--accent); transform: translateY(-2px); }
.ds-asset-n { display: block; font-size: 22px; font-weight: 700; color: var(--ink); }
.ds-asset-l { display: block; font-size: 11px; color: var(--ink-2); margin-top: 4px; }
.ds-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ds-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-top: 14px; }
.ds-bar { margin-bottom: 10px; }
.ds-bar-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; color: var(--ink); }
.ds-bar-track { height: 8px; background: var(--code-bg); border-radius: 999px; overflow: hidden; }
.ds-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #2cbe4e); border-radius: 999px; transition: width .4s; }
.ds-trend { width: 100%; height: 180px; }
.ds-heat { display: grid; grid-template-columns: repeat(53, 1fr); gap: 2px; }
.ds-heat-cell { width: 100%; aspect-ratio: 1; border-radius: 2px; min-height: 10px; }
.ds-heat-legend { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-2); margin-top: 8px; justify-content: flex-end; }
.ds-heat-legend .ds-heat-cell { width: 12px; height: 12px; min-height: 12px; }
.ds-weak { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px; border-radius: 6px; cursor: pointer; }
.ds-weak:hover { background: var(--code-bg); }
.ds-weak-front { font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ds-weak-fail { font-size: 11px; color: var(--red); flex-shrink: 0; margin-left: 8px; }
@media (max-width: 760px) {
  .ds-hero { grid-template-columns: 1fr; }
  .ds-hero-side { grid-template-rows: none; grid-template-columns: 1fr 1fr 1fr; }
  .ds-grid { grid-template-columns: repeat(4, 1fr); }
  .ds-row { grid-template-columns: 1fr; }
  .ds-heat { grid-template-columns: repeat(26, 1fr); }
}
</style>