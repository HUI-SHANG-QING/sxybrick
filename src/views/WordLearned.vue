<script setup>
// 全部已学（图1：复习中 / 复习完成 / 已标熟 三态列表 + 按日期筛选 + 今日词数）
// 状态判定（与 wordStats/WordStudy 掌握度口径一致）：
//   已标熟   familiar=1（用户主动标记，已移出复习队列）
//   复习完成 !familiar && intervalDays>=21 或 level>=4（调度意义上的「掌握」）
//   复习中   其余（含未复习的新词）
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { listWordCards } from '../word-repo.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const router = useRouter();
const all = ref([]);          // 全量卡（不含 template）
const tab = ref('learning');  // learning | done | familiar
const dateRange = ref('all'); // all | today | d7 | d30（按最近复习时间过滤）
const q = ref('');

const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

// 三态归类
function statusOf(c) {
  if (c.familiar) return 'familiar';
  if ((c.intervalDays || 0) >= 21 || (c.level || 0) >= 4) return 'done';
  return 'learning';
}

const counts = computed(() => {
  const o = { learning: 0, done: 0, familiar: 0 };
  for (const c of all.value) o[statusOf(c)]++;
  return o;
});

// 今日已复习词数（图1「今天 N词」）
const todayCount = computed(() => {
  const t0 = startOfToday.getTime();
  return all.value.filter((c) => (c.reviewedAt || 0) >= t0).length;
});

const dateOptions = [
  { id: 'all', label: t('views.wordLearned.dateAll') },
  { id: 'today', label: t('views.wordLearned.dateToday') },
  { id: 'd7', label: t('views.wordLearned.date7') },
  { id: 'd30', label: t('views.wordLearned.date30') },
];

const rows = computed(() => {
  let list = all.value.filter((c) => statusOf(c) === tab.value);
  const range = dateRange.value;
  if (range !== 'all') {
    const now = Date.now();
    const from = range === 'today'
      ? startOfToday.getTime()
      : now - (range === 'd7' ? 7 : 30) * 86400000;
    list = list.filter((c) => (c.reviewedAt || 0) >= from);
  }
  const kw = q.value.trim().toLowerCase();
  if (kw) {
    list = list.filter((c) =>
      (c.word || '').toLowerCase().includes(kw) ||
      (c.meaning || '').toLowerCase().includes(kw));
  }
  // 最近复习在前；从未复习的按加入时间在前
  return [...list].sort((a, b) => (b.reviewedAt || b.createdAt || 0) - (a.reviewedAt || a.createdAt || 0));
});

async function load() {
  const list = await listWordCards({ schedulableOnly: true });
  all.value = list;
}

onMounted(load);
</script>

<template>
  <div class="wl">
    <div class="wl-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordHub.title') }}</button>
      <h1>{{ t('views.wordLearned.title') }}</h1>
    </div>

    <!-- 三态 Tab + 总数 -->
    <div class="wl-tabs">
      <button v-for="tp in [
        { id: 'learning', label: t('views.wordLearned.tabLearning') },
        { id: 'done', label: t('views.wordLearned.tabDone') },
        { id: 'familiar', label: t('views.wordLearned.tabFamiliar') },
      ]" :key="tp.id" class="wl-tab" :class="{ on: tab === tp.id }" @click="tab = tp.id">
        {{ tp.label }}<span class="wl-tab-n">{{ counts[tp.id] }}</span>
      </button>
    </div>

    <!-- 日期筛选 + 今日词数 + 搜索 -->
    <div class="wl-tools">
      <div class="wl-dates">
        <button
          v-for="d in dateOptions" :key="d.id"
          class="wl-date" :class="{ on: dateRange === d.id }"
          @click="dateRange = d.id">{{ d.label }}</button>
      </div>
      <span class="wl-today">{{ t('views.wordLearned.todayCount', undefined, { n: todayCount }) }}</span>
      <input v-model="q" class="wl-search" :placeholder="t('views.wordLearned.searchPlaceholder')" />
    </div>

    <!-- 词列表 -->
    <div class="wl-list" v-if="rows.length">
      <div v-for="c in rows" :key="c.id" class="wl-row" @click="router.push('/english/book')">
        <div class="wl-word">
          <span class="wl-wtext">{{ c.word }}</span>
          <span v-if="c.phonetic" class="wl-phon">/{{ c.phonetic }}/</span>
        </div>
        <span class="wl-mean">{{ c.meaning }}</span>
        <span class="wl-st" :class="'wl-st-' + statusOf(c)">
          {{ statusOf(c) === 'familiar'
            ? t('views.wordLearned.tabFamiliar')
            : statusOf(c) === 'done'
              ? t('views.wordLearned.tabDone')
              : t('views.wordLearned.inReview') }}
        </span>
      </div>
    </div>
    <div class="wl-empty" v-else>
      <p>{{ t('views.wordLearned.empty') }}</p>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.wl { padding: 16px 16px 90px; max-width: 640px; margin: 0 auto; }
.wl-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; }
.wl-head h1 { margin: 6px 0 12px; font-size: 20px; color: var(--ink); }

.wl-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.wl-tab {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  border-radius: 12px; padding: 10px 6px; font-size: 14px; cursor: pointer; transition: .15s;
}
.wl-tab.on { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
.wl-tab-n { font-size: 12px; opacity: .85; font-variant-numeric: tabular-nums; }

.wl-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.wl-dates { display: flex; gap: 4px; }
.wl-date {
  border: 1px solid var(--line); background: transparent; border-radius: 8px;
  padding: 5px 10px; font-size: 12px; cursor: pointer; color: var(--ink-2);
}
.wl-date.on { border-color: var(--accent); color: var(--accent); background: var(--code-inline); }
.wl-today { font-size: 12px; color: var(--accent); white-space: nowrap; }
.wl-search {
  flex: 1; min-width: 120px; border: 1px solid var(--line); border-radius: 10px;
  padding: 7px 12px; background: var(--panel); color: var(--ink); font-size: 13px;
}

.wl-list { display: flex; flex-direction: column; gap: 8px; }
.wl-row {
  display: flex; align-items: center; gap: 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 12px 14px; cursor: pointer; transition: .15s;
}
.wl-row:hover { border-color: var(--accent); }
.wl-word { display: flex; align-items: baseline; gap: 8px; min-width: 40%; flex-shrink: 1; overflow: hidden; }
.wl-wtext { font-size: 16px; font-weight: 700; color: var(--ink); white-space: nowrap; }
.wl-phon { font-size: 11px; color: var(--ink-2); }
.wl-mean {
  flex: 1; font-size: 12px; color: var(--ink-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wl-st { font-size: 11px; white-space: nowrap; flex-shrink: 0; }
.wl-st-learning { color: var(--accent); }
.wl-st-done { color: #1f9255; }
.wl-st-familiar { color: #b7791f; }

.wl-empty { text-align: center; color: var(--ink-2); font-size: 13px; padding: 30px 0; }
</style>
