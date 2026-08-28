<script setup>
// 学习资料中枢（Phase 6）：上传 → 全量解析 → 预览 → 问答 → 生成卡片（用户选择制）
// ⚠️ 建卡原则：默认绝不自动建卡——用户点「生成卡片」→ 预览草稿 → 逐卡编辑/删除 → 确认才入库
import { ref, computed, onMounted, watch } from 'vue';
import { db } from '../db.js';
import { getSubjects } from '../repo.js';
import { toast } from '../utils/toast.js';
import {
  uploadFile, listDocFiles, deleteDocFile, retryParse,
  getDocText, getStorageInfo, ensurePersist, confirmDrafts, getFileBlob,
  ocrDoc, getOcrSettings, saveOcrSettings, linkDocToCards,
} from '../docs-lib.js';
import { OCR_LANG_OPTIONS } from '../utils/ocr.js';
import { textToCardDrafts } from '../utils/card-drafts.js';
import { askDoc } from '../utils/docs-qa.js';

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
  toast('OCR 设置已保存', 'success');
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
    if (r.ok) toast(`OCR 完成：${f.name}（${r.textLen} 字）`, 'success');
    else toast(`OCR 失败：${r.error}`, 'error');
  } catch (e) {
    toast('OCR 出错：' + (e?.message || e), 'error');
  } finally {
    ocr.value.busy = false;
    await load();
  }
}

// 知识图谱联动：把资料与它覆盖的卡片建「涵盖」边
async function runLink(f) {
  try {
    const r = await linkDocToCards(f.id);
    toast(r.created
      ? `已关联 ${r.created} 张卡片（${r.skipped ? `跳过 ${r.skipped} 条重复` : ''}），可在「知识图谱」查看`
      : '未找到可关联的卡片（需同科目且卡片内容出自该资料）', r.created ? 'success' : 'info');
  } catch (e) {
    toast('关联失败：' + (e?.message || e), 'error');
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
  uploading: '上传中…',
  parsing: '解析中…',
  ready: '✅ 就绪',
  failed: '❌ 失败',
}[f.status] || f.status);

async function load() {
  files.value = await listDocFiles();
  storage.value = await getStorageInfo();
  persisted.value = !!(await ensurePersist());
}

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
      else toast(`已上传并开始解析：${file.name}`, 'success');
    } catch (err) {
      toast(`${file.name} 上传失败：${err?.message || err}`, 'error');
    } finally {
      uploading.value = uploading.value.filter((x) => x !== up);
    }
  }
  // 等待解析队列消化后刷新列表（轮询）
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - t0 > 30000) { clearInterval(timer); return; }
    const rows = await listDocFiles();
    files.value = rows;
    if (rows.every((r) => r.status !== 'uploading' && r.status !== 'parsing')) clearInterval(timer);
  }, 1200);
}

async function onDelete(f) {
  if (!confirm(`删除「${f.name}」？将同时删除解析全文与索引（不可恢复）。`)) return;
  try {
    await deleteDocFile(f.id);
    toast('已删除', 'success');
    await load();
  } catch (e) { toast('删除失败：' + (e?.message || e), 'error'); }
}

async function retry(id) {
  toast('重新解析中…', 'info');
  await retryParse(id);
  await load();
}

// ---------- 预览 ----------

