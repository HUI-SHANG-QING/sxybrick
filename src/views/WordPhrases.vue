<script setup>
// 词组库（v40）：生词 / 词组 / 短句 / 范文模板 独立入口
// 数据源与单词本同一张 wordCards 表（与通用 cards 物理隔离），kind 为唯一分区键；
// 复习复用同一套记忆曲线（scheduleReview），「背这类」跳转 WordReview scope=<kind>
// 实现针对性背诵（生词/词组/短句均可 SRS；范文 template 无 SRS 语义，仅存储+收藏+导出）。
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import { speak } from '../utils/speak.js';
import {
  listWordCards, createWordCard, deleteWordCard, markFamiliar, wordStats, getWordSettings,
} from '../word-repo.js';

const router = useRouter();
const cards = ref([]);
const stats = ref(null);
const settings = ref(null);
const loading = ref(true);
const filterKind = ref('all'); // all/word/phrase/sentence/template
const q = ref('');
const adding = ref(false);
const bulkBusy = ref(false);
const showAdd = ref(false);
const showBulk = ref(false);
const bulkText = ref('');
const bulkKind = ref('phrase');
const form = ref({ word: '', meaning: '', kind: 'phrase', phonetic: '', example: '', note: '' });

const KINDS = ['all', 'word', 'phrase', 'sentence', 'template'];
const kindLabel = (k) => t('views.wordPhrases.' + 'kind' + k.charAt(0).toUpperCase() + k.slice(1));

async function load() {
  loading.value = true;
  try {
    const f = {};
    if (filterKind.value !== 'all') f.kind = filterKind.value;
    if (q.value.trim()) f.q = q.value.trim();
    cards.value = await listWordCards(f);
    stats.value = await wordStats();
  } finally {
    loading.value = false;
  }
}
watch(filterKind, load);
watch(q, load);

function studyKind() {
  if (filterKind.value === 'all' || filterKind.value === 'template') return;
  router.push(`/english/study?scope=${filterKind.value}`);
}

async function doAdd() {
  const word = String(form.value.word || '').trim();
  if (!word) { toast(t('views.wordPhrases.wordRequired'), 'warn'); return; }
  adding.value = true;
  try {
    const payload = { word, meaning: String(form.value.meaning || '').trim(), kind: form.value.kind };
    const phonetic = String(form.value.phonetic || '').trim();
    const example = String(form.value.example || '').trim();
    const note = String(form.value.note || '').trim();
    if (phonetic) payload.phonetic = phonetic;
    if (example) payload.example = example;
    if (note) payload.note = note;
    await createWordCard(payload);
    showAdd.value = false;
    form.value = { word: '', meaning: '', kind: form.value.kind, phonetic: '', example: '', note: '' };
    toast(t('views.wordPhrases.added'), 'success');
    await load();
  } finally {
    adding.value = false;
  }
}

