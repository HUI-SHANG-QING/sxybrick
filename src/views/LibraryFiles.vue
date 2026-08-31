<script setup>
// 学习资料中枢（Phase 6）：上传 → 全量解析 → 预览 → 问答 → 生成卡片（用户选择制）
// ⚠️ 建卡原则：默认绝不自动建卡——用户点「生成卡片」→ 预览草稿 → 逐卡编辑/删除 → 确认才入库
import { ref, computed, onMounted, watch, onUnmounted } from 'vue';
import { ElMessageBox } from 'element-plus';
import { db } from '../db.js';
import { getSubjects } from '../repo.js';
import { toast } from '../utils/toast.js';
import {
  uploadFile, listDocFiles, deleteDocFile, retryParse,
  getDocText, getStorageInfo, ensurePersist, confirmDrafts, getFileBlob,
  ocrDoc, getOcrSettings, saveOcrSettings, linkDocToCards,
} from '../docs-lib.js';
import { OCR_LANG_OPTIONS } from '../utils/ocr.js';
import EmptyState from '../components/EmptyState.vue';
import { textToCardDrafts } from '../utils/card-drafts.js';
import { askDoc } from '../utils/docs-qa.js';
import ExportButton from '../components/ExportButton.vue';
import { exportLibraryToJSON, exportLibraryToMarkdown } from '../utils/exporters.js';
import { sanitizeHtml } from '../utils/sanitize.js';
import { t } from '../i18n/index.js';

const ACCEPT = '.pdf,.xlsx,.xls,.csv,.docx,.doc,.txt,.md,.tex,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg';

const subjects = ref([]);
const files = ref([]);
const subject = ref('');
const uploading = ref([]);
const storage = ref(null);
const persisted = ref(false);

// 预览
const preview = ref(null);
const pdfCanvas = ref(null);
const pdfPage = ref(1);
const pdfPages = ref(0);
const sheetHtml = ref('');
const docxHtml = ref('');
const imgUrl = ref('');
const textPreview = ref('');

// 问答
const qa = ref({ docId: null, question: '', answer: '', citations: [], busy: false });

// 建卡弹窗（用户选择制）
const draftModal = ref(null);
const draftBusy = ref(false);

