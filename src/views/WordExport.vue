<script setup>
// 单词导出页（不背风改版）
//   打印通道：A4 双栏 40 词/页，三种版式（默写 / 中文词表 / 英文词表）+ 乱序 + 真实 A4 预览 + 导出历史；
//   文本通道：Markdown 复习卡 / Anki 导入包 / CSV；
//   顶部保留「原数据标注」，记录本次导出的完整上下文（应用/版本/范围/语言/顺序/条目数）。
import { ref, computed, onMounted, watch } from 'vue';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { listWordCards, listWordGroups } from '../word-repo.js';
import { currentDbMode } from '../db.js';
import { buildWordSheet, printWordSheet, downloadWordSheetHtml, PAGE_SIZE } from '../services/word-print.js';
import { exportWordPdf, listExportHistory } from '../services/word-pdf.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const WORD_MODULE_VERSION = '1.1';
const LAST_KEY = 'sxy_word_export_last';

const SUBJECTS = ['考研', '四六级', '雅思', '托福', '专四专八', '其他'];
const KINDS = [
  { value: 'word', key: 'views.wordBook.kindWord' },
  { value: 'phrase', key: 'views.wordBook.kindPhrase' },
  { value: 'sentence', key: 'views.wordBook.kindSentence' },
  { value: 'template', key: 'views.wordBook.kindTemplate' },
];
const LAYOUTS = [
  { value: 'a4write', icon: '✍️', label: 'pdfA4Write', desc: 'pdfA4WriteDesc' },
  { value: 'zhList', icon: '🀄', label: 'pdfZhList', desc: 'pdfZhListDesc' },
  { value: 'enList', icon: '🔤', label: 'pdfEnList', desc: 'pdfEnListDesc' },
];
const CHANNELS = [
  { value: 'print', label: 'channelPrint', desc: 'channelPrintDesc' },
  { value: 'html', label: 'channelHtml', desc: 'channelHtmlDesc' },
  { value: 'pdf', label: 'channelPdf', desc: 'channelPdfDesc' },
];

const fmt = ref('pdf');            // pdf | markdown | anki | csv
const layout = ref('a4write');     // a4write | zhList | enList
const channel = ref('print');      // print | html | pdf
const sheetTitle = ref('');
const shuffle = ref(false);
const lang = ref('both');          // both | en | zh
const order = ref('seq');          // seq | shuffle（文本通道用）
const range = ref('all');          // all | incremental | byKind | byGroup | bySubject
const rangeKind = ref('word');
const rangeGroup = ref('');
const rangeSubject = ref('考研');
const opt = ref({ note: true, example: true, phonetic: true, source: true });

const groups = ref([]);
const rows = ref([]);
const history = ref([]);
const busy = ref(false);
const lastExport = ref(Number(localStorage.getItem(LAST_KEY) || 0));

// ---------- 标注 / 标签 ----------
const langLabel = computed(() => ({
  both: t('views.wordExport.langBoth'),
  en: t('views.wordExport.langEn'),
  zh: t('views.wordExport.langZh'),
}[lang.value]));
const orderLabel = computed(() => (isShuffled.value ? t('views.wordExport.orderShuffle') : t('views.wordExport.orderSeq')));
const isShuffled = computed(() => (fmt.value === 'pdf' ? shuffle.value : order.value === 'shuffle'));
function kindName(v) { return t(KINDS.find((k) => k.value === v)?.key || 'views.wordBook.kindWord'); }
const rangeLabel = computed(() => {
  if (range.value === 'all') return t('views.wordExport.rangeAll');
  if (range.value === 'incremental') return t('views.wordExport.rangeIncremental');
  if (range.value === 'byKind') return `${t('views.wordExport.rangeByKind')}：${kindName(rangeKind.value)}`;
  if (range.value === 'byGroup') {
    const g = groups.value.find((x) => x.id === rangeGroup.value);
    return `${t('views.wordExport.rangeByGroup')}：${g?.name || '—'}`;
  }
  if (range.value === 'bySubject') return `${t('views.wordExport.rangeBySubject')}：${rangeSubject.value}`;
  return '';
});
const scopeLabel = computed(() => (currentDbMode() === 'test' ? 'test' : 'real'));

