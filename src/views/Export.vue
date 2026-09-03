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
import { downloadCsv, downloadAnkiText, downloadBackup as doDownloadBackup, downloadEncryptedBackup, countData } from '../sync.js';
import { clearedBeforeKey } from '../sync-manifest.js';
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
    toast(t('views.export.fullBackupDone'), 'success');
    await refreshCounts();
  } catch (e) { toast(e.message, 'error'); }
  finally { backupBusy.value = false; }
}
// M14：加密备份（.sxybrick）——离设备流转的文件不再明文，落盘/传输均带 AES-GCM 保护
async function doEncryptedBackup() {
  if (backupBusy.value) return;
  const pw = prompt(t('views.export.encBackupPwPrompt'));
  if (pw == null) return;
  if (String(pw).length < 8) { toast(t('views.export.encBackupPwShort'), 'warn'); return; }
  if (prompt(t('views.export.encBackupConfirm')) !== String(pw)) {
    toast(t('views.export.encBackupPwMismatch'), 'error');
    return;
  }
  backupBusy.value = true;
  try {
    await flushTelemetry();
    await downloadEncryptedBackup(String(pw));
    T.exportRun('encrypted', null);
    toast(t('views.export.encBackupDone'), 'success');
    await refreshCounts();
  } catch (e) { toast(e.message || t('views.export.encBackupFail'), 'error'); }
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
    if (!rows.length) { toast(t('views.export.noUserOps'), 'warn'); return; }
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
    // round17 R17-37：click 后不能同步 revoke（Firefox 等偶发下载失败/空文件），延迟 1s
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    T.exportRun('userOps.' + exportOpsMode.value, rows.length);
    toast(t('views.export.exportedUserOps', '已导出 userOps {size}（{n} 条）', { size: fmtBytes(blob.size), n: rows.length }), 'success');
  } catch (e) { toast(e.message, 'error'); }
}
// 导出隐私记录：JSON + CSV 双通道
async function doExportPrivacy() {
  try {
    await flushTelemetry();
    const range = privacyExportRange.value;
    const fromMs = range === 'all' ? 0 : Date.now() - Number(range) * 24 * 3600 * 1000;
    const recs = (await listPrivacyRecords({ limit: 5000 })).filter(r => (r.updatedAt || 0) >= fromMs);
    if (!recs.length) { toast(t('views.export.noPrivacy'), 'warn'); return; }
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
    toast(t('views.export.exportedPrivacy', '已导出 privacyRecords（JSON + CSV，{n} 条 · {size}）', { n: recs.length, size: fmtBytes(jsonBlob.size + csvBlob.size) }), 'success');
  } catch (e) { toast(e.message, 'error'); }
}
// 一次性清空两张新表（给用户"撤销恐怖监控"的按钮）
const dangerOpen = ref(false);
const dangerConfirm = ref('');
async function wipeUserOps() {
  if (dangerConfirm.value !== '清空埋点') return toast(t('views.export.wipeOpsPrompt'), 'warn');
  try {
    await db.userOps.clear();
    // F10（round15 P2）：写「已清空水位」——否则下轮同步把 hub/对端的历史埋点灌回，
    // 「撤销监控」失效（此前 clearedBeforeKey/filterClearedRows 是死代码）。
    localStorage.setItem(clearedBeforeKey('userOps'), String(Date.now()));
    dangerConfirm.value = '';
    await refreshCounts();
    toast(t('views.export.wipeOpsDone'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}
async function wipePrivacy() {
  if (dangerConfirm.value !== '清空隐私') return toast(t('views.export.wipePrivacyPrompt'), 'warn');
  try {
    await db.privacyRecords.clear();
    // F10：同上，写水位防隐私数据从同步回流
    localStorage.setItem(clearedBeforeKey('privacyRecords'), String(Date.now()));
    dangerConfirm.value = '';
    await refreshCounts();
    toast(t('views.export.wipePrivacyDone'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}

const SORT_OPTIONS = computed(() => [
  { id: 'updated', label: t('views.export.sortUpdated') },
  { id: 'created', label: t('views.export.sortCreated') },
  { id: 'subject', label: t('views.export.sortSubject') },
  { id: 'level', label: t('views.export.sortLevel') },
  { id: 'due', label: t('views.export.sortDue') },
]);

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
    .replace(/!\[[^\]]*\]\([^)]*\)/g, t('views.export.imgShort'))
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
  if (subjectSel.value.length) parts.push(t('views.export.scopeSubject', '科目={v}', { v: subjectSel.value.join('+') }));
  if (tagNames.value.length) parts.push(t('views.export.scopeTag', '标签[{logic}]={v}', { logic: logic.value, v: tagNames.value.join(',') }));
  if (q.value.trim()) parts.push(t('views.export.scopeSearch', '搜索={v}', { v: q.value.trim() }));
  if (checkedIds.value.length) parts.push(t('views.export.scopeManual', '手选={n}张', { n: checkedIds.value.length }));
  if (!parts.length) parts.push(t('views.export.scopeAll'));
  return parts.join('；') + (mode.value === 'incremental' ? t('views.export.scopeIncremental') : '');
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
      return toast(mode.value === 'incremental' ? t('views.export.noNewSince') : t('views.export.noCardsMatched'), 'error');
    }
    printCards.value = cards;
    scopeDesc.value = buildDesc();
    previewOpen.value = true;
    await nextTick();
  } catch (e) { toast(e.message, 'error'); }
}

function doPrint() {
  // round18 R18-8（P3）：onAfterPrint 写好了却从未接线 —— 「增量导出」水位 lastExport
  // 永不推进 → 该模式按钮因 :disabled="!lastExport" 永久置灰，"上次导出时间"也永不显示。
  // afterprint 在打印对话框关闭后触发（含取消，口径取「本次打印已消费」的简化版；
  // 若追求「取消不记」，需接入 onbeforeprint/onafterprint 配对判断，收益不大）。
  window.addEventListener('afterprint', onAfterPrint, { once: true });
  window.print();
}

async function doCsv() {
  try { await downloadCsv(); toast(t('views.export.csvDone'), 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

// P3-1 Anki 互操作导出：导出为 Anki 友好的 TSV（带 #tags column 配置，Anki 导入自动带标签）
// 优先导出勾选的卡片，无勾选则导出当前筛选结果
async function doAnki() {
  try {
    const cards = checkedIds.value.length
      ? candidates.value.filter(c => checkedIds.value.includes(c.id))
      : candidates.value;
    if (!cards.length) { toast(t('views.export.noCardsInRange'), 'error'); return; }
    await downloadAnkiText(cards);
    try { T.exportRun('anki', cards.length); } catch {}
    toast(t('views.export.exportedAnki', '已导出 {n} 张为 Anki TSV（带标签列），Anki 桌面版「导入 → 文本文件」直接可用', { n: cards.length }), 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// 导出 Markdown 文件（按科目分组 Q/A，配合知识库使用）
function doMarkdown() {
  const cards = selectedCards();
  if (!cards.length) { toast(t('views.export.noCardsToExport'), 'error'); return; }
  const L = [];
  L.push('# ' + t('views.export.subtitle'));
  L.push('');
  L.push(`> ${t('views.export.exportDateLabel', '导出日期：{date}', { date: exportDate.value })} · ${t('views.export.totalCardsLabel', '卡片总数：{n} 张', { n: cards.length })} · ${scopeDesc.value}`);
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
      L.push(hideAnswer.value ? `**A** _${t('views.export.answerHidden', '（答案已隐藏 · 自测模式）')}_` : `**A** ${c.back}`);
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
  // round17 R17-37：延迟释放（Firefox 等偶发下载失败/空文件）
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(t('views.export.exportedMarkdown', '已导出 {n} 张卡片为 Markdown 文件', { n: cards.length }), 'success');
}

async function onAfterPrint() {
  if (!previewOpen.value) return;
  lastExport.value = { exportedAt: Date.now(), count: printCards.value.length, scope: scopeDesc.value };
  localStorage.setItem('sxy_last_export', JSON.stringify(lastExport.value));
  toast(t('views.export.exportedPrint', '已导出 {n} 张卡片，可在打印对话框选择「另存为 PDF」', { n: printCards.value.length }), 'success');
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
  if (!cards.length) { toast(t('views.export.noShareCards'), 'error'); return; }
  shareMode.value = 'generate';
  shareOpen.value = true;
  shareCode.value = '';
  shareBusy.value = true;
  try {
    const code = await encodeShareCode(cards, { scope: buildDesc() });
    shareCode.value = code;
    toast(t('views.export.shareGenDone', '已生成分享码（{n} 张，约 {size} KB）', { n: cards.length, size: estimateSize(cards) }), 'success');
  } catch (e) { toast(t('views.export.shareGenFail', '生成失败：{msg}', { msg: e.message }), 'error'); }
  finally { shareBusy.value = false; }
}

async function copyShareCode() {
  if (!shareCode.value) return;
  try {
    await navigator.clipboard.writeText(shareCode.value);
    toast(t('views.export.shareCopied'), 'success');
  } catch { toast(t('views.export.clipboardUnavailable'), 'info'); }
}

function openShareImport() {
  shareMode.value = 'import';
  shareOpen.value = true;
  importCode.value = '';
  importPreview.value = null;
}

async function previewImport() {
  if (!importCode.value.trim()) { toast(t('views.export.pasteShare'), 'error'); return; }
  if (shareBusy.value) return;
  shareBusy.value = true;
  try {
    const r = await decodeShareCode(importCode.value);
    importPreview.value = r;
    toast(t('views.export.parseSuccess', '解析成功：{n} 张卡片', { n: r.cards.length }) + (r.scope ? t('views.export.parseSuccessScope', '·范围 {scope}', { scope: r.scope }) : ''), 'success');
  } catch (e) {
    toast(t('views.export.parseFail', '解析失败：{msg}', { msg: e.message }), 'error');
    importPreview.value = null;
  } finally { shareBusy.value = false; }
}

async function doImport() {
  if (!importPreview.value?.cards?.length) { toast(t('views.export.parseFirst'), 'error'); return; }
  if (shareBusy.value) return;
  shareBusy.value = true;
  let n = 0, fail = 0, firstErr = '';
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
      } catch (err) {
        // round18 R18-13：记下首条失败原因，最后如实汇报（此前 catch 后只数数，toast 恒 success）
        fail++;
        if (!firstErr) firstErr = `${String(c.front || '').slice(0, 40)}：${err?.message || err}`;
      }
    }
    toast(t('views.export.importedCards', undefined, { n, failPart: fail ? t('views.export.importedFailPart', undefined, { n: fail }) : '' })
      + (fail ? t('views.export.importedFailDetail', '；首条失败：{msg}', { msg: firstErr }) : ''), fail ? 'warning' : 'success');
    shareOpen.value = false;
    await loadMeta();
  } catch (e) { toast(t('views.export.importFail', '导入失败：{msg}', { msg: e.message }), 'error'); }
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
    toast(t('views.export.apkgParseSuccess', '解析成功：{n} 张卡片（下方预览前 8 张）', { n: r.count }), 'success');
  } catch (err) {
    toast(t('views.export.parseFail', '解析失败：{msg}', { msg: err?.message || err }), 'error');
    apkgPreview.value = null;
  } finally { apkgBusy.value = false; }
}
async function doApkgImport() {
  if (!apkgPreview.value?.cards?.length) { toast(t('views.export.pickApkgFirst'), 'error'); return; }
  if (apkgBusy.value) return;
  apkgBusy.value = true;
  let n = 0, fail = 0, firstErr = '';
  try {
    for (const c of apkgPreview.value.cards) {
      try {
        await createCard({
          front: c.front, back: c.back, subject: apkgSubject.value || '',
          tags: c.tags || [], type: 'basic', source: 'Anki 导入',
        });
        n++;
      } catch (err) {
        // round18 R18-13：与分享码导入同口径——失败不再静默、toast 降级为 warning 并附首条原因
        fail++;
        if (!firstErr) firstErr = `${String(c.front || '').slice(0, 40)}：${err?.message || err}`;
      }
    }
    toast(t('views.export.importedCards', undefined, { n, failPart: fail ? t('views.export.importedFailPart', undefined, { n: fail }) : '' })
      + (fail ? t('views.export.importedFailDetail', '；首条失败：{msg}', { msg: firstErr }) : ''), fail ? 'warning' : 'success');
    apkgOpen.value = false;
    await loadMeta();
  } catch (err) { toast(t('views.export.importFail', '导入失败：{msg}', { msg: err?.message || err }), 'error'); }
  finally { apkgBusy.value = false; }
}
</script>

<template>
  <div>
    <h2>{{ t('views.export.title') }}</h2>

    <!-- 筛选范围 -->
    <div class="panel no-print">
      <div class="field-label" style="margin-top:0">{{ t('views.export.subjectsLabel') }}</div>
      <div class="row">
        <button v-for="s in subjects" :key="s.name" class="chip"
                :class="{ on: subjectSel.includes(s.name) }" @click="toggleSubject(s.name)">
          {{ s.name }}<span v-if="s.count" class="n">{{ s.count }}</span>
        </button>
        <button v-if="subjectSel.length" class="chip" @click="subjectSel = []">{{ t('views.export.clearSubjects') }}</button>
      </div>

      <div class="field-label">{{ t('views.export.tagsLabel') }}</div>
      <div class="row">
        <button v-for="t in allTags" :key="t.name" class="chip"
                :class="{ on: tagNames.includes(t.name) }" @click="toggleTag(t.name)">
          {{ t.name }}<span class="n">{{ t.count }}</span>
        </button>
        <select v-if="tagNames.length" v-model="logic" class="input" style="width:auto">
          <option value="AND">{{ t('views.export.logicAnd') }}</option>
          <option value="OR">{{ t('views.export.logicOr') }}</option>
          <option value="NOT">{{ t('views.export.logicNot') }}</option>
        </select>
      </div>

      <div class="row" style="margin-bottom:0">
        <input v-model="q" class="input" style="max-width:240px" :placeholder="t('views.export.searchPlaceholder')" />
        <select v-model="sortBy" class="input" style="width:auto">
          <option v-for="o in SORT_OPTIONS" :key="o.id" :value="o.id">{{ t('views.export.sortPrefix', '排序：') }}{{ o.label }}</option>
        </select>
        <button class="chip" :class="{ on: mode === 'all' }" @click="mode = 'all'">{{ t('views.export.modeAll') }}</button>
        <button class="chip" :class="{ on: mode === 'incremental' }" @click="mode = 'incremental'"
                :disabled="!lastExport">{{ t('views.export.modeIncremental') }}</button>
      </div>
      <div v-if="lastExport" class="hint" style="margin-top:6px">
        {{ t('views.export.lastExportInfo', '上次导出：{time} · {count} 张 · {scope}', { time: fmtTime(lastExport.exportedAt), count: lastExport.count, scope: lastExport.scope }) }}
      </div>
    </div>

    <!-- 批量勾选清单 -->
    <div class="panel no-print" style="margin-top:14px">
      <div class="pick-bar">
        <div class="field-label" style="margin:0">{{ t('views.export.pickListLabel', '卡片勾选清单（{checked} / {total} 已选）', { checked: checkedCount, total: candidates.length }) }}</div>
        <div class="pick-actions">
          <button class="chip" @click="checkAll">{{ t('views.export.selectAll') }}</button>
          <button class="chip" @click="checkInvert">{{ t('views.export.invert') }}</button>
          <button class="chip" @click="checkClear">{{ t('views.export.clear') }}</button>
        </div>
      </div>
      <EmptyState v-if="!candidates.length" icon="🖨️" :title="t('views.export.emptyTitle')" :message="t('views.export.emptyMsg')" />
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
        {{ checkedCount ? t('views.export.genPreviewSelected', '生成 PDF 预览（已选 {n} 张）', { n: checkedCount }) : t('views.export.genPreviewAll', '生成 PDF 预览（全部 {n} 张）', { n: candidates.length }) }}
      </button>
      <button class="btn" @click="doCsv">{{ t('views.export.exportCsv') }}</button>
      <button class="btn" @click="doAnki" :title="t('views.export.exportAnkiTitle')">{{ t('views.export.exportAnki') }}</button>
      <button class="btn" @click="doMarkdown">{{ t('views.export.exportMarkdown') }}</button>
      <button class="btn" @click="openShareGen" :title="t('views.export.genShareCodeTitle')">{{ t('views.export.genShareCode') }}</button>
      <button class="btn" @click="openShareImport" :title="t('views.export.importShareCodeTitle')">{{ t('views.export.importShareCode') }}</button>
      <button class="btn" @click="openApkg" :title="t('views.export.importApkgTitle')">{{ t('views.export.importApkg') }}</button>
      <button class="chip" :class="{ on: hideAnswer }" @click="hideAnswer = !hideAnswer">
        {{ hideAnswer ? t('views.export.hideAnswerOn') : t('views.export.hideAnswerOff') }}
      </button>
    </div>

    <!-- 打印预览（格式保持优美版式不变） -->
    <teleport to="body">
      <div v-if="previewOpen" class="modal-mask" style="padding:20px">
        <div class="modal export-modal">
          <div class="no-print modal-bar">
            <h3 style="margin:0">{{ t('views.export.previewTitle', '打印预览（{n} 张）', { n: printCards.length }) }}</h3>
            <div>
              <button class="btn" @click="previewOpen = false">{{ t('views.export.previewClose') }}</button>
              <button class="btn primary" @click="doPrint">{{ t('views.export.previewPrint') }}</button>
            </div>
          </div>

          <div id="print-area" class="export-sheet">
            <div class="export-head">
              <div class="export-head-title">
                <div class="export-logo">SxyBrick</div>
                <div class="export-subtitle">{{ t('views.export.subtitle') }}</div>
              </div>
              <div class="export-head-meta">
                <div>{{ t('views.export.exportDateLabel', '导出日期：{date}', { date: exportDate }) }}</div>
                <div>{{ t('views.export.totalCardsLabel', '卡片总数：{n} 张', { n: printCards.length }) }}</div>
                <div>{{ t('views.export.scopeLabel', '范围：{scope}', { scope: scopeDesc }) }}</div>
              </div>
            </div>

            <div v-for="g in grouped" :key="g.name" class="export-group">
              <div class="group-title">
                <span class="group-bar"></span>
                <span class="group-name">{{ g.name }}</span>
                <span class="group-count">{{ t('views.export.unitCards', '{n} 张', { n: g.cards.length }) }}</span>
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
                  <div v-if="hideAnswer" class="answer-hidden">{{ t('views.export.answerHidden', '（答案已隐藏 · 自测模式）') }}</div>
                  <MarkdownRenderer v-else :content="c.back" />
                </div>
              </div>
            </div>

            <div class="export-foot">{{ t('views.export.footNote', '— SxyBrick 记忆卡片 · {date} —', { date: exportDate }) }}</div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- P3·#1 卡组分享码弹窗：生成 / 复制 / 粘贴 / 导入 -->
    <teleport to="body">
      <div v-if="shareOpen" class="modal-mask" @click.self="shareOpen = false">
        <div class="modal" style="max-width:620px">
          <h3 style="margin-top:0">{{ t('views.export.shareModalTitle') }}</h3>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="chip" :class="{ on: shareMode === 'generate' }" @click="shareMode = 'generate'">{{ t('views.export.shareGenTab') }}</button>
            <button class="chip" :class="{ on: shareMode === 'import' }" @click="shareMode = 'import'">{{ t('views.export.shareImportTab') }}</button>
          </div>

          <div v-if="shareMode === 'generate'">
            <p class="hint" style="margin:4px 0 8px">{{ t('views.export.shareGenHint') }}</p>
            <div v-if="shareBusy" class="hint" style="padding:12px;text-align:center">{{ t('views.export.generating') }}</div>
            <template v-else-if="shareCode">
              <textarea class="input" rows="6" readonly :value="shareCode" style="font-family:monospace;font-size:11px;word-break:break-all"></textarea>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn primary" @click="copyShareCode">{{ t('views.export.copyClipboard') }}</button>
                <button class="btn" @click="shareOpen = false">{{ t('views.export.previewClose') }}</button>
              </div>
            </template>
          </div>

          <div v-else>
            <p class="hint" style="margin:4px 0 8px">{{ t('views.export.shareImportHint') }}</p>
            <textarea v-model="importCode" class="input" rows="5" :placeholder="t('views.export.pastePlaceholder')" style="font-family:monospace;font-size:11px;word-break:break-all"></textarea>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn" :disabled="shareBusy || !importCode.trim()" @click="previewImport">{{ t('views.export.parsePreview') }}</button>
              <button v-if="importPreview" class="btn primary" :disabled="shareBusy" @click="doImport">{{ t('views.export.importN', '📥 导入 {n} 张', { n: importPreview.cards.length }) }}</button>
              <button class="btn" @click="shareOpen = false">{{ t('views.export.previewClose') }}</button>
            </div>
            <div v-if="importPreview" class="hint" style="margin-top:10px;padding:8px 10px;background:var(--code-bg);border-radius:6px">
              <div>{{ t('views.export.parsedSuccessN', '✅ 解析成功：{n} 张卡片', { n: importPreview.cards.length }) }}</div>
              <div v-if="importPreview.scope">{{ t('views.export.importScope', '范围：{scope}', { scope: importPreview.scope }) }}</div>
              <div v-if="importPreview.exportedAt">{{ t('views.export.exportedAt', '导出于：{time}', { time: fmtTime(importPreview.exportedAt) }) }}</div>
              <div style="margin-top:6px;max-height:120px;overflow-y:auto">
                <div v-for="(c, i) in importPreview.cards.slice(0, 5)" :key="i" style="font-size:12px;padding:2px 0">
                  · {{ (c.subject || '未分类') }} — {{ String(c.front).slice(0, 40) }}
                </div>
                <div v-if="importPreview.cards.length > 5" style="font-size:11px;color:var(--ink-2)">{{ t('views.export.moreN', '… 还有 {n} 张', { n: importPreview.cards.length - 5 }) }}</div>
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
          <h3 style="margin-top:0">{{ t('views.export.apkgModalTitle') }}</h3>
          <p class="hint" style="margin:4px 0 8px">
            {{ t('views.export.apkgHint') }}
          </p>
          <button class="btn" :disabled="apkgBusy" @click="pickApkg">{{ apkgBusy ? t('views.export.parsing') : t('views.export.pickApkg') }}</button>

          <div v-if="apkgPreview" style="margin-top:12px">
            <div class="hint" style="padding:8px 10px;background:var(--code-bg);border-radius:6px">
              <div>{{ t('views.export.apkgParsedSuccess', '✅ 解析成功：{n} 张卡片（下方预览前 8 张）', { n: apkgPreview.count }) }}</div>
            </div>
            <div style="margin-top:10px">
              <label class="field-label">{{ t('views.export.importToSubject') }}</label>
              <select v-model="apkgSubject" class="input" style="width:100%;max-width:260px">
                <option value="">{{ t('views.export.uncategorized') }}</option>
                <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
              </select>
            </div>
            <div style="margin-top:8px;max-height:140px;overflow-y:auto">
              <div v-for="(c, i) in apkgPreview.cards.slice(0, 8)" :key="i" style="font-size:12px;padding:3px 0;border-bottom:1px dashed var(--line)">
                · {{ String(c.front).slice(0, 50) }} <span v-if="c.tags?.length" class="hint">[{{ c.tags.join(' ') }}]</span>
              </div>
              <div v-if="apkgPreview.count > 8" class="hint" style="font-size:11px;padding:4px 0">{{ t('views.export.moreN', '… 还有 {n} 张', { n: apkgPreview.count - 8 }) }}</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn primary" :disabled="apkgBusy" @click="doApkgImport">{{ t('views.export.importN', '📥 导入 {n} 张', { n: apkgPreview.count }) }}</button>
              <button class="btn" @click="apkgOpen = false">{{ t('views.export.previewClose') }}</button>
            </div>
          </div>
          <div v-else-if="!apkgBusy" class="hint" style="margin-top:12px">{{ t('views.export.noFileSelected') }}</div>
        </div>
      </div>
    </teleport>

    <!-- ————— P1·9 新增：全量同步包 / 埋点监控 / 隐私人生数据 导出面板 ————— -->
    <div class="panel no-print" style="margin-top:18px;border-color:var(--accent)">
      <h3 style="margin:0 0 12px">{{ t('views.export.systemExportTitle') }}</h3>
      <div class="hint" style="margin-bottom:10px">
        {{ t('views.export.systemExportHint') }}
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
          {{ backupBusy ? t('views.export.packing') : t('views.export.fullBackupBtn') }}
        </button>
        <!-- M14：加密备份——离设备文件不带明文（隐私记录含位置/睡眠/财务等 PIPL 敏感项） -->
        <button class="btn" :disabled="backupBusy" @click="doEncryptedBackup" :title="t('views.export.encBackupTitle')">
          {{ t('views.export.encBackupBtn') }}
        </button>
        <button class="chip" @click="refreshCounts">{{ t('views.export.refreshStats') }}</button>
      </div>
    </div>

    <div class="panel no-print" style="margin-top:14px">
      <h3 style="margin:0 0 10px">{{ t('views.export.userOpsTitle') }}</h3>
      <div class="row">
        <span class="field-label" style="margin:0">{{ t('views.export.rangeLabel') }}</span>
        <select v-model="exportOpsRange" class="input" style="width:auto">
          <option value="7">{{ t('views.export.range7') }}</option>
          <option value="30">{{ t('views.export.range30') }}</option>
          <option value="90">{{ t('views.export.range90') }}</option>
          <option value="all">{{ t('views.export.rangeAll') }}</option>
        </select>
        <span class="field-label" style="margin:0">{{ t('views.export.granularity') }}</span>
        <button class="chip" :class="{ on: exportOpsMode === 'full' }" @click="exportOpsMode = 'full'">{{ t('views.export.opsFull') }}</button>
        <button class="chip" :class="{ on: exportOpsMode === 'aggregate' }" @click="exportOpsMode = 'aggregate'">{{ t('views.export.opsAggregate') }}</button>
        <button class="btn" @click="doExportUserOps">{{ t('views.export.exportUserOps') }}</button>
      </div>
      <div class="hint" style="margin:8px 0 0">
        {{ t('views.export.opsHint') }}
      </div>
    </div>

    <div class="panel no-print" style="margin-top:14px">
      <h3 style="margin:0 0 10px">{{ t('views.export.privacyTitle') }}</h3>
      <div class="row">
        <span class="field-label" style="margin:0">{{ t('views.export.rangeLabel') }}</span>
        <select v-model="privacyExportRange" class="input" style="width:auto">
          <option value="7">{{ t('views.export.range7') }}</option>
          <option value="30">{{ t('views.export.range30') }}</option>
          <option value="90">{{ t('views.export.range90') }}</option>
          <option value="all">{{ t('views.export.rangeAll') }}</option>
        </select>
        <button class="btn" @click="doExportPrivacy">{{ t('views.export.exportPrivacy') }}</button>
      </div>
      <div class="hint" style="margin:8px 0 0">
        {{ t('views.export.privacyHint') }}
      </div>
    </div>

    <div class="panel no-print" style="margin-top:14px;border-color:#e11d48;background:linear-gradient(180deg,#fff1f2,var(--panel))">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">{{ t('views.export.dangerTitle') }}</h3>
        <button class="btn small" @click="dangerOpen = !dangerOpen">
          {{ dangerOpen ? t('views.export.dangerCollapse') : t('views.export.dangerExpand') }}
        </button>
      </div>
      <div v-if="dangerOpen" style="margin-top:12px">
        <div class="hint" style="margin-bottom:8px">
          {{ t('views.export.dangerHint') }}
        </div>
        <div class="row">
          <input v-model="dangerConfirm" class="input" style="max-width:260px"
                 :placeholder="t('views.export.dangerPlaceholder')" />
          <button class="btn" style="background:#e11d48;color:#fff;border-color:#be123c" @click="wipeUserOps">{{ t('views.export.wipeOpsBtn') }}</button>
          <button class="btn" style="background:#9f1239;color:#fff;border-color:#881337" @click="wipePrivacy">{{ t('views.export.wipePrivacyBtn') }}</button>
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
