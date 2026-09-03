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
import { isInSyllabus, getSyllabusMeta, listSyllabus } from '../services/word-syllabus.js';
import { ocrImageText } from '../docs-lib.js';
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

// ---- 视图：我的词本 / 考研大纲词书 ----
const view = ref('book');          // book | syllabus
const PAGE_SIZE = 60;
const syllabusMeta = getSyllabusMeta();
const sylAll = listSyllabus();                    // 4956 词（按字母序）
const sylQuery = ref('');
const sylPage = ref(1);
const addedWords = ref(new Set());                // 已加入单词本的词（小写）
const sylBusy = ref(false);
// Exam type for the syllabus (English I / English II). Officially English I and II share
// one ~5,500-word syllabus (identical scope, different depth), so the word list itself is
// shared; this toggle only changes the label and the explanatory copy, not the data.
const SYL_EXAM_KEY = 'sxy_word_exam';
const sylExam = ref('en1'); // en1=English I (default), en2=English II
const sylTitle = computed(() => sylExam.value === 'en2'
  ? t('views.wordBook.syllabusTitleEn2')
  : t('views.wordBook.syllabusTitleEn1'));
function setExam(v) {
  sylExam.value = v;
  try { localStorage.setItem(SYL_EXAM_KEY, v); } catch { /* ignore persistence failure */ }
}

const sylFiltered = computed(() => {
  const kw = String(sylQuery.value || '').trim().toLowerCase();
  if (!kw) return sylAll;
  return sylAll.filter((w) => w.toLowerCase().includes(kw));
});
const sylPages = computed(() => Math.max(1, Math.ceil(sylFiltered.value.length / PAGE_SIZE)));
const sylSlice = computed(() => {
  const p = Math.min(Math.max(1, sylPage.value), sylPages.value);
  return sylFiltered.value.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
});
const sylAddedCount = computed(() => addedWords.value.size);
// 首字母索引：只列当前列表中真实存在的首字母
const sylLetters = computed(() => {
  const set = new Set();
  for (const w of sylAll) set.add(w.charAt(0).toUpperCase());
  return [...set].sort();
});
watch(sylQuery, () => { sylPage.value = 1; });

function jumpLetter(letter) {
  const idx = sylAll.findIndex((w) => w.charAt(0).toUpperCase() === letter);
  if (idx < 0) return;
  sylQuery.value = '';
  sylPage.value = Math.floor(idx / PAGE_SIZE) + 1;
}

async function switchView(v) {
  view.value = v;
  if (v === 'syllabus') await refreshAdded();
}

/** 刷新「已加入」集合（按 word 小写匹配本地卡） */
async function refreshAdded() {
  const rows = await listWordCards({});
  addedWords.value = new Set(rows.map((r) => String(r.word || '').trim().toLowerCase()));
}

function isAdded(w) { return addedWords.value.has(String(w || '').trim().toLowerCase()); }

async function addWord(w) {
  try {
    await createWordCard({ kind: 'word', word: w, subject: '考研', source: syllabusMeta.title });
    addedWords.value = new Set(addedWords.value).add(String(w).trim().toLowerCase());
    await load();
  } catch (e) {
    toast(t('views.wordBook.syllabusAddFailed', undefined, { msg: e?.message || e }), 'error');
  }
}

async function addPage() {
  const todo = sylSlice.value.filter((w) => !isAdded(w));
  if (!todo.length) return;
  sylBusy.value = true;
  try {
    for (const w of todo) {
      await createWordCard({ kind: 'word', word: w, subject: '考研', source: syllabusMeta.title });
    }
    toast(t('views.wordBook.syllabusAddedToast', undefined, { n: todo.length }), 'success');
    await load();
    await refreshAdded();
  } catch (e) {
    toast(t('views.wordBook.syllabusAddFailed', undefined, { msg: e?.message || e }), 'error');
  } finally {
    sylBusy.value = false;
  }
}

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
  // 大纲视图的「已加入」状态要保持同步（加入/删除词后都会走这里）
  if (view.value === 'syllabus') {
    addedWords.value = new Set(cards.value.map((r) => String(r.word || '').trim().toLowerCase()));
  }
}
onMounted(async () => {
  try { sylExam.value = localStorage.getItem(SYL_EXAM_KEY) || 'en1'; } catch { /* ignore */ }
  await load();
  // 首次进入：本地一个词都没有 → 直接落到考研大纲，让默认词库可见
  if (!cards.value.length) {
    view.value = 'syllabus';
    await refreshAdded();
  }
});
watch([filterKind, filterReviewed, filterFamiliar], load);

async function onSearch() { await load(); }

const filteredCount = computed(() => cards.value.length);

// ---- 添加 / 编辑 ----
function openAdd() { editing.value = null; form.value = blankForm(); showAdd.value = true; }
function openEdit(c) { editing.value = c; form.value = { ...blankForm(), ...c, tags: (c.tags || []).join(', ') }; showAdd.value = true; }

