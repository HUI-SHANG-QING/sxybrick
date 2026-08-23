<script setup>
// 备忘录：职场/学习随手记（速记灵感、待办、复习重点）
import { ref, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import VoiceInput from '../components/VoiceInput.vue';

const MEMO_KEY = 'sxy_memos';
const memos = ref([]);
const input = ref('');

function load() {
  try { memos.value = JSON.parse(localStorage.getItem(MEMO_KEY) || '[]'); } catch {}
}
function save() { localStorage.setItem(MEMO_KEY, JSON.stringify(memos.value)); }

function add() {
  const t = input.value.trim();
  if (!t) return;
  memos.value.unshift({ id: Date.now(), text: t, at: Date.now() });
  input.value = '';
  save();
  toast('已记录', 'success');
}
function remove(id) {
  memos.value = memos.value.filter(m => m.id !== id);
  save();
}
function fmt(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
onMounted(load);
</script>

<template>
  <div style="max-width:720px;margin:0 auto">
    <h2 style="margin:0 0 4px">备忘录</h2>
    <p class="hint" style="margin:0 0 16px">随手记下复习重点、会议速记、灵感、待办，数据存在本机。</p>

    <div class="panel">
      <div class="input-row">
        <VoiceInput @result="(t) => input = input ? input + t : t" />
        <input v-model="input" class="input" placeholder="记点什么…" @keydown.enter="add" />
        <button class="btn primary" @click="add">记下</button>
      </div>
    </div>

    <div v-if="!memos.length" class="hint" style="text-align:center;padding:40px">还没有记录，上面写一条吧。</div>

    <div v-for="m in memos" :key="m.id" class="memo-item">
      <div style="white-space:pre-wrap;word-break:break-word">{{ m.text }}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
        <span class="hint">{{ fmt(m.at) }}</span>
        <button class="btn small danger" @click="remove(m.id)">删除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 16px; }
.input-row { display: flex; gap: 8px; }
.input-row .input { flex: 1; }
.memo-item { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--amber); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 12px; }
</style>