async function openPreview(f) {
  preview.value = { row: f };
  sheetHtml.value = ''; docxHtml.value = ''; imgUrl.value = ''; textPreview.value = '';
  const blob = await getFileBlob(f);
  if (!blob) { toast('本机无原文件（跨设备同步的元数据无法预览）', 'error'); return; }
  try {
    if (f.ext === 'pdf') {
      pdfPage.value = 1;
      pdfPages.value = await renderPdfPage(blob, 1);
    } else if (['xlsx', 'xls', 'csv'].includes(f.ext)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
      const parts = [];
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
        parts.push(`<h4>${name}</h4><table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${String(c).replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      }
      sheetHtml.value = parts.join('');
    } else if (f.ext === 'docx' || f.ext === 'doc') {
      const { docxToHtml } = await import('../utils/parsers-docx.js');
      const r = await docxToHtml(blob);
      docxHtml.value = r.html;
    } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(f.ext)) {
      imgUrl.value = URL.createObjectURL(blob);
    } else {
      textPreview.value = await getDocText(f.id) || (await blob.text());
    }
  } catch (e) {
    toast('预览失败：' + (e?.message || e), 'error');
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
    } catch (e) { toast('PDF 翻页失败：' + (e?.message || e), 'error'); }
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
    qa.value.answer = '问答失败：' + (e?.message || e);
  } finally {
    qa.value.busy = false;
  }
}

// ---------- 生成卡片（用户选择制） ----------

async function openDrafts(f) {
  const text = await getDocText(f.id);
  if (!text?.trim()) { toast('该资料尚未解析出文本', 'error'); return; }
  const drafts = textToCardDrafts(text).map((d) => ({ ...d, _edit: false }));
  if (!drafts.length) { toast('未从文本中切分出可用卡片草稿', 'error'); return; }
  draftModal.value = { row: f, drafts };
  toast(`生成 ${drafts.length} 张草稿——请预览确认后再导入`, 'info');
}

function toggleEdit(d) { d._edit = !d._edit; }
function removeDraft(i) { draftModal.value.drafts.splice(i, 1); }

async function doImport() {
  const m = draftModal.value;
  if (!m?.drafts.length) { toast('没有可导入的卡片', 'error'); return; }
  draftBusy.value = true;
  try {
    const clean = m.drafts.map(({ front, back }) => ({ front, back }));
    const cards = await confirmDrafts(clean, { subject: m.row.subject, source: m.row.id });
    toast(`已导入 ${cards.length} 张卡片到复习队列（来源：${m.row.name}）`, 'success');
    draftModal.value = null;
  } catch (e) {
    toast('导入失败：' + (e?.message || e), 'error');
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
      <h2 style="margin:0 0 6px">📚 学习资料中枢</h2>
      <p class="hint" style="margin:0 0 14px;line-height:1.8">
        上传真题 / 讲义 / 笔记 → 全量解析（几百 MB 大文件不切片）→ 在线预览 → 对资料提问 → 一键生成卡片（<b>需你确认后才入库</b>）。<br>
        原文件存本机（OPFS 专属大仓库），元数据可跨设备同步；解析全文与问答索引本地保存。
      </p>
      <div class="mat-upload">
        <input ref="fileInput" type="file" multiple :accept="ACCEPT" style="display:none" @change="onPick" />
        <select v-model="subject" class="subject-sel">
          <option value="">选择科目（可选）</option>
          <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
        </select>
        <button class="btn" @click="$refs.fileInput.click()">📤 上传资料</button>
        <button class="btn" style="margin-left:8px" @click="showOcrCfg = !showOcrCfg">⚙️ OCR 设置</button>
        <span v-if="storage" class="hint" style="margin-left:12px">
          存储：{{ fmtBytes(storage.usage) }} / {{ fmtBytes(storage.quota) }}
          <span v-if="persisted" class="ok"> · 已持久化</span>
        </span>
      </div>
      <!-- OCR 设置面板（本地 Tesseract 优先，云端可选） -->
      <div v-if="showOcrCfg" class="ocr-cfg">
        <div class="ocr-cfg-row">
          <label>识别语言</label>
          <select v-model="ocrSettings.lang">
            <option v-for="o in ocrLangOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span class="hint">本地 Tesseract（数据不出浏览器，离线可用）；首次识别自动下载语言包并缓存</span>
        </div>
        <div class="ocr-cfg-row">
          <label>语言数据目录</label>
          <input v-model="ocrSettings.langPath" placeholder="留空 = jsdelivr CDN（可填本地/自建 tessdata 目录 URL）" />
        </div>
        <div class="ocr-cfg-row">
          <label><input type="checkbox" v-model="ocrSettings.cloud.enabled" /> 使用云端 OCR（OpenAI 兼容视觉，需 API Key）</label>
        </div>
        <template v-if="ocrSettings.cloud.enabled">
          <div class="ocr-cfg-row">
            <label>云端端点</label>
            <input v-model="ocrSettings.cloud.endpoint" placeholder="https://api.openai.com/v1/chat/completions" />
          </div>
          <div class="ocr-cfg-row">
            <label>API Key</label>
            <input v-model="ocrSettings.cloud.apiKey" type="password" placeholder="sk-…" />
          </div>
          <div class="ocr-cfg-row">
            <label>模型</label>
            <input v-model="ocrSettings.cloud.model" placeholder="gpt-4o-mini" />
          </div>
        </template>
        <div class="ocr-cfg-row" style="margin-top:10px">
          <button class="btn accent" @click="saveOcr">保存设置</button>
          <button class="btn" style="margin-left:8px" @click="showOcrCfg = false">取消</button>
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
          <span class="up-name">🔍 OCR：{{ ocr.name }}</span>
          <div class="bar"><div class="bar-in" :style="{ width: ocr.pct + '%' }"></div></div>
          <span class="up-pct">{{ ocr.pct }}%</span>
          <span v-if="ocr.pages" class="hint" style="margin-left:8px">{{ ocr.page }}/{{ ocr.pages }} 页</span>
        </div>
      </div>
    </div>

    <!-- 文件列表 -->
    <div class="mat-section">
      <div class="mat-title">资料库 <span class="hint">（{{ files.length }} 份）</span></div>
      <div v-if="!files.length" class="hint" style="padding:18px 0;text-align:center">还没有资料。上传第一份真题或讲义，它会成为你复习系统的知识源头。</div>
      <div v-for="f in files" :key="f.id" class="mat-row">
        <div class="mat-ico">{{ iconOf(f.ext) }}</div>
        <div class="mat-info">
          <div class="mat-name">{{ f.name }} <span class="tag">{{ (f.ext || '?').toUpperCase() }}</span></div>
          <div class="mat-meta">
            {{ fmtBytes(f.size) }}<span v-if="f.subject"> · {{ f.subject }}</span>
            <span v-if="f.pageCount"> · {{ f.pageCount }} 页</span>
            <span v-if="f.textLen"> · 解析全文 {{ f.textLen }} 字</span>
          </div>
          <div v-if="f.error" class="err" :title="f.error">⚠ {{ f.error }}</div>
        </div>
        <div class="mat-status">
          <span class="st" :class="'st-' + f.status">{{ statusText(f) }}</span>
        </div>
        <div class="mat-ops">
          <template v-if="f.status === 'ready'">
            <button class="btn small" @click="openPreview(f)">预览</button>
            <button class="btn small" @click="openQA(f)">问答</button>
            <button class="btn small accent" @click="openDrafts(f)">生成卡片</button>
            <button class="btn small" @click="runLink(f)" title="把资料与它覆盖的卡片建立知识图谱关联">🔗 关联卡片</button>
          </template>
          <button v-else-if="f.status === 'failed'" class="btn small" @click="retry(f.id)">重试</button>
          <button v-if="needsOcr(f)" class="btn small accent" :disabled="ocr.busy" @click="runOcr(f)">🔍 OCR 识别</button>
          <button class="btn small danger" @click="onDelete(f)">删除</button>
        </div>
      </div>
    </div>

    <!-- 预览面板 -->
    <div v-if="preview" class="mat-section">
      <div class="mat-title">
        预览：{{ preview.row.name }}
        <button class="btn small" style="margin-left:8px" @click="preview = null; pdfDocCache = null">关闭</button>
      </div>
      <div v-if="preview.row.ext === 'pdf'" class="pdf-box">
        <div class="pdf-toolbar">
          <button class="btn small" :disabled="pdfPage <= 1" @click="pdfPage--">← 上一页</button>
          <span>{{ pdfPage }} / {{ pdfPages }}</span>
          <button class="btn small" :disabled="pdfPage >= pdfPages" @click="pdfPage++">下一页 →</button>
        </div>
        <div class="pdf-scroll"><canvas ref="pdfCanvas" class="pdf-canvas"></canvas></div>
      </div>
      <div v-else-if="['xlsx', 'xls', 'csv'].includes(preview.row.ext)" class="sheet-wrap" v-html="sheetHtml"></div>
      <div v-else-if="preview.row.ext === 'docx' || preview.row.ext === 'doc'" class="docx-wrap">
        <div class="hint" style="margin-bottom:8px">⚠ 近似预览（Word 复杂排版在纯前端有损）</div>
        <div v-html="docxHtml"></div>
      </div>
      <div v-else-if="['png','jpg','jpeg','gif','webp','bmp','svg'].includes(preview.row.ext)"><img :src="imgUrl" class="img-preview" /></div>
      <div v-else class="text-preview"><pre>{{ textPreview }}</pre></div>
    </div>

    <!-- 问答面板 -->
    <div v-if="qa.docId" class="mat-section">
      <div class="mat-title">
        对资料提问
        <button class="btn small" style="margin-left:8px" @click="qa.docId = null">关闭</button>
      </div>
      <div class="qa-row">
        <input v-model="qa.question" class="qa-input" placeholder="例如：请总结这份真题的第三章考点" @keyup.enter="ask" :disabled="qa.busy" />
        <button class="btn accent" :disabled="qa.busy || !qa.question.trim()" @click="ask">{{ qa.busy ? '思考中…' : '提问' }}</button>
      </div>
      <div v-if="qa.answer" class="qa-answer">
        <div class="qa-text">{{ qa.answer }}</div>
        <div v-if="qa.citations.length" class="qa-cites">
          <div class="hint" style="margin-bottom:6px">📎 引用片段：</div>
          <div v-for="c in qa.citations" :key="c.idx" class="qa-cite">
            <span class="tag">片段{{ c.idx }} · 相似 {{ c.score }}%</span>
            <div class="qa-cite-text">{{ c.text }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 建卡预览弹窗（用户选择制：确认才入库） -->
    <div v-if="draftModal" class="modal-mask" @click.self="draftModal = null">
      <div class="modal">
        <div class="modal-head">
          <b>🃏 生成卡片预览 — {{ draftModal.row.name }}</b>
          <button class="btn small" @click="draftModal = null">✕</button>
        </div>
        <div class="hint" style="margin-bottom:10px;line-height:1.7">
          共 <b>{{ draftModal.drafts.length }}</b> 张草稿。可<b>编辑</b> / <b>删除</b>单张；
          点击「确认导入」后才进入复习队列（默认绝不自动建卡）。来源血缘会自动记录，卡片可反查原文。
        </div>
        <div class="draft-list">
          <div v-for="(d, i) in draftModal.drafts" :key="i" class="draft">
            <div class="draft-head">
              <span class="tag">{{ d.note }}</span>
              <span class="draft-idx">#{{ i + 1 }}</span>
              <span style="flex:1"></span>
              <button class="btn small" @click="toggleEdit(d)">{{ d._edit ? '完成编辑' : '编辑' }}</button>
              <button class="btn small danger" @click="removeDraft(i)">删除</button>
            </div>
            <template v-if="d._edit">
              <textarea v-model="d.front" class="draft-input" rows="3" placeholder="正面（提示 / 问题）"></textarea>
              <textarea v-model="d.back" class="draft-input" rows="4" placeholder="背面（结论 / 答案）"></textarea>
            </template>
            <template v-else>
              <div class="draft-front">Q：{{ d.front }}</div>
              <div class="draft-back">A：{{ d.back }}</div>
            </template>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="draftModal = null">取消（不建卡）</button>
          <button class="btn accent" :disabled="draftBusy || !draftModal.drafts.length" @click="doImport">
            {{ draftBusy ? '导入中…' : `✅ 确认导入 ${draftModal.drafts.length} 张卡片` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mat-hero { background: linear-gradient(135deg, var(--panel), var(--code-bg)); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px 24px; margin-bottom: 16px; }
.mat-upload { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
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
