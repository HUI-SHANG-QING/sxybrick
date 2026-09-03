<script setup>
// 英语学习统计页（图11-12：累计今日/总计 + 掌握度分布 + 签到日历 + 趋势）
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { wordStats, getWordSettings, wordCheckinStreak, wordCheckinCalendar, wordReviewedToday, wordReviewedTotal, todayStr, wordStudyTimeToday, wordStudyTimeTotal, listWordCards } from '../word-repo.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const router = useRouter();
const stats = ref(null);
const settings = ref(null);
const streak = ref(0);
const calendar = ref([]);
const reviewedToday = ref(0);
const reviewedTotal = ref(0);
// 时长统计（图2：今日总时长 / 累计时长，单位分钟，v27 wordStudyLog）
const timeToday = ref(0);
const timeTotal = ref(0);
// 计划进度（图2：已学习 X / 总词数 Y + 进度条）
const learnedCount = ref(0);
const totalCount = ref(0);

// 掌握度分布（按 level 与 interval 估算）
const mastery = ref({ new: 0, learning: 0, familiar: 0, mastered: 0 });

async function load() {
  stats.value = await wordStats();
  settings.value = await getWordSettings();
  streak.value = await wordCheckinStreak();
  calendar.value = await wordCheckinCalendar(35);
  reviewedToday.value = await wordReviewedToday();
  reviewedTotal.value = await wordReviewedTotal();
  timeToday.value = Math.round(await wordStudyTimeToday() / 60000);
  timeTotal.value = Math.round(await wordStudyTimeTotal() / 60000);

  const all = await listWordCards();
  let n = 0, l = 0, f = 0, m = 0, learned = 0;
  for (const c of all) {
    if (c.kind === 'template') continue;
    if ((c.reviewedAt || 0) > 0) learned++;
    if (c.familiar) { f++; continue; }
    if ((c.reviewedAt || 0) === 0) { n++; continue; }
    if ((c.intervalDays || 0) >= 21 || (c.level || 0) >= 4) m++;
    else l++;
  }
  learnedCount.value = learned;
  totalCount.value = n + l + f + m;
  mastery.value = { new: n, learning: l, familiar: f, mastered: m };
}

// 近 14 天复习趋势（按本地记录估算：这里用累计曲线近似展示）
const trend = ref([]);
async function buildTrend() {
  // O-1：只取近 14 天复习记录（用 reviewedAt 索引裁剪），避免全量 toArray 加载全部历史。
  const { db } = await import('../db.js');
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const cutoff = new Date(d); cutoff.setDate(d.getDate() - 13);
  cutoff.setHours(0, 0, 0, 0);
  const rows = await db.wordReviews.where('reviewedAt').aboveOrEqual(cutoff.getTime()).toArray();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(d); day.setDate(d.getDate() - i);
    const key = todayStr(day);
    days.push({ date: key, label: (day.getMonth() + 1) + '/' + day.getDate(), reviewed: 0, isNew: 0 });
  }
  const map = new Map(days.map(x => [x.date, x]));
  for (const r of rows) {
    const dt = new Date(r.reviewedAt);
    const key = todayStr(dt);
    if (map.has(key)) map.get(key).reviewed++;
  }
  trend.value = days;
}

onMounted(async () => { await load(); await buildTrend(); });
</script>

