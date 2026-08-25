<script setup>
// 错题集：独立页面，汇总所有错题（手动标记 + 遗忘多次），支持筛选/复习/取消标记
// P0 增补：AI 变式补卡（错题→生成同考点变式题，写入卡片库形成闭环）
import { ref, onMounted } from 'vue';
import { db } from '../db.js';
import { weakCards, setMarked, getSubjects, gradeCard, createCard } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
import { toast } from '../utils/toast.js';

const items = ref([]);
const subjects = ref([]);
const filterSubject = ref('');
const genBusy = ref(new Set()); // 正在生成变式的卡 id 集合
const batchBusy = ref(false);

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

// AI 变式补卡：针对错题生成同考点变式，写入卡片库（错题→补卡闭环，smart-reviewer 思路的按钮化）
async function genVariant(c) {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  if (genBusy.value.has(c.id)) return;
  genBusy.value.add(c.id);
  try {
    const r = await chatAI([
      { role: 'system', content: '你是出题老师。针对下面的错题出一道「变式」巩固题（同知识点、不同问法、难度相当），输出严格 JSON：{"front":"问题","back":"答案"}。只输出 JSON，不要多余文字。' },
      { role: 'user', content: `原题：${plain(c.front)}\n原答案：${plain(c.back)}\n错因：${reason(c)}` },
    ]);
    const m = String(r).match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : r);
    if (!obj?.front || !obj?.back) throw new Error('AI 返回格式异常');
    await createCard({
      front: String(obj.front).slice(0, 8000),
      back: String(obj.back).slice(0, 8000),
      subject: c.subject || '',
      tags: ['错题变式', ...(c.tags || []).slice(0, 3)],
      type: 'basic',
      source: '错题智能补卡',
    });
    toast(`已生成变式卡：「${String(obj.front).slice(0, 24)}…」`, 'success');
  } catch (e) { toast('生成失败：' + e.message, 'error'); }
  finally { genBusy.value.delete(c.id); }
}

// 批量为最薄弱的 5 道错题生成变式卡
async function genTop5() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  if (batchBusy.value) return;
  const targets = items.value.filter(c => !genBusy.value.has(c.id)).slice(0, 5);
  if (!targets.length) { toast('暂无可用错题', 'error'); return; }
  batchBusy.value = true;
  let n = 0;
  for (const c of targets) { await genVariant(c); n++; }
  batchBusy.value = false;
  toast(`已为 ${n} 道错题生成变式卡（可在「我的卡片」查看）`, 'success');
  await load();
}

onMounted(() => { load(); loadSubjects(); });
</script>

<template>
  <div style="max-width:820px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">错题集</h2>
      <span class="hint">共 {{ items.length }} 道错题</span>
      <span style="flex:1"></span>
      <button class="btn small" :disabled="batchBusy" @click="genTop5">{{ batchBusy ? '正在生成…' : '为最薄弱 5 题生成变式卡' }}</button>
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
        <button class="btn small" :disabled="genBusy.has(c.id)" @click="genVariant(c)">{{ genBusy.has(c.id) ? '生成中…' : 'AI 变式补卡' }}</button>
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