// OCR（6.5b）：本地 Tesseract 优先，可选云端
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const isImage = (ext) => IMAGE_EXTS.includes(String(ext || '').toLowerCase());
const needsOcr = (f) => f.status === 'failed' && (isImage(f.ext) || /ocr/i.test(f.error || ''));
const ocr = ref({ busy: false, name: '', pct: 0, page: 0, pages: 0 });
const ocrLangOptions = OCR_LANG_OPTIONS;
const showOcrCfg = ref(false);
const ocrSettings = ref({ lang: 'chi_sim+eng', langPath: '', cloud: { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini' } });

function loadOcrSettings() {
  const s = getOcrSettings();
  ocrSettings.value = {
    lang: 'chi_sim+eng', langPath: '',
    cloud: { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini' },
    ...s,
    cloud: { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini', ...(s.cloud || {}) },
  };
}

function saveOcr() {
  saveOcrSettings({
    lang: ocrSettings.value.lang,
    langPath: ocrSettings.value.langPath,
    cloud: ocrSettings.value.cloud,
  });
  toast(t('views.libraryFiles.ocrSaved'), 'success');
  showOcrCfg.value = false;
}

async function runOcr(f) {
  if (ocr.value.busy) return;
  ocr.value = { busy: true, name: f.name, pct: 0, page: 0, pages: 0 };
  try {
    const r = await ocrDoc(f.id, {
      lang: ocrSettings.value.lang,
      onPage: (i, total) => { ocr.value.page = i; ocr.value.pages = total; },
      onProgress: (p) => { ocr.value.pct = Math.round((p || 0) * 100); },
    });
    if (r.ok) toast(t('views.libraryFiles.ocrDone', undefined, { name: f.name, len: r.textLen }), 'success');
    else toast(t('views.libraryFiles.ocrFailed') + r.error, 'error');
  } catch (e) {
    toast(t('views.libraryFiles.ocrError') + (e?.message || e), 'error');
  } finally {
    ocr.value.busy = false;
    await load();
  }
}

// 知识图谱联动：把资料与它覆盖的卡片建「涵盖」边
async function runLink(f) {
  try {
    const r = await linkDocToCards(f.id);
    const skipped = r.skipped ? t('views.libraryFiles.linkSkipped', undefined, { n: r.skipped }) : '';
    toast(r.created
      ? t('views.libraryFiles.linkSuccess', undefined, { created: r.created, skipped })
      : t('views.libraryFiles.linkNone'), r.created ? 'success' : 'info');
  } catch (e) {
    toast(t('views.libraryFiles.linkFailed') + (e?.message || e), 'error');
  }
}

const fmtBytes = (n) => {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const iconOf = (ext) => ({ pdf: '📕', xlsx: '📗', xls: '📗', csv: '📊', docx: '📘', doc: '📘', txt: '📄', md: '📝', tex: '🧮' })[ext] || '🗂️';

const statusText = (f) => ({
  uploading: t('views.libraryFiles.statusUploading'),
  parsing: t('views.libraryFiles.statusParsing'),
  ready: t('views.libraryFiles.statusReady'),
  failed: t('views.libraryFiles.statusFailed'),
}[f.status] || f.status);

async function load() {
  files.value = await listDocFiles();
  storage.value = await getStorageInfo();
  persisted.value = !!(await ensurePersist());
}

/** 取资料全文长度（docTexts 表），N 通常不大，可接受 N+1 读 */
async function getTextLen(id) {
  const docText = await getDocText(id);
  return docText?.text?.length || 0;
}

const libraryExportFormats = [
  { key: 'md', label: 'Markdown', hint: t('views.libraryFiles.exportMdHint'), mime: 'text/markdown', ext: 'md',
    build: async (rows) => exportLibraryToMarkdown(rows, getTextLen) },
  { key: 'json', label: 'JSON', hint: t('views.libraryFiles.exportJsonHint'), mime: 'application/json', ext: 'json',
    build: async (rows) => exportLibraryToJSON(rows, getTextLen) },
];

async function onPick(e) {
  const list = Array.from(e.target.files || []);
  e.target.value = '';
  if (!list.length) return;
  for (const file of list) {
    const up = { name: file.name, pct: 0 };
    uploading.value.push(up);
    try {
      const row = await uploadFile(file, {
        subject: subject.value,
        onProgress: (written, total) => { up.pct = Math.round((written / total) * 100); },
      });
      if (row.status === 'failed') toast(`${file.name}：${row.error}`, 'error');
      else toast(t('views.libraryFiles.uploadStarted', undefined, { name: file.name }), 'success');
    } catch (err) {
      toast(t('views.libraryFiles.uploadFailed', undefined, { name: file.name, error: err?.message || err }), 'error');
    } finally {
      uploading.value = uploading.value.filter((x) => x !== up);
    }
  }
  // 等待解析队列消化后刷新列表（轮询）
  const t0 = Date.now();
  // P1-12：轮询定时器必须在组件卸载时清除，否则离开页面后继续跑且向已卸载组件写 files.value
  pollTimer = setInterval(async () => {
    if (Date.now() - t0 > 30000) { clearInterval(pollTimer); return; }
    const rows = await listDocFiles();
    files.value = rows;
    if (rows.every((r) => r.status !== 'uploading' && r.status !== 'parsing')) clearInterval(pollTimer);
  }, 1200);
}

let pollTimer = null;
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

async function onDelete(f) {
  try {
    await ElMessageBox.confirm(
      t('views.libraryFiles.deleteConfirmMsg', undefined, { name: f.name }),
      t('views.libraryFiles.deleteConfirmTitle'),
      { type: 'warning', confirmButtonText: t('views.libraryFiles.confirmDelete'), cancelButtonText: t('views.libraryFiles.cancel') },
    );
  } catch { return; }
  try {
    await deleteDocFile(f.id);
    toast(t('views.libraryFiles.deleted'), 'success');
    await load();
  } catch (e) { toast(t('views.libraryFiles.deleteFailed') + (e?.message || e), 'error'); }
}

async function retry(id) {
  toast(t('views.libraryFiles.retryStart'), 'info');
  await retryParse(id);
  await load();
}

// ---------- 预览 ----------

/** HTML 文本/属性转义（外部文件名与单元格内容拼进模板前必须转义） */
function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function openPreview(f) {
  preview.value = { row: f };
  sheetHtml.value = ''; docxHtml.value = ''; imgUrl.value = ''; textPreview.value = '';
  const blob = await getFileBlob(f);
  if (!blob) { toast(t('views.libraryFiles.previewNoFile'), 'error'); return; }
  try {
    if (f.ext === 'pdf') {
      pdfPage.value = 1;
      pdfPages.value = await renderPdfPage(blob, 1);
    } else if (['xlsx', 'xls', 'csv'].includes(f.ext)) {
      // 统一走 parsers-sheet（exceljs + 内置 CSV 解析器）；.xls 会被明确拒绝并提示另存为 .xlsx
      const { extractSheetRows } = await import('../utils/parsers-sheet.js');
      const { sheets } = await extractSheetRows(blob, { ext: f.ext });
      const parts = sheets.map((s) => {
        // 工作表名来自外部文件，必须转义后再拼进标签（否则可闭合 <h4> 注入）
        return `<h4>${escHtml(s.name)}</h4><table><tbody>${s.rows.map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      });
      // P0 安全：表格内容出自外部文件，净化后再交给 v-html
      sheetHtml.value = sanitizeHtml(parts.join(''));
    } else if (f.ext === 'docx' || f.ext === 'doc') {
      const { docxToHtml } = await import('../utils/parsers-docx.js');
      const r = await docxToHtml(blob);
      // P0 安全：mammoth 输出源于外部 Word 文档，净化后再交给 v-html
      docxHtml.value = sanitizeHtml(r.html);
    } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(f.ext)) {
      imgUrl.value = URL.createObjectURL(blob);
    } else {
      textPreview.value = await getDocText(f.id) || (await blob.text());
    }
  } catch (e) {
    toast(t('views.libraryFiles.previewFailed') + (e?.message || e), 'error');
  }
}

let pdfDocCache = null;
async function renderPdfPage(blob, pageNum) {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  if (!pdfDocCache) {
    pdfDocCache = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  }
  const page = await pdfDocCache.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.3 });
  const canvas = pdfCanvas.value;
  if (!canvas) return 0;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return pdfDocCache.numPages;
}

watch([preview, pdfPage], async ([pv, pg]) => {
  if (pv?.row?.ext === 'pdf' && pv.row.status === 'ready' && pg) {
    try {
      const blob = await getFileBlob(pv.row);
      if (blob) pdfPages.value = await renderPdfPage(blob, pg);
    } catch (e) { toast(t('views.libraryFiles.pdfPageFailed') + (e?.message || e), 'error'); }
  }
});

// ---------- 问答 ----------

async function openQA(f) {
  qa.value = { docId: f.id, question: '', answer: '', citations: [], busy: false };
  preview.value = null;
}

async function ask() {
  if (!qa.value.question.trim() || qa.value.busy) return;
  qa.value.busy = true;
  qa.value.answer = '';
  try {
    const r = await askDoc(qa.value.docId, qa.value.question);
    qa.value.answer = r.answer;
    qa.value.citations = r.citations;
  } catch (e) {
    qa.value.answer = t('views.libraryFiles.qaFailed') + (e?.message || e);
  } finally {
    qa.value.busy = false;
  }
}

// ---------- 生成卡片（用户选择制） ----------

async function openDrafts(f) {
  const text = await getDocText(f.id);
  if (!text?.trim()) { toast(t('views.libraryFiles.noText'), 'error'); return; }
  const drafts = textToCardDrafts(text).map((d) => ({ ...d, _edit: false }));
  if (!drafts.length) { toast(t('views.libraryFiles.noDrafts'), 'error'); return; }
  draftModal.value = { row: f, drafts };
  toast(t('views.libraryFiles.genDrafts', undefined, { n: drafts.length }), 'info');
}

function toggleEdit(d) { d._edit = !d._edit; }
function removeDraft(i) { draftModal.value.drafts.splice(i, 1); }

async function doImport() {
  const m = draftModal.value;
  if (!m?.drafts.length) { toast(t('views.libraryFiles.noImportCards'), 'error'); return; }
  draftBusy.value = true;
  try {
    const clean = m.drafts.map(({ front, back }) => ({ front, back }));
    const cards = await confirmDrafts(clean, { subject: m.row.subject, source: m.row.id });
    toast(t('views.libraryFiles.imported', undefined, { n: cards.length, name: m.row.name }), 'success');
    draftModal.value = null;
  } catch (e) {
    toast(t('views.libraryFiles.importFailed') + (e?.message || e), 'error');
  } finally {
    draftBusy.value = false;
  }
}

onMounted(async () => {
  subjects.value = await getSubjects();
  loadOcrSettings();
  await load();
});
</script>

<template>
  <div style="max-width:1100px;margin:0 auto">
    <!-- Hero / 上传 -->
    <div class="mat-hero">
      <div class="lib-title-row">
        <h2 style="margin:0 0 6px">{{ t('views.libraryFiles.title') }}</h2>
        <ExportButton
          v-if="files.length"
          :data="files"
          :count="files.length"
          filename-prefix="library"
          :label="t('views.libraryFiles.exportLabel')"
          :formats="libraryExportFormats"
        />
      </div>
      <p class="hint" style="margin:0 0 14px;line-height:1.8">
        {{ t('views.libraryFiles.heroHintPre') }}<b>{{ t('views.libraryFiles.heroHintBold') }}</b>{{ t('views.libraryFiles.heroHintPost') }}
      </p>
      <div class="mat-upload">
        <input ref="fileInput" type="file" multiple :accept="ACCEPT" style="display:none" @change="onPick" />
        <select v-model="subject" class="subject-sel">
          <option value="">{{ t('views.libraryFiles.subjectPlaceholder') }}</option>
          <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
        </select>
        <button class="btn" @click="$refs.fileInput.click()">{{ t('views.libraryFiles.uploadBtn') }}</button>
        <button class="btn" style="margin-left:8px" @click="showOcrCfg = !showOcrCfg">{{ t('views.libraryFiles.ocrSettingsBtn') }}</button>
        <span v-if="storage" class="hint" style="margin-left:12px">
          {{ t('views.libraryFiles.storageLabel') }}{{ fmtBytes(storage.usage) }} / {{ fmtBytes(storage.quota) }}
          <span v-if="persisted" class="ok"> · {{ t('views.libraryFiles.storagePersisted') }}</span>
        </span>
      </div>
      <!-- OCR 设置面板（本地 Tesseract 优先，云端可选） -->
      <div v-if="showOcrCfg" class="ocr-cfg">
        <div class="ocr-cfg-row">
          <label>{{ t('views.libraryFiles.ocrLangLabel') }}</label>
          <select v-model="ocrSettings.lang">
            <option v-for="o in ocrLangOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span class="hint">{{ t('views.libraryFiles.ocrLangHint') }}</span>
        </div>
        <div class="ocr-cfg-row">
          <label>{{ t('views.libraryFiles.ocrLangDirLabel') }}</label>
          <input v-model="ocrSettings.langPath" :placeholder="t('views.libraryFiles.ocrLangDirPlaceholder')" />
        </div>
        <div class="ocr-cfg-row">
          <label><input type="checkbox" v-model="ocrSettings.cloud.enabled" /> {{ t('views.libraryFiles.ocrCloudLabel') }}</label>
        </div>
        <template v-if="ocrSettings.cloud.enabled">
          <div class="ocr-cfg-row">
            <label>{{ t('views.libraryFiles.ocrCloudEndpointLabel') }}</label>
            <input v-model="ocrSettings.cloud.endpoint" placeholder="https://api.openai.com/v1/chat/completions" />
          </div>
          <div class="ocr-cfg-row">
            <label>{{ t('views.libraryFiles.ocrApiKeyLabel') }}</label>
            <input v-model="ocrSettings.cloud.apiKey" type="password" placeholder="sk-…" />
          </div>
          <div class="ocr-cfg-row">
            <label>{{ t('views.libraryFiles.ocrModelLabel') }}</label>
            <input v-model="ocrSettings.cloud.model" placeholder="gpt-4o-mini" />
          </div>
        </template>
        <div class="ocr-cfg-row" style="margin-top:10px">
          <button class="btn accent" @click="saveOcr">{{ t('views.libraryFiles.ocrSave') }}</button>
          <button class="btn" style="margin-left:8px" @click="showOcrCfg = false">{{ t('views.libraryFiles.ocrCancel') }}</button>
        </div>
      </div>
      <div v-if="uploading.length" class="up-list">
        <div v-for="u in uploading" :key="u.name" class="up-item">
          <span class="up-name">{{ u.name }}</span>
          <div class="bar"><div class="bar-in" :style="{ width: u.pct + '%' }"></div></div>
          <span class="up-pct">{{ u.pct }}%</span>
        </div>
      </div>
      <div v-if="ocr.busy" class="up-list">
        <div class="up-item">
          <span class="up-name">{{ t('views.libraryFiles.ocrBusy', undefined, { name: ocr.name }) }}</span>
          <div class="bar"><div class="bar-in" :style="{ width: ocr.pct + '%' }"></div></div>
          <span class="up-pct">{{ ocr.pct }}%</span>
          <span v-if="ocr.pages" class="hint" style="margin-left:8px">{{ t('views.libraryFiles.ocrPages', undefined, { page: ocr.page, pages: ocr.pages }) }}</span>
        </div>
      </div>
    </div>

    <!-- 文件列表 -->
    <div class="mat-section">
      <div class="mat-title">{{ t('views.libraryFiles.libTitle') }} <span class="hint">{{ t('views.libraryFiles.libCount', undefined, { n: files.length }) }}</span></div>
      <EmptyState v-if="!files.length" icon="📚" :title="t('views.libraryFiles.emptyTitle')" :message="t('views.libraryFiles.emptyMsg')" />
      <div v-for="f in files" :key="f.id" class="mat-row">
        <div class="mat-ico">{{ iconOf(f.ext) }}</div>
        <div class="mat-info">
          <div class="mat-name">{{ f.name }} <span class="tag">{{ (f.ext || '?').toUpperCase() }}</span></div>
          <div class="mat-meta">
            {{ fmtBytes(f.size) }}<span v-if="f.subject"> · {{ f.subject }}</span>
            <span v-if="f.pageCount"> · {{ t('views.libraryFiles.metaPages', undefined, { n: f.pageCount }) }}</span>
            <span v-if="f.textLen"> · {{ t('views.libraryFiles.metaTextLen', undefined, { n: f.textLen }) }}</span>
          </div>
          <div v-if="f.error" class="err" :title="f.error">⚠ {{ f.error }}</div>
        </div>
        <div class="mat-status">
          <span class="st" :class="'st-' + f.status">{{ statusText(f) }}</span>
        </div>
        <div class="mat-ops">
          <template v-if="f.status === 'ready'">
            <button class="btn small" @click="openPreview(f)">{{ t('views.libraryFiles.opPreview') }}</button>
            <button class="btn small" @click="openQA(f)">{{ t('views.libraryFiles.opQA') }}</button>
            <button class="btn small accent" @click="openDrafts(f)">{{ t('views.libraryFiles.opGenerate') }}</button>
            <button class="btn small" @click="runLink(f)" :title="t('views.libraryFiles.opLinkTitle')">{{ t('views.libraryFiles.opLink') }}</button>
          </template>
          <button v-else-if="f.status === 'failed'" class="btn small" @click="retry(f.id)">{{ t('views.libraryFiles.opRetry') }}</button>
          <button v-if="needsOcr(f)" class="btn small accent" :disabled="ocr.busy" @click="runOcr(f)">{{ t('views.libraryFiles.opOcr') }}</button>
          <button class="btn small danger" @click="onDelete(f)">{{ t('views.libraryFiles.opDelete') }}</button>
        </div>
      </div>
    </div>

    <!-- 预览面板 -->
    <div v-if="preview" class="mat-section">
      <div class="mat-title">
        {{ t('views.libraryFiles.previewTitle', undefined, { name: preview.row.name }) }}
        <button class="btn small" style="margin-left:8px" @click="preview = null; pdfDocCache = null">{{ t('views.libraryFiles.previewClose') }}</button>
      </div>
      <div v-if="preview.row.ext === 'pdf'" class="pdf-box">
        <div class="pdf-toolbar">
          <button class="btn small" :disabled="pdfPage <= 1" @click="pdfPage--">{{ t('views.libraryFiles.pdfPrev') }}</button>
          <span>{{ pdfPage }} / {{ pdfPages }}</span>
          <button class="btn small" :disabled="pdfPage >= pdfPages" @click="pdfPage++">{{ t('views.libraryFiles.pdfNext') }}</button>
        </div>
        <div class="pdf-scroll"><canvas ref="pdfCanvas" class="pdf-canvas"></canvas></div>
      </div>
      <div v-else-if="['xlsx', 'xls', 'csv'].includes(preview.row.ext)" class="sheet-wrap" v-html="sheetHtml"></div>
      <div v-else-if="preview.row.ext === 'docx' || preview.row.ext === 'doc'" class="docx-wrap">
        <div class="hint" style="margin-bottom:8px">{{ t('views.libraryFiles.docxWarn') }}</div>
        <div v-html="docxHtml"></div>
      </div>
      <div v-else-if="['png','jpg','jpeg','gif','webp','bmp','svg'].includes(preview.row.ext)"><img :src="imgUrl" class="img-preview" /></div>
      <div v-else class="text-preview"><pre>{{ textPreview }}</pre></div>
    </div>

    <!-- 问答面板 -->
    <div v-if="qa.docId" class="mat-section">
      <div class="mat-title">
        {{ t('views.libraryFiles.qaTitle') }}
        <button class="btn small" style="margin-left:8px" @click="qa.docId = null">{{ t('views.libraryFiles.qaClose') }}</button>
      </div>
      <div class="qa-row">
        <input v-model="qa.question" class="qa-input" :placeholder="t('views.libraryFiles.qaPlaceholder')" @keyup.enter="ask" :disabled="qa.busy" />
        <button class="btn accent" :disabled="qa.busy || !qa.question.trim()" @click="ask">{{ qa.busy ? t('views.libraryFiles.qaThinking') : t('views.libraryFiles.qaAsk') }}</button>
      </div>
      <div v-if="qa.answer" class="qa-answer">
        <div class="qa-text">{{ qa.answer }}</div>
        <div v-if="qa.citations.length" class="qa-cites">
          <div class="hint" style="margin-bottom:6px">{{ t('views.libraryFiles.qaCites') }}</div>
          <div v-for="c in qa.citations" :key="c.idx" class="qa-cite">
            <span class="tag">{{ t('views.libraryFiles.qaCite', undefined, { n: c.idx, score: c.score }) }}</span>
            <div class="qa-cite-text">{{ c.text }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 建卡预览弹窗（用户选择制：确认才入库） -->
    <div v-if="draftModal" class="modal-mask" @click.self="draftModal = null">
      <div class="modal">
        <div class="modal-head">
          <b>{{ t('views.libraryFiles.draftTitle', undefined, { name: draftModal.row.name }) }}</b>
          <button class="btn small" @click="draftModal = null">✕</button>
        </div>
        <div class="hint" style="margin-bottom:10px;line-height:1.7">
          {{ t('views.libraryFiles.draftHintPre') }}<b>{{ draftModal.drafts.length }}</b>{{ t('views.libraryFiles.draftHintMid') }}<b>{{ t('views.libraryFiles.draftEdit') }}</b>{{ t('views.libraryFiles.draftSep') }}<b>{{ t('views.libraryFiles.draftDelete') }}</b>{{ t('views.libraryFiles.draftHintPost') }}
        </div>
        <div class="draft-list">
          <div v-for="(d, i) in draftModal.drafts" :key="i" class="draft">
            <div class="draft-head">
              <span class="tag">{{ d.note }}</span>
              <span class="draft-idx">#{{ i + 1 }}</span>
              <span style="flex:1"></span>
              <button class="btn small" @click="toggleEdit(d)">{{ d._edit ? t('views.libraryFiles.draftBtnDone') : t('views.libraryFiles.draftBtnEdit') }}</button>
              <button class="btn small danger" @click="removeDraft(i)">{{ t('views.libraryFiles.opDelete') }}</button>
            </div>
            <template v-if="d._edit">
              <textarea v-model="d.front" class="draft-input" rows="3" :placeholder="t('views.libraryFiles.draftFrontPlaceholder')"></textarea>
              <textarea v-model="d.back" class="draft-input" rows="4" :placeholder="t('views.libraryFiles.draftBackPlaceholder')"></textarea>
            </template>
            <template v-else>
              <div class="draft-front">Q：{{ d.front }}</div>
              <div class="draft-back">A：{{ d.back }}</div>
            </template>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="draftModal = null">{{ t('views.libraryFiles.draftCancel') }}</button>
          <button class="btn accent" :disabled="draftBusy || !draftModal.drafts.length" @click="doImport">
            {{ draftBusy ? t('views.libraryFiles.draftImporting') : t('views.libraryFiles.draftConfirm', undefined, { n: draftModal.drafts.length }) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mat-hero { background: linear-gradient(135deg, var(--panel), var(--code-bg)); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px 24px; margin-bottom: 16px; }
.mat-upload { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lib-title-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
.subject-sel { padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 13px; }
.up-list { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.up-item { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.up-name { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { flex: 1; height: 6px; background: var(--line); border-radius: 99px; overflow: hidden; }
.bar-in { height: 100%; background: var(--accent); border-radius: 99px; transition: width .2s; }
.up-pct { width: 40px; text-align: right; color: var(--ink-2); }
.ok { color: var(--green, #2a9d5f); }
.ocr-cfg { margin-top: 12px; padding: 14px 16px; border: 1px dashed var(--line); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--code-bg); }
.ocr-cfg-row { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.ocr-cfg-row label { min-width: 96px; color: var(--ink-2); }
.ocr-cfg-row select, .ocr-cfg-row input { padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 13px; }
.ocr-cfg-row input { flex: 1; min-width: 200px; }
.ocr-cfg-row .hint { color: var(--ink-3); font-size: 12px; }
.mat-section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 16px; }
.mat-title { font-weight: 700; margin-bottom: 12px; font-size: 15px; display: flex; align-items: center; }
.mat-row { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px dashed var(--line); }
.mat-row:last-child { border-bottom: none; }
.mat-ico { font-size: 24px; }
.mat-info { flex: 1; min-width: 0; }
.mat-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-meta { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.err { font-size: 12px; color: var(--red); margin-top: 2px; }
.mat-status { width: 84px; }
.st { font-size: 12px; padding: 2px 8px; border-radius: 99px; }
.st-ready { color: var(--green, #2a9d5f); }
.st-parsing, .st-uploading { color: var(--accent); }
.st-failed { color: var(--red); }
.mat-ops { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: var(--code-bg); border: 1px solid var(--line); color: var(--ink-2); }
.pdf-box { display: flex; flex-direction: column; gap: 8px; }
.pdf-toolbar { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.pdf-scroll { max-height: 70vh; overflow: auto; background: #525659; border-radius: 8px; padding: 10px; }
.pdf-canvas { display: block; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,.35); background: #fff; }
.sheet-wrap { max-height: 70vh; overflow: auto; font-size: 13px; }
.sheet-wrap table { border-collapse: collapse; width: 100%; }
.sheet-wrap td { border: 1px solid var(--line); padding: 4px 8px; white-space: nowrap; }
.docx-wrap { max-height: 70vh; overflow: auto; }
.img-preview { max-width: 100%; border-radius: 8px; }
.text-preview { max-height: 70vh; overflow: auto; background: var(--code-bg); border-radius: 8px; padding: 12px; }
.text-preview pre { white-space: pre-wrap; word-break: break-word; font-size: 13px; margin: 0; line-height: 1.8; }
.qa-row { display: flex; gap: 8px; margin-bottom: 10px; }
.qa-input { flex: 1; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); }
.qa-answer { background: var(--code-bg); border-radius: 10px; padding: 14px; }
.qa-text { white-space: pre-wrap; line-height: 1.8; font-size: 14px; }
.qa-cites { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 10px; }
.qa-cite { margin-bottom: 8px; }
.qa-cite-text { font-size: 12px; color: var(--ink-2); line-height: 1.7; margin-top: 2px; padding: 6px 10px; background: var(--panel); border-left: 3px solid var(--accent); border-radius: 4px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 24px; }
.modal { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; width: min(760px, 96vw); max-height: 86vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--line); }
.draft-list { flex: 1; overflow-y: auto; padding: 12px 18px; display: flex; flex-direction: column; gap: 10px; }
.draft { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.draft-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.draft-idx { font-size: 11px; color: var(--ink-2); }
.draft-front { font-size: 13px; font-weight: 600; line-height: 1.6; }
.draft-back { font-size: 12px; color: var(--ink-2); line-height: 1.6; margin-top: 2px; white-space: pre-wrap; }
.draft-input { width: 100%; margin-top: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 13px; resize: vertical; box-sizing: border-box; }
</style>
