<script setup>
// 数据同步：手动导出/导入（数据包文件）+ 局域网一键同步（电脑端中枢）
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import { downloadBackup, importBackup, previewImport, syncWithHub, countData, downloadSubjectBackup, downloadAnkiText, parseAnkiLines, buildBackup, saveSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, buildIncrementalBackup, backupScope } from '../sync.js';
import { useAppModeStore } from '../stores/appMode.js';
import { getSubjects, createCard } from '../repo.js';
import { getErrors, clearErrors } from '../utils/errorLog.js';
import { verifyToken, createGistBackup, updateGistBackup, fetchGistBackup } from '../utils/gistBackup.js';
import { T } from '../utils/telemetry.js';
import { buildAuthHeaders } from '../utils/hub-auth.js';
import EmptyState from '../components/EmptyState.vue';
// M5 同步状态面板：各模块 成功/待同步/失败/未配置 + 条数 + 最后同步时间 + 重试
import { getModuleStatus, recordAllModulesOk, recordAllModulesError, recordModuleResult, resetStatus, summarizeStatus, MODULE_LABELS } from '../sync-status.js';
import { getEffectiveSyncTables } from '../sync.js';
import { t } from '../i18n/index.js';
import { fmtLocaleDateTime } from '../utils/locale-date.js';

const counts = ref({ cards: 0, reviews: 0, images: 0, aiChats: 0, aiMemories: 0, memos: 0, plans: 0, graphEdges: 0, docs: 0, pomoSessions: 0, mindmaps: 0, weeklyReports: 0, achievements: 0, exams: 0 });
// GH Pages 上 location.origin 是 https://xxx.github.io 且没有 /backup 接口，不能作为 Hub 默认地址。
// 如果用户没手动填过 Hub，这里不默认使用 location.origin，避免误操作 Fail to fetch。
// 注意：Vue SFC 模板里无法直接访问全局 location，模板要用的属性必须显式暴露为顶层变量。
const isOnGhPages = /\.github\.io$|pages\.dev|vercel\.app|netlify\.app/.test(location.hostname);
const isHttps = location.protocol === 'https:';
const defaultHub = isOnGhPages ? '' : (isHttps ? '' : location.origin);
const hubUrl = ref(localStorage.getItem('sxy_hub') || defaultHub);
const hubToken = ref(localStorage.getItem('sxy_hub_token') || '');
const fileInput = ref(null);
const syncing = ref(false);
const testingHub = ref(false);
const loading = ref(true); // P2-30 初始数据加载态（避免界面假死）
const hubStatus = ref(null); // { ok, tips, tokenOk, error }
const importing = ref(false);
// P2-23 导入去重预览：选文件后先算分类，确认后才真正写入
const importPreview = ref(null);
const pendingBackup = ref(null);
const previewTables = computed(() => (importPreview.value?.tables || []).filter(t => t.added || t.overwritten || t.skipped || t.duplicated || t.deleted));
const lastBackup = ref(null);
const lastReport = ref(JSON.parse(localStorage.getItem('sxy_last_sync_report') || 'null'));
const errors = ref([]);
async function loadErrors() { errors.value = await getErrors(30); }
async function clearErrs() { await clearErrors(); errors.value = []; toast(t('views.sync.errorsCleared'), 'success'); }