async function genMaterials() {
  const word = form.value.word.trim();
  if (!word) { toast(t('views.wordBook.wordRequired'), 'warn'); return; }
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
      toast(t('views.wordBook.aiGenFailed', undefined, { msg: r.reason || '' }), 'error');
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
    syllable: f.syllable || '', derived: f.derived || [],
  };
  return out;
}

// 判断当前表单是否「仅填单词」：有单词、但其余学习内容字段（释义/音标/例句/同义词/词组/短语等）全空。
function isWordOnly() {
  const f = form.value;
  const word = String(f.word || '').trim();
  if (!word) return false;
  const contentEmpty = !(
    String(f.meaning || '').trim() || String(f.phonetic || '').trim() ||
    String(f.example || '').trim() || String(f.note || '').trim() ||
    (f.synonyms && f.synonyms.length) || (f.collocations && f.collocations.length) ||
    (f.phrases && f.phrases.length) || (f.examples && f.examples.length)
  );
  return contentEmpty;
}

// 静默自动生成（save 时调用）：仅回填空缺字段，绝不覆盖用户已填内容；
// 失败/未开启/超纲都静默跳过，不阻塞保存，也不弹错误（由 save 侧决定是否提示）。
async function autoGenerateSilent() {
  const word = String(form.value.word || '').trim();
  if (!settings.value?.aiEnabled || !isInSyllabus(word)) return false;
  try {
    const r = await generateWordMaterials({ word, levels: settings.value.exampleLevels, settings: settings.value });
    if (!r.ok || !r.data) return false;
    const d = r.data;
    form.value.meaning = form.value.meaning || (d.defs?.[0]?.meaning || '');
    form.value.pos = form.value.pos || d.pos || '';
    form.value.syllable = form.value.syllable || d.syllable || '';
    form.value.defs = form.value.defs?.length ? form.value.defs : (d.defs || []);
    form.value.synonyms = form.value.synonyms || d.synonyms;
    form.value.collocations = form.value.collocations || d.collocations;
    form.value.phrases = form.value.phrases || d.phrases;
    form.value.examples = form.value.examples || d.examples;
    form.value.derived = form.value.derived?.length ? form.value.derived : (d.derived || []);
    form.value.rootAffix = form.value.rootAffix || d.rootAffix || '';
    form.value.mnemonics = form.value.mnemonics || (d.mnemonic ? [d.mnemonic] : []);
    return true;
  } catch {
    return false;
  }
}

async function save() {
  const f = form.value;
  // 仅填单词 → 自动生成同义词/词组/短语/例句（AI 已开启且在大纲内），补齐后再落库
  let autoFilled = false;
  if (!editing.value && isWordOnly()) {
    genRunning.value = true;
    try { autoFilled = await autoGenerateSilent(); } finally { genRunning.value = false; }
  }
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
      toast(autoFilled ? t('views.wordBook.createdWithAi') : t('views.wordBook.created'), 'success');
    }
    showAdd.value = false;
    await load();
  } catch (e) {
    toast(t('views.wordBook.saveFailed') + '：' + (e?.message || e), 'error');
  }
}

async function remove(c) {
  if (!(await confirmDialog(t('views.wordBook.confirmDelete', undefined, { word: c.word })))) return;
  await deleteWordCard(c.id);
  toast(t('views.wordBook.deleted'), 'success');
  await load();
}

async function toggleFamiliar(c) {
  await markFamiliar(c.id, c.familiar ? 0 : 1);
  await load();
}

function openDetail(c) { detail.value = c; detailTab.value = 'collocations'; showDetail.value = true; }

// ---- 详情卡（对标成熟单词 App：音节大字 / 多词性释义 / 例句高亮 / 四 Tab） ----
const detailTab = ref('collocations'); // collocations | derived | root | synonyms
const detailTabs = computed(() => [
  { id: 'collocations', label: t('views.wordBook.detailCollocations') },
  { id: 'derived', label: t('views.wordBook.tabDerived') },
  { id: 'root', label: t('views.wordBook.tabRoot') },
  { id: 'synonyms', label: t('views.wordBook.detailSynonyms') },
]);
// 词条主显示：优先 AI 生成的音节拆分（al·ter·na·tive），无则原词
function displaySyllable(c) { return c?.syllable || c?.word || ''; }
// 列表卡片释义：defs 优先（多义项拼接），老数据退化为 meaning 字段
function cardMeaning(c) {
  if (c?.defs?.length) return c.defs.filter(d => d?.meaning).map(d => d.pos ? `${d.pos} ${d.meaning}` : d.meaning).join('；');
  return c?.meaning || '';
}
// 多义项释义：defs（[{pos,meaning}]）优先；老数据退化为 [{pos, meaning}] 单条
function detailDefs(c) {
  if (c?.defs?.length) return c.defs.filter((d) => d && (d.pos || d.meaning));
  return (c?.meaning || c?.pos) ? [{ pos: c?.pos || '', meaning: c?.meaning || '' }] : [];
}
// 例句数组：examples 优先，老数据退化为 example/exampleTrans 单条
function detailExamples(c) {
  if (c?.examples?.length) return c.examples;
  return c?.example ? [{ level: '', sentence: c.example, translation: c.exampleTrans || '' }] : [];
}

