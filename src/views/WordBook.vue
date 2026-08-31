<script setup>
// 单词本（图2-5：不背风列表 + 添加/口述 + AI 自动生成 + 已背/熟词/批注/词组 + 详情抽屉）
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import { speak } from '../utils/speak.js';
import {
  listWordCards, wordStats, createWordCard, updateWordCard, deleteWordCard,
  markFamiliar, setWordNote, getWordSettings, listWordGroups,
} from '../word-repo.js';
import { generateWordMaterials } from '../services/word-llm.js';
import { isInSyllabus, getSyllabusMeta } from '../services/word-syllabus.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const router = useRouter();
const cards = ref([]);
const stats = ref(null);
const groups = ref([]);
const settings = ref(null);

const filterKind = ref('all');     // all/word/phrase/sentence/template
const filterReviewed = ref('all'); // all/reviewed/unreviewed
const filterFamiliar = ref(false);
const q = ref('');

const showAdd = ref(false);
const showDetail = ref(false);
const detail = ref(null);
const editing = ref(null); // 编辑中的 card
const genRunning = ref(false);

const form = ref(blankForm());
function blankForm() {
  return {
    id: null, kind: 'word', word: '', phonetic: '', meaning: '', example: '',
    exampleTrans: '', note: '', source: '', subject: '考研', tags: '',
    aiGen: true,
  };
}

const kinds = [
  { id: 'all', label: t('views.wordBook.filterAll') },
  { id: 'word', label: t('views.wordBook.filterWord') },
  { id: 'phrase', label: t('views.wordBook.filterPhrase') },
  { id: 'sentence', label: t('views.wordBook.filterSentence') },
  { id: 'template', label: t('views.wordBook.filterTemplate') },
];

async function load() {
  const f = {};
  if (filterKind.value !== 'all') f.kind = filterKind.value;
  if (filterReviewed.value === 'reviewed') f.reviewedOnly = true;
  if (filterReviewed.value === 'unreviewed') f.reviewedOnly = false;
  if (filterFamiliar.value) f.familiar = 1;
  cards.value = await listWordCards({ ...f, q: q.value });
  stats.value = await wordStats();
  groups.value = await listWordGroups();
  settings.value = await getWordSettings();
}
onMounted(load);
watch([filterKind, filterReviewed, filterFamiliar], load);

async function onSearch() { await load(); }

const filteredCount = computed(() => cards.value.length);

// ---- 添加 / 编辑 ----
function openAdd() { editing.value = null; form.value = blankForm(); showAdd.value = true; }
function openEdit(c) { editing.value = c; form.value = { ...blankForm(), ...c, tags: (c.tags || []).join(', ') }; showAdd.value = true; }

async function genMaterials() {
  const word = form.value.word.trim();
  if (!word) { toast('请先填写单词', 'warn'); return; }
  if (!settings.value?.aiEnabled) { toast(t('views.wordBook.aiGenOff'), 'warn'); return; }
  if (!isInSyllabus(word)) { toast(t('views.wordBook.aiGenSkip'), 'warn'); return; }
  genRunning.value = true;
  try {
    const r = await generateWordMaterials({ word, levels: settings.value.exampleLevels, settings: settings.value });
    if (r.ok && r.data) {
      const d = r.data;
      form.value.meaning = form.value.meaning || (d.defs?.[0]?.meaning || '');
      form.value.pos = d.pos || '';
      form.value.synonyms = d.synonyms; form.value.collocations = d.collocations;
      form.value.phrases = d.phrases; form.value.examples = d.examples;
      form.value.mnemonics = d.mnemonic ? [d.mnemonic] : [];
      toast(t('views.wordBook.aiGenDone'), 'success');
    } else {
      toast(t('views.wordBook.aiGenFailed', { msg: r.reason || '' }), 'error');
    }
  } finally {
    genRunning.value = false;
  }
}

function parseExt() {
  const f = form.value;
  const out = {
    pos: f.pos || '', defs: f.defs || [], synonyms: f.synonyms || [],
    collocations: f.collocations || [], phrases: f.phrases || [], examples: f.examples || [],
    mnemonics: f.mnemonics || [], rootAffix: f.rootAffix || '', confusions: f.confusions || [],
    syllable: f.syllable || '',
  };
  return out;
}

