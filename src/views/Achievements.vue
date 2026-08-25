<script setup>
// 成就体系（借鉴 Progress AI，纯本地判定）：进入页面即时评估，新解锁自动落库并随数据包同步
import { ref, onMounted } from 'vue';
import { evaluateAchievements } from '../achievements.js';
import { unlockAchievement } from '../repo.js';
import { toast } from '../utils/toast.js';

const items = ref([]);
const unlockedCount = ref(0);
const checking = ref(true);

function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function refresh() {
  checking.value = true;
  try {
    const all = await evaluateAchievements();
    const fresh = [];
    for (const a of all) {
      if (!a.unlocked && a.value >= a.goal) {
        if (await unlockAchievement(a.key)) fresh.push(a.name);
      }
    }
    items.value = await evaluateAchievements();
    unlockedCount.value = items.value.filter(x => x.unlocked).length;
    if (fresh.length) {
      toast(`🎉 解锁新成就：${fresh.join('、')}`, 'success', 4000);
    }
  } finally { checking.value = false; }
}

onMounted(refresh);
</script>

<template>
  <div class="ach-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">成就</h2>
      <span class="hint">{{ checking ? '评估中…' : `已解锁 ${unlockedCount} / ${items.length}` }}</span>
      <span style="flex:1"></span>
      <button class="btn small" @click="refresh">重新评估</button>
    </div>
    <p class="hint" style="margin:4px 0 14px">跟着你的学习足迹自动解锁：建卡、复习、打卡、专注、图谱、文档、计划……成就数据保存在本机并跨设备同步。</p>

    <div class="ach-grid">
      <div v-for="a in items" :key="a.key" class="ach-card" :class="{ unlocked: a.unlocked }">
        <div class="ach-icon">{{ a.icon }}</div>
        <div class="ach-name">{{ a.name }}</div>
        <div class="ach-desc">{{ a.desc }}</div>
        <div v-if="a.unlocked" class="ach-date">解锁于 {{ fmtDate(a.unlockedAt) }}</div>
        <div v-else class="ach-progress">
          <div class="bar"><div class="fill" :style="{ width: Math.round(a.progress * 100) + '%' }"></div></div>
          <div class="ach-num">{{ Math.round(Math.min(a.value, a.goal)) }} / {{ a.goal }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ach-wrap { max-width: 900px; margin: 0 auto; }
.ach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.ach-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 14px; text-align: center; opacity: 0.75; }
.ach-card.unlocked { opacity: 1; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.ach-icon { font-size: 30px; }
.ach-name { font-weight: 700; margin-top: 6px; }
.ach-desc { font-size: 12px; color: var(--ink-2); margin-top: 4px; min-height: 30px; }
.ach-date { font-size: 11px; color: var(--green); margin-top: 6px; }
.ach-progress { margin-top: 8px; }
.bar { height: 6px; background: var(--code-inline); border-radius: 999px; overflow: hidden; }
.fill { height: 100%; background: var(--accent); border-radius: 999px; }
.ach-num { font-size: 11px; color: var(--ink-2); margin-top: 4px; }
</style>