function speakWord(w) { speak(w, { lang: settings.value?.accent === 'auto' ? 'en-US' : settings.value?.accent }); }

const exampleLevelLabels = {
  simple: t('views.wordBook.exSimple'), long: t('views.wordBook.exLong'),
};

// HTML 转义（外部数据拼进 v-html 前必须转义，防注入）
function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 例句高亮目标词（先转义再包裹 <b>，顺序不能反——否则转义会把 <b> 吃掉）。
 * 词本身来自用户输入/AI 生成，同样需转义后再进正则（防正则元字符破坏匹配）。
 */
function highlightWord(example, word) {
  const safe = escHtml(example);
  const w = String(word || '').trim();
  if (!w) return safe;
  const pattern = escHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(pattern, 'gi'), (m) => `<b>${m}</b>`);
  } catch {
    return safe; // 正则异常时退回纯转义文本，不打断渲染
  }
}

// ---- 拍照识字：图片 → OCR → 抽取英文单词 → 批量建卡并自动补全缺失字段 ----

const ocrBusy = ref(false);       // OCR 识别中
const ocrAdding = ref(false);     // 批量加入中
const ocrShow = ref(false);       // 结果弹窗
const ocrError = ref('');
const ocrWords = ref([]);         // 识别到的候选单词（去重、按出现顺序）
const ocrSelected = ref(new Set());
const ocrFileInput = ref(null);

// 常见功能词：图片若为整段文字，过滤掉冠词/介词/代词等，只保留实义词，减少噪音。
const OCR_STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'this', 'that', 'these', 'those',
  'with', 'from', 'have', 'has', 'had', 'not', 'but', 'you', 'your', 'they',
  'their', 'them', 'his', 'her', 'its', 'our', 'all', 'can', 'will', 'would',
  'should', 'could', 'may', 'might', 'shall', 'about', 'into', 'over', 'after',
  'before', 'between', 'under', 'again', 'then', 'than', 'there', 'here', 'when',
  'where', 'which', 'what', 'who', 'whom', 'whose', 'why', 'how', 'also', 'such',
  'only', 'very', 'just', 'more', 'most', 'some', 'any', 'each', 'both', 'other',
  'another', 'been', 'being', 'does', 'did', 'doing', 'a', 'an', 'of', 'to', 'in',
  'on', 'at', 'by', 'as', 'is', 'it', 'be', 'or', 'so', 'if', 'we', 'he', 'she',
  'i', 'do', 'up', 'out', 'off', 'no', 'nor', 'too', 'yet', 'own', 'same', 'am',
]);

// 从 OCR 文本抽取英文单词：字母（可含连字符/撇号），长度≥2，去重 + 过滤功能词 + 上限截断
function extractWords(text) {
  const seen = new Set();
  const out = [];
  const re = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  let m;
  while ((m = re.exec(text)) && out.length < 300) {
    const raw = m[0];
    const low = raw.toLowerCase();
    if (low.length < 2) continue;
    if (OCR_STOP.has(low)) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(raw);
  }
  return out;
}

function openOcrPicker() {
  ocrFileInput.value?.click();
}

async function onOcrFile(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许重复选择同一文件
  if (!file) return;
  ocrBusy.value = true;
  ocrError.value = '';
  ocrWords.value = [];
  ocrSelected.value = new Set();
  ocrShow.value = true;
  try {
    const text = await ocrImageText(file);
    const words = extractWords(text);
    ocrWords.value = words;
    ocrSelected.value = new Set(words.map((_, i) => i));
    if (!words.length) ocrError.value = t('views.wordBook.ocrEmpty');
  } catch (err) {
    ocrError.value = t('views.wordBook.ocrFailed', undefined, { msg: err?.message || err });
  } finally {
    ocrBusy.value = false;
  }
}

function toggleOcrAll() {
  if (ocrSelected.value.size === ocrWords.value.length) ocrSelected.value = new Set();
  else ocrSelected.value = new Set(ocrWords.value.map((_, i) => i));
}