const metaObj = computed(() => ({
  [t('views.wordExport.metaApp')]: 'SxyBrick',
  [t('views.wordExport.metaVersion')]: WORD_MODULE_VERSION,
  [t('views.wordExport.metaExportedAt')]: new Date().toLocaleString(),
  [t('views.wordExport.metaScope')]: scopeLabel.value,
  [t('views.wordExport.metaRange')]: rangeLabel.value,
  [t('views.wordExport.metaLang')]: langLabel.value,
  [t('views.wordExport.metaOrder')]: orderLabel.value,
  [t('views.wordExport.metaTotal')]: rows.value.length,
  [t('views.wordExport.metaIncremental')]: range.value === 'incremental' ? '✓' : '—',
}));
const lastExportText = computed(() => (lastExport.value ? new Date(lastExport.value).toLocaleString() : t('views.wordExport.neverExported')));

// 页眉标题：未填时用「范围 + 条目数」自动生成
const effectiveTitle = computed(() => sheetTitle.value.trim() || `${t('views.wordExport.title')} · ${rangeLabel.value}`);
const metaLine = computed(() => [
  `${rows.value.length} ${t('views.wordExport.metaTotal')}`,
  rangeLabel.value,
  orderLabel.value,
  new Date().toLocaleDateString(),
].filter(Boolean).join(' · '));
const pageCount = computed(() => Math.max(1, Math.ceil(rows.value.length / PAGE_SIZE)));

// ---------- 取数 ----------
async function gather() {
  const base = {};
  if (range.value === 'byKind') base.kind = rangeKind.value;
  else if (range.value === 'bySubject') base.subject = rangeSubject.value;
  else if (range.value === 'byGroup') base.groupId = rangeGroup.value;
  let list = await listWordCards(base);
  if (range.value === 'incremental') {
    const last = Number(localStorage.getItem(LAST_KEY) || 0);
    list = list.filter((r) => (r.updatedAt || 0) > last);
  }
  list = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  rows.value = list;
  return list;
}
async function refresh() { await gather(); }
async function loadHistory() { history.value = await listExportHistory(); }

onMounted(async () => {
  groups.value = await listWordGroups();
  await gather();
  await loadHistory();
});
watch([range, rangeKind, rangeGroup, rangeSubject], refresh);

// ---------- A4 预览（仅首页 40 词，避免大列表卡顿） ----------
const previewHtml = computed(() => {
  if (fmt.value !== 'pdf') return '';
  const cards = rows.value.slice(0, PAGE_SIZE);
  if (!cards.length) return '';
  return buildWordSheet({
    cards,
    mode: layout.value,
    title: effectiveTitle.value,
    metaLine: metaLine.value,
    phonetic: opt.value.phonetic,
  }).html;
});