<template>
  <div class="study">
    <div class="study-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordStudy.backHub') }}</button>
      <h1>{{ t('views.wordStudy.title') }}</h1>
      <p>{{ t('views.wordStudy.subtitle') }}</p>
    </div>

    <div class="study-body" v-if="stats">
      <!-- 学习计划（图2：已学习 X / 总词数 Y + 进度条） -->
      <section class="block plan-block">
        <h2>{{ t('views.wordStudy.planTitle') }}</h2>
        <div class="plan-nums">
          <span class="pn-learned">{{ t('views.wordStudy.planLearned', undefined, { n: learnedCount }) }}</span>
          <span class="pn-total">/ {{ t('views.wordStudy.planTotal', undefined, { n: totalCount }) }}</span>
        </div>
        <div class="plan-bar">
          <div class="plan-bar-fill" :style="{ width: (totalCount ? Math.min(100, Math.round(learnedCount / totalCount * 100)) : 0) + '%' }"></div>
        </div>
      </section>

      <!-- 今日 -->
      <section class="block">
        <h2>{{ t('views.wordStudy.todayTitle') }}</h2>
        <div class="mini-grid">
          <div class="mini"><b>{{ reviewedToday }}</b><span>{{ t('views.wordStudy.todayReviewed') }}</span></div>
          <div class="mini"><b>{{ stats.newToday }}</b><span>{{ t('views.wordStudy.todayNew') }}</span></div>
          <div class="mini"><b>{{ settings?.dailyGoal || 20 }}</b><span>{{ t('views.wordStudy.todayGoal') }}</span></div>
          <div class="mini"><b>{{ timeToday }}</b><span>{{ t('views.wordStudy.timeToday') }}</span></div>
        </div>
      </section>

      <!-- 累计 -->
      <section class="block">
        <h2>{{ t('views.wordStudy.totalTitle') }}</h2>
        <div class="mini-grid">
          <div class="mini"><b>{{ stats.total }}</b><span>{{ t('views.wordStudy.totalCards') }}</span></div>
          <div class="mini"><b>{{ reviewedTotal }}</b><span>{{ t('views.wordStudy.totalReviewed') }}</span></div>
          <div class="mini"><b>{{ stats.mastered }}</b><span>{{ t('views.wordStudy.totalMastered') }}</span></div>
          <div class="mini"><b>{{ stats.familiar }}</b><span>{{ t('views.wordStudy.totalFamiliar') }}</span></div>
          <div class="mini"><b>{{ stats.templates }}</b><span>{{ t('views.wordStudy.totalTemplates') }}</span></div>
          <div class="mini"><b>{{ timeTotal }}</b><span>{{ t('views.wordStudy.timeTotal') }}</span></div>
        </div>
      </section>

      <!-- 掌握度分布 -->
      <section class="block">
        <h2>{{ t('views.wordStudy.masteryTitle') }}</h2>
        <div class="mastery">
          <div class="m-bar">
            <div class="m-seg seg-new" :style="{ flex: mastery.new || .01 }"></div>
            <div class="m-seg seg-learn" :style="{ flex: mastery.learning || .01 }"></div>
            <div class="m-seg seg-fam" :style="{ flex: mastery.familiar || .01 }"></div>
            <div class="m-seg seg-mast" :style="{ flex: mastery.mastered || .01 }"></div>
          </div>
          <div class="m-legend">
            <span><i class="dot seg-new"></i>{{ t('views.wordStudy.levelNew') }} {{ mastery.new }}</span>
            <span><i class="dot seg-learn"></i>{{ t('views.wordStudy.levelLearning') }} {{ mastery.learning }}</span>
            <span><i class="dot seg-fam"></i>{{ t('views.wordStudy.levelFamiliar') }} {{ mastery.familiar }}</span>
            <span><i class="dot seg-mast"></i>{{ t('views.wordStudy.levelMastered') }} {{ mastery.mastered }}</span>
          </div>
        </div>
      </section>

      <!-- 趋势 -->
      <section class="block">
        <h2>{{ t('views.wordStudy.trendTitle') }}</h2>
        <div class="trend">
          <div v-for="d in trend" :key="d.date" class="trend-col" :title="d.date + '：' + d.reviewed">
            <div class="trend-bar" :style="{ height: Math.min(100, d.reviewed * 8) + '%' }"></div>
            <span class="trend-label">{{ d.label }}</span>
          </div>
        </div>
      </section>

      <!-- 签到日历 -->
      <section class="block">
        <h2>{{ t('views.wordStudy.calendarTitle') }}</h2>
        <p class="cal-streak" v-if="streak > 0">{{ t('views.wordStudy.calendarStreak', undefined, { n: streak }) }}</p>
        <p class="cal-streak" v-else>{{ t('views.wordStudy.calendarEmpty') }}</p>
        <div class="checkin-calendar">
          <div v-for="(c, i) in calendar" :key="i"
               class="cal-cell" :class="{ on: c.checked, today: c.date === todayStr() }" :title="c.date"></div>
        </div>
      </section>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.study { padding-bottom: 90px; }
.study-head { padding: 16px 16px 4px; }
.study-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; padding: 0; }
.study-head h1 { margin: 6px 0 2px; font-size: 20px; color: var(--ink); }
.study-head p { margin: 0; font-size: 12px; color: var(--ink-2); }
.study-body { padding: 8px 16px; display: flex; flex-direction: column; gap: 14px; }
.block { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; }
.block h2 { margin: 0 0 10px; font-size: 14px; color: var(--ink); }
.mini-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
@media (max-width: 520px) { .mini-grid { grid-template-columns: repeat(2, 1fr); } }
.mini { background: var(--bg, #f6f7fb); border-radius: 12px; padding: 12px 8px; text-align: center; }
.mini b { display: block; font-size: 20px; color: var(--ink); }
.mini span { font-size: 11px; color: var(--ink-2); }

/* 学习计划进度条 */
.plan-nums { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
.pn-learned { font-size: 22px; font-weight: 700; color: var(--accent); }
.pn-total { font-size: 13px; color: var(--ink-2); }
.plan-bar { height: 8px; background: var(--line); border-radius: 6px; overflow: hidden; }
.plan-bar-fill { height: 100%; background: var(--accent); transition: width .4s; }

.m-bar { display: flex; height: 16px; border-radius: 8px; overflow: hidden; }
.m-seg { height: 100%; }
.seg-new { background: #9ca3af; }
.seg-learn { background: #4f7cff; }
.seg-fam { background: #f0c14b; }
.seg-mast { background: #34c759; }
.m-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 12px; color: var(--ink-2); }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
.dot.seg-new { background: #9ca3af; }
.dot.seg-learn { background: #4f7cff; }
.dot.seg-fam { background: #f0c14b; }
.dot.seg-mast { background: #34c759; }

.trend { display: flex; align-items: flex-end; gap: 4px; height: 110px; }
.trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.trend-bar { width: 70%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; transition: height .3s; }
.trend-label { font-size: 9px; color: var(--ink-2); margin-top: 4px; }

.cal-streak { margin: 0 0 10px; font-size: 13px; color: var(--accent); }
.checkin-calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
.cal-cell { aspect-ratio: 1; border-radius: 6px; background: var(--line); opacity: .5; }
.cal-cell.on { background: var(--accent); opacity: 1; }
.cal-cell.today { box-shadow: 0 0 0 2px var(--accent); }
</style>