function toggleOcr(i) {
  const s = new Set(ocrSelected.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  ocrSelected.value = s;
}

// 加入单个词：已有同词跳过；大纲内且 AI 开启则自动生成同义词/词组/短语/例句补齐
async function addOcrWord(word) {
  const w = String(word || '').trim();
  if (!w) return { word: w, status: 'empty' };
  const exists = cards.value.some((c) => String(c.word || '').trim().toLowerCase() === w.toLowerCase());
  if (exists) return { word: w, status: 'skip' };
  const card = await createWordCard({ kind: 'word', word: w, subject: t('views.wordBook.defaultSubject'), source: t('views.wordBook.ocrSource') });
  if (settings.value?.aiEnabled && isInSyllabus(w)) {
    try {
      const r = await generateWordMaterials({ word: w, levels: settings.value.exampleLevels, settings: settings.value });
      if (r.ok && r.data) {
        const d = r.data;
        await updateWordCard(card.id, {
          meaning: d.defs?.[0]?.meaning || '',
          pos: d.pos || '',
          synonyms: d.synonyms, collocations: d.collocations,
          phrases: d.phrases, examples: d.examples,
          mnemonics: d.mnemonic ? [d.mnemonic] : [],
        });
        return { word: w, status: 'ok' };
      }
    } catch { /* 生成失败仅保留单词卡，不中断批量流程 */ }
  }
  return { word: w, status: 'wordOnly' };
}

async function addOcrWords() {
  const idxs = [...ocrSelected.value].filter((i) => i >= 0 && i < ocrWords.value.length);
  if (!idxs.length) { toast(t('views.wordBook.ocrEmpty'), 'warn'); return; }
  ocrAdding.value = true;
  let added = 0, generated = 0;
  try {
    for (const i of idxs) {
      const r = await addOcrWord(ocrWords.value[i]);
      if (r.status === 'ok') { added++; generated++; }
      else if (r.status === 'wordOnly') added++;
    }
    toast(t('views.wordBook.ocrDone', undefined, { n: added, m: generated }), 'success');
    ocrShow.value = false;
    await load();
  } catch (err) {
    toast(t('views.wordBook.ocrFailed', undefined, { msg: err?.message || err }), 'error');
  } finally {
    ocrAdding.value = false;
  }
}
</script>

<template>
  <div class="wbook">
    <div class="wb-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordHub.title') }}</button>
      <h1>{{ t('views.wordBook.title') }}</h1>
      <p>{{ t('views.wordBook.subtitle') }}</p>
    </div>

    <!-- 视图切换：我的词本 / 考研大纲（默认词库） -->
    <div class="wb-viewsw">
      <button class="wv" :class="{ on: view === 'book' }" @click="switchView('book')">
        {{ t('views.wordBook.myBookTab') }}<span v-if="stats"> · {{ stats.total }}</span>
      </button>
      <button class="wv" :class="{ on: view === 'syllabus' }" @click="switchView('syllabus')">
        {{ t('views.wordBook.syllabusTab') }} · {{ sylAll.length }}
      </button>
    </div>

    <!-- 统计卡 -->
    <div class="wb-stats" v-if="stats">
      <div class="wbs"><b>{{ stats.due }}</b><span>{{ t('views.wordBook.statDue') }}</span></div>
      <div class="wbs"><b>{{ stats.mastered }}</b><span>{{ t('views.wordBook.statMastered') }}</span></div>
      <div class="wbs"><b>{{ stats.newToday }}</b><span>{{ t('views.wordBook.statNewToday') }}</span></div>
      <div class="wbs"><b>{{ stats.familiar }}</b><span>{{ t('views.wordBook.statFamiliar') }}</span></div>
      <div class="wbs"><b>{{ stats.templates ?? 0 }}</b><span>{{ t('views.wordBook.statTemplate') }}</span></div>
      <div class="wbs"><b>{{ stats.total }}</b><span>{{ t('views.wordBook.statTotal') }}</span></div>
    </div>

    <!-- 考研大纲词书：4956 词按需分页浏览（不落库，点「加入」才进单词本） -->
    <div class="wb-syllabus" v-if="view === 'syllabus'">
      <div class="syl-head">
        <div class="syl-exam">
          <button class="se" :class="{ on: sylExam === 'en1' }" @click="setExam('en1')">{{ t('views.wordBook.syllabusExamEn1') }}</button>
          <button class="se" :class="{ on: sylExam === 'en2' }" @click="setExam('en2')">{{ t('views.wordBook.syllabusExamEn2') }}</button>
        </div>
        <div class="syl-title">{{ sylTitle }}</div>
        <div class="syl-meta">
          {{ t('views.wordBook.syllabusMeta', undefined, { n: sylAll.length, version: syllabusMeta.version || 'v1.0' }) }}
          · {{ t('views.wordBook.syllabusProgress', undefined, { n: sylAddedCount, total: sylAll.length }) }}
        </div>
        <div class="syl-disc">{{ t('views.wordBook.syllabusSharedHint') }}</div>
      </div>

      <div class="syl-tools">
        <input
          class="syl-search" v-model="sylQuery"
          :placeholder="t('views.wordBook.syllabusSearch')" />
        <button class="syl-addpage" :disabled="sylBusy" @click="addPage">
          {{ t('views.wordBook.syllabusAddPage', undefined, { n: sylSlice.filter((w) => !isAdded(w)).length }) }}
        </button>
      </div>

      <div class="syl-letters">
        <button
          v-for="L in sylLetters" :key="L" class="sl"
          @click="jumpLetter(L)">{{ L }}</button>
      </div>

      <div class="syl-grid" v-if="sylSlice.length">
        <div v-for="w in sylSlice" :key="w" class="syl-item" :class="{ added: isAdded(w) }">
          <span class="sw">{{ w }}</span>
          <button
            v-if="!isAdded(w)" class="sa" @click.stop="addWord(w)">{{ t('views.wordBook.syllabusAdd') }}</button>
          <span v-else class="sd">{{ t('views.wordBook.syllabusAdded') }}</span>
        </div>
      </div>
      <div class="syl-empty" v-else>{{ t('views.wordBook.syllabusEmpty') }}</div>

      <div class="syl-pager">
        <button class="sp" :disabled="sylPage <= 1" @click="sylPage--">{{ t('views.wordBook.syllabusPrev') }}</button>
        <span class="spi">{{ t('views.wordBook.syllabusPageInfo', undefined, { page: Math.min(sylPage, sylPages), pages: sylPages }) }}</span>
        <button class="sp" :disabled="sylPage >= sylPages" @click="sylPage++">{{ t('views.wordBook.syllabusNext') }}</button>
      </div>
    </div>

    <template v-else>

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
        <button class="wb-add wb-ocr" @click="openOcrPicker">📷 {{ t('views.wordBook.ocrAdd') }}</button>
        <button class="wb-add" @click="openAdd">＋ {{ t('views.wordBook.addBtn') }}</button>
        <input ref="ocrFileInput" type="file" accept="image/*" class="ocr-input" @change="onOcrFile" />
      </div>
    </div>

    <!-- 列表（不背风卡片：单词 / 音标 / 类型 + 释义 + 例句(高亮) + 翻译 + 批注来源标签 + 四操作） -->
    <div class="wb-list" v-if="cards.length">
      <div v-for="c in cards" :key="c.id" class="wb-card" @click="openDetail(c)">
        <div class="wb-card-top">
          <div class="wb-word">
            <span class="wb-wtext">{{ c.word }}</span>
            <span v-if="c.phonetic" class="wb-phon">/{{ c.phonetic }}/</span>
          </div>
          <span class="bdg" :class="'bdg-' + c.kind">{{ t('views.wordBook.kind' + c.kind.charAt(0).toUpperCase() + c.kind.slice(1)) }}</span>
        </div>
        <div class="wb-meaning" v-if="cardMeaning(c)">{{ cardMeaning(c) }}</div>
        <div class="wb-ex" v-if="c.example" v-html="highlightWord(c.example, c.word)"></div>
        <div class="wb-ex wb-ex-tr" v-if="c.exampleTrans">{{ c.exampleTrans }}</div>
        <div class="wb-meta" v-if="c.note || c.source || (c.tags && c.tags.length) || c.familiar">
          <span v-if="c.note" class="tag tag-note">📝 {{ c.note }}</span>
          <span v-if="c.source" class="tag">📚 {{ c.source }}</span>
          <span v-for="tg in (c.tags || [])" :key="tg" class="tag">#{{ tg }}</span>
          <span v-if="c.familiar" class="tag tag-fam">★ {{ t('views.wordBook.familiarBadge') }}</span>
        </div>
        <div class="wb-acts">
          <button @click.stop="speakWord(c.word)">🔊 <span>{{ t('views.wordBook.speak') }}</span></button>
          <button :class="{ on: c.familiar }" @click.stop="toggleFamiliar(c)">
            {{ c.familiar ? '★' : '☆' }} <span>{{ c.familiar ? t('views.wordBook.unmarkFamiliar') : t('views.wordBook.markFamiliar') }}</span>
          </button>
          <button @click.stop="openDetail(c)">📚 <span>{{ t('views.wordBook.addToGroup') }}</span></button>
          <button @click.stop="openEdit(c)">📝 <span>{{ t('views.wordBook.editNote') }}</span></button>
        </div>
      </div>
    </div>
    <div class="wb-empty" v-else>
      <p>{{ t('views.wordBook.empty') }}</p>
      <p class="hint">{{ t('views.wordBook.emptyHint') }}</p>
      <p class="hint syl-guide">{{ t('views.wordBook.syllabusGuide') }}</p>
      <button class="btn-primary" style="margin-top:12px" @click="switchView('syllabus')">
        {{ t('views.wordBook.syllabusTab') }}
      </button>
    </div>

    </template>

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

    <!-- 详情抽屉（对标成熟单词 App：音节大字 + 多词性释义 + 例句高亮 + 四 Tab） -->
    <div v-if="showDetail && detail" class="modal-mask" @click.self="showDetail = false">
      <div class="modal detail-modal">
        <div class="detail-head">
          <div class="detail-head-main">
            <h3 class="detail-word">{{ displaySyllable(detail) }}</h3>
            <div class="detail-phon-line" v-if="detail.phonetic">
              <span class="detail-phon">/{{ detail.phonetic }}/</span>
              <button class="wb-spk" @click="speakWord(detail.word)">🔊</button>
            </div>
            <div class="detail-defs">
              <div v-for="(d, i) in detailDefs(detail)" :key="i" class="ddef">
                <span v-if="d.pos" class="ddef-pos">{{ d.pos }}</span>{{ d.meaning }}
              </div>
            </div>
          </div>
          <span v-if="detail.familiar" class="tag tag-fam">★ {{ t('views.wordBook.familiarBadge') }}</span>
        </div>

        <!-- 例句：目标词加粗 + 中英对照 -->
        <div class="detail-examples" v-if="detailExamples(detail).length">
          <div class="de-title">{{ t('views.wordBook.detailExamples') }}</div>
          <div v-for="(ex, i) in detailExamples(detail)" :key="i" class="de-item">
            <span v-if="ex.level" class="de-lv" :class="'lv-' + ex.level">{{ exampleLevelLabels[ex.level] || ex.level }}</span>
            <div class="de-body">
              <div class="de-sent" v-html="highlightWord(ex.sentence, detail.word)"></div>
              <div class="de-trans" v-if="ex.translation">{{ ex.translation }}</div>
            </div>
            <button class="de-spk" @click="speak(ex.sentence)">🔊</button>
          </div>
        </div>

        <!-- 四 Tab：词组搭配 / 派生 / 词根 / 近义 -->
        <div class="detail-tabs">
          <button v-for="tb in detailTabs" :key="tb.id" class="dtab" :class="{ on: detailTab === tb.id }" @click="detailTab = tb.id">
            {{ tb.label }}
          </button>
        </div>

        <div class="detail-tab-body">
          <!-- 词组搭配 -->
          <template v-if="detailTab === 'collocations'">
            <div class="dtb-sec" v-if="detail.collocations && detail.collocations.length">
              <div class="ds-label">{{ t('views.wordBook.detailCollocations') }}</div>
              <div class="dtb-chips">
                <span v-for="c in detail.collocations" :key="c" class="dtb-chip">{{ c }}</span>
              </div>
            </div>
            <div class="dtb-sec" v-if="detail.phrases && detail.phrases.length">
              <div class="ds-label">{{ t('views.wordBook.detailPhrases') }}</div>
              <div class="dtb-chips">
                <span v-for="p in detail.phrases" :key="p" class="dtb-chip dtb-chip-p">{{ p }}</span>
              </div>
            </div>
            <p v-if="!(detail.collocations || []).length && !(detail.phrases || []).length" class="dtb-empty">{{ t('views.wordBook.tabEmpty') }}</p>
          </template>

          <!-- 派生 -->
          <template v-else-if="detailTab === 'derived'">
            <div class="dtb-sec" v-if="detail.derived && detail.derived.length">
              <div v-for="(dv, i) in detail.derived" :key="i" class="dtb-row">
                <span class="dtb-word">{{ dv.word }}</span>
                <span class="dtb-mean">{{ dv.meaning }}</span>
              </div>
            </div>
            <p v-else class="dtb-empty">{{ t('views.wordBook.tabEmpty') }}</p>
          </template>

          <!-- 词根（词根词缀 + 音节 + 助记） -->
          <template v-else-if="detailTab === 'root'">
            <div class="dtb-sec" v-if="detail.rootAffix">
              <div class="ds-label">{{ t('views.wordBook.detailRootAffix') }}</div>
              <p class="dtb-text">{{ detail.rootAffix }}</p>
            </div>
            <div class="dtb-sec" v-if="detail.syllable">
              <div class="ds-label">{{ t('views.wordBook.detailSyllable') }}</div>
              <p class="dtb-text">{{ detail.syllable }}</p>
            </div>
            <div class="dtb-sec" v-if="detail.mnemonics && detail.mnemonics.length">
              <div class="ds-label">{{ t('views.wordBook.detailMnemonics') }}</div>
              <p class="dtb-text">{{ detail.mnemonics.join('；') }}</p>
            </div>
            <p v-if="!detail.rootAffix && !detail.syllable && !(detail.mnemonics || []).length" class="dtb-empty">{{ t('views.wordBook.tabEmpty') }}</p>
          </template>

          <!-- 近义（同义词 + 易混淆） -->
          <template v-else-if="detailTab === 'synonyms'">
            <div class="dtb-sec" v-if="detail.synonyms && detail.synonyms.length">
              <div class="ds-label">{{ t('views.wordBook.detailSynonyms') }}</div>
              <div class="dtb-chips">
                <span v-for="s in detail.synonyms" :key="s" class="dtb-chip">{{ s }}</span>
              </div>
            </div>
            <div class="dtb-sec" v-if="detail.confusions && detail.confusions.length">
              <div class="ds-label">{{ t('views.wordBook.detailConfusions') }}</div>
              <div v-for="(cf, i) in detail.confusions" :key="i" class="dtb-row">
                <span class="dtb-word">{{ cf.word }}</span>
                <span class="dtb-mean">{{ cf.meaning }}</span>
              </div>
            </div>
            <p v-if="!(detail.synonyms || []).length && !(detail.confusions || []).length" class="dtb-empty">{{ t('views.wordBook.tabEmpty') }}</p>
          </template>
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

    <!-- 拍照识字结果 -->
    <div v-if="ocrShow" class="modal-mask" @click.self="!ocrAdding && (ocrShow = false)">
      <div class="modal ocr-modal">
        <h3>{{ t('views.wordBook.ocrTitle') }}</h3>
        <p class="ocr-hint">{{ t('views.wordBook.ocrHint') }}</p>

        <div v-if="ocrBusy" class="ocr-state">{{ t('views.wordBook.ocrBusy') }}</div>
        <div v-else-if="ocrError && !ocrWords.length" class="ocr-state err">{{ ocrError }}</div>
        <template v-else>
          <div class="ocr-tools">
            <span class="ocr-count">{{ t('views.wordBook.ocrFound', undefined, { n: ocrWords.length }) }}</span>
            <div class="spacer"></div>
            <button class="btn-ghost" @click="toggleOcrAll">{{ t('views.wordBook.ocrToggleAll') }}</button>
            <button class="btn-ghost" @click="openOcrPicker">{{ t('views.wordBook.ocrRescan') }}</button>
          </div>
          <div class="ocr-words">
            <label v-for="(w, i) in ocrWords" :key="w + '-' + i" class="ocr-word" :class="{ on: ocrSelected.has(i) }">
              <input type="checkbox" :checked="ocrSelected.has(i)" @change="toggleOcr(i)" />
              <span>{{ w }}</span>
            </label>
          </div>
          <div class="ocr-foot">
            <button class="btn-ghost" :disabled="ocrAdding" @click="ocrShow = false">{{ t('views.wordBook.cancel') }}</button>
            <div class="spacer"></div>
            <button class="btn-primary" :disabled="ocrAdding || !ocrSelected.size" @click="addOcrWords">
              {{ ocrAdding ? t('views.wordBook.ocrAdding') : t('views.wordBook.ocrAddSelected', undefined, { n: ocrSelected.size }) }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.wbook {
  /* 不背风：标志性流动渐变「墙」背景——以主题 token 派生，自适应 11 风格 × 3 模式 */
  --wb-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 16%, transparent);
  padding-bottom: 90px;
  min-height: 100vh;
  background-image: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 9%, var(--bg)),
    var(--bg) 45%,
    color-mix(in srgb, var(--accent) 6%, var(--bg))
  );
  background-size: 220% 220%;
  animation: wbwall 22s ease infinite;
}
@keyframes wbwall {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@media (prefers-reduced-motion: reduce) {
  .wbook { animation: none; }
}
.wb-head { padding: 16px 16px 4px; }
.wb-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; }
.wb-head h1 { margin: 6px 0 2px; font-size: 20px; color: var(--ink); }
.wb-head p { margin: 0; font-size: 12px; color: var(--ink-2); }