// ---------- 文本通道 ----------
function fa(c) {
  const ph = opt.value.phonetic && c.phonetic ? `/${c.phonetic}/` : '';
  const ex = opt.value.example && c.example ? c.example + (c.exampleTrans ? ` —— ${c.exampleTrans}` : '') : '';
  const note = opt.value.note && c.note ? c.note : '';
  const src = opt.value.source && c.source ? c.source : '';
  if (lang.value === 'en') return { front: c.word + (ph ? ` ${ph}` : ''), back: ex || c.meaning, ex, note, src };
  if (lang.value === 'zh') return { front: c.meaning, back: c.word + (ph ? ` ${ph}` : ''), ex, note, src };
  return { front: c.word + (ph ? ` ${ph}` : ''), back: c.meaning + (ex ? `\n${ex}` : ''), ex, note, src };
}
function textList() {
  const list = rows.value.slice();
  if (order.value === 'shuffle') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  return list;
}
function metaComment(prefix) {
  return Object.entries(metaObj.value).map(([k, v]) => `${prefix}${k}：${v}`).join('\n');
}
function genMarkdown(list) {
  let out = `# ${t('views.wordExport.title')}\n\n${metaComment('> ')}\n`;
  for (const c of list) {
    const f = fa(c);
    out += `\n## ${f.front}\n- ${t('views.wordBook.formMeaning')}：${f.back}\n`;
    if (opt.value.example && c.example) out += `- ${t('views.wordBook.formExample')}：${c.example}${c.exampleTrans ? ` —— ${c.exampleTrans}` : ''}\n`;
    if (f.note) out += `- ${t('views.wordBook.noteLabel')}：${f.note}\n`;
    if (f.src) out += `- ${t('views.wordBook.sourceLabel')}：${f.src}\n`;
    if (c.tags && c.tags.length) out += `- ${t('views.wordBook.formTags')}：${c.tags.join(', ')}\n`;
  }
  return out;
}
function genAnki(list) {
  let out = `${metaComment('# ')}\n`;
  for (const c of list) {
    const f = fa(c);
    out += `${f.front.replace(/\t/g, ' ')}\t${String(f.back).replace(/\t/g, ' ').replace(/\n/g, '<br>')}\n`;
  }
  return out;
}
function genCsv(list) {
  let cols; let header;
  // 表头跟随界面语言（英文 locale 导出的文件不应该是中文表头，P2-A）
  if (lang.value === 'en') {
    cols = ['word', 'phonetic', 'example', 'exampleTrans', 'note', 'source', 'subject', 'kind'];
    header = t('views.wordExport.csvHeaderEn');
  } else if (lang.value === 'zh') {
    cols = ['meaning', 'exampleTrans', 'note', 'source', 'subject', 'kind'];
    header = t('views.wordExport.csvHeaderZh');
  } else {
    cols = ['word', 'phonetic', 'meaning', 'example', 'exampleTrans', 'note', 'source', 'subject', 'kind', 'tags'];
    header = t('views.wordExport.csvHeaderBoth');
  }
  const escq = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let out = `${metaComment('# ')}\n`;
  out += `${header.map(escq).join(',')}\n`;
  for (const c of list) {
    out += `${cols.map((col) => (col === 'tags' ? (c.tags || []).join('; ') : c[col] || '')).map(escq).join(',')}\n`;
  }
  return `\uFEFF${out}`;
}
const textPreview = computed(() => {
  if (fmt.value === 'pdf' || !rows.value.length) return '';
  const list = rows.value.slice(0, 60);
  if (fmt.value === 'markdown') return genMarkdown(list);
  if (fmt.value === 'anki') return genAnki(list);
  return genCsv(list);
});
const fmtDesc = computed(() => ({
  pdf: t('views.wordExport.fmtPdfDesc'),
  markdown: t('views.wordExport.fmtMarkdownDesc'),
  anki: t('views.wordExport.fmtAnkiDesc'),
  csv: t('views.wordExport.fmtCsvDesc'),
}[fmt.value]));

function stampLast() {
  localStorage.setItem(LAST_KEY, String(Date.now()));
  lastExport.value = Date.now();
}

function downloadText() {
  const list = textList();
  if (!list.length) { toast(t('views.wordExport.empty'), 'warning'); return; }
  let text; let name; let mime;
  if (fmt.value === 'markdown') { text = genMarkdown(list); name = 'words.md'; mime = 'text/markdown'; }
  else if (fmt.value === 'anki') { text = genAnki(list); name = 'words-anki.txt'; mime = 'text/plain'; }
  else { text = genCsv(list); name = 'words.csv'; mime = 'text/csv'; }
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  stampLast();
  toast(t('views.wordExport.exportedToast'), 'success');
}

// ---------- 打印通道 ----------
async function runSheet() {
  if (!rows.value.length) { toast(t('views.wordExport.empty'), 'warning'); return; }
  busy.value = true;
  const req = {
    cards: rows.value,
    mode: layout.value,
    title: effectiveTitle.value,
    metaLine: metaLine.value,
    phonetic: opt.value.phonetic,
    shuffle: shuffle.value,
    scopeLabel: rangeLabel.value,
    langLabel: langLabel.value,
  };
  let res;
  try {
    if (channel.value === 'print') res = await printWordSheet(req);
    else if (channel.value === 'html') res = await downloadWordSheetHtml(req);
    else res = await exportWordPdf(req);
  } catch (e) {
    res = { ok: false, reason: e?.message || 'unknown' };
  }
  busy.value = false;
  if (res?.ok) {
    stampLast();
    await loadHistory();
    toast(
      channel.value === 'print'
        ? t('views.wordExport.printOk', undefined, { n: res.pageCount || pageCount.value })
        : t('views.wordExport.exportedToast'),
      'success',
    );
  } else {
    toast(t('views.wordExport.printFailed', undefined, { reason: res?.reason || '' }), 'error');
  }
}

async function copyText() {
  const text = textPreview.value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast(t('views.wordExport.copied'), 'success'); }
  catch { toast(t('views.wordExport.printFailed', undefined, { reason: 'clipboard' }), 'error'); }
}

// ---------- 历史 ----------
const HIST_KIND = {
  a4write: 'pdfA4Write', zhList: 'pdfZhList', enList: 'pdfEnList',
};
function histKind(k) {
  const key = HIST_KIND[k];
  return key ? t(`views.wordExport.${key}`) : String(k || '').toUpperCase();
}
function histTime(ts) { return new Date(ts || 0).toLocaleString(); }
</script>

