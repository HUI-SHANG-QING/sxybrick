<script setup>
// 导出打印：自由组合筛选（多科目 × 多标签 × 搜索 × 逻辑）+ 批量勾选单卡 + 排序 + 缩略图 + 隐藏答案 + Markdown 导出
// 预览采用 CodeBrick 式排版：导出头 + 按科目分组 + 编号卡片（Q/A 分区、虚线分隔）
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';
import { toast } from '../utils/toast.js';
import {
  getSubjects, getTags, listCards, createCard,
  queryUserOps, listPrivacyRecords,
} from '../repo.js';
import { downloadCsv, downloadAnkiText, downloadBackup as doDownloadBackup, countData } from '../sync.js';
import { imgUrl, ensureImages, extractImageIds } from '../images.js';
import { encodeShareCode, decodeShareCode, estimateSize } from '../utils/shareCode.js';
import { parseApkg } from '../utils/apkg.js';
import { flushTelemetry, T } from '../utils/telemetry.js';
import { db } from '../db.js';
import { t } from '../i18n/index.js';

const subjects = ref([]);
const allTags = ref([]);
const subjectSel = ref([]);   // 已选科目（多选）
const tagNames = ref([]);     // 已选标签（多选）
const logic = ref('AND');     // 标签间逻辑 AND/OR/NOT
const q = ref('');
const mode = ref('all');      // all | incremental
const sortBy = ref('updated');
const hideAnswer = ref(false);
const checkedIds = ref([]);   // 批量勾选的卡片 id
const allCache = ref([]);     // 全量卡片缓存
const thumbMap = ref({});     // cardId -> objectURL（响应式缩略图）

