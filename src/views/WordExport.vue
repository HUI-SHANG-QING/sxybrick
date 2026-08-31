<script setup>
// 单词导出页（重点）：原数据标注 + 多语言(中英/仅英/仅中) + 顺序/乱序 + 范围(全量/增量/按类型/词组/类别) + 格式(Markdown/Anki/CSV/A4)。
import { ref, computed, onMounted } from 'vue';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { listWordCards, listWordGroups } from '../word-repo.js';
import { currentDbMode } from '../db.js';

const WORD_MODULE_VERSION = '1.0';
const LAST_KEY = 'sxy_word_export_last';

const SUBJECTS = ['考研', '四六级', '雅思', '托福', '专四专八', '其他'];
const KINDS = [
  { value: 'word', key: 'views.wordBook.kindWord' },
  { value: 'phrase', key: 'views.wordBook.kindPhrase' },
  { value: 'sentence', key: 'views.wordBook.kindSentence' },
  { value: 'template', key: 'views.wordBook.kindTemplate' },
];

const lang = ref('both'); // both | en | zh
const order = ref('seq'); // seq | shuffle
const range = ref('all'); // all | incremental | byKind | byGroup | bySubject
const rangeKind = ref('word');
const rangeGroup = ref('');
const rangeSubject = ref('考研');
const fmt = ref('markdown'); // markdown | anki | csv | a4
const opt = ref({ note: true, example: true, phonetic: true, source: true });

const groups = ref([]);
const rows = ref([]);
const lastExport = ref(Number(localStorage.getItem(LAST_KEY) || 0));

const langLabel = computed(() => ({ both: t('views.wordExport.langBoth'), en: t('views.wordExport.langEn'), zh: t('views.wordExport.langZh') }[lang.value]));
const orderLabel = computed(() => ({ seq: t('views.wordExport.orderSeq'), shuffle: t('views.wordExport.orderShuffle') }[order.value]));
function kindName(v) { return t(KINDS.find(k => k.value === v)?.key || 'views.wordBook.kindWord'); }
const rangeLabel = computed(() => {
  if (range.value === 'all') return t('views.wordExport.rangeAll');
  if (range.value === 'incremental') return t('views.wordExport.rangeIncremental');
  if (range.value === 'byKind') return t('views.wordExport.rangeByKind') + '：' + kindName(rangeKind.value);
  if (range.value === 'byGroup') { const g = groups.value.find(x => x.id === rangeGroup.value); return t('views.wordExport.rangeByGroup') + '：' + (g?.name || '—'); }
  if (range.value === 'bySubject') return t('views.wordExport.rangeBySubject') + '：' + rangeSubject.value;
  return '';
});
const scopeLabel = computed(() => (currentDbMode() === 'test' ? 'test' : 'real'));

// 原数据标注（实时反映当前选择）
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
const lastExportText = computed(() => lastExport.value ? new Date(lastExport.value).toLocaleString() : t('views.wordExport.neverExported'));

async function gather() {
  const base = {};
  if (range.value === 'byKind') base.kind = rangeKind.value;
  else if (range.value === 'bySubject') base.subject = rangeSubject.value;
  else if (range.value === 'byGroup') base.groupId = rangeGroup.value;
  let list = await listWordCards(base);
  if (range.value === 'incremental') {
    const last = Number(localStorage.getItem(LAST_KEY) || 0);
    list = list.filter(r => (r.updatedAt || 0) > last);
  }
  if (order.value === 'shuffle') {
    list = list.slice();
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[list[i], list[j]] = [list[j], list[i]]; }
  } else {
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  rows.value = list;
  return list;
}
onMounted(async () => { groups.value = await listWordGroups(); await gather(); });

async function refresh() { await gather(); }

