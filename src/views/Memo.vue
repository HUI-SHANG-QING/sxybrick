<script setup>
// 备忘录 · 四象限：按「重要/紧急」分类事项，存 IndexedDB 可随数据包同步
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from '../utils/toast.js';
import { listMemos, addMemo, deleteMemo } from '../repo.js';
import VoiceInput from '../components/VoiceInput.vue';
import ExportButton from '../components/ExportButton.vue';
import { t } from '../i18n/index.js';
import {
  exportMemosToJSON, exportMemosToMarkdown, exportMemosToCSV,
} from '../utils/exporters.js';

const route = useRoute();
const memos = ref([]);
const highlightId = ref('');
const input = ref('');
const important = ref(false);
const urgent = ref(false);

async function load() { memos.value = await listMemos(); }
async function add() {
  const txt = input.value.trim();
  if (!txt) return;
  await addMemo({ text: txt, important: important.value, urgent: urgent.value });
  input.value = ''; important.value = false; urgent.value = false;
  toast(t('views.memo.recorded'), 'success');
  await load();
}
async function remove(id) { await deleteMemo(id); await load(); }

const memoExportFormats = [
  { key: 'md', label: 'Markdown', hint: t('views.memo.exportHintMd'), mime: 'text/markdown', ext: 'md', build: exportMemosToMarkdown },
  { key: 'json', label: 'JSON', hint: t('views.memo.exportHintJson'), mime: 'application/json', ext: 'json', build: exportMemosToJSON },
  { key: 'csv', label: 'CSV', hint: t('views.memo.exportHintCsv'), mime: 'text/csv', ext: 'csv', build: exportMemosToCSV },
];

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
    <div class="page-header-row">
      <h2 style="margin:0 0 4px">{{ t('views.memo.title') }}</h2>
      <ExportButton
        :data="memos"
        :count="memos.length"
        filename-prefix="memos"
        :label="t('views.memo.exportLabel')"
        :formats="memoExportFormats"
      />
    </div>
    <p class="hint" style="margin:0 0 16px">{{ t('views.memo.hint') }}</p>

    <div class="panel">
      <div class="input-row">
        <VoiceInput @result="(t) => input = input ? input + t : t" />
        <input v-model="input" class="input" :placeholder="t('views.memo.placeholder')" @keydown.enter="add" />
        <label class="mini-chip"><input type="checkbox" v-model="important" /> {{ t('views.memo.important') }}</label>
        <label class="mini-chip"><input type="checkbox" v-model="urgent" /> {{ t('views.memo.urgent') }}</label>
        <button class="btn primary" @click="add">{{ t('views.memo.addBtn') }}</button>
      </div>
    </div>

    <div class="quad">
      <div class="q q1">
        <div class="q-title">{{ t('views.memo.q1') }}</div>
        <div v-if="!quadrants.q1.length" class="hint" style="padding:12px">{{ t('views.memo.empty') }}</div>
        <div v-for="m in quadrants.q1" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">{{ t('views.memo.del') }}</a>
        </div>
      </div>
      <div class="q q2">
        <div class="q-title">{{ t('views.memo.q2') }}</div>
        <div v-if="!quadrants.q2.length" class="hint" style="padding:12px">{{ t('views.memo.empty') }}</div>
        <div v-for="m in quadrants.q2" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">{{ t('views.memo.del') }}</a>
        </div>
      </div>
      <div class="q q3">
        <div class="q-title">{{ t('views.memo.q3') }}</div>
        <div v-if="!quadrants.q3.length" class="hint" style="padding:12px">{{ t('views.memo.empty') }}</div>
        <div v-for="m in quadrants.q3" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">{{ t('views.memo.del') }}</a>
        </div>
      </div>
      <div class="q q4">
        <div class="q-title">{{ t('views.memo.q4') }}</div>
        <div v-if="!quadrants.q4.length" class="hint" style="padding:12px">{{ t('views.memo.empty') }}</div>
        <div v-for="m in quadrants.q4" :key="m.id" class="q-item" :class="{ hl: highlightId === m.id }">
          <span>{{ m.text }}</span><a class="q-del" @click="remove(m.id)">{{ t('views.memo.del') }}</a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 16px; }
.page-header-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
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