/* ---- 视图切换 ---- */
.wb-viewsw { display: flex; gap: 8px; padding: 10px 16px 2px; }
.wv {
  flex: 1; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  border-radius: 12px; padding: 9px 10px; font-size: 13px; cursor: pointer; transition: .15s;
}
.wv.on { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }

/* ---- 考研大纲词书 ---- */
.wb-syllabus { padding: 8px 16px 0; display: flex; flex-direction: column; gap: 10px; }
.syl-head {
  background: var(--panel); border: 1px dashed var(--line); border-radius: 14px; padding: 12px 14px;
}
.syl-exam { display: flex; gap: 6px; margin-bottom: 8px; }
.syl-exam .se {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  border-radius: 16px; padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.syl-exam .se.on { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
.syl-title { font-size: 15px; font-weight: 700; color: var(--ink); }
.syl-meta { font-size: 12px; color: var(--accent); margin-top: 4px; }
.syl-disc { font-size: 11px; color: var(--ink-2); margin-top: 6px; line-height: 1.6; }
.syl-tools { display: flex; gap: 8px; }
.syl-search {
  flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px;
  background: var(--panel); color: var(--ink); font-size: 13px;
}
.syl-addpage {
  border: none; background: var(--accent); color: #fff; border-radius: 10px;
  padding: 9px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.syl-addpage:disabled { opacity: .5; cursor: default; }
.syl-letters { display: flex; flex-wrap: wrap; gap: 4px; }
.syl-letters .sl {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  border-radius: 8px; padding: 3px 7px; font-size: 11px; cursor: pointer;
}
.syl-letters .sl:hover { border-color: var(--accent); color: var(--accent); }
.syl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.syl-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 7px 10px;
}
.syl-item.added { opacity: .6; }
.syl-item .sw { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.syl-item .sa {
  border: 1px solid var(--accent); background: transparent; color: var(--accent);
  border-radius: 8px; padding: 2px 7px; font-size: 11px; cursor: pointer; flex-shrink: 0;
}
.syl-item .sa:hover { background: var(--accent); color: #fff; }
.syl-item .sd { font-size: 11px; color: var(--ink-2); flex-shrink: 0; }
.syl-empty { padding: 26px 0; text-align: center; color: var(--ink-2); font-size: 13px; }
.syl-pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 4px 0 10px; }
.syl-pager .sp {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 9px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.syl-pager .sp:disabled { opacity: .4; cursor: default; }
.syl-pager .spi { font-size: 12px; color: var(--ink-2); }
.wb-empty .syl-guide { color: var(--accent); margin-top: 10px; }

.wb-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 12px 16px; }
.wbs { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 6px; text-align: center; box-shadow: var(--wb-shadow); }
.wbs b { display: block; font-size: 20px; font-weight: 700; color: var(--ink); }
.wbs span { font-size: 11px; color: var(--ink-2); }

.wb-toolbar { padding: 6px 16px 10px; display: flex; flex-direction: column; gap: 8px; }
.wb-kinds { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; padding-bottom: 8px; scrollbar-width: none; }
.wb-kinds::-webkit-scrollbar { display: none; }
.kchip { border: none; background: transparent; border-radius: 16px; padding: 6px 14px; font-size: 12px; cursor: pointer; color: var(--ink-2); white-space: nowrap; transition: .15s; }
.kchip.on { background: var(--accent); color: #fff; }
.wb-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.wb-search { flex: 1; min-width: 140px; border: 1px solid var(--line); border-radius: 14px; padding: 11px 14px; background: var(--panel); color: var(--ink); font-size: 13px; }
.wb-rev, .fam-toggle { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--panel); color: var(--ink); font-size: 13px; cursor: pointer; }
.fam-toggle.on { border-color: var(--accent); color: var(--accent); }
.wb-add { border: none; background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 13px; cursor: pointer; white-space: nowrap; }

.wb-list { padding: 0 16px; display: flex; flex-direction: column; gap: 12px; }
.wb-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 18px;
  padding: 16px 16px 0; cursor: pointer; transition: .15s; overflow: hidden;
  box-shadow: var(--wb-shadow);
}
.wb-card:hover { border-color: var(--accent); transform: translateY(-2px); }
.wb-card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.wb-word { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.wb-wtext { font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: .3px; }
.wb-phon { font-size: 13px; color: var(--ink-2); }
.wb-meaning { margin-top: 8px; font-size: 15px; line-height: 1.55; color: var(--ink); }
.wb-ex {
  margin-top: 8px; font-size: 13px; line-height: 1.65; color: var(--ink-2);
  border-left: 3px solid var(--line); padding-left: 10px;
}
.wb-ex :deep(b) { color: var(--accent); font-weight: 700; }
.wb-ex-tr { border-left-color: var(--accent-soft, var(--line)); }
.wb-meta { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.wb-meta .tag {
  font-size: 11px; color: var(--ink-2); background: var(--line);
  border-radius: 8px; padding: 2px 8px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wb-meta .tag-note { color: var(--accent); }
.wb-meta .tag-fam { color: #b7791f; background: #fff0d6; }
.wb-acts {
  display: flex; margin: 12px -16px 0; border-top: 1px solid var(--line);
}
.wb-acts button {
  flex: 1; border: none; background: transparent; color: var(--ink-2);
  font-size: 12px; padding: 9px 2px; cursor: pointer; display: flex;
  align-items: center; justify-content: center; gap: 3px; transition: .15s;
}
.wb-acts button + button { border-left: 1px solid var(--line); }
.wb-acts button:hover { background: var(--code-inline); color: var(--accent); }
.wb-acts button.on { color: #b7791f; }
.wb-acts button span { white-space: nowrap; }
@media (max-width: 420px) { .wb-acts button span { display: none; } .wb-acts button { font-size: 15px; } }
.wb-spk { border: none; background: transparent; cursor: pointer; font-size: 15px; }
.bdg { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--code-inline); color: var(--accent); flex-shrink: 0; }
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

/* ---- 拍照识字 ---- */
.ocr-input { display: none; }
.wb-ocr { background: transparent; border: 1px solid var(--accent); color: var(--accent); }
.ocr-modal h3 { margin: 0 0 4px; font-size: 16px; color: var(--ink); }
.ocr-hint { margin: 0 0 12px; font-size: 12px; color: var(--ink-2); line-height: 1.6; }
.ocr-state { padding: 26px 10px; text-align: center; font-size: 13px; color: var(--ink-2); }
.ocr-state.err { color: #d9534f; }
.ocr-tools { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ocr-count { font-size: 12px; color: var(--ink-2); }
.ocr-words { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow-y: auto; padding: 2px; }
.ocr-word {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border: 1px solid var(--line); border-radius: 16px; font-size: 13px;
  color: var(--ink); cursor: pointer; user-select: none;
}
.ocr-word.on { border-color: var(--accent); background: var(--code-inline); color: var(--accent); }
.ocr-word input { width: 15px; height: 15px; margin: 0; }
.ocr-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.ocr-foot .btn-primary:disabled { opacity: .55; cursor: default; }
@media (max-width: 520px) { .add-grid { grid-template-columns: 1fr; } .ag-wide { grid-column: span 1; } }
</style>