// ---------- 生成 ----------
function fa(c) {
  const ph = opt.value.phonetic && c.phonetic ? '/' + c.phonetic + '/' : '';
  const ex = opt.value.example && c.example ? (c.example + (c.exampleTrans ? ' —— ' + c.exampleTrans : '')) : '';
  const note = opt.value.note && c.note ? c.note : '';
  const src = opt.value.source && c.source ? c.source : '';
  if (lang.value === 'en') {
    return { front: c.word + (ph ? ' ' + ph : ''), back: ex || c.meaning, ex, note, src };
  }
  if (lang.value === 'zh') {
    return { front: c.meaning, back: c.word + (ph ? ' ' + ph : ''), ex, note, src };
  }
  return { front: c.word + (ph ? ' ' + ph : ''), back: c.meaning + (ex ? '\n' + ex : ''), ex, note, src };
}

function metaComment(prefix) {
  return Object.entries(metaObj.value).map(([k, v]) => `${prefix} ${k}：${v}`).join('\n');
}

function genMarkdown(list) {
  let out = `# ${t('views.wordExport.title')}\n\n${metaComment('> ')}\n`;
  for (const c of list) {
    const f = fa(c);
    out += `\n## ${f.front}\n- ${t('views.wordExport.formMeaning')}：${f.back}\n`;
    if (opt.value.example && c.example) out += `- ${t('views.wordBook.formExample')}：${c.example}${c.exampleTrans ? ' —— ' + c.exampleTrans : ''}\n`;
    if (f.note) out += `- ${t('views.wordBook.noteLabel')}：${f.note}\n`;
    if (f.src) out += `- ${t('views.wordBook.sourceLabel')}：${f.src}\n`;
    if (c.tags && c.tags.length) out += `- ${t('views.wordBook.formTags')}：${c.tags.join(', ')}\n`;
  }
  return out;
}

function genAnki(list) {
  let out = metaComment('# ') + '\n';
  for (const c of list) {
    const f = fa(c);
    out += `${f.front.replace(/\t/g, ' ')}\t${String(f.back).replace(/\t/g, ' ')}\n`;
  }
  return out;
}

function genCsv(list) {
  let cols, header;
  if (lang.value === 'en') { cols = ['word', 'phonetic', 'example', 'exampleTrans', 'note', 'source', 'subject', 'kind']; header = ['单词', '音标', '例句', '例句翻译', '批注', '来源', '考试类别', '类型']; }
  else if (lang.value === 'zh') { cols = ['meaning', 'exampleTrans', 'note', 'source', 'subject', 'kind']; header = ['释义', '例句翻译', '批注', '来源', '考试类别', '类型']; }
  else { cols = ['word', 'phonetic', 'meaning', 'example', 'exampleTrans', 'note', 'source', 'subject', 'kind', 'tags']; header = ['单词', '音标', '释义', '例句', '例句翻译', '批注', '来源', '考试类别', '类型', '标签']; }
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let out = metaComment('# ') + '\n';
  out += header.map(esc).join(',') + '\n';
  for (const c of list) {
    const row = cols.map(col => {
      if (col === 'tags') return (c.tags || []).join('; ');
      return c[col] || '';
    });
    out += row.map(esc).join(',') + '\n';
  }
  return '﻿' + out; // BOM for Excel
}