async function doBulk() {
  const lines = String(bulkText.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return;
  bulkBusy.value = true;
  let n = 0, s = 0;
  try {
    for (const line of lines) {
      const m = line.match(/^(.+?)\s*[=＝:：]\s*(.+)$/);
      if (!m) { s++; continue; }
      const word = m[1].trim();
      const meaning = m[2].trim();
      if (!word || !meaning) { s++; continue; }
      await createWordCard({ word, meaning, kind: bulkKind.value });
      n++;
    }
    if (n === 0) toast(t('views.wordPhrases.bulkSkipAll'), 'warn');
    else toast(t('views.wordPhrases.bulkOk', undefined, { n, s }), 'success');
    showBulk.value = false;
    bulkText.value = '';
    await load();
  } finally {
    bulkBusy.value = false;
  }
}

async function toggleFamiliar(c) {
  await markFamiliar(c.id, c.familiar ? 0 : 1);
  await load();
}
async function remove(c) {
  if (!(await confirmDialog(t('views.wordPhrases.confirmDelete', undefined, { w: c.word })))) return;
  await deleteWordCard(c.id);
  toast(t('views.wordPhrases.deleteOk'), 'success');
  await load();
}
function speakWord(w) {
  speak(w, { lang: settings.value?.accent === 'auto' ? 'en-US' : settings.value?.accent });
}

onMounted(async () => {
  settings.value = await getWordSettings();
  await load();
});
</script>

<template>
  <div class="wp-wrap">
    <div class="wp-head">
      <h2 style="margin:0">{{ t('views.wordPhrases.heading') }}</h2>
      <p class="hint" style="margin:6px 0 0">{{ t('views.wordPhrases.subtitle') }}</p>
      <div class="wp-stats" v-if="stats">
        <div class="wpb"><b>{{ stats.total }}</b><span>{{ t('views.wordPhrases.statTotal') }}</span></div>
        <div class="wpb"><b>{{ stats.due }}</b><span>{{ t('views.wordPhrases.statDue') }}</span></div>
        <div class="wpb"><b>{{ stats.templates }}</b><span>{{ t('views.wordPhrases.statTemplate') }}</span></div>
        <div class="wpb"><b>{{ stats.familiar }}</b><span>{{ t('views.wordPhrases.statFamiliar') }}</span></div>
      </div>
    </div>

    <div class="wp-toolbar">
      <div class="wp-kinds">
        <button v-for="k in KINDS" :key="k" class="kchip" :class="{ on: filterKind === k }" @click="filterKind = k">
          {{ k === 'all' ? t('views.wordPhrases.tabAll') : kindLabel(k) }}
        </button>
      </div>
      <div class="wp-actions">
        <input class="wp-search" v-model="q" :placeholder="t('views.wordPhrases.searchPlaceholder')" />
        <button class="btn" @click="showBulk = true">⚡ {{ t('views.wordPhrases.bulkBtn') }}</button>
        <button class="btn" @click="showAdd = true">＋ {{ t('views.wordPhrases.addBtn') }}</button>
        <button class="btn primary" :disabled="filterKind === 'all' || filterKind === 'template'"
          :title="filterKind === 'template' ? t('views.wordPhrases.studyDisabled') : ''" @click="studyKind">
          🎯 {{ t('views.wordPhrases.studyBtn') }}
        </button>
      </div>
    </div>

    <div class="wp-list" v-if="cards.length">
      <div v-for="c in cards" :key="c.id" class="wp-card">
        <div class="wp-card-top">
          <div class="wp-word">
            <span class="wp-wtext">{{ c.word }}</span>
            <span v-if="c.phonetic" class="wp-phon">/{{ c.phonetic }}/</span>
          </div>
          <span class="bdg" :class="'bdg-' + c.kind">{{ kindLabel(c.kind) }}</span>
        </div>
        <div class="wp-meaning" v-if="c.meaning">{{ c.meaning }}</div>
        <div class="wp-ex" v-if="c.example">{{ c.example }}</div>
        <div class="wp-meta" v-if="c.note || c.familiar">
          <span v-if="c.note" class="tag tag-note">📝 {{ c.note }}</span>
          <span v-if="c.familiar" class="tag tag-fam">★ {{ t('views.wordPhrases.statFamiliar') }}</span>
        </div>
        <div class="wp-acts">
          <button @click.stop="speakWord(c.word)">🔊</button>
          <button :class="{ on: c.familiar }" @click.stop="toggleFamiliar(c)">{{ c.familiar ? '★' : '☆' }}</button>
          <button class="wp-del" @click.stop="remove(c)">🗑</button>
        </div>
      </div>
    </div>
    <div class="wp-empty" v-else-if="!loading">
      <p>{{ t('views.wordPhrases.empty') }}</p>
      <p class="hint">{{ t('views.wordPhrases.emptyHint') }}</p>
    </div>

    <!-- 添加弹窗 -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false">
      <div class="modal wp-modal">
        <h3>{{ t('views.wordPhrases.addTitle') }}</h3>
        <div class="wp-grid">
          <label>{{ t('views.wordPhrases.labelKind') }}
            <select v-model="form.kind">
              <option value="word">{{ t('views.wordPhrases.kindWord') }}</option>
              <option value="phrase">{{ t('views.wordPhrases.kindPhrase') }}</option>
              <option value="sentence">{{ t('views.wordPhrases.kindSentence') }}</option>
              <option value="template">{{ t('views.wordPhrases.kindTemplate') }}</option>
            </select>
          </label>
          <label>{{ t('views.wordPhrases.labelPhonetic') }}
            <input v-model="form.phonetic" class="input" placeholder="/teɪk pleɪs/" />
          </label>
          <label class="wp-full">{{ t('views.wordPhrases.labelWord') }}
            <input v-model="form.word" class="input" placeholder="take place" />
          </label>
          <label class="wp-full">{{ t('views.wordPhrases.labelMeaning') }}
            <input v-model="form.meaning" class="input" />
          </label>
          <label class="wp-full">{{ t('views.wordPhrases.labelExample') }}
            <input v-model="form.example" class="input" placeholder="The ceremony will take place on Friday." />
          </label>
          <label class="wp-full">{{ t('views.wordPhrases.labelNote') }}
            <input v-model="form.note" class="input" />
          </label>
        </div>
        <div class="wp-foot">
          <button class="btn" @click="showAdd = false">{{ t('views.wordPhrases.cancel') }}</button>
          <button class="btn primary" :disabled="adding" @click="doAdd">{{ t('views.wordPhrases.added') }}</button>
        </div>
      </div>
    </div>

    <!-- 批量导入弹窗 -->
    <div v-if="showBulk" class="modal-mask" @click.self="showBulk = false">
      <div class="modal wp-modal">
        <h3>{{ t('views.wordPhrases.bulkTitle') }}</h3>
        <p class="hint" style="margin:4px 0 8px">{{ t('views.wordPhrases.bulkHint') }}</p>
        <label class="wp-kind-line">{{ t('views.wordPhrases.labelKind') }}
          <select v-model="bulkKind">
            <option value="word">{{ t('views.wordPhrases.kindWord') }}</option>
            <option value="phrase">{{ t('views.wordPhrases.kindPhrase') }}</option>
            <option value="sentence">{{ t('views.wordPhrases.kindSentence') }}</option>
            <option value="template">{{ t('views.wordPhrases.kindTemplate') }}</option>
          </select>
        </label>
        <textarea v-model="bulkText" class="wp-textarea" :placeholder="t('views.wordPhrases.bulkPlaceholder')"></textarea>
        <div class="wp-foot">
          <button class="btn" @click="showBulk = false">{{ t('views.wordPhrases.cancel') }}</button>
          <button class="btn primary" :disabled="bulkBusy" @click="doBulk">{{ t('views.wordPhrases.bulkOkBtn') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wp-wrap { max-width: 980px; margin: 0 auto; }
.wp-stats { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
.wpb { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 8px 14px; text-align: center; min-width: 64px; }
.wpb b { font-size: 18px; display: block; }
.wpb span { font-size: 11px; color: var(--ink-2); }
.wp-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 14px 0 10px; }
.wp-kinds { display: flex; gap: 6px; flex-wrap: wrap; }
.kchip { padding: 5px 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; font-size: 12px; cursor: pointer; transition: .12s; }
.kchip:hover { border-color: var(--accent); }
.kchip.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.wp-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }
.wp-search { padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 13px; min-width: 180px; }
.wp-list { display: flex; flex-direction: column; gap: 8px; }
.wp-card { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 10px 12px; }
.wp-card-top { display: flex; align-items: baseline; gap: 8px; }
.wp-wtext { font-size: 16px; font-weight: 700; }
.wp-phon { font-size: 12px; color: var(--ink-2); }
.bdg { margin-left: auto; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
.bdg-word { color: #4f7cff; }
.bdg-phrase { color: #2fbf71; }
.bdg-sentence { color: #e6a23c; }
.bdg-template { color: #9b59b6; }
.wp-meaning { font-size: 13px; margin-top: 4px; }
.wp-ex { font-size: 12px; color: var(--ink-2); margin-top: 4px; font-style: italic; }
.wp-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.wp-acts { display: flex; gap: 4px; margin-top: 8px; }
.wp-acts button { border: 1px solid var(--line); background: var(--code-bg); border-radius: 8px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
.wp-acts button.on { border-color: var(--accent); }
.wp-del { color: var(--red); }
.wp-empty { text-align: center; padding: 48px 0; color: var(--ink-2); }
.wp-modal { width: 520px; max-width: 100%; }
.wp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.wp-grid label { font-size: 12px; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px; }
.wp-full { grid-column: 1 / -1; }
.wp-grid select { padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 13px; }
.wp-kind-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-2); }
.wp-kind-line select { padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 13px; }
.wp-textarea { width: 100%; min-height: 160px; margin-top: 8px; resize: vertical; font-family: inherit; line-height: 1.6; padding: 8px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
.wp-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
</style>
