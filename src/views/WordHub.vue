<script setup>
// 英语中心页（图1 + 今日计划卡 + 数据概览 + 签到）
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import {
  wordStats, getWordSettings, checkInToday, wordCheckinStreak,
  wordCheckinCalendar, wordReviewedToday, todayStr,
} from '../word-repo.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const router = useRouter();
const stats = ref(null);
const settings = ref(null);
const streak = ref(0);
const calendar = ref([]);
const reviewedToday = ref(0);
const checking = ref(false);

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 11) return t('views.wordHub.greetingMorning');
  if (h < 18) return t('views.wordHub.greetingAfternoon');
  return t('views.wordHub.greetingEvening');
});

const checkedToday = computed(() => calendar.value.some(c => c.date === todayStr() && c.checked));
const newGoal = computed(() => settings.value?.dailyGoal || 20);
const planProgress = computed(() => {
  if (!stats.value) return 0;
  const g = newGoal.value || 1;
  return Math.min(100, Math.round((reviewedToday.value / g) * 100));
});

const statCards = computed(() => {
  if (!stats.value) return [];
  const s = stats.value;
  return [
    { key: 'due', label: t('views.wordHub.statDue'), value: s.due },
    { key: 'mastered', label: t('views.wordHub.statMastered'), value: s.mastered },
    { key: 'newToday', label: t('views.wordHub.statNewToday'), value: s.newToday },
    { key: 'familiar', label: t('views.wordHub.statFamiliar'), value: s.familiar },
    { key: 'total', label: t('views.wordHub.statTotal'), value: s.total },
    { key: 'template', label: t('views.wordHub.statTemplate'), value: s.templates },
  ];
});

async function load() {
  stats.value = await wordStats();
  settings.value = await getWordSettings();
  streak.value = await wordCheckinStreak();
  calendar.value = await wordCheckinCalendar(35);
  reviewedToday.value = await wordReviewedToday();
}

async function doCheckIn() {
  if (checking.value || checkedToday.value) return;
  checking.value = true;
  try {
    const r = await checkInToday();
    streak.value = r.streak;
    calendar.value = await wordCheckinCalendar(35);
    toast(t('views.wordHub.checkinDone'), 'success');
  } finally {
    checking.value = false;
  }
}

const navCards = [
  { key: 'book', icon: '📘', label: t('views.wordHub.navBook'), to: '/english/book' },
  { key: 'phrases', icon: '🧩', label: t('views.wordHub.navPhrases'), to: '/english/phrases' },
  { key: 'aiModes', icon: '🤖', label: t('views.wordHub.navAiModes'), to: '/english/ai-modes' },
  { key: 'learned', icon: '📖', label: t('views.wordHub.navLearned'), to: '/english/learned' },
  { key: 'groups', icon: '🗂️', label: t('views.wordHub.navGroups'), to: '/english/groups' },
  { key: 'study', icon: '📊', label: t('views.wordHub.navStudy'), to: '/english/stats' },
  { key: 'export', icon: '🖨️', label: t('views.wordHub.navExport'), to: '/english/export' },
  { key: 'settings', icon: '⚙️', label: t('views.wordHub.navSettings'), to: '/english/settings' },
];

onMounted(load);
</script>