function genA4(list) {
  const cards = list.map(c => {
    const f = fa(c);
    return `<div class="wc"><div class="wf">${escHtml(f.front)}</div><div class="wb">${escHtml(String(f.back).replace(/\n/g, '<br>'))}</div></div>`;
  }).join('\n');
  const meta = Object.entries(metaObj.value).map(([k, v]) => `<div class="mk">${escHtml(k)}：<b>${escHtml(v)}</b></div>`).join('');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${escHtml(t('views.wordExport.title'))}</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #222; margin: 0; padding: 18px; }
.meta { border: 1px solid #ddd; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; background: #fafafa; display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; color: #555; }
.meta .mk b { color: #222; }
.page { column-count: 2; column-gap: 14px; }
.wc { break-inside: avoid; border: 1px solid #e3e3e3; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.wf { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
.wb { font-size: 14px; color: #444; }
@media print { body { padding: 0; } .meta { background: #fff; } }
</style></head><body>
<p style="font-size:20px;font-weight:700;margin:0 0 8px">${escHtml(t('views.wordExport.title'))}</p>
<div class="meta">${meta}</div>
<div class="page">${cards}</div>
</body></html>`;
}
function escHtml(s) { return String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }

const preview = computed(() => {
  const list = rows.value;
  if (!list.length) return '';
  if (fmt.value === 'markdown') return genMarkdown(list);
  if (fmt.value === 'anki') return genAnki(list);
  if (fmt.value === 'csv') return genCsv(list);
  return genA4(list);
});

function download() {
  const list = rows.value;
  if (!list.length) { toast(t('views.wordExport.empty'), 'warning'); return; }
  let text, name, mime;
  if (fmt.value === 'markdown') { text = genMarkdown(list); name = 'words.md'; mime = 'text/markdown'; }
  else if (fmt.value === 'anki') { text = genAnki(list); name = 'words-anki.txt'; mime = 'text/plain'; }
  else if (fmt.value === 'csv') { text = genCsv(list); name = 'words.csv'; mime = 'text/csv'; }
  else { text = genA4(list); name = 'words-a4.html'; mime = 'text/html'; }
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  localStorage.setItem(LAST_KEY, String(Date.now()));
  lastExport.value = Date.now();
  toast(t('views.wordExport.exportedToast'), 'success');
}

async function copyText() {
  const text = preview.value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast(t('views.wordExport.copied'), 'success'); }
  catch { toast(t('views.wordExport.empty'), 'error'); }
}
</script>

<template>
  <div class="ex">
    <header class="ex-head">
      <h1>{{ t('views.wordExport.title') }}</h1>
      <p class="sub">{{ t('views.wordExport.subtitle') }}</p>
    </header>

    <!-- 原数据标注（首页头，实时） -->
    <section class="meta-card">
      <div class="meta-title">🏷️ {{ t('views.wordExport.metaTitle') }}</div>
      <div class="meta-grid">
        <div v-for="(v, k) in metaObj" :key="k" class="mi"><span>{{ k }}</span><b>{{ v }}</b></div>
      </div>
      <p class="last">{{ t('views.wordExport.lastExportAt', undefined, { time: lastExportText }) }}</p>
    </section>

    <!-- 选项 -->
    <section class="opts">
      <div class="opt">
        <label>{{ t('views.wordExport.langLabel') }}</label>
        <el-radio-group v-model="lang" @change="refresh">
          <el-radio-button value="both">{{ t('views.wordExport.langBoth') }}</el-radio-button>
          <el-radio-button value="en">{{ t('views.wordExport.langEn') }}</el-radio-button>
          <el-radio-button value="zh">{{ t('views.wordExport.langZh') }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="opt">
        <label>{{ t('views.wordExport.orderLabel') }}</label>
        <el-radio-group v-model="order" @change="refresh">
          <el-radio-button value="seq">{{ t('views.wordExport.orderSeq') }}</el-radio-button>
          <el-radio-button value="shuffle">{{ t('views.wordExport.orderShuffle') }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="opt">
        <label>{{ t('views.wordExport.rangeLabel') }}</label>
        <el-select v-model="range" @change="refresh" style="width:100%">
          <el-option value="all" :label="t('views.wordExport.rangeAll')" />
          <el-option value="incremental" :label="t('views.wordExport.rangeIncremental')" />
          <el-option value="byKind" :label="t('views.wordExport.rangeByKind')" />
          <el-option value="byGroup" :label="t('views.wordExport.rangeByGroup')" />
          <el-option value="bySubject" :label="t('views.wordExport.rangeBySubject')" />
        </el-select>
      </div>
      <div v-if="range === 'byKind'" class="opt">
        <label>{{ t('views.wordExport.metaKind') }}</label>
        <el-select v-model="rangeKind" @change="refresh" style="width:100%">
          <el-option v-for="k in KINDS" :key="k.value" :value="k.value" :label="t(k.key)" />
        </el-select>
      </div>
      <div v-if="range === 'byGroup'" class="opt">
        <label>{{ t('views.wordExport.metaGroup') }}</label>
        <el-select v-model="rangeGroup" @change="refresh" style="width:100%">
          <el-option v-for="g in groups" :key="g.id" :value="g.id" :label="g.name" />
        </el-select>
      </div>
      <div v-if="range === 'bySubject'" class="opt">
        <label>{{ t('views.wordExport.metaSubject') }}</label>
        <el-select v-model="rangeSubject" @change="refresh" style="width:100%">
          <el-option v-for="s in SUBJECTS" :key="s" :value="s" :label="s" />
        </el-select>
      </div>
      <div class="opt">
        <label>{{ t('views.wordExport.formatLabel') }}</label>
        <el-radio-group v-model="fmt">
          <el-radio-button value="markdown">{{ t('views.wordExport.fmtMarkdown') }}</el-radio-button>
          <el-radio-button value="anki">{{ t('views.wordExport.fmtAnki') }}</el-radio-button>
          <el-radio-button value="csv">{{ t('views.wordExport.fmtCsv') }}</el-radio-button>
          <el-radio-button value="a4">{{ t('views.wordExport.fmtA4') }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="opt checks">
        <label>{{ t('views.wordExport.optionsTitle') }}</label>
        <div class="cl">
          <label><input type="checkbox" v-model="opt.note" @change="refresh" /> {{ t('views.wordExport.includeNote') }}</label>
          <label><input type="checkbox" v-model="opt.example" @change="refresh" /> {{ t('views.wordExport.includeExample') }}</label>
          <label><input type="checkbox" v-model="opt.phonetic" @change="refresh" /> {{ t('views.wordExport.includePhonetic') }}</label>
          <label><input type="checkbox" v-model="opt.source" @change="refresh" /> {{ t('views.wordExport.includeSource') }}</label>
        </div>
      </div>
    </section>

    <p class="fmt-desc">{{ t('views.wordExport.fmt' + fmt + 'Desc') }}</p>

    <!-- 操作 -->
    <section class="acts">
      <el-button type="primary" @click="download">{{ t('views.wordExport.exportBtn') }}</el-button>
      <el-button :disabled="!preview" @click="copyText">{{ t('views.wordExport.copyBtn') }}</el-button>
    </section>

    <!-- 预览 -->
    <section class="preview">
      <div class="pv-title">{{ t('views.wordExport.previewLabel') }}（{{ rows.length }}）</div>
      <pre v-if="fmt !== 'a4'" class="pv">{{ preview || t('views.wordExport.empty') }}</pre>
      <iframe v-else :srcdoc="preview" class="pv-iframe"></iframe>
    </section>
  </div>
</template>

<style scoped>
.ex { max-width: 920px; margin: 0 auto; padding: 18px 16px 60px; color: var(--el-text-color-primary); }
.ex-head h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin: 0 0 16px; }

.meta-card { background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 16px; }
.meta-title { font-weight: 700; color: var(--el-color-primary); margin-bottom: 8px; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 16px; font-size: 13px; }
.mi { display: flex; gap: 6px; }
.mi span { color: var(--el-text-color-secondary); }
.last { font-size: 12px; color: var(--el-text-color-secondary); margin: 8px 0 0; }

.opts { display: flex; flex-direction: column; gap: 12px; background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 16px; }
.opt { display: flex; flex-direction: column; gap: 6px; }
.opt > label { font-size: 13px; color: var(--el-text-color-regular); }
.checks .cl { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; }
.checks .cl label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.fmt-desc { font-size: 12px; color: var(--el-text-color-secondary); margin: 10px 0; }

.acts { display: flex; gap: 10px; margin: 14px 0; }
.preview { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 14px; }
.pv-title { font-size: 13px; color: var(--el-text-color-secondary); margin-bottom: 8px; }
.pv { white-space: pre-wrap; word-break: break-word; font-size: 13px; max-height: 420px; overflow: auto; margin: 0; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
.pv-iframe { width: 100%; height: 460px; border: 0; }
</style>