<template>
  <div class="ex">
    <header class="ex-head">
      <h1>{{ t('views.wordExport.title') }}</h1>
      <p class="sub">{{ t('views.wordExport.subtitle') }}</p>
    </header>

    <!-- 原数据标注 -->
    <section class="card meta-card">
      <div class="card-title">🏷️ {{ t('views.wordExport.metaTitle') }}</div>
      <div class="meta-grid">
        <div v-for="(v, k) in metaObj" :key="k" class="mi"><span>{{ k }}</span><b>{{ v }}</b></div>
      </div>
      <p class="muted sm">{{ t('views.wordExport.lastExportAt', undefined, { time: lastExportText }) }}</p>
    </section>

    <!-- 范围 -->
    <section class="card">
      <div class="card-title">🎯 {{ t('views.wordExport.rangeLabel') }}</div>
      <div class="grid2">
        <div class="fld">
          <label>{{ t('views.wordExport.rangeLabel') }}</label>
          <el-select v-model="range" style="width:100%">
            <el-option value="all" :label="t('views.wordExport.rangeAll')" />
            <el-option value="incremental" :label="t('views.wordExport.rangeIncremental')" />
            <el-option value="byKind" :label="t('views.wordExport.rangeByKind')" />
            <el-option value="byGroup" :label="t('views.wordExport.rangeByGroup')" />
            <el-option value="bySubject" :label="t('views.wordExport.rangeBySubject')" />
          </el-select>
        </div>
        <div v-if="range === 'byKind'" class="fld">
          <label>{{ t('views.wordExport.metaKind') }}</label>
          <el-select v-model="rangeKind" style="width:100%">
            <el-option v-for="k in KINDS" :key="k.value" :value="k.value" :label="t(k.key)" />
          </el-select>
        </div>
        <div v-else-if="range === 'byGroup'" class="fld">
          <label>{{ t('views.wordExport.metaGroup') }}</label>
          <el-select v-model="rangeGroup" style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :value="g.id" :label="g.name" />
          </el-select>
        </div>
        <div v-else-if="range === 'bySubject'" class="fld">
          <label>{{ t('views.wordExport.metaSubject') }}</label>
          <el-select v-model="rangeSubject" style="width:100%">
            <el-option v-for="s in SUBJECTS" :key="s" :value="s" :label="s" />
          </el-select>
        </div>
      </div>
      <p v-if="range === 'incremental'" class="muted sm">{{ t('views.wordExport.incrementalHint') }}</p>
      <div class="chips opts-chips">
        <button class="chip" :class="{ on: opt.phonetic }" @click="opt.phonetic = !opt.phonetic">{{ t('views.wordExport.includePhonetic') }}</button>
        <button class="chip" :class="{ on: opt.example }" @click="opt.example = !opt.example">{{ t('views.wordExport.includeExample') }}</button>
        <button class="chip" :class="{ on: opt.note }" @click="opt.note = !opt.note">{{ t('views.wordExport.includeNote') }}</button>
        <button class="chip" :class="{ on: opt.source }" @click="opt.source = !opt.source">{{ t('views.wordExport.includeSource') }}</button>
      </div>
    </section>

    <!-- 格式 -->
    <section class="card">
      <div class="card-title">📦 {{ t('views.wordExport.formatLabel') }}</div>
      <div class="chips">
        <button class="chip" :class="{ on: fmt === 'pdf' }" @click="fmt = 'pdf'">{{ t('views.wordExport.fmtPdf') }}</button>
        <button class="chip" :class="{ on: fmt === 'markdown' }" @click="fmt = 'markdown'">{{ t('views.wordExport.fmtMarkdown') }}</button>
        <button class="chip" :class="{ on: fmt === 'anki' }" @click="fmt = 'anki'">{{ t('views.wordExport.fmtAnki') }}</button>
        <button class="chip" :class="{ on: fmt === 'csv' }" @click="fmt = 'csv'">{{ t('views.wordExport.fmtCsv') }}</button>
      </div>
      <p class="muted sm">{{ fmtDesc }}</p>
    </section>

    <!-- 打印通道 -->
    <template v-if="fmt === 'pdf'">
      <section class="card">
        <div class="card-title">🖨️ {{ t('views.wordExport.pdfTitle') }}</div>
        <div class="layouts">
          <button v-for="l in LAYOUTS" :key="l.value" class="layout" :class="{ on: layout === l.value }" @click="layout = l.value">
            <span class="lo-ico">{{ l.icon }}</span>
            <span class="lo-txt">
              <b>{{ t('views.wordExport.' + l.label) }}</b>
              <i>{{ t('views.wordExport.' + l.desc) }}</i>
            </span>
          </button>
        </div>

        <div class="grid2 mt">
          <div class="fld">
            <label>{{ t('views.wordExport.sheetTitleLabel') }}</label>
            <el-input v-model="sheetTitle" :placeholder="t('views.wordExport.sheetTitlePlaceholder')" clearable />
          </div>
          <div class="fld">
            <label>{{ t('views.wordExport.shuffleLabel') }}</label>
            <div class="row-line">
              <el-switch v-model="shuffle" />
              <span class="muted sm">{{ shuffle ? t('views.wordExport.shuffleOn') : t('views.wordExport.shuffleOff') }}</span>
            </div>
          </div>
        </div>

        <div class="fld mt">
          <label>{{ t('views.wordExport.channelLabel') }}</label>
          <div class="chips">
            <button v-for="c in CHANNELS" :key="c.value" class="chip" :class="{ on: channel === c.value }" @click="channel = c.value">
              {{ t('views.wordExport.' + c.label) }}
            </button>
          </div>
          <p class="muted sm">{{ t('views.wordExport.' + (CHANNELS.find(c => c.value === channel)?.desc || 'channelPrintDesc')) }}</p>
          <p v-if="channel === 'pdf'" class="warn">{{ t('views.wordExport.cjkWarn') }}</p>
        </div>

        <div class="acts">
          <el-button type="primary" :loading="busy" @click="runSheet">
            {{ channel === 'print' ? t('views.wordExport.printBtn') : (channel === 'html' ? t('views.wordExport.htmlBtn') : t('views.wordExport.pdfBtn')) }}
          </el-button>
          <span class="muted sm">{{ t('views.wordExport.pagesInfo', undefined, { n: pageCount }) }}</span>
        </div>
      </section>

      <!-- A4 预览 -->
      <section class="card">
        <div class="card-title">👀 {{ t('views.wordExport.previewLabel') }}（{{ rows.length }}）</div>
        <div v-if="previewHtml" class="a4-wrap">
          <iframe :srcdoc="previewHtml" title="A4 preview"></iframe>
        </div>
        <div v-else class="empty">
          <p>{{ t('views.wordExport.empty') }}</p>
          <p class="muted sm">{{ t('views.wordExport.emptyHint') }}</p>
        </div>
      </section>
    </template>

    <!-- 文本通道 -->
    <template v-else>
      <section class="card">
        <div class="grid2">
          <div class="fld">
            <label>{{ t('views.wordExport.langLabel') }}</label>
            <div class="chips">
              <button class="chip" :class="{ on: lang === 'both' }" @click="lang = 'both'">{{ t('views.wordExport.langBoth') }}</button>
              <button class="chip" :class="{ on: lang === 'en' }" @click="lang = 'en'">{{ t('views.wordExport.langEn') }}</button>
              <button class="chip" :class="{ on: lang === 'zh' }" @click="lang = 'zh'">{{ t('views.wordExport.langZh') }}</button>
            </div>
          </div>
          <div class="fld">
            <label>{{ t('views.wordExport.orderLabel') }}</label>
            <div class="chips">
              <button class="chip" :class="{ on: order === 'seq' }" @click="order = 'seq'">{{ t('views.wordExport.orderSeq') }}</button>
              <button class="chip" :class="{ on: order === 'shuffle' }" @click="order = 'shuffle'">{{ t('views.wordExport.orderShuffle') }}</button>
            </div>
          </div>
        </div>
        <div class="acts">
          <el-button type="primary" @click="downloadText">{{ t('views.wordExport.exportBtn') }}</el-button>
          <el-button :disabled="!textPreview" @click="copyText">{{ t('views.wordExport.copyBtn') }}</el-button>
        </div>
      </section>
      <section class="card">
        <div class="card-title">👀 {{ t('views.wordExport.previewLabel') }}（{{ rows.length }}）</div>
        <pre v-if="textPreview" class="pv">{{ textPreview }}</pre>
        <div v-else class="empty">
          <p>{{ t('views.wordExport.empty') }}</p>
          <p class="muted sm">{{ t('views.wordExport.emptyHint') }}</p>
        </div>
      </section>
    </template>

    <!-- 导出历史 -->
    <section class="card">
      <div class="card-title">🕐 {{ t('views.wordExport.historyTitle') }}</div>
      <div v-if="history.length" class="hist">
        <div v-for="h in history" :key="h.id" class="hi">
          <span class="hk">{{ histKind(h.kind) }}</span>
          <span class="ht">{{ histTime(h.createdAt) }}</span>
          <span class="hs">{{ h.scope || '—' }}</span>
          <span class="hn">{{ h.total }} · {{ t('views.wordExport.historyPages', undefined, { n: h.pageCount || 1 }) }}</span>
          <span class="ho">{{ h.ordered ? t('views.wordExport.shuffleOff') : t('views.wordExport.shuffleOn') }}</span>
        </div>
      </div>
      <p v-else class="muted sm">{{ t('views.wordExport.historyEmpty') }}</p>
      <p class="muted sm">{{ t('views.wordExport.historyKeep') }}</p>
    </section>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.ex { max-width: 880px; margin: 0 auto; padding: 18px 16px 96px; color: var(--el-text-color-primary); }