// ————— P1·9 新增：全量数据导出（含 userOps / privacyRecords）+ 仪表盘 + 隐私 CSV 导出 —————
const globalCounts = ref({});
const exportOpsMode = ref('full');   // 'full' 全量 | 'aggregate' 仅聚合（体积小）
const exportOpsRange = ref('90');    // '7'|'30'|'90'|'all'
const privacyExportRange = ref('90');
const backupBusy = ref(false);
async function refreshCounts() {
  try { globalCounts.value = await countData(); } catch {}
}
async function doFullBackup() {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    await flushTelemetry();
    await doDownloadBackup();
    T.exportRun('json', null);
    toast('全量数据包已导出（含 userOps 埋点 + privacyRecords 隐私记录，可用于跨设备同步）', 'success');
    await refreshCounts();
  } catch (e) { toast(e.message, 'error'); }
  finally { backupBusy.value = false; }
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
// 导出 userOps：full = 原始 JSON 数组；aggregate = 日 / 模块 / 类型聚合三份 JSON
async function doExportUserOps() {
  try {
    await flushTelemetry();
    const range = exportOpsRange.value;
    const from = range === 'all' ? 0 : Date.now() - Number(range) * 24 * 3600 * 1000;
    const rows = await queryUserOps({ from, groupBy: null });
    if (!rows.length) { toast('范围内没有 userOps 记录', 'warn'); return; }
    let payload;
    if (exportOpsMode.value === 'aggregate') {
      const [byDay, byHour, byModule, byType] = await Promise.all([
        queryUserOps({ from, groupBy: 'day' }),
        queryUserOps({ from, groupBy: 'hour' }),
        queryUserOps({ from, groupBy: 'module' }),
        queryUserOps({ from, groupBy: 'type' }),
      ]);
      payload = { mode: 'aggregate', rangeDays: range === 'all' ? 'all' : Number(range), total: rows.length, byDay, byHour, byModule, byType, exportedAt: Date.now() };
    } else {
      payload = { mode: 'full', rangeDays: range === 'all' ? 'all' : Number(range), total: rows.length, rows, exportedAt: Date.now() };
    }
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    a.download = `sxybrick-userOps-${exportOpsMode.value === 'aggregate' ? '聚合' : '全量'}-${range === 'all' ? 'all' : range + 'd'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    T.exportRun('userOps.' + exportOpsMode.value, rows.length);
    toast(`已导出 userOps ${fmtBytes(blob.size)}（${rows.length} 条）`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}
// 导出隐私记录：JSON + CSV 双通道
async function doExportPrivacy() {
  try {
    await flushTelemetry();
    const range = privacyExportRange.value;
    const fromMs = range === 'all' ? 0 : Date.now() - Number(range) * 24 * 3600 * 1000;
    const recs = (await listPrivacyRecords({ limit: 5000 })).filter(r => (r.updatedAt || 0) >= fromMs);
    if (!recs.length) { toast('范围内没有隐私记录', 'warn'); return; }
    // JSON 通道
    const jsonBlob = new Blob([JSON.stringify({ rangeDays: range === 'all' ? 'all' : Number(range), total: recs.length, records: recs, exportedAt: Date.now() })], { type: 'application/json' });
    // CSV 通道（物理/精神/自定义的关键字段展开，复杂块以 JSON 字符串存放）
    const header = ['id', 'date', 'type', 'subType', 'startTime', 'endTime', 'location', 'people', 'mood', 'energy', 'focus', 'pleasure', 'stress', 'painIndex', 'painParts', 'sleepBlock', 'eatBlock', 'moveBlock', 'learnBlock', 'workBlock', 'screenBlock', 'financeBlock', 'customTags', 'customKV', 'mental', 'createdAt', 'updatedAt'];
    const rows = [header];
    for (const r of recs) {
      rows.push(header.map(h => {
        const v = r[h];
        if (v == null) return '';
        if (typeof v === 'object') {
          try { return JSON.stringify(v); } catch { return String(v); }
        }
        return String(v);
      }));
    }
    const esc = s => String(s ?? '').replace(/"/g, '""');
    const csv = rows.map(r => r.map(c => `"${esc(c)}"`).join(',')).join('\n');
    const csvBlob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    const suffix = `${range === 'all' ? 'all' : range + 'd'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const save = (blob, ext) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sxybrick-privacyRecords-${suffix}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    save(jsonBlob, 'json');
    save(csvBlob, 'csv');
    T.exportRun('privacy.json+csv', recs.length);
    toast(`已导出 privacyRecords（JSON + CSV，${recs.length} 条 · ${fmtBytes(jsonBlob.size + csvBlob.size)}）`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}
// 一次性清空两张新表（给用户"撤销恐怖监控"的按钮）
const dangerOpen = ref(false);
const dangerConfirm = ref('');
async function wipeUserOps() {
  if (dangerConfirm.value !== '清空埋点') return toast('请在输入框输入「清空埋点」再确认', 'warn');
  try {
    await db.userOps.clear();
    dangerConfirm.value = '';
    await refreshCounts();
    toast('已清空全部 userOps 埋点记录（本地与同步链均失效，需重新同步）', 'success');
  } catch (e) { toast(e.message, 'error'); }
}
async function wipePrivacy() {
  if (dangerConfirm.value !== '清空隐私') return toast('请在输入框输入「清空隐私」再确认', 'warn');
  try {
    await db.privacyRecords.clear();
    dangerConfirm.value = '';
    await refreshCounts();
    toast('已清空全部 privacyRecords 隐私记录（历史画像一并重置）', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

const SORT_OPTIONS = [
  { id: 'updated', label: '最近更新' },
  { id: 'created', label: '创建时间' },
  { id: 'subject', label: '科目' },
  { id: 'level', label: '复习进度' },
  { id: 'due', label: '到期时间' },
];

const previewOpen = ref(false);
const printCards = ref([]);
const scopeDesc = ref('');
const lastExport = ref(null); // { exportedAt, count, scope }

const exportDate = computed(() => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});

// 筛选后的候选卡片（科目并集 → 标签逻辑 → 搜索 → 排序）
const candidates = computed(() => {
  let cards = allCache.value;
  const k = q.value.trim();
  if (k) cards = cards.filter(c => c.front.includes(k) || c.back.includes(k));
  if (subjectSel.value.length) {
    cards = cards.filter(c => subjectSel.value.includes(c.subject || '未分类'));
  }
  const ts = tagNames.value;
  if (ts.length) {
    if (logic.value === 'AND') cards = cards.filter(c => ts.every(t => (c.tags || []).includes(t)));
    else if (logic.value === 'OR') cards = cards.filter(c => ts.some(t => (c.tags || []).includes(t)));
    else cards = cards.filter(c => !ts.some(t => (c.tags || []).includes(t)));
  }
  const s = sortBy.value;
  const arr = [...cards];
  if (s === 'created') arr.sort((a, b) => (b.createdAt - a.createdAt) || (b.id > a.id ? 1 : -1));
  else if (s === 'subject') arr.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || '')) || (b.updatedAt - a.updatedAt));
  else if (s === 'level') arr.sort((a, b) => (b.level - a.level) || (b.updatedAt - a.updatedAt));
  else if (s === 'due') arr.sort((a, b) => (a.dueAt - b.dueAt) || (b.updatedAt - a.updatedAt));
  else arr.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.id > a.id ? 1 : -1));
  return arr;
});

// 当候选变化时：清掉已不存在的勾选 + 批量加载缩略图
watch(candidates, async (list) => {
  const ids = new Set(list.map(c => c.id));
  checkedIds.value = checkedIds.value.filter(id => ids.has(id));
  const imgIds = [];
  const byCard = [];
  for (const c of list) {
    const eid = extractImageIds(c.front)[0];
    if (eid) { imgIds.push(eid); byCard.push([c.id, eid]); }
  }
  await ensureImages(imgIds);
  const map = {};
  for (const [cid, iid] of byCard) map[cid] = imgUrl(iid);
  thumbMap.value = map;
}, { immediate: true });

