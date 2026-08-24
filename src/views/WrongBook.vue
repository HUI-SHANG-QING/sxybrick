<script setup>
// 错题集：独立页面，汇总所有错题（手动标记 + 遗忘多次），支持筛选/复习/取消标记
import { ref, onMounted } from 'vue';
import { db } from '../db.js';
import { weakCards, setMarked, getSubjects, gradeCard } from '../repo.js';
import { toast } from '../utils/toast.js';

const items = ref([]);
const subjects = ref([]);
const filterSubject = ref('');

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function load() {
  const w = await weakCards(1000, 1);
  items.value = w.filter(c => !filterSubject.value || c.subject === filterSubject.value);
}
async function loadSubjects() { subjects.value = await getSubjects(); }

async function unmark(card) {
  await setMarked(card.id, false);
  toast('已取消错题标记', 'success');
  await load();
}
async function dueNow(card) {
  await db.cards.put({ ...card, dueAt: Date.now(), updatedAt: Date.now() });
  toast('已加入今日复习，去「背诵」页练习', 'success');
}
function reason(c) {
  if (c.wrongReason) return c.wrongReason;
  if (c.marked) return '手动标记';
  return `遗忘 ${c.failCount || 0} 次`;
}

onMounted(() => { load(); loadSubjects(); });
</script>

<template>
  <div style="max-width:820px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">错题集</h2>
      <span class="hint">共 {{ items.length }} 道错题</span>
      <span style="flex:1"></span>
      <select v-model="filterSubject" class="input" style="width:auto" @change="load">
        <option value="">全部科目</option>
        <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
      </select>
    </div>

    <div v-if="!items.length" class="hint" style="text-align:center;padding:60px">暂无错题，继续保持！</div>

    <div v-for="c in items" :key="c.id" class="wb-item">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="chip">{{ c.subject || '未分类' }}</span>
        <span class="chip" style="color:var(--red);border-color:var(--red)">{{ reason(c) }}</span>
        <span class="hint" style="font-size:12px">{{ gradeCard(c).label }}</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="dueNow(c)">加入复习</button>
        <button class="btn small danger" @click="unmark(c)">取消标记</button>
      </div>
      <div class="wb-front">{{ plain(c.front) }}</div>
      <div class="wb-back">{{ plain(c.back) }}</div>
    </div>
  </div>
</template>

<style scoped>
.wb-item { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--red); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; }
.wb-front { font-weight: 600; line-height: 1.6; }
.wb-back { color: var(--ink-2); margin-top: 6px; line-height: 1.6; font-size: 14px; }
</style>