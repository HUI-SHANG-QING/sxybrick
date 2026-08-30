<script setup>
// 数字书房（E3 资产叙事）：你的学习资料数字资产，一次看全
// 首屏定位叙事 + 资产画廊（卡组/导图/成就/模考/总资产）+ 关于（免费·无广告·数据自持）
import { ref, computed, onMounted } from 'vue';
import { t } from '../i18n/index.js';
import { db } from '../db.js';
import { getSubjects } from '../repo.js';
import { listAchievements } from '../repo.js';
import { listExams, listMindmaps, listDocs } from '../repo.js';
import { evaluateAchievements } from '../achievements.js';
import { getTodayCount, getStreak } from '../utils/streak.js';
import { useRouter } from 'vue-router';

const router = useRouter();
const subjects = ref([]);
const counts = ref({ cards: 0, docs: 0, mindmaps: 0, exams: 0, memos: 0, graphEdges: 0, pomo: 0 });
const unlocked = ref(0);
const totalAch = ref(0);
const streak = ref(0);
const today = ref(0);

const totalAssets = computed(() =>
  counts.value.cards + counts.value.docs + counts.value.mindmaps + counts.value.exams + counts.value.memos,
);

onMounted(async () => {
  const [subj, ach] = await Promise.all([getSubjects(), evaluateAchievements()]);
  subjects.value = subj;
  unlocked.value = ach.filter(a => a.unlocked).length;
  totalAch.value = ach.length;
  counts.value = {
    cards: await db.cards.count(),
    docs: await db.docs.count(),
    mindmaps: await db.mindmaps.count(),
    exams: await db.exams.count(),
    memos: await db.memos.count(),
    graphEdges: await db.graphEdges.count(),
    pomo: await db.pomoSessions.count(),
  };
  streak.value = await getStreak();
  today.value = await getTodayCount();
});
</script>