.ex-head h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin: 0 0 16px; line-height: 1.6; }

.card { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 16px; margin-bottom: 14px; }
.card-title { font-weight: 700; font-size: 14px; margin-bottom: 12px; }
.meta-card { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-7); }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px 16px; font-size: 13px; }
.mi { display: flex; gap: 6px; min-width: 0; }
.mi span { color: var(--el-text-color-secondary); flex: none; }
.mi b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.muted { color: var(--el-text-color-secondary); }
.sm { font-size: 12px; margin: 8px 0 0; line-height: 1.6; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fld > label { font-size: 13px; color: var(--el-text-color-regular); }
.mt { margin-top: 12px; }
.row-line { display: flex; align-items: center; gap: 10px; height: 32px; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--el-border-color); background: var(--el-fill-color-blank); color: var(--el-text-color-regular);
        border-radius: 999px; padding: 6px 14px; font-size: 13px; cursor: pointer; transition: .18s; min-height: 32px; }
.chip:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.chip.on { background: var(--el-color-primary); border-color: var(--el-color-primary); color: #fff; }
.opts-chips { margin-top: 12px; }

.layouts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.layout { display: flex; align-items: flex-start; gap: 10px; text-align: left; cursor: pointer; padding: 12px;
          border: 1px solid var(--el-border-color); border-radius: var(--radius); background: var(--el-fill-color-blank); transition: .18s; }
.layout:hover { border-color: var(--el-color-primary); }
.layout.on { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.lo-ico { font-size: 20px; line-height: 1.2; }
.lo-txt { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lo-txt b { font-size: 14px; color: var(--el-text-color-primary); }
.lo-txt i { font-style: normal; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; }

.warn { font-size: 12px; color: var(--el-color-warning); background: var(--el-color-warning-light-9);
        border: 1px solid var(--el-color-warning-light-7); border-radius: 8px; padding: 8px 10px; margin: 8px 0 0; line-height: 1.6; }
.acts { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.acts .sm { margin: 0; }

.a4-wrap { --pv: .62; width: calc(794px * var(--pv)); height: calc(1123px * var(--pv));
           overflow: hidden; margin: 0 auto; border-radius: 6px; box-shadow: 0 2px 14px rgba(0, 0, 0, .12); background: #fff; }
.a4-wrap iframe { width: 794px; height: 1123px; border: 0; transform: scale(var(--pv)); transform-origin: top left; }
@media (max-width: 760px) { .a4-wrap { --pv: .4; } }

.pv { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; max-height: 420px; overflow: auto; margin: 0;
      font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; background: var(--el-fill-color-light);
      border-radius: 8px; padding: 12px; }
.empty { text-align: center; padding: 28px 10px; }
.empty p { margin: 0; font-size: 14px; }

.hist { display: flex; flex-direction: column; gap: 6px; }
.hi { display: grid; grid-template-columns: 88px 1fr 1fr 120px 56px; gap: 10px; align-items: center;
      font-size: 12.5px; padding: 8px 10px; border-radius: 8px; background: var(--el-fill-color-light); }
.hi > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hk { font-weight: 700; color: var(--el-color-primary); }
.ht, .hs, .hn, .ho { color: var(--el-text-color-secondary); }
@media (max-width: 700px) { .hi { grid-template-columns: 1fr 1fr; } }
</style>
