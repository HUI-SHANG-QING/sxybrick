<script setup>
// 数字书房（E3 资产叙事）：你的学习资料数字资产，一次看全
// 首屏定位叙事 + 资产画廊（卡组/导图/成就/模考/总资产）+ 关于（免费·无广告·数据自持）
import { ref, computed, onMounted } from 'vue';
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
      <h2 style="margin:0 0 6px">你的知识资产，永远属于你</h2>
      <p class="hint" style="margin:0 0 14px;font-size:14px;line-height:1.9">
        这里是你的<b>数字书房</b>：卡片、笔记、导图、成绩、徽章——你亲手积累的每一份学习资料，<br>
        都存在你自己的设备里：<b>免费 · 无广告 · 数据自持</b>，导出即带走，同步不出内网。
      </p>
      <div class="hero-pills">
        <span class="hero-pill">🗂️ {{ counts.cards }} 张卡片</span>
        <span class="hero-pill">📄 {{ counts.docs }} 篇文档</span>
        <span class="hero-pill">🗺️ {{ counts.mindmaps }} 张导图</span>
        <span class="hero-pill">🧪 {{ counts.exams }} 场模考</span>
        <span class="hero-pill">📝 {{ counts.memos }} 条备忘</span>
        <span class="hero-pill">🏆 {{ unlocked }}/{{ totalAch }} 成就</span>
        <span class="hero-pill">🔥 连续 {{ streak }} 天</span>
        <span class="hero-pill">📖 今日已背 {{ today }} 张</span>
      </div>
      <div class="hint" style="margin-top:12px">数字资产合计：<b style="color:var(--accent);font-size:16px">{{ totalAssets }}</b> 件 · 全部可导出 / 可同步 / 永不丢失</div>
    </div>

    <!-- 资产画廊：科目书架 -->
    <div class="lib-section">
      <div class="lib-title">科目书架</div>
      <div class="shelf">
        <div v-for="s in subjects" :key="s.name" class="book" :class="{ empty: !s.count }" @click="router.push('/')">
          <div class="book-spine" :style="{ background: `hsl(${(subjects.indexOf(s) * 47) % 360} 55% 45%)` }">{{ s.name.slice(0, 1) }}</div>
          <div class="book-name">{{ s.name }}</div>
          <div class="book-n">{{ s.count }} 卡</div>
        </div>
      </div>
    </div>

    <!-- 资产画廊：其他资产与快捷入口 -->
    <div class="lib-section">
      <div class="lib-title">资产捷径</div>
      <div class="shortcuts">
        <div class="shortcut" @click="router.push('/mindmap')"><span class="sc-icon">🗺️</span><span>思维导图（{{ counts.mindmaps }}）</span></div>
        <div class="shortcut" @click="router.push('/docs')"><span class="sc-icon">📄</span><span>AI 文档（{{ counts.docs }}）</span></div>
        <div class="shortcut" @click="router.push('/exam')"><span class="sc-icon">🧪</span><span>模考成绩（{{ counts.exams }}）</span></div>
        <div class="shortcut" @click="router.push('/achievements')"><span class="sc-icon">🏆</span><span>成就徽章（{{ unlocked }}/{{ totalAch }}）</span></div>
        <div class="shortcut" @click="router.push('/health')"><span class="sc-icon">🩺</span><span>资产体检</span></div>
        <div class="shortcut" @click="router.push('/sync')"><span class="sc-icon">🔄</span><span>资产同步与备份</span></div>
      </div>
    </div>

    <!-- 关于 -->
    <div class="lib-section">
      <div class="lib-title">关于 SxyBrick</div>
      <p class="hint" style="line-height:1.9;margin:0">
        本地优先记忆卡片应用：所有数据存于你的浏览器 IndexedDB，不经过任何服务器。支持手动数据包（含全部 14 类数据）与局域网一键同步（hub 中枢）跨设备合并；8 种界面风格 × 白天/夜间/护眼三模式；AI 能力支持自备密钥接入任意 OpenAI 兼容端点。用于考研复习、语言学习与日常知识管理。
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