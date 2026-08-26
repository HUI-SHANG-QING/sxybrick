<script setup>
// 备忘录 · 四象限：按「重要/紧急」分类事项，存 IndexedDB 可随数据包同步
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from '../utils/toast.js';
import { listMemos, addMemo, deleteMemo } from '../repo.js';
import VoiceInput from '../components/VoiceInput.vue';

const route = useRoute();
const memos = ref([]);
const highlightId = ref('');
const input = ref('');
const important = ref(false);
const urgent = ref(false);

async function load() { memos.value = await listMemos(); }
async function add() {
  const t = input.value.trim();
  if (!t) return;
  await addMemo({ text: t, important: important.value, urgent: urgent.value });
  input.value = ''; important.value = false; urgent.value = false;
  toast('已记录', 'success');
  await load();
}
async function remove(id) { await deleteMemo(id); await load(); }

const quadrants = computed(() => {
  const g = { q1: [], q2: [], q3: [], q4: [] };
  for (const m of memos.value) {
    if (m.important && m.urgent) g.q1.push(m);
    else if (m.important && !m.urgent) g.q2.push(m);
    else if (!m.important && m.urgent) g.q3.push(m);
    else g.q4.push(m);
  }
  return g;
});

// 搜索结果跳转：URL ?id=xxx 自动高亮对应备忘（四象限里不影响展示，加 2s 高亮提示）
async function applyRouteId() {
  await load();
  const id = route.query?.id ? String(route.query.id) : '';
  if (!id) return;
  await nextTick();
  const hit = memos.value.find(m => m.id === id);
  if (hit) { highlightId.value = id; setTimeout(() => { highlightId.value = ''; }, 2500); }
}
onMounted(applyRouteId);
</script>

<template>
  <div style="max-width:900px;margin:0 auto">
    <h2 style="margin:0 0 4px">备忘录 · 四象限</h2>
    <p class="hint" style="margin:0 0 16px">按「重要 / 紧急」给事项分类：先做重要且紧急的。数据可随数据包同步。</p>

    <div class="panel">
      <div class="input-row">
        <VoiceInput @result="(t) => input = input ? input + t : t" />
        <input v-model="input" class="input" placeholder="记点什么…" @keydown.enter="add" />
        <label class="mini-chip"><input type="checkbox" v-model="important" /> 重要</label>
        <label class="mini-chip"><input type="checkbox" v-model="urgent" /> 紧急</label>
        <button class="btn primary" @click="add">记下</button>
      </div>
    </div>

    <div class="quad">
      <div class="q q1">
        <div class="q-title">重要且紧急 · 先做</div>
        <div v-if="!quadrants.q1.length" class="hint" style="padding:12px">空</div>
        <div v-for="m in quadrants.q1" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">删</a>
        </div>
      </div>
      <div class="q q2">
        <div class="q-title">重要不紧急 · 计划做</div>
        <div v-if="!quadrants.q2.length" class="hint" style="padding:12px">空</div>
        <div v-for="m in quadrants.q2" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">删</a>
        </div>
      </div>
      <div class="q q3">
        <div class="q-title">不重要但紧急 · 可委派</div>
        <div v-if="!quadrants.q3.length" class="hint" style="padding:12px">空</div>
        <div v-for="m in quadrants.q3" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">删</a>
        </div>
      </div>
      <div class="q q4">
        <div class="q-title">不重要不紧急 · 少做</div>
        <div v-if="!quadrants.q4.length" class="hint" style="padding:12px">空</div>
        <div v-for="m in quadrants.q4" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">删</a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 16px; }
.input-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.input-row .input { flex: 1; min-width: 160px; }
.mini-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; user-select: none; }
.quad { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.q { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; min-height: 140px; }
.q-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.q1 .q-title { color: #dc2626; }
.q2 .q-title { color: #2563eb; }
.q3 .q-title { color: #d97706; }
.q4 .q-title { color: var(--ink-2); }
.q-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13px; word-break: break-word; }
.q-item:last-child { border-bottom: none; }
.q-del { color: var(--red); cursor: pointer; flex: none; font-size: 12px; }
.q-item.hl { padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 18%, transparent); animation: mem-hl 2s ease-in-out infinite; }
@keyframes mem-hl { 0%,100%{ box-shadow: inset 0 0 0 0 color-mix(in srgb,var(--accent) 50%,transparent); } 50%{ box-shadow: inset 0 0 0 2px var(--accent); } }
@media (max-width: 720px) { .quad { grid-template-columns: 1fr; } }
</style>