<template>
  <div class="hub">
    <!-- 顶部动态壁纸 + 问候 -->
    <header class="hub-hero">
      <div class="hero-wall"></div>
      <div class="hero-inner">
        <h1 class="hero-greet">{{ greeting }}</h1>
        <p class="hero-sub">{{ t('views.wordHub.subtitle') }}</p>
      </div>
    </header>

    <div class="hub-body">
      <!-- 今日计划卡 -->
      <section class="plan-card">
        <div class="plan-head">
          <span class="plan-title">📅 {{ t('views.wordHub.planTitle') }}</span>
          <button class="plan-go" @click="router.push('/english/study?mode=adaptive')">
            ▶ {{ t('views.wordHub.planStart') }}
          </button>
        </div>
        <div v-if="stats && stats.due > 0" class="plan-row">
          <div class="plan-metric">
            <b>{{ stats.due }}</b><span>{{ t('views.wordHub.planDue') }}</span>
          </div>
          <div class="plan-metric">
            <b>{{ newGoal }}</b><span>{{ t('views.wordHub.planNewGoal') }}</span>
          </div>
          <div class="plan-metric">
            <b>{{ reviewedToday }}</b><span>{{ t('views.wordHub.planReviewed') }}</span>
          </div>
        </div>
        <p v-else class="plan-empty">{{ t('views.wordHub.planEmpty') }}</p>
        <div class="plan-bar">
          <div class="plan-bar-fill" :style="{ width: planProgress + '%' }"></div>
        </div>
      </section>

      <!-- 数据概览 -->
      <section class="stat-grid">
        <div v-for="c in statCards" :key="c.key" class="stat-cell">
          <b>{{ c.value }}</b><span>{{ c.label }}</span>
        </div>
      </section>

      <!-- 签到 -->
      <section class="checkin-card">
        <div class="checkin-head">
          <span>🔥 {{ t('views.wordHub.checkinTitle') }}</span>
          <span class="checkin-streak">{{ t('views.wordHub.checkinStreak', undefined, { n: streak }) }}</span>
        </div>
        <div class="checkin-calendar">
          <div v-for="(d, i) in calendar" :key="i"
               class="cal-cell" :class="{ on: d.checked, today: d.date === todayStr() }"
               :title="d.date"></div>
        </div>
        <button class="checkin-btn" :disabled="checkedToday" @click="doCheckIn">
          {{ checkedToday ? '✓ ' + t('views.wordHub.checkinDone') : t('views.wordHub.checkinToday') }}
        </button>
        <p class="checkin-hint">{{ t('views.wordHub.checkinHint') }}</p>
      </section>

      <!-- 模块导航 -->
      <section class="nav-grid">
        <button v-for="n in navCards" :key="n.key" class="nav-cell" @click="router.push(n.to)">
          <span class="nav-icon">{{ n.icon }}</span>
          <span>{{ n.label }}</span>
        </button>
      </section>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.hub { min-height: 100%; padding-bottom: 90px; }
.hub-hero { position: relative; overflow: hidden; }
.hero-wall {
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 80% at 20% 0%, rgba(79, 124, 255, .18), transparent 60%),
    radial-gradient(120% 90% at 90% 10%, rgba(240, 138, 120, .16), transparent 55%),
    linear-gradient(160deg, var(--panel), var(--bg, #fafbff));
}
.hero-inner { position: relative; padding: 26px 20px 18px; }
.hero-greet { margin: 0; font-size: 22px; font-weight: 700; color: var(--ink); }
.hero-sub { margin: 6px 0 0; font-size: 13px; color: var(--ink-2); max-width: 560px; }

.hub-body { padding: 0 16px; display: flex; flex-direction: column; gap: 14px; margin-top: 6px; }

.plan-card, .checkin-card, .nav-grid {
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px;
}
.plan-head { display: flex; align-items: center; justify-content: space-between; }
.plan-title { font-weight: 600; color: var(--ink); }
.plan-go {
  border: none; background: var(--accent); color: #fff; border-radius: 10px;
  padding: 6px 14px; font-size: 13px; cursor: pointer;
}
.plan-row { display: flex; gap: 18px; margin: 12px 0 10px; }
.plan-metric { display: flex; flex-direction: column; }
.plan-metric b { font-size: 22px; color: var(--ink); }
.plan-metric span { font-size: 12px; color: var(--ink-2); }
.plan-empty { color: var(--ink-2); font-size: 13px; margin: 12px 0 6px; }
.plan-bar { height: 8px; background: var(--line); border-radius: 6px; overflow: hidden; }
.plan-bar-fill { height: 100%; background: var(--accent); transition: width .4s; }

.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat-cell {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 14px 10px; text-align: center;
}
.stat-cell b { display: block; font-size: 22px; color: var(--ink); }
.stat-cell span { font-size: 12px; color: var(--ink-2); }

.checkin-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; color: var(--ink); }
.checkin-streak { font-size: 13px; color: var(--accent); }
.checkin-calendar {
  display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin: 12px 0;
}
.cal-cell { aspect-ratio: 1; border-radius: 6px; background: var(--line); opacity: .5; }
.cal-cell.on { background: var(--accent); opacity: 1; }
.cal-cell.today { box-shadow: 0 0 0 2px var(--accent); }
.checkin-btn {
  width: 100%; border: none; background: var(--accent); color: #fff; border-radius: 10px;
  padding: 9px; font-size: 14px; cursor: pointer;
}
.checkin-btn:disabled { background: var(--line); color: var(--ink-2); cursor: default; }
.checkin-hint { margin: 8px 0 0; font-size: 11px; color: var(--ink-2); text-align: center; }

.nav-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.nav-cell {
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 6px;
  border: 1px solid var(--line); border-radius: 14px; background: transparent; cursor: pointer; color: var(--ink);
}
.nav-cell:hover { border-color: var(--accent); }
.nav-icon { font-size: 24px; }
.nav-cell span:last-child { font-size: 12px; }
@media (max-width: 420px) {
  .stat-grid, .nav-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