<template>
  <div style="max-width:1000px;margin:0 auto">
    <!-- 定位叙事（落地页式首屏） -->
    <div class="lib-hero">
      <h2 style="margin:0 0 6px">{{ t('views.library.heroTitle') }}</h2>
      <p class="hint" style="margin:0 0 14px;font-size:14px;line-height:1.9">
        {{ t('views.library.hero1') }}<b>{{ t('views.library.heroBold1') }}</b>{{ t('views.library.hero2') }}<br>
        {{ t('views.library.hero3') }}<b>{{ t('views.library.heroBold2') }}</b>{{ t('views.library.hero4') }}
      </p>
      <div class="hero-pills">
        <span class="hero-pill">🗂️ {{ t('views.library.pillCards', undefined, { n: counts.cards }) }}</span>
        <span class="hero-pill">📄 {{ t('views.library.pillDocs', undefined, { n: counts.docs }) }}</span>
        <span class="hero-pill">🗺️ {{ t('views.library.pillMindmaps', undefined, { n: counts.mindmaps }) }}</span>
        <span class="hero-pill">🧪 {{ t('views.library.pillExams', undefined, { n: counts.exams }) }}</span>
        <span class="hero-pill">📝 {{ t('views.library.pillMemos', undefined, { n: counts.memos }) }}</span>
        <span class="hero-pill">🏆 {{ t('views.library.pillAch', undefined, { unlocked, total: totalAch }) }}</span>
        <span class="hero-pill">🔥 {{ t('views.library.pillStreak', undefined, { n: streak }) }}</span>
        <span class="hero-pill">📖 {{ t('views.library.pillToday', undefined, { n: today }) }}</span>
      </div>
      <div class="hint" style="margin-top:12px">{{ t('views.library.assetsLabel') }}<b style="color:var(--accent);font-size:16px">{{ totalAssets }}</b>{{ t('views.library.assetsSuffix') }}</div>
    </div>

    <!-- 资产画廊：科目书架 -->
    <div class="lib-section">
      <div class="lib-title">{{ t('views.library.shelfTitle') }}</div>
      <div class="shelf">
        <div v-for="s in subjects" :key="s.name" class="book" :class="{ empty: !s.count }" :title="t('views.library.bookTitle', undefined, { name: s.name, count: s.count })" @click="router.push(`/cards?subject=${encodeURIComponent(s.name)}`)">
          <div class="book-spine" :style="{ background: `hsl(${(subjects.indexOf(s) * 47) % 360} 55% 45%)` }">{{ s.name.slice(0, 1) }}</div>
          <div class="book-name">{{ s.name }}</div>
          <div class="book-n">{{ t('views.library.bookN', undefined, { n: s.count }) }}</div>
        </div>
      </div>
    </div>

    <!-- 资产画廊：其他资产与快捷入口 -->
    <div class="lib-section">
      <div class="lib-title">{{ t('views.library.shortcutTitle') }}</div>
      <div class="shortcuts">
        <div class="shortcut" @click="router.push('/cards')"><span class="sc-icon">🗂️</span><span>{{ t('views.library.scCards', undefined, { n: counts.cards }) }}</span></div>
        <div class="shortcut" @click="router.push('/wrong')"><span class="sc-icon">❌</span><span>{{ t('views.library.scWrong') }}</span></div>
        <div class="shortcut" @click="router.push('/review')"><span class="sc-icon">🧠</span><span>{{ t('views.library.scReview') }}</span></div>
        <div class="shortcut" @click="router.push('/plans')"><span class="sc-icon">📋</span><span>{{ t('views.library.scPlans') }}</span></div>
        <div class="shortcut" @click="router.push('/mindmap')"><span class="sc-icon">🗺️</span><span>{{ t('views.library.scMindmap', undefined, { n: counts.mindmaps }) }}</span></div>
        <div class="shortcut" @click="router.push('/docs')"><span class="sc-icon">📄</span><span>{{ t('views.library.scDocs', undefined, { n: counts.docs }) }}</span></div>
        <div class="shortcut" @click="router.push('/graph')"><span class="sc-icon">🔗</span><span>{{ t('views.library.scGraph') }}</span></div>
        <div class="shortcut" @click="router.push('/exam')"><span class="sc-icon">🧪</span><span>{{ t('views.library.scExam', undefined, { n: counts.exams }) }}</span></div>
        <div class="shortcut" @click="router.push('/achievements')"><span class="sc-icon">🏆</span><span>{{ t('views.library.scAch', undefined, { unlocked, total: totalAch }) }}</span></div>
        <div class="shortcut" @click="router.push('/health')"><span class="sc-icon">🩺</span><span>{{ t('views.library.scHealth') }}</span></div>
        <div class="shortcut" @click="router.push('/sync')"><span class="sc-icon">🔄</span><span>{{ t('views.library.scSync') }}</span></div>
      </div>
    </div>

    <!-- 关于 -->
    <div class="lib-section">
      <div class="lib-title">{{ t('views.library.aboutTitle') }}</div>
      <p class="hint" style="line-height:1.9;margin:0">
        {{ t('views.library.about') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.lib-hero { background: linear-gradient(135deg, var(--panel), var(--code-bg)); border: 1px solid var(--line); border-radius: var(--radius); padding: 26px 28px; text-align: center; margin-bottom: 16px; }
.hero-pills { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.hero-pill { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 6px 14px; font-size: 13px; }
.lib-section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 16px; }
.lib-title { font-weight: 700; margin-bottom: 12px; font-size: 15px; }
.shelf { display: flex; gap: 12px; flex-wrap: wrap; }
.book { width: 110px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; text-align: center; transition: transform .15s, box-shadow .15s; background: var(--code-bg); }
.book:hover { transform: translateY(-4px); box-shadow: 0 8px 18px rgba(0,0,0,.08); }
.book.empty { opacity: .55; }
.book-spine { width: 40px; height: 52px; margin: 0 auto 8px; border-radius: 6px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; box-shadow: inset -4px 0 rgba(0,0,0,.18); }
.book-name { font-size: 13px; font-weight: 600; }
.book-n { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.shortcuts { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.shortcut { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; font-size: 14px; transition: border-color .15s; }
.shortcut:hover { border-color: var(--accent); }
.sc-icon { font-size: 20px; }
</style>