async function save() {
  const f = form.value;
  const base = {
    kind: f.kind, word: f.word, phonetic: f.phonetic, meaning: f.meaning,
    example: f.example, exampleTrans: f.exampleTrans, note: f.note,
    source: f.source, subject: f.subject, tags: String(f.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    ...parseExt(),
  };
  try {
    if (editing.value) {
      await updateWordCard(editing.value.id, base);
      toast(t('views.wordBook.updated'), 'success');
    } else {
      await createWordCard(base);
      toast(t('views.wordBook.created'), 'success');
    }
    showAdd.value = false;
    await load();
  } catch (e) {
    toast(t('views.wordBook.saveFailed') + '：' + (e?.message || e), 'error');
  }
}

async function remove(c) {
  if (!(await confirmDialog(t('views.wordBook.confirmDelete', { word: c.word })))) return;
  await deleteWordCard(c.id);
  toast(t('views.wordBook.deleted'), 'success');
  await load();
}

async function toggleFamiliar(c) {
  await markFamiliar(c.id, c.familiar ? 0 : 1);
  await load();
}

function openDetail(c) { detail.value = c; showDetail.value = true; }

function speakWord(w) { speak(w, { lang: settings.value?.accent === 'auto' ? 'en-US' : settings.value?.accent }); }

const exampleLevelLabels = {
  simple: t('views.wordBook.exSimple'), long: t('views.wordBook.exLong'),
  en1: t('views.wordBook.exEn1'), en2: t('views.wordBook.exEn2'),
};
</script>

<template>
  <div class="wbook">
    <div class="wb-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordHub.title') }}</button>
      <h1>{{ t('views.wordBook.title') }}</h1>
      <p>{{ t('views.wordBook.subtitle') }}</p>
    </div>

    <!-- 统计卡 -->
    <div class="wb-stats" v-if="stats">
      <div class="wbs"><b>{{ stats.due }}</b><span>{{ t('views.wordBook.statDue') }}</span></div>
      <div class="wbs"><b>{{ stats.mastered }}</b><span>{{ t('views.wordBook.statMastered') }}</span></div>
      <div class="wbs"><b>{{ stats.newToday }}</b><span>{{ t('views.wordBook.statNewToday') }}</span></div>
      <div class="wbs"><b>{{ stats.familiar }}</b><span>{{ t('views.wordBook.statFamiliar') }}</span></div>
      <div class="wbs"><b>{{ stats.total }}</b><span>{{ t('views.wordBook.statTotal') }}</span></div>
    </div>

    <!-- 筛选 + 搜索 + 添加 -->
    <div class="wb-toolbar">
      <div class="wb-kinds">
        <button v-for="k in kinds" :key="k.id" class="kchip" :class="{ on: filterKind === k.id }" @click="filterKind = k.id">{{ k.label }}</button>
      </div>
      <div class="wb-actions">
        <input class="wb-search" v-model="q" :placeholder="t('views.wordBook.searchPlaceholder')" @input="onSearch" />
        <button class="fam-toggle" :class="{ on: filterFamiliar }" @click="filterFamiliar = !filterFamiliar">{{ t('views.wordBook.familiarBadge') }}</button>
        <select class="wb-rev" v-model="filterReviewed">
          <option value="all">{{ t('views.wordBook.showAll') }}</option>
          <option value="reviewed">{{ t('views.wordBook.showReviewed') }}</option>
          <option value="unreviewed">{{ t('views.wordBook.showUnreviewed') }}</option>
        </select>
        <button class="wb-add" @click="openAdd">＋ {{ t('views.wordBook.addBtn') }}</button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="wb-list" v-if="cards.length">
      <div v-for="c in cards" :key="c.id" class="wb-card" @click="openDetail(c)">
        <div class="wb-card-main">
          <div class="wb-word">
            <span class="wb-wtext">{{ c.word }}</span>
            <span v-if="c.phonetic" class="wb-phon">/{{ c.phonetic }}/</span>
            <button class="wb-spk" @click.stop="speakWord(c.word)" title="朗读">🔊</button>
          </div>
          <div class="wb-meaning">{{ c.meaning }}</div>
        </div>
        <div class="wb-badges">
          <span class="bdg" :class="'bdg-' + c.kind">{{ t('views.wordBook.kind' + c.kind.charAt(0).toUpperCase() + c.kind.slice(1)) }}</span>
          <span v-if="c.familiar" class="bdg bdg-fam">{{ t('views.wordBook.familiarBadge') }}</span>
          <span v-if="c.note" class="bdg bdg-note">📝</span>
        </div>
      </div>
    </div>
    <div class="wb-empty" v-else>
      <p>{{ t('views.wordBook.empty') }}</p>
      <p class="hint">{{ t('views.wordBook.emptyHint') }}</p>
    </div>

    <!-- 添加 / 编辑 弹窗 -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false">
      <div class="modal add-modal">
        <h3>{{ editing ? t('views.wordBook.editTitle') : t('views.wordBook.addTitle') }}</h3>
        <div class="add-voice-hint">🎙️ {{ t('views.wordBook.voiceHint') }}</div>
        <div class="add-grid">
          <div class="ag">
            <label>{{ t('views.wordBook.formKind') }}</label>
            <select v-model="form.kind">
              <option value="word">{{ t('views.wordBook.kindWord') }}</option>
              <option value="phrase">{{ t('views.wordBook.filterPhrase') }}</option>
              <option value="sentence">{{ t('views.wordBook.filterSentence') }}</option>
              <option value="template">{{ t('views.wordBook.filterTemplate') }}</option>
            </select>
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formWord') }}</label>
            <input v-model="form.word" :placeholder="t('views.wordBook.formWordPlaceholder')" @keyup.enter="genMaterials" />
          </div>
          <div class="ag">
            <label>{{ t('views.wordBook.formPhonetic') }}</label>
            <input v-model="form.phonetic" :placeholder="t('views.wordBook.formPhoneticPlaceholder')" />
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formMeaning') }}</label>
            <input v-model="form.meaning" :placeholder="t('views.wordBook.formMeaningPlaceholder')" />
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formExample') }}</label>
            <input v-model="form.example" :placeholder="t('views.wordBook.formExamplePlaceholder')" />
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formExampleTrans') }}</label>
            <input v-model="form.exampleTrans" :placeholder="t('views.wordBook.formExampleTransPlaceholder')" />
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formNote') }}</label>
            <input v-model="form.note" :placeholder="t('views.wordBook.formNotePlaceholder')" />
          </div>
          <div class="ag">
            <label>{{ t('views.wordBook.formSubject') }}</label>
            <select v-model="form.subject">
              <option value="考研">{{ t('views.wordBook.subjectKaoyan') }}</option>
              <option value="四六级">{{ t('views.wordBook.subjectCet') }}</option>
              <option value="雅思">{{ t('views.wordBook.subjectIelts') }}</option>
              <option value="托福">{{ t('views.wordBook.subjectToefl') }}</option>
              <option value="专四专八">{{ t('views.wordBook.subjectTem') }}</option>
              <option value="其他">{{ t('views.wordBook.subjectOther') }}</option>
            </select>
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formSource') }}</label>
            <input v-model="form.source" :placeholder="t('views.wordBook.formSourcePlaceholder')" />
          </div>
          <div class="ag ag-wide">
            <label>{{ t('views.wordBook.formTags') }}</label>
            <input v-model="form.tags" placeholder="word1, word2" />
          </div>
        </div>
        <div class="add-foot">
          <button class="gen-btn" :disabled="genRunning" @click="genMaterials">
            {{ genRunning ? t('views.wordBook.aiGenRunning') : '✨ ' + t('views.wordBook.aiGen') }}
          </button>
          <span class="gen-hint">{{ t('views.wordBook.aiGenHint') }}</span>
          <div class="spacer"></div>
          <button class="btn-ghost" @click="showAdd = false">{{ t('views.wordBook.cancel') }}</button>
          <button class="btn-primary" @click="save">{{ t('views.wordBook.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 详情抽屉 -->
    <div v-if="showDetail && detail" class="modal-mask" @click.self="showDetail = false">
      <div class="modal detail-modal">
        <div class="detail-head">
          <div>
            <h3 class="detail-word">{{ detail.word }} <span v-if="detail.phonetic" class="detail-phon">/{{ detail.phonetic }}/</span></h3>
            <p class="detail-meaning">{{ detail.meaning }}</p>
          </div>
          <button class="wb-spk" @click="speakWord(detail.word)">🔊</button>
        </div>

        <div class="detail-sec" v-if="detail.pos"><span class="ds-label">{{ t('views.wordBook.formKind') }}</span>{{ detail.pos }}</div>
        <div class="detail-sec" v-if="detail.synonyms && detail.synonyms.length">
          <span class="ds-label">{{ t('views.wordBook.detailSynonyms') }}</span>{{ detail.synonyms.join('、') }}
        </div>
        <div class="detail-sec" v-if="detail.collocations && detail.collocations.length">
          <span class="ds-label">{{ t('views.wordBook.detailCollocations') }}</span>{{ detail.collocations.join('、') }}
        </div>
        <div class="detail-sec" v-if="detail.phrases && detail.phrases.length">
          <span class="ds-label">{{ t('views.wordBook.detailPhrases') }}</span>{{ detail.phrases.join('、') }}
        </div>
        <div class="detail-sec" v-if="detail.rootAffix"><span class="ds-label">{{ t('views.wordBook.detailRootAffix') }}</span>{{ detail.rootAffix }}</div>
        <div class="detail-sec" v-if="detail.mnemonics && detail.mnemonics.length">
          <span class="ds-label">{{ t('views.wordBook.detailMnemonics') }}</span>{{ detail.mnemonics.join('；') }}
        </div>
        <div class="detail-sec" v-if="detail.confusions && detail.confusions.length">
          <span class="ds-label">{{ t('views.wordBook.detailConfusions') }}</span>
          <span v-for="(cf, i) in detail.confusions" :key="i" class="cf">{{ cf.word }}（{{ cf.meaning }}）</span>
        </div>

        <div class="detail-examples" v-if="detail.examples && detail.examples.length">
          <div class="de-title">{{ t('views.wordBook.detailExamples') }}</div>
          <div v-for="(ex, i) in detail.examples" :key="i" class="de-item">
            <span class="de-lv" :class="'lv-' + ex.level">{{ exampleLevelLabels[ex.level] }}</span>
            <div class="de-body">
              <div class="de-sent">{{ ex.sentence }}</div>
              <div class="de-trans">{{ ex.translation }}</div>
            </div>
            <button class="de-spk" @click="speak(ex.sentence)">🔊</button>
          </div>
        </div>

        <div class="detail-foot">
          <button class="btn-ghost" @click="toggleFamiliar(detail)">{{ detail.familiar ? t('views.wordBook.unmarkFamiliar') : t('views.wordBook.markFamiliar') }}</button>
          <button class="btn-ghost" @click="openEdit(detail); showDetail = false">{{ t('views.wordBook.edit') }}</button>
          <button class="btn-danger" @click="remove(detail)">{{ t('views.wordBook.delete') }}</button>
          <div class="spacer"></div>
          <button class="btn-primary" @click="showDetail = false">{{ t('views.wordBook.cancel') }}</button>
        </div>
      </div>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.wbook { padding-bottom: 90px; }
.wb-head { padding: 16px 16px 4px; }
.wb-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; }
.wb-head h1 { margin: 6px 0 2px; font-size: 20px; color: var(--ink); }
.wb-head p { margin: 0; font-size: 12px; color: var(--ink-2); }

.wb-stats { display: flex; gap: 8px; padding: 10px 16px; overflow-x: auto; }
.wbs { flex: 1; min-width: 64px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 6px; text-align: center; }
.wbs b { display: block; font-size: 18px; color: var(--ink); }
.wbs span { font-size: 11px; color: var(--ink-2); }

.wb-toolbar { padding: 6px 16px 10px; display: flex; flex-direction: column; gap: 8px; }
.wb-kinds { display: flex; gap: 6px; flex-wrap: wrap; }
.kchip { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 5px 12px; font-size: 13px; cursor: pointer; color: var(--ink); }
.kchip.on { border-color: var(--accent); background: var(--code-inline); color: var(--accent); }
.wb-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.wb-search { flex: 1; min-width: 140px; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--panel); color: var(--ink); font-size: 13px; }
.wb-rev, .fam-toggle { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--panel); color: var(--ink); font-size: 13px; cursor: pointer; }
.fam-toggle.on { border-color: var(--accent); color: var(--accent); }
.wb-add { border: none; background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 13px; cursor: pointer; white-space: nowrap; }

.wb-list { padding: 0 16px; display: flex; flex-direction: column; gap: 8px; }
.wb-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; cursor: pointer; transition: .15s; }
.wb-card:hover { border-color: var(--accent); }
.wb-word { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.wb-wtext { font-size: 17px; font-weight: 600; color: var(--ink); }
.wb-phon { font-size: 12px; color: var(--ink-2); }
.wb-spk { border: none; background: transparent; cursor: pointer; font-size: 15px; }
.wb-meaning { font-size: 13px; color: var(--ink-2); margin-top: 2px; }
.wb-badges { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }
.bdg { font-size: 11px; padding: 2px 7px; border-radius: 8px; background: var(--line); color: var(--ink-2); }
.bdg-word { background: #e7eefe; color: #2f5bd0; }
.bdg-phrase { background: #e6f6ec; color: #1f9255; }
.bdg-sentence { background: #fdeede; color: #c47f1a; }
.bdg-template { background: #f3e8fe; color: #8a4fd0; }
.bdg-fam { background: #fff0d6; color: #b7791f; }
.bdg-note { background: var(--line); color: var(--ink-2); }
.wb-empty { padding: 30px 16px; text-align: center; color: var(--ink); }
.wb-empty .hint { font-size: 12px; color: var(--ink-2); }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: flex-end; justify-content: center; z-index: 100; }
.modal { width: 100%; max-width: 560px; background: var(--panel); border-radius: 18px 18px 0 0; padding: 18px; max-height: 90vh; overflow-y: auto; }
@media (min-width: 600px) { .modal-mask { align-items: center; } .modal { border-radius: 18px; } }
.add-voice-hint { font-size: 12px; color: var(--accent); background: var(--code-inline); padding: 8px 10px; border-radius: 10px; margin: 8px 0 12px; }
.add-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ag { display: flex; flex-direction: column; gap: 4px; }
.ag-wide { grid-column: span 2; }
.ag label { font-size: 12px; color: var(--ink-2); }
.ag select, .ag input { border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; background: var(--bg, #fff); color: var(--ink); font-size: 13px; }
.add-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.gen-btn { border: 1px solid var(--accent); background: transparent; color: var(--accent); border-radius: 10px; padding: 8px 12px; cursor: pointer; font-size: 13px; }
.gen-hint { font-size: 11px; color: var(--ink-2); flex: 1; min-width: 120px; }
.spacer { flex: 1; }
.btn-ghost { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 8px 12px; cursor: pointer; color: var(--ink); font-size: 13px; }
.btn-primary { border: none; background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
.btn-danger { border: 1px solid #f0a0a0; background: transparent; color: #d9534f; border-radius: 10px; padding: 8px 12px; cursor: pointer; font-size: 13px; }

.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.detail-word { margin: 0; font-size: 22px; color: var(--ink); }
.detail-phon { font-size: 13px; color: var(--ink-2); font-weight: 400; }
.detail-meaning { margin: 4px 0 0; font-size: 14px; color: var(--ink-2); }
.detail-sec { font-size: 13px; color: var(--ink); margin-top: 10px; line-height: 1.6; }
.ds-label { display: inline-block; min-width: 64px; color: var(--ink-2); font-size: 12px; margin-right: 6px; }
.cf { display: inline-block; margin-right: 8px; color: #b7791f; }
.detail-examples { margin-top: 12px; }
.de-title { font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 8px; }
.de-item { display: flex; gap: 8px; align-items: flex-start; padding: 8px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; }
.de-lv { font-size: 11px; padding: 2px 7px; border-radius: 8px; flex-shrink: 0; background: var(--line); color: var(--ink-2); }
.de-lv.lv-simple { background: #e7eefe; color: #2f5bd0; }
.de-lv.lv-long { background: #fdeede; color: #c47f1a; }
.de-lv.lv-en1 { background: #e6f6ec; color: #1f9255; }
.de-lv.lv-en2 { background: #f3e8fe; color: #8a4fd0; }
.de-body { flex: 1; }
.de-sent { font-size: 13px; color: var(--ink); }
.de-trans { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.detail-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
@media (max-width: 520px) { .add-grid { grid-template-columns: 1fr; } .ag-wide { grid-column: span 1; } }
</style>