// ---------- P3-3 快照 / 回滚 / 冲突可视化 ----------
const snapshots = ref([]);
const lastConflicts = ref([]); // 上次导入返回的 stats.conflicts（在 UI 展示哪些字段被覆盖）
const showConflicts = ref(false);
const snapshotBusy = ref(false);
async function loadSnapshots() { try { snapshots.value = await listSnapshots(); } catch {} }
async function doManualSnapshot() {
  snapshotBusy.value = true;
  try {
    const snap = await saveSnapshot(t('views.sync.manualSnapLabel', '手动快照 · {time}', { time: fmtLocaleDateTime(Date.now()) }), 'manual');
    await loadSnapshots();
    const sizeText = snap.sizeBytes ? Math.round(snap.sizeBytes / 1024) + ' KB' : t('views.sync.snapData');
    toast(t('views.sync.snapCreated', '已创建快照（含 {size}，可在下方回滚）', { size: sizeText }), 'success');
  } catch (e) { toast(t('views.sync.createSnapFail', '创建快照失败：{msg}', { msg: e?.message || e }), 'error'); }
  finally { snapshotBusy.value = false; }
}
async function doRestore(id, label) {
  if (!(await confirmDialog(t('views.sync.confirmRestore', '确定回滚到该快照吗？\n\n{label}\n\n回滚后当前所有非图片数据会被该快照覆盖，请谨慎操作。', { label })))) return;
  snapshotBusy.value = true;
  try {
    // 回滚前再保存一次「回滚前自动快照」，避免回滚动作本身不可逆
    await saveSnapshot(t('views.sync.preRollbackSnapLabel', '回滚前自动快照 · {time}', { time: fmtLocaleDateTime(Date.now()) }), 'backup-before-import');
    const r = await restoreSnapshot(id);
    await loadCounts(); await loadSnapshots();
    toast(t('views.sync.restored', '已回滚到：{label}（{time}）', { label: r.label, time: fmt(r.restoredAt) }), 'success');
  } catch (e) { toast(t('views.sync.restoreFail', '回滚失败：{msg}', { msg: e?.message || e }), 'error'); }
  finally { snapshotBusy.value = false; }
}
async function doDeleteSnapshot(id) {
  if (!(await confirmDialog(t('views.sync.confirmDeleteSnap')))) return;
  try { await deleteSnapshot(id); await loadSnapshots(); toast(t('views.sync.snapDeleted'), 'success'); }
  catch (e) { toast(t('views.sync.deleteFail', '删除失败：{msg}', { msg: e?.message || e }), 'error'); }
}
function fmtSize(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function winnerLabel(w) {
  return w === 'incoming' ? t('views.sync.winIncoming') : w === 'local' ? t('views.sync.winLocal') : t('views.sync.winMixed');
}

// ---------- P3·#2 Gist 云备份 ----------
// M3：gist token 共用（同一 GitHub 账户），但 gistId 按数据域分开——
// real/test 各自独立 Gist，备份文件也在各自 Gist 内按 scope 命名，互不覆盖
const appMode = useAppModeStore();
const ghToken = ref(localStorage.getItem('sxy_gist_token') || '');
const gistIdKey = () => (backupScope() === 'test' ? 'sxy_gist_id_test' : 'sxy_gist_id');
const gistId = ref(localStorage.getItem(gistIdKey()) || '');
const ghLogin = ref(localStorage.getItem('sxy_gist_login') || '');
const gistBusy = ref(false);
const gistOpen = ref(false);

function saveGistCfg() {
  localStorage.setItem('sxy_gist_token', ghToken.value);
  localStorage.setItem(gistIdKey(), gistId.value);
  localStorage.setItem('sxy_gist_login', ghLogin.value);
}

async function verifyGhToken() {
  if (!ghToken.value) { toast(t('views.sync.fillToken'), 'error'); return; }
  if (gistBusy.value) return;
  gistBusy.value = true;
  try {
    const r = await verifyToken(ghToken.value);
    ghLogin.value = r.login;
    saveGistCfg();
    toast(t('views.sync.tokenValid', '✅ Token 有效，账号：{login}', { login: r.login }), 'success');
  } catch (e) { toast(t('views.sync.tokenVerifyFail', 'Token 校验失败：{msg}', { msg: e.message }), 'error'); }
  finally { gistBusy.value = false; }
}

async function uploadToGist() {
  if (!ghToken.value) { toast(t('views.sync.fillTokenVerify'), 'error'); return; }
  if (gistBusy.value) return;
  gistBusy.value = true;
  try {
    const payload = await buildBackup();
    const modeText = appMode.isTest ? t('views.sync.demoData') : t('views.sync.realData');
    if (gistId.value) {
      // 已有 gist：PATCH 更新（payload.scope 决定写入哪个文件名）
      const r = await updateGistBackup(ghToken.value, gistId.value, payload);
      toast(t('views.sync.gistUpdated', '✅ 已更新 Gist 备份（{cards} 张卡 · {mode} · 更新于 {time}）', { cards: counts.value.cards, mode: modeText, time: fmtLocaleDateTime(r.updatedAt) }), 'success');
    } else {
      // 首次：创建新 secret gist
      const r = await createGistBackup(ghToken.value, payload);
      gistId.value = r.gistId;
      saveGistCfg();
      toast(t('views.sync.gistFirst', '✅ 首次云备份完成（{cards} 张卡 · {mode} · Gist ID 已保存）', { cards: counts.value.cards, mode: modeText }), 'success');
    }
    // M5：gist 推送 = 全模块推送成功（buildBackup 为全量包）
    const rows = {};
    for (const t of getEffectiveSyncTables()) rows[t.table] = payload[t.table]?.length || 0;
    recordAllModulesOk(rows);
  } catch (e) {
    toast(t('views.sync.uploadFail', '上传失败：{msg}', { msg: e.message }), 'error');
    recordAllModulesError(e.message || String(e));
  }
  finally {
    gistBusy.value = false;
    await loadModuleStatus(); // M5
  }
}

async function pullFromGist() {
  if (!ghToken.value || !gistId.value) { toast(t('views.sync.fillTokenGist'), 'error'); return; }
  if (gistBusy.value) return;
  if (!(await confirmDialog(t('views.sync.confirmPullGist')))) return;
  gistBusy.value = true;
  try {
    const payload = await fetchGistBackup(ghToken.value, gistId.value, { scope: backupScope() });
    // M3 scope 校验：包内 scope 必须与当前数据域一致，防止演示包混入真实数据（反之亦然）
    if (payload.scope && payload.scope !== backupScope()) {
      toast(t('views.sync.scopeMismatch', '数据域不匹配：该 Gist 存的是「{remote}」数据，当前是「{local}」模式', {
        remote: payload.scope === 'test' ? t('views.sync.scopeTest') : t('views.sync.scopeReal'),
        local: backupScope() === 'test' ? t('views.sync.scopeTest') : t('views.sync.scopeReal'),
      }), 'error');
      return;
    }
    const stats = await importBackup(payload, 'merge');
    saveReport('gist-pull', stats);
    await loadCounts();
    // M5：gist 拉取 = 全部模块拉取完成（本地变更仍需下次推送，面板按 maxTs 判定待同步）
    const rows = {};
    for (const t of getEffectiveSyncTables()) rows[t.table] = stats[t.table] || 0;
    recordAllModulesOk(rows);
    toast(t('views.sync.gistPulled', '✅ 已从 Gist 拉取并合并：{stats}', { stats: fmtStats(stats) }), 'success');
  } catch (e) { toast(t('views.sync.pullFail', '拉取失败：{msg}', { msg: e.message }), 'error'); }
  finally {
    gistBusy.value = false;
    await loadModuleStatus(); // M5
  }
}

async function resetGist() {
  if (!(await confirmDialog(t('views.sync.confirmResetGist')))) return;
  ghToken.value = ''; gistId.value = ''; ghLogin.value = '';
  localStorage.removeItem('sxy_gist_token');
  localStorage.removeItem(gistIdKey());
  localStorage.removeItem(gistIdKey() === 'sxy_gist_id' ? 'sxy_gist_id_test' : 'sxy_gist_id');
  localStorage.removeItem('sxy_gist_login');
  toast(t('views.sync.gistCfgCleared'), 'info');
}

function saveReport(mode, stats) {
  lastReport.value = { at: Date.now(), mode, stats };
  localStorage.setItem('sxy_last_sync_report', JSON.stringify(lastReport.value));
}

async function loadCounts() {
  counts.value = await countData();
}

function fmt(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtStats(stats) {
  const S = (k, fb, v) => t('views.sync.stats.' + k, fb, { n: v });
  const parts = [S('cards', '卡片 +{n}', stats.cards || 0)];
  if (stats.overridden) parts.push(S('updated', '更新 {n}', stats.overridden));
  if (stats.deleted) parts.push(S('deleted', '删除 {n}', stats.deleted));
  if (stats.duplicated) parts.push(S('duplicated', '去重跳过 {n}', stats.duplicated));
  parts.push(S('reviews', '复习 +{n}', stats.reviews || 0), S('images', '图片 +{n}', stats.images || 0));
  const extra = [
    ['aiChats', 'aiChats'], ['aiMemories', 'aiMemories'], ['memos', 'memos'], ['plans', 'plans'],
    ['graphEdges', 'graphEdges'], ['docs', 'docs'], ['pomoSessions', 'pomoSessions'],
    ['mindmaps', 'mindmaps'], ['weeklyReports', 'weeklyReports'], ['achievements', 'achievements'], ['exams', 'exams'],
  ];
  for (const [k, dk] of extra) if (stats[k]) parts.push(S(dk, dk + ' +{n}', stats[k]));
  return parts.join(t('views.sync.stats.join', '，'));
}

async function doExport() {
  try {
    await downloadBackup();
    lastBackup.value = { at: Date.now() };
    localStorage.setItem('sxy_last_backup', JSON.stringify(lastBackup.value));
    toast(t('views.sync.backupExported'), 'success');
    await refreshStatus(); // M5：导出后通道状态变化（备份通道已配置）
  } catch (e) { toast(e.message, 'error'); }
}

function pickFile() { fileInput.value?.click(); }

async function onFile(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  importing.value = true;
  try {
    const backup = JSON.parse(await f.text());
    // P2-23：先 dry-run 预览（新增/覆盖/跳过/重复/墓碑删除），确认后再写库
    const pv = await previewImport(backup);
    if (!pv.valid) { toast(pv.error || t('views.sync.fileInvalid'), 'error'); return; }
    pendingBackup.value = backup;
    importPreview.value = pv;
  } catch (err) {
    toast(err.message || t('views.sync.parseFileFail'), 'error');
  } finally { importing.value = false; }
}

// P2-23 确认导入：真正执行 importBackup（内部已自动建快照，可回滚）
async function confirmImport() {
  if (!pendingBackup.value) return;
  importing.value = true;
  try {
    const backup = pendingBackup.value;
    const stats = await importBackup(backup);
    await loadCounts();
    await loadSnapshots(); // P3-3 导入会自动创建快照，刷新列表
    saveReport('导入数据包', stats);
    await loadModuleStatus(); // M5：导入后刷新「待同步」判定（远端数据已合并到本地）
    // P3-3 冲突可视化：若有字段被覆盖，提示用户可查看明细
    lastConflicts.value = stats.conflicts || [];
    showConflicts.value = lastConflicts.value.length > 0;
    const meta = backup.deckMeta;
    const metaText = meta?.author ? t('views.sync.deckAuthor', '（卡组作者：{author}{desc}）', { author: meta.author, desc: meta.description ? ' · ' + meta.description.slice(0, 40) : '' }) : '';
    const conflictText = lastConflicts.value.length ? t('views.sync.conflictSuffix', '，{n} 张卡片有字段被覆盖', { n: lastConflicts.value.length }) : '';
    const snapText = stats.snapshotId ? t('views.sync.snapAutoHint') : '';
    toast(t('views.sync.importDone', '导入完成：{stats}{meta}{conflict}{snap}', { stats: fmtStats(stats), meta: metaText, conflict: conflictText, snap: snapText }), 'success');
    importPreview.value = null;
    pendingBackup.value = null;
  } catch (err) {
    toast(err.message || t('views.sync.importFailFile'), 'error');
  } finally { importing.value = false; }
}

function cancelImport() {
  importPreview.value = null;
  pendingBackup.value = null;
}

function saveHub() {
  localStorage.setItem('sxy_hub', hubUrl.value);
  localStorage.setItem('sxy_hub_token', hubToken.value);
  hubStatus.value = null;
  toast(t('views.sync.hubSaved'), 'success');
}

// 常见错误原因诊断（Fail to fetch / CORS / 混合内容）
function diagnoseFetchError(msg, url) {
  const text = String(msg || '').toLowerCase();
  const hints = [];
  try {
    if (url && location.protocol === 'https:' && /^http:\/\//i.test(url)) {
      hints.push(t('views.sync.diagHttps'));
      hints.push(t('views.sync.diagHttpsFix'));
    }
    if (/failed to fetch|networkerror|网络错误|typeerror: failed/.test(text)) {
      hints.push(t('views.sync.diagOther'));
      hints.push(t('views.sync.diagHubNotStarted'));
      hints.push(t('views.sync.diagFirewall'));
      hints.push(t('views.sync.diagUsb'));
    }
    if (/401|密码|token|unauthorized/.test(text)) hints.push(t('views.sync.diagToken'));
    if (/404|not found/.test(text)) hints.push(t('views.sync.diag404'));
  } catch {}
  return hints;
}

async function testHub() {
  const hub = String(hubUrl.value || '').replace(/\/+$/, '');
  if (!hub) { toast(t('views.sync.fillHub'), 'warn'); return; }
  testingHub.value = true;
  hubStatus.value = null;
  try {
    // 先探活（/health 不含任何口令信息，无法被用作穷举预言机）
    const res = await fetch(`${hub}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`Hub 返回 HTTP ${res.status}`);
    const j = await res.json();
    const tips = j.tips || [];
    // 再验证密码：用 HMAC 挑战-响应，密码本身不上网；挑战一次性且有有效期
    // M3：探测路径按数据域走 /backup/{scope}（与 doSync 同路径，中枢独立数据文件）
    const scopePath = `/backup/${backupScope()}`;
    let tokenOk = null; // null = 未验证（没填密码或协议不支持）
    if (hubToken.value) {
      const authHeaders = await buildAuthHeaders({ hub, token: hubToken.value, method: 'GET', path: scopePath })
        || { 'x-sync-token': hubToken.value };
      const vr = await fetch(`${hub}${scopePath}`, { method: 'GET', headers: { ...authHeaders } });
      tokenOk = vr.ok;
      if (vr.status === 401) {
        const d = await vr.json().catch(() => ({}));
        tips.unshift(t('views.sync.pwdFailPrefix', '密码校验未通过：{msg}', { msg: d?.error || t('views.sync.pwdFailDefault') }));
      }
    }
    hubStatus.value = { ok: true, tokenOk, tips };
    const msg = tokenOk === null
      ? t('views.sync.hubConnNoToken')
      : tokenOk ? t('views.sync.hubConnOk') : t('views.sync.hubConnFail');
    toast(msg, tokenOk === false ? 'warn' : 'success');
  } catch (e) {
    const hints = diagnoseFetchError(e.message, hub);
    hubStatus.value = { ok: false, error: String(e.message || e), hints };
    toast(t('views.sync.hubUnreachableToast', '无法访问 Hub：{msg}', { msg: e.message || e }), 'error');
  } finally { testingHub.value = false; }
}

async function doSync() {
  if (syncing.value) return;
  const hub = String(hubUrl.value || '').replace(/\/+$/, '');
  if (!hub) { toast(t('views.sync.fillHubSync'), 'warn'); return; }
  syncing.value = true;
  try {
    const stats = await syncWithHub(hub, hubToken.value);
    await loadCounts();
    saveReport('局域网一键同步', stats);
    try { T.syncRun('hub', true); } catch {}
    // M5：hub 同步成功 = 全部模块推送+拉取完成
    const rows = {};
    for (const t of getEffectiveSyncTables()) rows[t.table] = stats[t.table] || 0;
    recordAllModulesOk(rows);
    toast(t('views.sync.syncDone', '与电脑同步完成：{stats}', { stats: fmtStats(stats) }), 'success');
  } catch (e) {
    const base = e.message || String(e);
    try { T.syncRun('hub', false); } catch {}
    // M5：同步失败 → 全部模块记失败（保留各自错误原因，面板可重试）
    recordAllModulesError(base);
    const extras = diagnoseFetchError(base, hub);
    // 把诊断追加到 toast，详细诊断放错误日志便于排查
    const fullMsg = base + (extras.length ? '\n\n' + extras.join('\n') : '');
    toast(fullMsg, 'error');
    try {
      // 懒加载：避免顶层循环依赖
      const { logError } = await import('../utils/errorLog.js');
      await logError(new Error(base), { component: 'Sync.vue', route: '/sync', info: `hub=${hub} details=${JSON.stringify(extras).slice(0,250)}` });
    } catch {}
  } finally {
    syncing.value = false;
    await loadModuleStatus(); // M5：刷新状态判定
  }
}

function loadLastBackup() {
  try { lastBackup.value = JSON.parse(localStorage.getItem('sxy_last_backup') || 'null'); } catch {}
}

const subjects = ref([]);
const shareSubject = ref('');
const shareAuthor = ref('');
const shareDesc = ref('');
async function loadSubjects() { subjects.value = await getSubjects(); }
async function doShare() {
  try {
    await downloadSubjectBackup(shareSubject.value, { author: shareAuthor.value, description: shareDesc.value });
    toast(t('views.sync.deckExported'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Anki 互通（E2）：导出 Anki 文本 / 导入 Anki 文本建卡 ----
const ankiInput = ref(null);
const ankiBusy = ref(false);
async function doAnkiExport() {
  try { await downloadAnkiText(); toast(t('views.sync.ankiExported'), 'success'); }
  catch (e) { toast(e.message, 'error'); }
}
function pickAnki() { ankiInput.value?.click(); }
async function onAnkiFile(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  ankiBusy.value = true;
  try {
    const pairs = parseAnkiLines(await f.text());
    if (!pairs.length) { toast(t('views.sync.noAnkiRows'), 'error'); return; }
    let n = 0;
    for (const p of pairs) { await createCard({ front: p.front, back: p.back, subject: '', tags: [], type: 'basic', source: 'Anki 导入' }); n++; }
    await loadCounts();
    toast(t('views.sync.ankiImported', '已从 Anki 文本导入 {n} 张卡片', { n }), 'success');
  } catch (err) { toast(t('views.sync.importFail', '导入失败：{msg}', { msg: err.message || t('views.sync.ankiFileFormat') }), 'error'); }
  finally { ankiBusy.value = false; }
}

// ---------- M5 同步状态面板 ----------
const moduleStatus = ref([]);
const statusSummary = ref(null);
const syncingAll = ref(false);
const syncingModule = ref('');
function channelsConfigured() {
  return {
    hub: !!String(hubUrl.value || '').trim(),
    gist: !!(ghToken.value && gistId.value),
    backup: !!(lastBackup.value && lastBackup.value.at),
  };
}
async function loadModuleStatus() {
  try {
    moduleStatus.value = await getModuleStatus({ channels: channelsConfigured() });
    statusSummary.value = summarizeStatus(moduleStatus.value);
  } catch {}
}
function statusIcon(s) { return { ok: '✅', pending: '⏳', error: '❌', none: '⚪' }[s] || '⚪'; }
function statusLabel(s) { return { ok: t('views.sync.stOk'), pending: t('views.sync.stPending'), error: t('views.sync.stError'), none: t('views.sync.stNone') }[s] || s; }
function fmtTs(ts) { return ts ? fmt(ts) : '—'; }

/** 立即同步（全部模块）：有 hub 走 hub；否则引导配置 */
async function doSyncAll() {
  const hub = String(hubUrl.value || '').replace(/\/+$/, '');
  if (!hub) {
    toast(t('views.sync.noChannel'), 'warn');
    return;
  }
  syncingAll.value = true;
  try {
    const stats = await syncWithHub(hub, hubToken.value);
    // M5：hub 返回的是全量合并包 → 所有模块都已拉取更新；本地变更已全部推送
    const rows = {};
    for (const t of getEffectiveSyncTables()) rows[t.table] = stats[t.table] || 0;
    recordAllModulesOk(rows);
    await loadCounts();
    saveReport('立即同步（全部模块）', stats);
    try { T.syncRun('hub', true); } catch {}
    toast(t('views.sync.allModulesSynced', '✅ 全模块同步完成：{stats}', { stats: fmtStats(stats) }), 'success');
  } catch (e) {
    recordAllModulesError(e.message || String(e));
    toast(t('views.sync.syncFail', '同步失败：{msg}', { msg: e.message || e }), 'error');
  } finally {
    syncingAll.value = false;
    await loadModuleStatus();
  }
}

/** 单模块同步：只推送该模块增量；hub 返回全量包仍整体合并（= 全模块拉取），状态按「该模块推送成功」记录 */
async function doSyncModule(module) {
  const hub = String(hubUrl.value || '').replace(/\/+$/, '');
  if (!hub) { toast(t('views.sync.noChannelHub'), 'warn'); return; }
  if (syncingModule.value || syncingAll.value) return;
  syncingModule.value = module;
  try {
    const stats = await syncWithHub(hub, hubToken.value, { table: module });
    recordModuleResult(module, { ok: true, rows: stats[module] || 0 });
    // 其余模块：这次拉取也更新了它们 → 记成功（rows 取 stats）
    for (const t of getEffectiveSyncTables()) if (t.table !== module) recordModuleResult(t.table, { ok: true, rows: stats[t.table] || 0 });
    await loadCounts();
    toast(t('views.sync.moduleSyncDone', '✅ 「{label}」同步完成', { label: MODULE_LABELS[module] || module }), 'success');
  } catch (e) {
    recordModuleResult(module, { ok: false, error: e.message || String(e) });
    toast(t('views.sync.moduleSyncFail', '「{label}」同步失败：{msg}', { label: MODULE_LABELS[module] || module, msg: e.message || e }), 'error');
  } finally {
    syncingModule.value = '';
    await loadModuleStatus();
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([loadCounts(), loadLastBackup(), loadSubjects(), loadErrors(), loadSnapshots()]);
    await loadModuleStatus(); // M5 状态面板
  }
  finally { loading.value = false; }
});
// M5：每次同步动作（导出/导入/gist）后刷新状态判定（「待同步」= 有新变更未同步）
async function refreshStatus() { await loadModuleStatus(); }
</script>

<template>
  <div style="max-width:720px;margin:0 auto" v-loading="loading" :element-loading-text="t('views.sync.loading')">
    <h2 style="margin:0 0 4px">{{ t('views.sync.title') }}</h2>
    <div class="hint" style="margin-bottom:16px">
      {{ t('views.sync.localData', '本机数据：{cards} 卡片 · {reviews} 复习 · {images} 图片 · {aiChats} 对话 · {aiMemories} 记忆 · {memos} 备忘 · {plans} 计划 · {graphEdges} 图谱边 · {docs} 文档 · {pomoSessions} 专注 · {mindmaps} 导图 · {weeklyReports} 周报 · {achievements} 成就 · {exams} 模考', {
        cards: counts.cards, reviews: counts.reviews, images: counts.images, aiChats: counts.aiChats,
        aiMemories: counts.aiMemories, memos: counts.memos, plans: counts.plans, graphEdges: counts.graphEdges,
        docs: counts.docs, pomoSessions: counts.pomoSessions, mindmaps: counts.mindmaps,
        weeklyReports: counts.weeklyReports, achievements: counts.achievements, exams: counts.exams,
      }) }}
    </div>

    <!-- M5 同步状态面板：所有数据模块的同步状态一览（全覆盖，无遗漏表） -->
    <div class="panel">
      <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span>{{ t('views.sync.statusTitle') }}{{ appMode.isTest ? t('views.sync.statusTitleTest') : '' }}</span>
        <button class="btn primary" :disabled="syncingAll || syncingModule" @click="doSyncAll">
          {{ syncingAll ? t('views.sync.syncingAll') : t('views.sync.syncAllBtn') }}
        </button>
      </div>
      <div v-if="statusSummary" class="hint" style="margin-top:4px">
        {{ t('views.sync.unitModules', '{n} 个模块：', { n: statusSummary.total }) }}
        <span style="color:var(--green)">{{ t('views.sync.sumOk', '✅ 成功 {n}', { n: statusSummary.ok }) }}</span> ·
        <span style="color:var(--amber)">{{ t('views.sync.sumPending', '⏳ 待同步 {n}', { n: statusSummary.pending }) }}</span> ·
        <span style="color:var(--red)">{{ t('views.sync.sumError', '❌ 失败 {n}', { n: statusSummary.error }) }}</span> ·
        <span>{{ t('views.sync.sumNone', '⚪ 未配置 {n}', { n: statusSummary.none }) }}</span>
        <span v-if="appMode.isTest" style="color:var(--amber)">{{ t('views.sync.statusTestNote') }}</span>
      </div>
      <div v-if="!moduleStatus.some(m => m.status !== 'none')" class="hint" style="margin-top:8px">
        {{ t('views.sync.noChannelConfigured') }}
      </div>
      <table v-else class="status-table">
        <thead><tr><th>{{ t('views.sync.thModule') }}</th><th>{{ t('views.sync.thCount') }}</th><th>{{ t('views.sync.thLastSync') }}</th><th>{{ t('views.sync.thStatus') }}</th><th></th></tr></thead>
        <tbody>
          <tr v-for="m in moduleStatus" :key="m.module">
            <td>{{ m.label }}</td>
            <td class="num">{{ m.count }}</td>
            <td class="ts">{{ fmtTs(m.lastSyncAt) }}<span v-if="m.lastRows" class="hint">（+{{ m.lastRows }}）</span></td>
            <td><span class="st" :class="'st-' + m.status" :title="m.status === 'error' ? m.error : ''">{{ statusIcon(m.status) }} {{ statusLabel(m.status) }}</span></td>
            <td>
              <button v-if="m.status === 'error' || m.status === 'pending'" class="btn mini"
                      :disabled="syncingAll || syncingModule" @click="doSyncModule(m.module)"
                      :title="m.status === 'error' ? t('views.sync.retryTitle') : t('views.sync.syncNowTitle')">
                {{ syncingModule === m.module ? t('views.sync.syncing') : (m.status === 'error' ? t('views.sync.retry') : t('views.sync.syncBtn')) }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="hint" style="margin-top:8px">
        {{ t('views.sync.statusHint') }}
      </div>
    </div>

    <!-- 手动同步 -->
    <div class="panel">
      <div class="panel-title">{{ t('views.sync.manualTitle') }}</div>
      <p class="hint" style="margin-top:0">
        {{ t('views.sync.manualHint') }}
      </p>
      <div v-if="lastBackup" class="hint" style="margin-bottom:8px">{{ t('views.sync.lastBackup', '上次备份：{time}', { time: fmt(lastBackup.at) }) }}</div>
      <div v-else class="hint" style="margin-bottom:8px;color:var(--amber)">{{ t('views.sync.noBackupYet') }}</div>
      <div class="row">
        <button class="btn primary" @click="doExport">{{ t('views.sync.exportData') }}</button>
        <button class="btn" :disabled="importing" @click="pickFile">
          {{ importing ? t('views.sync.importing') : t('views.sync.importData') }}
        </button>
        <input ref="fileInput" type="file" accept=".json,application/json" style="display:none" @change="onFile" />
      </div>
      <div class="hint">{{ t('views.sync.mergeRule') }}</div>

      <!-- P2-23 导入去重预览：选文件后先预览，确认才写入 -->
      <div v-if="importPreview && importPreview.valid" class="preview-box">
        <div class="panel-title" style="margin-bottom:8px">{{ t('views.sync.importPreviewTitle') }}</div>
        <p class="hint" style="margin-top:0">
          {{ t('views.sync.previewSummary', '新增 {added} · 覆盖 {overwritten} · 跳过（已相同）{skipped} · 重复跳过 {duplicated} · 删除（墓碑）{deleted}', {
            added: importPreview.totalAdded, overwritten: importPreview.totalOverwritten,
            skipped: importPreview.totalSkipped, duplicated: importPreview.totalDuplicated, deleted: importPreview.totalDeleted,
          }) }}
        </p>
        <p v-if="importPreview.deckMeta" class="hint deck-meta">
          {{ t('views.sync.deckLabel') }}<b>{{ importPreview.deckMeta.author || t('views.sync.deckAnon') }}</b><template v-if="importPreview.deckMeta.description"> · {{ importPreview.deckMeta.description }}</template>
        </p>
        <div class="preview-list">
          <div v-for="t in previewTables" :key="t.table" class="preview-item">
            <div class="preview-label">{{ t.label }}</div>
            <div class="preview-nums">
              <span v-if="t.added" class="pn add">+{{ t.added }}</span>
              <span v-if="t.overwritten" class="pn ov">~{{ t.overwritten }}</span>
              <span v-if="t.skipped" class="pn skip">={{ t.skipped }}</span>
              <span v-if="t.duplicated" class="pn dup">⊘{{ t.duplicated }}</span>
              <span v-if="t.deleted" class="pn del">-{{ t.deleted }}</span>
            </div>
            <div class="preview-samples">
              <span v-for="(s, i) in t.samples" :key="i" class="ps" :class="'ps-' + s.status">{{ s.title }}</span>
            </div>
          </div>
        </div>
        <div class="row" style="margin-top:12px;margin-bottom:0">
          <button class="btn primary" :disabled="importing" @click="confirmImport">{{ t('views.sync.confirmImport') }}</button>
          <button class="btn" :disabled="importing" @click="cancelImport">{{ t('views.sync.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 最近一次同步/导入明细（E1 数字资产对账） -->
    <div v-if="lastReport" class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.sync.lastReportTitle', '最近一次{mode}明细（{time}）', { mode: lastReport.mode, time: fmt(lastReport.at) }) }}</div>
      <div class="sync-detail">
        <span class="sd-item">{{ t('views.sync.detailCards', '卡片新增 {n}', { n: lastReport.stats.cards || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailUpdated', '内容更新 {n}', { n: lastReport.stats.overridden || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailDeleted', '跨端删除 {n}', { n: lastReport.stats.deleted || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailDuplicated', '重复跳过 {n}', { n: lastReport.stats.duplicated || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailReviews', '复习记录 {n}', { n: lastReport.stats.reviews || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailImages', '图片 {n}', { n: lastReport.stats.images || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailChats', '对话 {n}', { n: lastReport.stats.aiChats || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailMemories', '记忆 {n}', { n: lastReport.stats.aiMemories || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailMemos', '备忘 {n}', { n: lastReport.stats.memos || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailPlans', '计划 {n}', { n: lastReport.stats.plans || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailGraph', '图谱 {n}', { n: lastReport.stats.graphEdges || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailDocs', '文档 {n}', { n: lastReport.stats.docs || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailPomo', '专注 {n}', { n: lastReport.stats.pomoSessions || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailMindmaps', '导图 {n}', { n: lastReport.stats.mindmaps || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailWeekly', '周报 {n}', { n: lastReport.stats.weeklyReports || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailAchievements', '成就 {n}', { n: lastReport.stats.achievements || 0 }) }}</span>
        <span class="sd-item">{{ t('views.sync.detailExams', '模考 {n}', { n: lastReport.stats.exams || 0 }) }}</span>
      </div>
    </div>

    <!-- P3-3 冲突可视化：哪些卡片的哪些字段被覆盖 -->
    <div v-if="showConflicts" class="panel" style="margin-top:16px">
      <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>{{ t('views.sync.conflictTitle', '字段冲突明细（{n} 张卡片有字段被覆盖）', { n: lastConflicts.length }) }}</span>
        <button class="btn small" @click="showConflicts = false">{{ t('views.sync.collapse') }}</button>
      </div>
      <p class="hint" style="margin-top:0">{{ t('views.sync.conflictHint') }}</p>
      <div v-if="lastConflicts.length > 50" class="hint" style="color:var(--ink-2)">{{ t('views.sync.conflictMore') }}</div>
      <div class="conflict-list">
        <div v-for="c in lastConflicts.slice(0, 50)" :key="c.id" class="conflict-item" :class="'win-' + c.winner">
          <div class="conflict-front">{{ c.front || t('views.sync.emptyCard') }}</div>
          <div class="conflict-meta">
            <span class="conflict-winner">{{ winnerLabel(c.winner) }}</span>
            <span class="conflict-fields">{{ c.fields.join(' / ') }}</span>
          </div>
          <div class="conflict-reason">{{ c.reason }}</div>
        </div>
      </div>
    </div>

    <!-- P3-3 历史快照 / 回滚 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>{{ t('views.sync.snapshotsTitle') }}</span>
        <button class="btn small" :disabled="snapshotBusy" @click="doManualSnapshot">{{ t('views.sync.createSnapshot') }}</button>
      </div>
      <p class="hint" style="margin-top:0">{{ t('views.sync.snapshotsHint') }}</p>
      <EmptyState v-if="!snapshots.length" compact icon="🗑️" :title="t('views.sync.snapEmptyTitle')" :message="t('views.sync.snapEmptyMsg')" />
      <div v-else class="snapshot-list">
        <div v-for="s in snapshots" :key="s.id" class="snapshot-item">
          <div class="snapshot-main">
            <div class="snapshot-label">{{ s.label || t('views.sync.unnamedSnapshot') }}</div>
            <div class="snapshot-meta">
              <span>{{ fmt(s.createdAt) }}</span>
              <span v-if="s.sizeBytes"> · {{ fmtSize(s.sizeBytes) }}</span>
              <span class="snapshot-kind">{{ s.kind === 'manual' ? t('views.sync.snapManual') : s.kind === 'auto-before-sync' ? t('views.sync.snapBeforeSync') : t('views.sync.snapBeforeImport') }}</span>
            </div>
          </div>
          <div class="snapshot-actions">
            <button class="btn small" :disabled="snapshotBusy" @click="doRestore(s.id, s.label || fmt(s.createdAt))">{{ t('views.sync.rollback') }}</button>
            <button class="btn small danger" :disabled="snapshotBusy" @click="doDeleteSnapshot(s.id)">{{ t('views.sync.delete') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分享卡组 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.sync.shareDeckTitle') }}</div>
      <p class="hint" style="margin-top:0">{{ t('views.sync.shareDeckHint') }}</p>
      <div class="row">
        <select v-model="shareSubject" class="input" style="max-width:240px">
          <option value="">{{ t('views.sync.selectSubject') }}</option>
          <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}（{{ s.count }}）</option>
        </select>
        <button class="btn" @click="doShare">{{ t('views.sync.exportSubject') }}</button>
      </div>
      <div class="row" style="margin-bottom:0">
        <input v-model="shareAuthor" class="input" style="max-width:180px" :placeholder="t('views.sync.authorPlaceholder')" />
        <input v-model="shareDesc" class="input" style="flex:1;max-width:340px" :placeholder="t('views.sync.descPlaceholder')" />
      </div>
    </div>

    <!-- Anki 互通（E2 数字资产流转） -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.sync.ankiTitle') }}</div>
      <p class="hint" style="margin-top:0">
        {{ t('views.sync.ankiHint') }}
      </p>
      <div class="row" style="margin-bottom:0">
        <button class="btn" @click="doAnkiExport">{{ t('views.sync.exportAnkiText') }}</button>
        <button class="btn" :disabled="ankiBusy" @click="pickAnki">{{ ankiBusy ? t('views.sync.importing') : t('views.sync.importAnkiText') }}</button>
        <input ref="ankiInput" type="file" accept=".txt,.tsv,.csv,text/plain" style="display:none" @change="onAnkiFile" />
      </div>
    </div>

    <!-- Gist 云备份（P3-B） -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.sync.gistTitle') }}</div>
      <p class="hint" style="margin-top:0">
        {{ t('views.sync.gistHint') }}
      </p>

      <div class="field-label" style="margin-top:0">{{ t('views.sync.gistTokenLabel') }}</div>
      <div class="row">
        <input v-model="ghToken" class="input" type="password" :placeholder="t('views.sync.gistTokenPlaceholder')" />
        <button class="btn small" :disabled="gistBusy" @click="verifyGhToken">{{ gistBusy ? t('views.sync.verifying') : t('views.sync.verify') }}</button>
      </div>
      <div v-if="ghLogin" class="hint" style="margin-bottom:8px;color:var(--green)">{{ t('views.sync.gistVerified', '✓ 已校验账号：{login}', { login: ghLogin }) }}</div>

      <div class="field-label" v-if="gistId">{{ t('views.sync.gistIdBound') }}</div>
      <div class="row" v-if="gistId">
        <input v-model="gistId" class="input" :readonly="!gistOpen" :placeholder="t('views.sync.gistIdPlaceholder')" />
        <button class="btn small" @click="gistOpen = !gistOpen">{{ gistOpen ? t('views.sync.lock') : t('views.sync.edit') }}</button>
      </div>

      <div class="row" style="margin-bottom:0">
        <button class="btn primary" :disabled="gistBusy" @click="uploadToGist">{{ gistBusy ? t('views.sync.processing') : (gistId ? t('views.sync.uploadUpdate') : t('views.sync.firstBackup')) }}</button>
        <button class="btn" :disabled="gistBusy || !gistId" @click="pullFromGist">{{ t('views.sync.pullGist') }}</button>
        <button class="btn small" style="color:var(--red)" @click="resetGist" v-if="ghToken || gistId">{{ t('views.sync.clearConfig') }}</button>
      </div>
      <div class="hint" style="margin-top:8px;margin-bottom:0">
        {{ t('views.sync.gistHint2') }}
      </div>
    </div>

    <!-- 局域网自动同步 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.sync.lanTitle') }}</div>
      <p class="hint" style="margin-top:0">
        {{ t('views.sync.lanHint') }}
      </p>

      <div v-if="isOnGhPages" class="hub-banner hub-warn">
        {{ t('views.sync.ghPagesWarn') }}
      </div>
      <div v-else-if="isHttps && hubUrl && /^http:\/\//i.test(hubUrl)" class="hub-banner hub-warn">
        {{ t('views.sync.httpsWarn') }}
      </div>

      <div class="field-label" style="margin-top:0">{{ t('views.sync.hubAddrLabel') }}</div>
      <div class="row">
        <input v-model="hubUrl" class="input" :placeholder="t('views.sync.hubAddrPlaceholder')" />
        <button class="btn small" :disabled="testingHub" @click="testHub">{{ testingHub ? t('views.sync.testing') : t('views.sync.testConn') }}</button>
        <button class="btn small" @click="saveHub">{{ t('views.sync.save') }}</button>
      </div>

      <div v-if="hubStatus" class="hub-status" :class="hubStatus.ok ? 'ok' : 'bad'">
        <template v-if="hubStatus.ok">
          {{ t('views.sync.hubReachable') }}{{
            hubStatus.tokenOk === null ? t('views.sync.hubNoToken')
            : hubStatus.tokenOk ? t('views.sync.hubTokenOk')
            : t('views.sync.hubTokenFail')
          }}
          <ul v-if="hubStatus.tips?.length" style="margin:6px 0 0 18px;padding:0"><li v-for="(t,i) in hubStatus.tips" :key="i" class="hint" style="font-size:12px">{{ t }}</li></ul>
        </template>
        <template v-else>
          {{ t('views.sync.hubUnreachable') }}<b>{{ hubStatus.error }}</b>
          <ul v-if="hubStatus.hints?.length" style="margin:6px 0 0 18px;padding:0"><li v-for="(h,i) in hubStatus.hints" :key="i" style="font-size:12px">{{ h }}</li></ul>
        </template>
      </div>

      <div class="field-label">{{ t('views.sync.hubPwdLabel') }}</div>
      <div class="row">
        <input v-model="hubToken" class="input" :placeholder="t('views.sync.hubPwdPlaceholder')" />
      </div>

      <button class="btn primary" style="width:100%" :disabled="syncing" @click="doSync">
        {{ syncing ? t('views.sync.syncing') : t('views.sync.syncWithPc') }}
      </button>

      <div class="hub-steps">
        <div class="step-title">{{ t('views.sync.stepTitle') }}</div>
        <ol>
          <li>{{ t('views.sync.step1') }}</li>
          <li>{{ t('views.sync.step2') }}</li>
          <li>{{ t('views.sync.step3') }}</li>
          <li>{{ t('views.sync.step4') }}</li>
        </ol>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">{{ t('views.sync.errLogTitle') }}</h3>
        <span class="hint">{{ t('views.sync.errCount', '{n} 条', { n: errors.length }) }}</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="loadErrors">{{ t('views.sync.refresh') }}</button>
        <button class="btn small" style="color:var(--red)" @click="clearErrs" v-if="errors.length">{{ t('views.sync.clearBtn') }}</button>
      </div>
      <p class="hint" style="margin:4px 0 8px">{{ t('views.sync.errLogHint') }}</p>
      <EmptyState v-if="!errors.length" compact icon="🐞" :title="t('views.sync.errEmptyTitle')" :message="t('views.sync.errEmptyMsg')" />
      <div v-for="e in errors" :key="e.id" class="err-row">
        <div class="err-head">
          <span class="err-sev" :class="e.severity">{{ e.severity }}</span>
          <span class="err-time">{{ fmt(e.createdAt) }}</span>
          <span class="err-ctx" v-if="e.ctx">{{ e.ctx }}</span>
        </div>
        <div class="err-msg">{{ e.message }}</div>
        <details v-if="e.stack"><summary class="hint">{{ t('views.sync.stack') }}</summary><pre class="err-stack">{{ e.stack }}</pre></details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.panel-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
/* M5 同步状态表：移动端压缩为紧凑布局 */
.status-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
.status-table th { text-align: left; color: var(--ink-2); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.status-table td { padding: 5px 8px; border-bottom: 1px dashed var(--line); }
.status-table .num { font-variant-numeric: tabular-nums; }
.status-table .ts { color: var(--ink-2); white-space: nowrap; }
.status-table .st { white-space: nowrap; }
.st-ok { color: var(--green); }
.st-pending { color: var(--amber); }
.st-error { color: var(--red); }
.st-none { color: var(--ink-2); }
@media (max-width: 600px) {
  .status-table th:nth-child(3), .status-table td:nth-child(3) { display: none; }
}
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 12px 0 6px; }
.hub-steps { margin-top: 16px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
.step-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.hub-steps ol { margin: 0; padding-left: 20px; font-size: 13px; color: var(--ink-2); }
.hub-steps code { background: var(--code-inline); border-radius: 4px; padding: 1px 5px; }
.sync-detail { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; }
.sd-item { font-size: 12px; color: var(--ink-2); }
.sd-item b { color: var(--ink); }
.err-row { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 12px; }
.err-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.err-sev { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
.err-sev.error { background: var(--red); color: #fff; }
.err-sev.warn { background: var(--accent); color: #fff; }
.err-time { color: var(--ink-2); }
.err-ctx { color: var(--ink-2); font-family: monospace; }
.err-msg { color: var(--ink); word-break: break-all; }
.err-stack { font-size: 10px; color: var(--ink-2); white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow: auto; margin: 4px 0 0; }
.hub-banner { padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.55; margin-bottom: 10px; }
.hub-warn { background: color-mix(in srgb, #f59e0b 15%, transparent); border: 1px solid color-mix(in srgb,#f59e0b 40%,transparent); color: var(--ink); }
.hub-status { margin-top: 8px; padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; }
.hub-status.ok { background: color-mix(in srgb, #10b981 14%, transparent); border: 1px solid color-mix(in srgb,#10b981 40%,transparent); }
.hub-status.bad { background: color-mix(in srgb, var(--red) 14%, transparent); border: 1px solid color-mix(in srgb,var(--red) 40%,transparent); }
/* P3-3 冲突可视化 */
.conflict-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.conflict-item { border: 1px solid var(--line); border-left: 4px solid var(--ink-2); border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.conflict-item.win-incoming { border-left-color: #3b82f6; }
.conflict-item.win-local { border-left-color: #10b981; }
.conflict-item.win-mixed { border-left-color: #f59e0b; }
.conflict-front { font-weight: 600; color: var(--ink); margin-bottom: 4px; word-break: break-all; }
.conflict-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.conflict-winner { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: var(--code-inline); font-weight: 600; }
.conflict-fields { font-family: monospace; color: var(--ink-2); }
.conflict-reason { color: var(--ink-2); margin-top: 4px; }
/* P3-3 快照列表 */
.snapshot-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.snapshot-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.snapshot-main { flex: 1; min-width: 0; }
.snapshot-label { font-size: 13px; font-weight: 600; color: var(--ink); word-break: break-all; }
.snapshot-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.snapshot-kind { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--code-inline); }
.snapshot-actions { display: flex; gap: 6px; flex-shrink: 0; }
.btn.danger { border-color: color-mix(in srgb, var(--red) 40%, var(--line)); color: var(--red); }
/* P2-23 导入去重预览 */
.preview-box { margin-top: 14px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
.preview-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.preview-item { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.preview-label { font-size: 13px; font-weight: 600; color: var(--ink); min-width: 84px; }
.preview-nums { display: flex; gap: 6px; flex-shrink: 0; }
.pn { font-size: 12px; padding: 2px 7px; border-radius: 6px; font-weight: 600; font-family: monospace; }
.pn.add { background: color-mix(in srgb, #10b981 16%, transparent); color: #047857; }
.pn.ov { background: color-mix(in srgb, #f59e0b 16%, transparent); color: #b45309; }
.pn.skip { background: var(--code-inline); color: var(--ink-2); }
.pn.dup { background: color-mix(in srgb, var(--ink-2) 12%, transparent); color: var(--ink-2); }
.pn.del { background: color-mix(in srgb, var(--red) 16%, transparent); color: #b91c1c; }
.preview-samples { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 160px; }
.ps { font-size: 11px; padding: 2px 7px; border-radius: 5px; background: var(--code-bg); color: var(--ink-2); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ps-new { border-left: 3px solid #10b981; }
.ps-overwrite { border-left: 3px solid #f59e0b; }
.deck-meta { margin-top: 6px !important; padding: 6px 10px; border-radius: 7px; background: color-mix(in srgb, var(--amber) 14%, var(--panel)); border: 1px solid color-mix(in srgb, var(--amber) 40%, var(--line)); }
</style>