// 按科目分组（未分类排最后）—— 导出排版用
const grouped = computed(() => {
  const map = new Map();
  for (const c of printCards.value) {
    const key = c.subject || '未分类';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const groups = [...map.entries()].map(([name, cards]) => ({ name, cards }));
  groups.sort((a, b) => {
    if (a.name === '未分类') return 1;
    if (b.name === '未分类') return -1;
    return a.name.localeCompare(b.name);
  });
  return groups;
});

const checkedCount = computed(() => checkedIds.value.length);

function plain(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]')
    .replace(/[#>*`~|=-]+/g, '')
    .replace(/\$\$?/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags();
  allCache.value = (await listCards({})).items;
  if (allCache.value.some(c => !c.subject)) {
    const cnt = allCache.value.filter(c => !c.subject).length;
    subjects.value = [...subjects.value.filter(s => s.name !== '未分类'), { name: '未分类', count: cnt }];
  }
}

function toggleSubject(name) {
  const i = subjectSel.value.indexOf(name);
  if (i >= 0) subjectSel.value.splice(i, 1);
  else subjectSel.value.push(name);
}
function toggleTag(name) {
  const i = tagNames.value.indexOf(name);
  if (i >= 0) tagNames.value.splice(i, 1);
  else tagNames.value.push(name);
}

function checkAll() { checkedIds.value = candidates.value.map(c => c.id); }
function checkInvert() {
  const ids = new Set(checkedIds.value);
  checkedIds.value = candidates.value.filter(c => !ids.has(c.id)).map(c => c.id);
}
function checkClear() { checkedIds.value = []; }
function toggleOne(id) {
  const i = checkedIds.value.indexOf(id);
  if (i >= 0) checkedIds.value.splice(i, 1);
  else checkedIds.value.push(id);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildDesc() {
  const parts = [];
  if (subjectSel.value.length) parts.push(`科目=${subjectSel.value.join('+')}`);
  if (tagNames.value.length) parts.push(`标签[${logic.value}]=${tagNames.value.join(',')}`);
  if (q.value.trim()) parts.push(`搜索=${q.value.trim()}`);
  if (checkedIds.value.length) parts.push(`手选=${checkedIds.value.length}张`);
  if (!parts.length) parts.push('全部卡片');
  return parts.join('；') + (mode.value === 'incremental' ? '（仅新增）' : '');
}

// 最终选定的卡片（勾选优先，否则全部筛选结果）
function selectedCards() {
  return checkedIds.value.length
    ? candidates.value.filter(c => checkedIds.value.includes(c.id))
    : candidates.value;
}

async function generate() {
  try {
    let cards = selectedCards();
    if (mode.value === 'incremental' && lastExport.value?.exportedAt) {
      cards = cards.filter(c => (c.updatedAt || 0) > (lastExport.value.exportedAt || 0));
    }
    if (!cards.length) {
      return toast(mode.value === 'incremental' ? '上次导出后没有新增或修改' : '没有符合条件的卡片', 'error');
    }
    printCards.value = cards;
    scopeDesc.value = buildDesc();
    previewOpen.value = true;
    await nextTick();
  } catch (e) { toast(e.message, 'error'); }
}

function doPrint() {
  window.print();
}

async function doCsv() {
  try { await downloadCsv(); toast('已导出 CSV/TSV 文件，可用 Excel 或 Anki 导入', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

// P3-1 Anki 互操作导出：导出为 Anki 友好的 TSV（带 #tags column 配置，Anki 导入自动带标签）
// 优先导出勾选的卡片，无勾选则导出当前筛选结果
async function doAnki() {
  try {
    const cards = checkedIds.value.length
      ? candidates.value.filter(c => checkedIds.value.includes(c.id))
      : candidates.value;
    if (!cards.length) { toast('当前筛选范围内没有卡片可导出', 'error'); return; }
    await downloadAnkiText(cards);
    try { T.exportRun('anki', cards.length); } catch {}
    toast(`已导出 ${cards.length} 张为 Anki TSV（带标签列），Anki 桌面版「导入 → 文本文件」直接可用`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// 导出 Markdown 文件（按科目分组 Q/A，配合知识库使用）
function doMarkdown() {
  const cards = selectedCards();
  if (!cards.length) { toast('没有可导出的卡片', 'error'); return; }
  const L = [];
  L.push('# SxyBrick 记忆卡片');
  L.push('');
  L.push(`> 导出日期：${exportDate.value} · 共 ${cards.length} 张 · ${scopeDesc.value}`);
  L.push('');
  const map = new Map();
  for (const c of cards) {
    const k = c.subject || '未分类';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  let no = 0;
  for (const [subject, list] of map) {
    L.push(`## ${subject}`);
    L.push('');
    for (const c of list) {
      no++;
      const tags = (c.tags || []).map(t => `\`${t}\``).join(' ');
      L.push(`### ${no}. ${plain(c.front).slice(0, 48)}`);
      L.push('');
      if (tags) { L.push(tags); L.push(''); }
      L.push(`**Q** ${c.front}`);
      L.push('');
      L.push(hideAnswer.value ? `**A** _（答案已隐藏）_` : `**A** ${c.back}`);
      L.push('');
      L.push('---');
      L.push('');
    }
  }
  const text = L.join('\n');
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sxybrick-卡片-${exportDate.value}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${cards.length} 张卡片为 Markdown 文件`, 'success');
}

async function onAfterPrint() {
  if (!previewOpen.value) return;
  lastExport.value = { exportedAt: Date.now(), count: printCards.value.length, scope: scopeDesc.value };
  localStorage.setItem('sxy_last_export', JSON.stringify(lastExport.value));
  toast(`已导出 ${printCards.value.length} 张卡片，可在打印对话框选择「另存为 PDF」`, 'success');
}

onMounted(() => {
  loadMeta();
  refreshCounts();
  try { lastExport.value = JSON.parse(localStorage.getItem('sxy_last_export') || 'null'); } catch {}
});

// ---------- P3·#1 卡组分享码：生成 / 复制 / 粘贴导入 ----------
const shareOpen = ref(false);
const shareMode = ref('generate'); // 'generate' | 'import'
const shareCode = ref('');
const shareBusy = ref(false);
const importCode = ref('');
const importPreview = ref(null); // { cards, scope, exportedAt }

async function openShareGen() {
  const cards = selectedCards();
  if (!cards.length) { toast('没有可分享的卡片', 'error'); return; }
  shareMode.value = 'generate';
  shareOpen.value = true;
  shareCode.value = '';
  shareBusy.value = true;
  try {
    const code = await encodeShareCode(cards, { scope: buildDesc() });
    shareCode.value = code;
    toast(`已生成分享码（${cards.length} 张，约 ${estimateSize(cards)} KB）`, 'success');
  } catch (e) { toast('生成失败：' + e.message, 'error'); }
  finally { shareBusy.value = false; }
}

async function copyShareCode() {
  if (!shareCode.value) return;
  try {
    await navigator.clipboard.writeText(shareCode.value);
    toast('分享码已复制到剪贴板', 'success');
  } catch { toast('剪贴板不可用，请手动选中复制', 'info'); }
}

function openShareImport() {
  shareMode.value = 'import';
  shareOpen.value = true;
  importCode.value = '';
  importPreview.value = null;
}

async function previewImport() {
  if (!importCode.value.trim()) { toast('请粘贴分享码', 'error'); return; }
  if (shareBusy.value) return;
  shareBusy.value = true;
  try {
    const r = await decodeShareCode(importCode.value);
    importPreview.value = r;
    toast(`解析成功：${r.cards.length} 张卡片${r.scope ? '·范围 ' + r.scope : ''}`, 'success');
  } catch (e) {
    toast('解析失败：' + e.message, 'error');
    importPreview.value = null;
  } finally { shareBusy.value = false; }
}

async function doImport() {
  if (!importPreview.value?.cards?.length) { toast('请先解析预览', 'error'); return; }
  if (shareBusy.value) return;
  shareBusy.value = true;
  let n = 0, fail = 0;
  try {
    for (const c of importPreview.value.cards) {
      try {
        await createCard({
          front: c.front, back: c.back, subject: c.subject || '',
          tags: c.tags || [], mnemonic: c.mnemonic || '',
          wrongReason: c.wrongReason || '', type: c.type || 'basic',
          source: '分享码导入',
        });
        n++;
      } catch { fail++; }
    }
    toast(`已导入 ${n} 张卡片${fail ? `，失败 ${fail} 张` : ''}（可在「我的卡片」查看）`, 'success');
    shareOpen.value = false;
    await loadMeta();
  } catch (e) { toast('导入失败：' + e.message, 'error'); }
  finally { shareBusy.value = false; }
}

// ————— Anki .apkg 二进制导入（jszip + sql.js 本地解析，零服务端） —————
const apkgBusy = ref(false);
const apkgOpen = ref(false);
const apkgPreview = ref(null);  // { cards, count }
const apkgSubject = ref('');    // 导入目标科目（空 = 未分类）
const apkgFileEl = ref(null);
function openApkg() { apkgOpen.value = true; apkgPreview.value = null; apkgSubject.value = ''; }
function pickApkg() { apkgFileEl.value?.click(); }
async function onApkgFile(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许重复选同一文件
  if (!file || apkgBusy.value) return;
  apkgBusy.value = true;
  try {
    const buf = await file.arrayBuffer();
    const r = await parseApkg(buf);
    apkgPreview.value = r;
    toast(`解析成功：${r.count} 张卡片（下方预览前 8 张）`, 'success');
  } catch (err) {
    toast('解析失败：' + (err?.message || err), 'error');
    apkgPreview.value = null;
  } finally { apkgBusy.value = false; }
}
async function doApkgImport() {
  if (!apkgPreview.value?.cards?.length) { toast('请先选择 .apkg 文件', 'error'); return; }
  if (apkgBusy.value) return;
  apkgBusy.value = true;
  let n = 0, fail = 0;
  try {
    for (const c of apkgPreview.value.cards) {
      try {
        await createCard({
          front: c.front, back: c.back, subject: apkgSubject.value || '',
          tags: c.tags || [], type: 'basic', source: 'Anki 导入',
        });
        n++;
      } catch { fail++; }
    }
    toast(`已导入 ${n} 张卡片${fail ? `，失败 ${fail} 张` : ''}（可在「我的卡片」查看）`, 'success');
    apkgOpen.value = false;
    await loadMeta();
  } catch (err) { toast('导入失败：' + (err?.message || err), 'error'); }
  finally { apkgBusy.value = false; }
}
</script>

<template>
  <div>
    <h2>导出打印</h2>

    <!-- 筛选范围 -->
    <div class="panel no-print">
      <div class="field-label" style="margin-top:0">科目（可多选，多个科目为并集）</div>
      <div class="row">
        <button v-for="s in subjects" :key="s.name" class="chip"
                :class="{ on: subjectSel.includes(s.name) }" @click="toggleSubject(s.name)">
          {{ s.name }}<span v-if="s.count" class="n">{{ s.count }}</span>
        </button>
        <button v-if="subjectSel.length" class="chip" @click="subjectSel = []">清除科目</button>
      </div>

      <div class="field-label">标签（可多选）</div>
      <div class="row">
        <button v-for="t in allTags" :key="t.name" class="chip"
                :class="{ on: tagNames.includes(t.name) }" @click="toggleTag(t.name)">
          {{ t.name }}<span class="n">{{ t.count }}</span>
        </button>
        <select v-if="tagNames.length" v-model="logic" class="input" style="width:auto">
          <option value="AND">交集 AND</option>
          <option value="OR">并集 OR</option>
          <option value="NOT">差集 NOT</option>
        </select>
      </div>

      <div class="row" style="margin-bottom:0">
        <input v-model="q" class="input" style="max-width:240px" placeholder="搜索定位（可选）" />
        <select v-model="sortBy" class="input" style="width:auto">
          <option v-for="o in SORT_OPTIONS" :key="o.id" :value="o.id">排序：{{ o.label }}</option>
        </select>
        <button class="chip" :class="{ on: mode === 'all' }" @click="mode = 'all'">全部导出</button>
        <button class="chip" :class="{ on: mode === 'incremental' }" @click="mode = 'incremental'"
                :disabled="!lastExport">仅新增卡片</button>
      </div>
      <div v-if="lastExport" class="hint" style="margin-top:6px">
        上次导出：{{ fmtTime(lastExport.exportedAt) }} · {{ lastExport.count }} 张 · {{ lastExport.scope }}
      </div>
    </div>

    <!-- 批量勾选清单 -->
    <div class="panel no-print" style="margin-top:14px">
      <div class="pick-bar">
        <div class="field-label" style="margin:0">卡片勾选清单（{{ checkedCount }} / {{ candidates.length }} 已选）</div>
        <div class="pick-actions">
          <button class="chip" @click="checkAll">全选</button>
          <button class="chip" @click="checkInvert">反选</button>
          <button class="chip" @click="checkClear">清空</button>
        </div>
      </div>
      <EmptyState v-if="!candidates.length" icon="🖨️" title="暂无符合条件的卡片" message="请调整上方筛选条件" />
      <div v-else class="pick-list">
        <label v-for="(c, i) in candidates" :key="c.id" class="pick-item"
               :class="{ on: checkedIds.includes(c.id) }">
          <input type="checkbox" :checked="checkedIds.includes(c.id)" @change="toggleOne(c.id)" />
          <span class="pick-thumb">
            <img v-if="thumbMap[c.id]" :src="thumbMap[c.id]" alt="" />
            <span v-else class="thumb-ph">{{ (c.subject || '未分类').slice(0, 1) }}</span>
          </span>
          <span class="pick-no">#{{ i + 1 }}</span>
          <span class="pick-main">
            <span class="pick-head">
              <span class="pick-subj">{{ c.subject || '未分类' }}</span>
              <span v-for="t in c.tags" :key="t" class="tag-pill">{{ t }}</span>
            </span>
            <span class="pick-front">{{ plain(c.front) }}</span>
          </span>
        </label>
      </div>
    </div>

    <!-- 操作 -->
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" class="no-print">
      <button class="btn primary" @click="generate">
        生成 PDF 预览{{ checkedCount ? `（已选 ${checkedCount} 张）` : `（全部 ${candidates.length} 张）` }}
      </button>
      <button class="btn" @click="doCsv">导出 CSV</button>
      <button class="btn" @click="doAnki" title="导出为 Anki 桌面版可识别的 TSV（带标签列），导入时自动带标签">导出 Anki 卡组</button>
      <button class="btn" @click="doMarkdown">导出 Markdown</button>
      <button class="btn" @click="openShareGen" title="把当前筛选/勾选的卡片编码成短字符串，对方粘贴即可导入">🔗 生成分享码</button>
      <button class="btn" @click="openShareImport" title="粘贴他人分享的码，解析后批量导入">📥 导入分享码</button>
      <button class="btn" @click="openApkg" title="导入 Anki 桌面版导出的 .apkg 卡组（本地解析，零服务端）">📦 导入 .apkg</button>
      <button class="chip" :class="{ on: hideAnswer }" @click="hideAnswer = !hideAnswer">
        {{ hideAnswer ? '已隐藏答案（自测）' : '隐藏答案（自测模式）' }}
      </button>
    </div>

    <!-- 打印预览（格式保持优美版式不变） -->
    <teleport to="body">
      <div v-if="previewOpen" class="modal-mask" style="padding:20px">
        <div class="modal export-modal">
          <div class="no-print modal-bar">
            <h3 style="margin:0">打印预览（{{ printCards.length }} 张）</h3>
            <div>
              <button class="btn" @click="previewOpen = false">关闭</button>
              <button class="btn primary" @click="doPrint">打印 / 另存为 PDF</button>
            </div>
          </div>

          <div id="print-area" class="export-sheet">
            <div class="export-head">
              <div class="export-head-title">
                <div class="export-logo">SxyBrick</div>
                <div class="export-subtitle">记忆卡片</div>
              </div>
              <div class="export-head-meta">
                <div>导出日期：{{ exportDate }}</div>
                <div>卡片总数：{{ printCards.length }} 张</div>
                <div>范围：{{ scopeDesc }}</div>
              </div>
            </div>

            <div v-for="g in grouped" :key="g.name" class="export-group">
              <div class="group-title">
                <span class="group-bar"></span>
                <span class="group-name">{{ g.name }}</span>
                <span class="group-count">{{ g.cards.length }} 张</span>
              </div>

              <div v-for="(c, i) in g.cards" :key="c.id" class="print-card">
                <div class="card-head">
                  <span class="card-no">{{ g.name === '未分类' ? '' : g.name + ' · ' }}#{{ i + 1 }}</span>
                  <span class="card-tags">
                    <span v-for="t in c.tags" :key="t" class="tag-pill">{{ t }}</span>
                  </span>
                </div>
                <div class="qa q-side"><span class="qa-mark">Q</span><MarkdownRenderer :content="c.front" /></div>
                <div class="qa-divider"></div>
                <div class="qa a-side">
                  <span class="qa-mark a">A</span>
                  <div v-if="hideAnswer" class="answer-hidden">（答案已隐藏 · 自测模式）</div>
                  <MarkdownRenderer v-else :content="c.back" />
                </div>
              </div>
            </div>

            <div class="export-foot">— SxyBrick 记忆卡片 · {{ exportDate }} —</div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- P3·#1 卡组分享码弹窗：生成 / 复制 / 粘贴 / 导入 -->
    <teleport to="body">
      <div v-if="shareOpen" class="modal-mask" @click.self="shareOpen = false">
        <div class="modal" style="max-width:620px">
          <h3 style="margin-top:0">🔗 卡组分享码</h3>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="chip" :class="{ on: shareMode === 'generate' }" @click="shareMode = 'generate'">生成分享码</button>
            <button class="chip" :class="{ on: shareMode === 'import' }" @click="shareMode = 'import'">粘贴导入</button>
          </div>

          <div v-if="shareMode === 'generate'">
            <p class="hint" style="margin:4px 0 8px">把当前筛选/勾选的卡片编码成短字符串（gzip+base64 压缩，零外部服务）。对方在「导入分享码」粘贴即可批量导入。</p>
            <div v-if="shareBusy" class="hint" style="padding:12px;text-align:center">生成中…</div>
            <template v-else-if="shareCode">
              <textarea class="input" rows="6" readonly :value="shareCode" style="font-family:monospace;font-size:11px;word-break:break-all"></textarea>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn primary" @click="copyShareCode">📋 复制到剪贴板</button>
                <button class="btn" @click="shareOpen = false">关闭</button>
              </div>
            </template>
          </div>

          <div v-else>
            <p class="hint" style="margin:4px 0 8px">粘贴以 <code>SXY1:</code> 或 <code>SXY0:</code> 开头的分享码，先解析预览，再批量导入。</p>
            <textarea v-model="importCode" class="input" rows="5" placeholder="在此粘贴分享码…" style="font-family:monospace;font-size:11px;word-break:break-all"></textarea>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn" :disabled="shareBusy || !importCode.trim()" @click="previewImport">解析预览</button>
              <button v-if="importPreview" class="btn primary" :disabled="shareBusy" @click="doImport">📥 导入 {{ importPreview.cards.length }} 张</button>
              <button class="btn" @click="shareOpen = false">关闭</button>
            </div>
            <div v-if="importPreview" class="hint" style="margin-top:10px;padding:8px 10px;background:var(--code-bg);border-radius:6px">
              <div>✅ 解析成功：{{ importPreview.cards.length }} 张卡片</div>
              <div v-if="importPreview.scope">范围：{{ importPreview.scope }}</div>
              <div v-if="importPreview.exportedAt">导出于：{{ fmtTime(importPreview.exportedAt) }}</div>
              <div style="margin-top:6px;max-height:120px;overflow-y:auto">
                <div v-for="(c, i) in importPreview.cards.slice(0, 5)" :key="i" style="font-size:12px;padding:2px 0">
                  · {{ (c.subject || '未分类') }} — {{ String(c.front).slice(0, 40) }}
                </div>
                <div v-if="importPreview.cards.length > 5" style="font-size:11px;color:var(--ink-2)">… 还有 {{ importPreview.cards.length - 5 }} 张</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- Anki .apkg 导入 -->
    <input ref="apkgFileEl" type="file" accept=".apkg,.colpkg,.zip" style="display:none" @change="onApkgFile" />
    <teleport to="body">
      <div v-if="apkgOpen" class="modal-mask" @click.self="apkgOpen = false">
        <div class="modal" style="max-width:620px">
          <h3 style="margin-top:0">📦 导入 Anki 卡组（.apkg）</h3>
          <p class="hint" style="margin:4px 0 8px">
            Anki 桌面版「导出 → 卡组格式(.apkg)」得到文件后在此导入。全程本地解析，不上传任何数据。
          </p>
          <button class="btn" :disabled="apkgBusy" @click="pickApkg">{{ apkgBusy ? '解析中…' : '选择 .apkg 文件' }}</button>

          <div v-if="apkgPreview" style="margin-top:12px">
            <div class="hint" style="padding:8px 10px;background:var(--code-bg);border-radius:6px">
              <div>✅ 解析成功：{{ apkgPreview.count }} 张卡片</div>
            </div>
            <div style="margin-top:10px">
              <label class="field-label">导入到科目（留空 = 未分类）</label>
              <select v-model="apkgSubject" class="input" style="width:100%;max-width:260px">
                <option value="">未分类</option>
                <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
              </select>
            </div>
            <div style="margin-top:8px;max-height:140px;overflow-y:auto">
              <div v-for="(c, i) in apkgPreview.cards.slice(0, 8)" :key="i" style="font-size:12px;padding:3px 0;border-bottom:1px dashed var(--line)">
                · {{ String(c.front).slice(0, 50) }} <span v-if="c.tags?.length" class="hint">[{{ c.tags.join(' ') }}]</span>
              </div>
              <div v-if="apkgPreview.count > 8" class="hint" style="font-size:11px;padding:4px 0">… 还有 {{ apkgPreview.count - 8 }} 张</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn primary" :disabled="apkgBusy" @click="doApkgImport">📥 导入 {{ apkgPreview.count }} 张</button>
              <button class="btn" @click="apkgOpen = false">关闭</button>
            </div>
          </div>
          <div v-else-if="!apkgBusy" class="hint" style="margin-top:12px">尚未选择文件。</div>
        </div>
      </div>
    </teleport>

    <!-- ————— P1·9 新增：全量同步包 / 埋点监控 / 隐私人生数据 导出面板 ————— -->
    <div class="panel no-print" style="margin-top:18px;border-color:var(--accent)">
      <h3 style="margin:0 0 12px">🧰 系统级数据导出 / 一键同步备份</h3>
      <div class="hint" style="margin-bottom:10px">
        「全量数据包」包含卡片 / 复习 / AI / 导图 / 周报 / 成就 / 模考 / 通知 / 错误日志 / 操作埋点(userOps) / 人生隐私(privacyRecords) 全部模块，
        与「同步 / 局域网一键同步」走同一条链路，可直接跨设备导入。
      </div>
      <div class="stat-grid" style="margin-bottom:12px">
        <div v-for="(v, k) in ['cards','reviews','userOps','privacyRecords','docs','mindmaps','graphEdges','aiChats','weeklyReports','exams']"
             :key="k" class="stat-chip" :class="{ 'is-zero': !globalCounts[k] }">
          <span class="stat-k">{{ k }}</span>
          <span class="stat-v">{{ globalCounts[k] ?? 0 }}</span>
        </div>
      </div>
      <div class="row" style="margin-bottom:0">
        <button class="btn primary" :disabled="backupBusy" @click="doFullBackup">
          {{ backupBusy ? '打包中…' : '📦 导出全量数据包（一键同步）' }}
        </button>
        <button class="chip" @click="refreshCounts">🔄 刷新统计</button>
      </div>
    </div>

    <div class="panel no-print" style="margin-top:14px">
      <h3 style="margin:0 0 10px">👁️ 恐怖级操作监控（userOps 埋点）导出</h3>
      <div class="row">
        <span class="field-label" style="margin:0">范围</span>
        <select v-model="exportOpsRange" class="input" style="width:auto">
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
          <option value="all">全部历史</option>
        </select>
        <span class="field-label" style="margin:0">粒度</span>
        <button class="chip" :class="{ on: exportOpsMode === 'full' }" @click="exportOpsMode = 'full'">原始明细（全量）</button>
        <button class="chip" :class="{ on: exportOpsMode === 'aggregate' }" @click="exportOpsMode = 'aggregate'">仅聚合（体积小）</button>
        <button class="btn" @click="doExportUserOps">📤 导出 userOps JSON</button>
      </div>
      <div class="hint" style="margin:8px 0 0">
        聚合版会自动压缩出：日活跃、24 小时时段、模块使用占比、操作类型分布 4 份结果，体积通常为明细的 1~5%。
      </div>
    </div>

    <div class="panel no-print" style="margin-top:14px">
      <h3 style="margin:0 0 10px">🧍 人生隐私监控（privacyRecords）导出</h3>
      <div class="row">
        <span class="field-label" style="margin:0">范围</span>
        <select v-model="privacyExportRange" class="input" style="width:auto">
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
          <option value="all">全部历史</option>
        </select>
        <button class="btn" @click="doExportPrivacy">📤 导出 JSON + CSV（双通道）</button>
      </div>
      <div class="hint" style="margin:8px 0 0">
        CSV 展开睡眠 / 饮食 / 运动 / 学习 / 工作 / 屏幕 / 财务 / 心情 / 疼痛 / 自定义标签等字段，可用 Excel 做二次透视；JSON 保留完整结构，可再导入本系统。
      </div>
    </div>

    <div class="panel no-print" style="margin-top:14px;border-color:#e11d48;background:linear-gradient(180deg,#fff1f2,var(--panel))">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">⚠️ 危险区：清空监控 / 隐私数据</h3>
        <button class="btn small" @click="dangerOpen = !dangerOpen">
          {{ dangerOpen ? '收起' : '展开危险区' }}
        </button>
      </div>
      <div v-if="dangerOpen" style="margin-top:12px">
        <div class="hint" style="margin-bottom:8px">
          清空是单向的：本地 IndexedDB 立即删除，下一次同步会把删除事件传播到其他设备。请谨慎操作。
        </div>
        <div class="row">
          <input v-model="dangerConfirm" class="input" style="max-width:260px"
                 placeholder="输入「清空埋点」或「清空隐私」" />
          <button class="btn" style="background:#e11d48;color:#fff;border-color:#be123c" @click="wipeUserOps">🗑️ 清空全部 userOps 埋点</button>
          <button class="btn" style="background:#9f1239;color:#fff;border-color:#881337" @click="wipePrivacy">🗑️ 清空全部隐私人生记录</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }

/* 勾选清单 */
.pick-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.pick-actions { display: flex; gap: 6px; }
.pick-list { max-height: 400px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 4px; }
.pick-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 6px;
  cursor: pointer; transition: background .12s;
}
.pick-item:hover { background: var(--code-inline); }
.pick-item.on { background: var(--tag-bg); }
.pick-item input { margin-top: 14px; flex: none; }
.pick-thumb {
  flex: none; width: 44px; height: 44px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--line); background: var(--code-inline);
  display: flex; align-items: center; justify-content: center;
}
.pick-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-ph { font-size: 18px; font-weight: 700; color: var(--ink-2); }
.pick-no { flex: none; font-size: 12px; color: var(--ink-2); font-weight: 600; min-width: 34px; margin-top: 14px; }
.pick-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-top: 2px; }
.pick-head { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.pick-subj { font-size: 12px; font-weight: 700; color: var(--accent); }
.pick-front { font-size: 13px; color: var(--ink); word-break: break-all; }

/* 预览弹窗 */
.export-modal { max-width: 900px; }
.modal-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }

/* 导出纸张样式 */
.export-sheet { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 28px 32px; }
.export-head {
  display: flex; justify-content: space-between; align-items: flex-end;
  border-bottom: 2px solid #16202c; padding-bottom: 14px; margin-bottom: 22px;
}
.export-head-title .export-logo { font-size: 26px; font-weight: 800; color: #16202c; line-height: 1.1; }
.export-head-title .export-subtitle { font-size: 14px; color: #5b6b7d; letter-spacing: 4px; }
.export-head-meta { text-align: right; font-size: 12px; color: #5b6b7d; line-height: 1.7; }

.export-group { margin-bottom: 20px; }
.group-title { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.group-bar { width: 5px; height: 18px; background: #16202c; border-radius: 2px; }
.group-name { font-size: 17px; font-weight: 700; color: #16202c; }
.group-count { font-size: 12px; color: #9aa5b1; }

.print-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; margin-bottom: 12px; }
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.card-no { font-size: 12px; color: #9aa5b1; font-weight: 600; }
.card-tags { display: flex; gap: 5px; flex-wrap: wrap; }

.qa { display: flex; gap: 10px; }
.qa-mark {
  flex: none; width: 22px; height: 22px; border-radius: 6px; background: #16202c; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; margin-top: 2px;
}
.qa-mark.a { background: #2563eb; }
.q-side { font-weight: 600; }
.qa-divider { border-top: 1px dashed #d1d5db; margin: 12px 0 12px 32px; }
.a-side { color: #2b3440; }
.answer-hidden { font-size: 13px; color: #9aa5b1; font-style: italic; padding: 4px 0; }

.export-foot { text-align: center; font-size: 12px; color: #9aa5b1; margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; }

/* 表格着色（作用于 Markdown 渲染出的 table） */
.print-card :deep(table) { border-collapse: collapse; width: 100%; margin: 8px 0; }
.print-card :deep(th) { background: #16202c; color: #fff; font-weight: 600; }
.print-card :deep(th), .print-card :deep(td) { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
.print-card :deep(tr:nth-child(even) td) { background: #f8fafc; }

.stat-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px;
}
.stat-chip {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 10px; border-radius: 8px; background: var(--code-inline);
  border: 1px solid var(--line);
}
.stat-chip.is-zero { opacity: 0.55; }
.stat-k { font-size: 12px; color: var(--ink-2); font-weight: 600; word-break: break-all; }
.stat-v { font-size: 13px; font-weight: 700; color: var(--accent); flex: none; margin-left: 8px; }

@media (max-width: 720px) {
  .export-sheet { padding: 18px 14px; }
  .export-head { flex-direction: column; align-items: flex-start; gap: 8px; }
  .export-head-meta { text-align: left; }
  .pick-item input { margin-top: 12px; }
  .pick-no { margin-top: 12px; }
}
</style>
