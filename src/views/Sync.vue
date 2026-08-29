<script setup>
// 数据同步：手动导出/导入（数据包文件）+ 局域网一键同步（电脑端中枢）
import { confirmDialog } from '../utils/confirm.js';
import { ref, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import { downloadBackup, importBackup, syncWithHub, countData, downloadSubjectBackup, downloadAnkiText, parseAnkiLines, buildBackup, saveSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, buildIncrementalBackup } from '../sync.js';
import { getSubjects, createCard } from '../repo.js';
import { getErrors, clearErrors } from '../utils/errorLog.js';
import { verifyToken, createGistBackup, updateGistBackup, fetchGistBackup } from '../utils/gistBackup.js';
import { T } from '../utils/telemetry.js';
import { buildAuthHeaders } from '../utils/hub-auth.js';

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
const lastBackup = ref(null);
const lastReport = ref(JSON.parse(localStorage.getItem('sxy_last_sync_report') || 'null'));
const errors = ref([]);
async function loadErrors() { errors.value = await getErrors(30); }
async function clearErrs() { await clearErrors(); errors.value = []; toast('错误日志已清空', 'success'); }

// ---------- P3-3 快照 / 回滚 / 冲突可视化 ----------
const snapshots = ref([]);
const lastConflicts = ref([]); // 上次导入返回的 stats.conflicts（在 UI 展示哪些字段被覆盖）
const showConflicts = ref(false);
const snapshotBusy = ref(false);
async function loadSnapshots() { try { snapshots.value = await listSnapshots(); } catch {} }
async function doManualSnapshot() {
  snapshotBusy.value = true;
  try {
    const snap = await saveSnapshot(`手动快照 · ${new Date().toLocaleString('zh-CN')}`, 'manual');
    await loadSnapshots();
    toast(`已创建快照（含 ${snap.sizeBytes ? Math.round(snap.sizeBytes / 1024) + ' KB' : '数据'}，可在下方回滚）`, 'success');
  } catch (e) { toast('创建快照失败：' + (e?.message || e), 'error'); }
  finally { snapshotBusy.value = false; }
}
async function doRestore(id, label) {
  if (!(await confirmDialog(`确定回滚到该快照吗？\n\n${label}\n\n回滚后当前所有非图片数据会被该快照覆盖，请谨慎操作。`))) return;
  snapshotBusy.value = true;
  try {
    // 回滚前再保存一次「回滚前自动快照」，避免回滚动作本身不可逆
    await saveSnapshot(`回滚前自动快照 · ${new Date().toLocaleString('zh-CN')}`, 'backup-before-import');
    const r = await restoreSnapshot(id);
    await loadCounts(); await loadSnapshots();
    toast(`已回滚到：${r.label}（${fmt(r.restoredAt)}）`, 'success');
  } catch (e) { toast('回滚失败：' + (e?.message || e), 'error'); }
  finally { snapshotBusy.value = false; }
}
async function doDeleteSnapshot(id) {
  if (!(await confirmDialog('确定删除该快照？删除后无法恢复。'))) return;
  try { await deleteSnapshot(id); await loadSnapshots(); toast('快照已删除', 'success'); }
  catch (e) { toast('删除失败：' + (e?.message || e), 'error'); }
}
function fmtSize(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function winnerLabel(w) {
  return w === 'incoming' ? '导入方' : w === 'local' ? '本地' : '混合';
}

// ---------- P3·#2 Gist 云备份 ----------
const ghToken = ref(localStorage.getItem('sxy_gist_token') || '');
const gistId = ref(localStorage.getItem('sxy_gist_id') || '');
const ghLogin = ref(localStorage.getItem('sxy_gist_login') || '');
const gistBusy = ref(false);
const gistOpen = ref(false);

function saveGistCfg() {
  localStorage.setItem('sxy_gist_token', ghToken.value);
  localStorage.setItem('sxy_gist_id', gistId.value);
  localStorage.setItem('sxy_gist_login', ghLogin.value);
}

async function verifyGhToken() {
  if (!ghToken.value) { toast('请填写 Token', 'error'); return; }
  if (gistBusy.value) return;
  gistBusy.value = true;
  try {
    const r = await verifyToken(ghToken.value);
    ghLogin.value = r.login;
    saveGistCfg();
    toast(`✅ Token 有效，账号：${r.login}`, 'success');
  } catch (e) { toast('Token 校验失败：' + e.message, 'error'); }
  finally { gistBusy.value = false; }
}

async function uploadToGist() {
  if (!ghToken.value) { toast('请先填 Token 并校验', 'error'); return; }
  if (gistBusy.value) return;
  gistBusy.value = true;
  try {
    const payload = await buildBackup();
    if (gistId.value) {
      // 已有 gist：PATCH 更新
      const r = await updateGistBackup(ghToken.value, gistId.value, payload);
      toast(`✅ 已更新 Gist 备份（${counts.value.cards} 张卡 · 更新于 ${new Date(r.updatedAt).toLocaleString()}）`, 'success');
    } else {
      // 首次：创建新 secret gist
      const r = await createGistBackup(ghToken.value, payload);
      gistId.value = r.gistId;
      saveGistCfg();
      toast(`✅ 首次云备份完成（${counts.value.cards} 张卡 · Gist ID 已保存）`, 'success');
    }
  } catch (e) { toast('上传失败：' + e.message, 'error'); }
  finally { gistBusy.value = false; }
}

async function pullFromGist() {
  if (!ghToken.value || !gistId.value) { toast('请先填 Token 和 Gist ID', 'error'); return; }
  if (gistBusy.value) return;
  if (!(await confirmDialog('将从 Gist 拉取备份并合并到本地库（保留本地较新内容）。继续？'))) return;
  gistBusy.value = true;
  try {
    const payload = await fetchGistBackup(ghToken.value, gistId.value);
    const stats = await importBackup(payload, 'merge');
    saveReport('gist-pull', stats);
    await loadCounts();
    toast(`✅ 已从 Gist 拉取并合并：${fmtStats(stats)}`, 'success');
  } catch (e) { toast('拉取失败：' + e.message, 'error'); }
  finally { gistBusy.value = false; }
}

async function resetGist() {
  if (!(await confirmDialog('清空本机的 Gist 配置（不影响云端 Gist）？'))) return;
  ghToken.value = ''; gistId.value = ''; ghLogin.value = '';
  localStorage.removeItem('sxy_gist_token');
  localStorage.removeItem('sxy_gist_id');
  localStorage.removeItem('sxy_gist_login');
  toast('已清空 Gist 配置', 'info');
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
  const parts = [`卡片 +${stats.cards || 0}`];
  if (stats.overridden) parts.push(`更新 ${stats.overridden}`);
  if (stats.deleted) parts.push(`删除 ${stats.deleted}`);
  if (stats.duplicated) parts.push(`去重跳过 ${stats.duplicated}`);
  parts.push(`复习 +${stats.reviews || 0}`, `图片 +${stats.images || 0}`);
  const extra = [
    ['aiChats', 'AI对话'], ['aiMemories', '记忆'], ['memos', '备忘'], ['plans', '计划'],
    ['graphEdges', '图谱'], ['docs', '文档'], ['pomoSessions', '专注'],
    ['mindmaps', '导图'], ['weeklyReports', '周报'], ['achievements', '成就'], ['exams', '模考'],
  ];
  for (const [k, label] of extra) if (stats[k]) parts.push(`${label} +${stats[k]}`);
  return parts.join('，');
}

async function doExport() {
  try {
    await downloadBackup();
    lastBackup.value = { at: Date.now() };
    localStorage.setItem('sxy_last_backup', JSON.stringify(lastBackup.value));
    toast('数据包已导出，请把文件发到另一台设备导入', 'success');
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
    const stats = await importBackup(backup);
    await loadCounts();
    await loadSnapshots(); // P3-3 导入会自动创建快照，刷新列表
    saveReport('导入数据包', stats);
    // P3-3 冲突可视化：若有字段被覆盖，提示用户可查看明细
    lastConflicts.value = stats.conflicts || [];
    showConflicts.value = lastConflicts.value.length > 0;
    const meta = backup.deckMeta;
    const metaText = meta?.author ? `（卡组作者：${meta.author}${meta.description ? ' · ' + meta.description.slice(0, 40) : ''}）` : '';
    const conflictText = lastConflicts.value.length ? `，${lastConflicts.value.length} 张卡片有字段被覆盖` : '';
    const snapText = stats.snapshotId ? '（已自动创建导入前快照，可在下方回滚）' : '';
    toast(`导入完成：${fmtStats(stats)}${metaText}${conflictText}${snapText}`, 'success');
  } catch (err) {
    toast(err.message || '导入失败，请检查文件格式', 'error');
  } finally { importing.value = false; }
}

function saveHub() {
  localStorage.setItem('sxy_hub', hubUrl.value);
  localStorage.setItem('sxy_hub_token', hubToken.value);
  hubStatus.value = null;
  toast('已保存电脑端地址和密码', 'success');
}

// 常见错误原因诊断（Fail to fetch / CORS / 混合内容）
function diagnoseFetchError(msg, url) {
  const text = String(msg || '').toLowerCase();
  const hints = [];
  try {
    if (url && location.protocol === 'https:' && /^http:\/\//i.test(url)) {
      hints.push('🚫 当前页面是 HTTPS（如 GitHub Pages），你填的 Hub 是 HTTP：浏览器「混合内容阻断」会直接拒绝请求，表现为「Failed to fetch」。');
      hints.push('   → 解决：改用手机/平板浏览器直接打开 Hub 地址（http://<电脑IP>:4780），或本地启动前端 npm run dev 再用同步页。');
    }
    if (/failed to fetch|networkerror|网络错误|typeerror: failed/.test(text)) {
      hints.push('💡 其它常见「Failed to fetch」原因：');
      hints.push('   1) 电脑没启动 npm run hub，或填错端口；');
      hints.push('   2) Windows 防火墙拦截了 node.exe 的 4780 端口入站请求，需在弹窗选「允许访问」；');
      hints.push('   3) USB/数据线连接未开启 USB 共享网络 —— 手机设置里打开后再访问 Hub 提示的 RNDIS IP。');
    }
    if (/401|密码|token|unauthorized/.test(text)) hints.push('🔐 同步密码不匹配：复制 npm run hub 终端里打印的密码。');
    if (/404|not found/.test(text)) hints.push('⚠ 响应 404：地址填错了？必须是 http://<IP>:<端口>，不要加子路径。');
  } catch {}
  return hints;
}

async function testHub() {
  const hub = String(hubUrl.value || '').replace(/\/+$/, '');
  if (!hub) { toast('请先填写电脑端地址', 'warn'); return; }
  testingHub.value = true;
  hubStatus.value = null;
  try {
    // 先探活（/health 不含任何口令信息，无法被用作穷举预言机）
    const res = await fetch(`${hub}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`Hub 返回 HTTP ${res.status}`);
    const j = await res.json();
    const tips = j.tips || [];
    // 再验证密码：用 HMAC 挑战-响应，密码本身不上网；挑战一次性且有有效期
    let tokenOk = null; // null = 未验证（没填密码或协议不支持）
    if (hubToken.value) {
      const authHeaders = await buildAuthHeaders({ hub, token: hubToken.value, method: 'GET', path: '/backup' })
        || { 'x-sync-token': hubToken.value };
      const vr = await fetch(`${hub}/backup`, { method: 'GET', headers: { ...authHeaders } });
      tokenOk = vr.ok;
      if (vr.status === 401) {
        const d = await vr.json().catch(() => ({}));
        tips.unshift(`密码校验未通过：${d?.error || '请检查同步密码'}`);
      }
    }
    hubStatus.value = { ok: true, tokenOk, tips };
    const msg = tokenOk === null
      ? '✅ 已连接到 Hub（未填密码，未做校验）'
      : tokenOk ? '✅ 已连接，密码正确，可以同步' : '⚠ 连接成功，但密码校验未通过，请检查同步密码';
    toast(msg, tokenOk === false ? 'warn' : 'success');
  } catch (e) {
    const hints = diagnoseFetchError(e.message, hub);
    hubStatus.value = { ok: false, error: String(e.message || e), hints };
    toast('无法访问 Hub：' + (e.message || e), 'error');
  } finally { testingHub.value = false; }
}

async function doSync() {
  if (syncing.value) return;
  const hub = String(hubUrl.value || '').replace(/\/+$/, '');
  if (!hub) { toast('请先填写电脑端地址后再同步', 'warn'); return; }
  syncing.value = true;
  try {
    const stats = await syncWithHub(hub, hubToken.value);
    await loadCounts();
    saveReport('局域网一键同步', stats);
    try { T.syncRun('hub', true); } catch {}
    toast(`与电脑同步完成：${fmtStats(stats)}`, 'success');
  } catch (e) {
    const base = e.message || String(e);
    try { T.syncRun('hub', false); } catch {}
    const extras = diagnoseFetchError(base, hub);
    // 把诊断追加到 toast，详细诊断放错误日志便于排查
    const fullMsg = base + (extras.length ? '\n\n' + extras.join('\n') : '');
    toast(fullMsg, 'error');
    try {
      // 懒加载：避免顶层循环依赖
      const { logError } = await import('../utils/errorLog.js');
      await logError(new Error(base), { component: 'Sync.vue', route: '/sync', info: `hub=${hub} details=${JSON.stringify(extras).slice(0,250)}` });
    } catch {}
  } finally { syncing.value = false; }
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
    toast('卡组已导出（含署名信息），发给同学导入即可', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Anki 互通（E2）：导出 Anki 文本 / 导入 Anki 文本建卡 ----
const ankiInput = ref(null);
const ankiBusy = ref(false);
async function doAnkiExport() {
  try { await downloadAnkiText(); toast('已导出 Anki 文本（可在 Anki 桌面版「导入 → 文本文件」使用）', 'success'); }
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
    if (!pairs.length) { toast('未解析出卡片行', 'error'); return; }
    let n = 0;
    for (const p of pairs) { await createCard({ front: p.front, back: p.back, subject: '', tags: [], type: 'basic', source: 'Anki 导入' }); n++; }
    await loadCounts();
    toast(`已从 Anki 文本导入 ${n} 张卡片`, 'success');
  } catch (err) { toast('导入失败：' + (err.message || '文件格式不正确'), 'error'); }
  finally { ankiBusy.value = false; }
}

onMounted(async () => {
  loading.value = true;
  try { await Promise.all([loadCounts(), loadLastBackup(), loadSubjects(), loadErrors(), loadSnapshots()]); }
  finally { loading.value = false; }
});
</script>

<template>
  <div style="max-width:720px;margin:0 auto" v-loading="loading" element-loading-text="加载中…">
    <h2 style="margin:0 0 4px">数据同步</h2>
    <div class="hint" style="margin-bottom:16px">
      本机数据：{{ counts.cards }} 卡片 · {{ counts.reviews }} 复习 · {{ counts.images }} 图片 · {{ counts.aiChats }} 对话 · {{ counts.aiMemories }} 记忆 · {{ counts.memos }} 备忘 · {{ counts.plans }} 计划 · {{ counts.graphEdges }} 图谱边 · {{ counts.docs }} 文档 · {{ counts.pomoSessions }} 专注 · {{ counts.mindmaps }} 导图 · {{ counts.weeklyReports }} 周报 · {{ counts.achievements }} 成就 · {{ counts.exams }} 模考
    </div>

    <!-- 手动同步 -->
    <div class="panel">
      <div class="panel-title">手动同步（数据包文件）</div>
      <p class="hint" style="margin-top:0">
        导出一份数据包文件，包含<b>全部模块数据</b>：卡片、复习记录、图片、AI 对话（AI 问答 + 费曼 + Agent 工作台）、Agent 记忆、备忘录、学习计划、知识图谱、AI 文档、番茄专注记录、思维导图、每周报告、成就、每日目标与打卡。通过微信/QQ/网盘发到另一台设备导入即可。
      </p>
      <div v-if="lastBackup" class="hint" style="margin-bottom:8px">上次备份：{{ fmt(lastBackup.at) }}</div>
      <div v-else class="hint" style="margin-bottom:8px;color:var(--amber)">⚠ 尚未备份过，建议定期导出数据包，防止数据丢失</div>
      <div class="row">
        <button class="btn primary" @click="doExport">导出数据包</button>
        <button class="btn" :disabled="importing" @click="pickFile">
          {{ importing ? '导入中…' : '导入数据包' }}
        </button>
        <input ref="fileInput" type="file" accept=".json,application/json" style="display:none" @change="onFile" />
      </div>
      <div class="hint">合并规则：同 id 的记录按「最后修改时间」谁新听谁；删除会跨设备同步；图片按 id 自动去重；各模块（对话/记忆/计划/图谱/文档/专注）按 id 幂等合并。</div>
    </div>

    <!-- 最近一次同步/导入明细（E1 数字资产对账） -->
    <div v-if="lastReport" class="panel" style="margin-top:16px">
      <div class="panel-title">最近一次{{ lastReport.mode }}明细（{{ fmt(lastReport.at) }}）</div>
      <div class="sync-detail">
        <span class="sd-item">卡片新增 <b>{{ lastReport.stats.cards || 0 }}</b></span>
        <span class="sd-item">内容更新 <b>{{ lastReport.stats.overridden || 0 }}</b></span>
        <span class="sd-item">跨端删除 <b>{{ lastReport.stats.deleted || 0 }}</b></span>
        <span class="sd-item">重复跳过 <b>{{ lastReport.stats.duplicated || 0 }}</b></span>
        <span class="sd-item">复习记录 <b>{{ lastReport.stats.reviews || 0 }}</b></span>
        <span class="sd-item">图片 <b>{{ lastReport.stats.images || 0 }}</b></span>
        <span class="sd-item">对话 <b>{{ lastReport.stats.aiChats || 0 }}</b></span>
        <span class="sd-item">记忆 <b>{{ lastReport.stats.aiMemories || 0 }}</b></span>
        <span class="sd-item">备忘 <b>{{ lastReport.stats.memos || 0 }}</b></span>
        <span class="sd-item">计划 <b>{{ lastReport.stats.plans || 0 }}</b></span>
        <span class="sd-item">图谱 <b>{{ lastReport.stats.graphEdges || 0 }}</b></span>
        <span class="sd-item">文档 <b>{{ lastReport.stats.docs || 0 }}</b></span>
        <span class="sd-item">专注 <b>{{ lastReport.stats.pomoSessions || 0 }}</b></span>
        <span class="sd-item">导图 <b>{{ lastReport.stats.mindmaps || 0 }}</b></span>
        <span class="sd-item">周报 <b>{{ lastReport.stats.weeklyReports || 0 }}</b></span>
        <span class="sd-item">成就 <b>{{ lastReport.stats.achievements || 0 }}</b></span>
        <span class="sd-item">模考 <b>{{ lastReport.stats.exams || 0 }}</b></span>
      </div>
    </div>

    <!-- P3-3 冲突可视化：哪些卡片的哪些字段被覆盖 -->
    <div v-if="showConflicts" class="panel" style="margin-top:16px">
      <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>字段冲突明细（{{ lastConflicts.length }} 张卡片有字段被覆盖）</span>
        <button class="btn small" @click="showConflicts = false">收起</button>
      </div>
      <p class="hint" style="margin-top:0">合并按「双时间戳字段级」策略：内容字段按 updatedAt、复习状态按 reviewedAt、错因按 wrongReasonAt 各自取新者。下表显示每张卡被覆盖的字段来自哪一端。</p>
      <div v-if="lastConflicts.length > 50" class="hint" style="color:var(--ink-2)">仅展示前 50 条，完整明细可在「自动快照」中回滚查看。</div>
      <div class="conflict-list">
        <div v-for="c in lastConflicts.slice(0, 50)" :key="c.id" class="conflict-item" :class="'win-' + c.winner">
          <div class="conflict-front">{{ c.front || '(空卡)' }}</div>
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
        <span>历史快照与回滚</span>
        <button class="btn small" :disabled="snapshotBusy" @click="doManualSnapshot">立即创建快照</button>
      </div>
      <p class="hint" style="margin-top:0">每次导入数据包前会自动创建快照（最多保留 12 份，超出自动删最旧）。回滚会把当前所有非图片数据覆盖为快照内容，回滚前会再自动保存一次「回滚前快照」。</p>
      <div v-if="!snapshots.length" class="hint">暂无快照。导入数据包或点击「立即创建快照」即可生成。</div>
      <div v-else class="snapshot-list">
        <div v-for="s in snapshots" :key="s.id" class="snapshot-item">
          <div class="snapshot-main">
            <div class="snapshot-label">{{ s.label || '(未命名快照)' }}</div>
            <div class="snapshot-meta">
              <span>{{ fmt(s.createdAt) }}</span>
              <span v-if="s.sizeBytes"> · {{ fmtSize(s.sizeBytes) }}</span>
              <span class="snapshot-kind">{{ s.kind === 'manual' ? '手动' : s.kind === 'auto-before-sync' ? '同步前' : '导入前' }}</span>
            </div>
          </div>
          <div class="snapshot-actions">
            <button class="btn small" :disabled="snapshotBusy" @click="doRestore(s.id, s.label || fmt(s.createdAt))">回滚</button>
            <button class="btn small danger" :disabled="snapshotBusy" @click="doDeleteSnapshot(s.id)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分享卡组 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">分享卡组（导出某个科目）</div>
      <p class="hint" style="margin-top:0">把某个科目的卡片单独打包成文件，发给同学导入；可附署名与说明（数字资产的"作品署名"）。</p>
      <div class="row">
        <select v-model="shareSubject" class="input" style="max-width:240px">
          <option value="">选择科目</option>
          <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}（{{ s.count }}）</option>
        </select>
        <button class="btn" @click="doShare">导出该科目</button>
      </div>
      <div class="row" style="margin-bottom:0">
        <input v-model="shareAuthor" class="input" style="max-width:180px" placeholder="作者署名（选填）" />
        <input v-model="shareDesc" class="input" style="flex:1;max-width:340px" placeholder="卡组说明（选填，如：408 计算机网络高频考点）" />
      </div>
    </div>

    <!-- Anki 互通（E2 数字资产流转） -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">Anki 互通（数字资产流转）</div>
      <p class="hint" style="margin-top:0">
        导出 `.txt` 可在 Anki 桌面版「导入 → 文本文件」直接使用；也支持导入 Anki 导出的文本（每行一张，Tab / | / → 分隔正反面）。
      </p>
      <div class="row" style="margin-bottom:0">
        <button class="btn" @click="doAnkiExport">导出 Anki 文本</button>
        <button class="btn" :disabled="ankiBusy" @click="pickAnki">{{ ankiBusy ? '导入中…' : '导入 Anki 文本' }}</button>
        <input ref="ankiInput" type="file" accept=".txt,.tsv,.csv,text/plain" style="display:none" @change="onAnkiFile" />
      </div>
    </div>

    <!-- Gist 云备份（P3-B） -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">GitHub Gist 云备份</div>
      <p class="hint" style="margin-top:0">
        用 GitHub Gist 做跨设备云端备份：上传一份加密快照到你的 Gist，换设备/换浏览器时拉取合并。Token 仅存本机 localStorage，不上传任何第三方。
      </p>

      <div class="field-label" style="margin-top:0">GitHub Personal Access Token（需 gist 权限）</div>
      <div class="row">
        <input v-model="ghToken" class="input" type="password" placeholder="ghp_xxxx（在 GitHub Settings → Developer settings → Tokens 生成）" />
        <button class="btn small" :disabled="gistBusy" @click="verifyGhToken">{{ gistBusy ? '校验中…' : '校验' }}</button>
      </div>
      <div v-if="ghLogin" class="hint" style="margin-bottom:8px;color:var(--green)">✓ 已校验账号：{{ ghLogin }}</div>

      <div class="field-label" v-if="gistId">已绑定的 Gist ID</div>
      <div class="row" v-if="gistId">
        <input v-model="gistId" class="input" :readonly="!gistOpen" placeholder="Gist ID（首次上传后自动填入）" />
        <button class="btn small" @click="gistOpen = !gistOpen">{{ gistOpen ? '锁定' : '编辑' }}</button>
      </div>

      <div class="row" style="margin-bottom:0">
        <button class="btn primary" :disabled="gistBusy" @click="uploadToGist">{{ gistBusy ? '处理中…' : (gistId ? '上传更新到 Gist' : '首次云备份') }}</button>
        <button class="btn" :disabled="gistBusy || !gistId" @click="pullFromGist">从 Gist 拉取合并</button>
        <button class="btn small" style="color:var(--red)" @click="resetGist" v-if="ghToken || gistId">清空配置</button>
      </div>
      <div class="hint" style="margin-top:8px;margin-bottom:0">
        提示：首次点「首次云备份」会创建一个 secret Gist 并自动记下 ID；之后点「上传更新」即覆盖同一份。拉取时按「最后修改时间」合并，保留本地较新内容。
      </div>
    </div>

    <!-- 局域网自动同步 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">局域网一键同步（在家用）</div>
      <p class="hint" style="margin-top:0">
        手机/平板和电脑连同一个 WiFi 时，点一下就把三端数据合并一致。需要先在家里那台电脑上启动「同步中枢」。
      </p>

      <div v-if="isOnGhPages" class="hub-banner hub-warn">
        ⚠ 当前部署在 GitHub Pages（HTTPS），浏览器会阻止 HTTPS 页面请求 HTTP 内网 Hub，表现为「Fail to fetch」。<br/>
        请用手机/平板浏览器直接打开电脑端 Hub 地址（<code>http://<b>&lt;电脑IP&gt;</b>:4780</code>），即可使用同步功能。
      </div>
      <div v-else-if="isHttps && hubUrl && /^http:\/\//i.test(hubUrl)" class="hub-banner hub-warn">
        ⚠ 当前页面是 HTTPS，但你填的 Hub 地址是 HTTP。浏览器「混合内容阻断」会直接拒绝请求，这就是「Fail to fetch」的常见原因。
      </div>

      <div class="field-label" style="margin-top:0">电脑端地址</div>
      <div class="row">
        <input v-model="hubUrl" class="input" placeholder="例如 http://192.168.1.5:4780" />
        <button class="btn small" :disabled="testingHub" @click="testHub">{{ testingHub ? '检测中…' : '测试连接' }}</button>
        <button class="btn small" @click="saveHub">保存</button>
      </div>

      <div v-if="hubStatus" class="hub-status" :class="hubStatus.ok ? 'ok' : 'bad'">
        <template v-if="hubStatus.ok">
          ✅ Hub 可达。{{
            hubStatus.tokenOk === null ? '未填密码，未做校验。'
            : hubStatus.tokenOk ? '密码校验通过。'
            : '⚠ 密码未通过，请检查同步密码。'
          }}
          <ul v-if="hubStatus.tips?.length" style="margin:6px 0 0 18px;padding:0"><li v-for="(t,i) in hubStatus.tips" :key="i" class="hint" style="font-size:12px">{{ t }}</li></ul>
        </template>
        <template v-else>
          ❌ 无法访问 Hub：<b>{{ hubStatus.error }}</b>
          <ul v-if="hubStatus.hints?.length" style="margin:6px 0 0 18px;padding:0"><li v-for="(h,i) in hubStatus.hints" :key="i" style="font-size:12px">{{ h }}</li></ul>
        </template>
      </div>

      <div class="field-label">同步密码</div>
      <div class="row">
        <input v-model="hubToken" class="input" placeholder="电脑启动中枢时显示的密码" />
      </div>

      <button class="btn primary" style="width:100%" :disabled="syncing" @click="doSync">
        {{ syncing ? '同步中…' : '与电脑一键同步' }}
      </button>

      <div class="hub-steps">
        <div class="step-title">如何在电脑上启动同步中枢（只需一次）</div>
        <ol>
          <li>命令行进入本项目的 <code>new_card</code> 目录；</li>
          <li>运行 <code>npm run hub</code>（会显示电脑的内网 IP 和端口）；</li>
          <li>把上面「电脑端地址」填成 <code>http://该IP:4780</code> 并保存；</li>
          <li>以后在家点「一键同步」即可，三端数据自动合并。</li>
        </ol>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">本地错误日志</h3>
        <span class="hint">{{ errors.length }} 条</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="loadErrors">刷新</button>
        <button class="btn small" style="color:var(--red)" @click="clearErrs" v-if="errors.length">清空</button>
      </div>
      <p class="hint" style="margin:4px 0 8px">记录应用运行时的异常（看不见的崩溃），便于反馈排查。最多保留 200 条。</p>
      <div v-if="!errors.length" class="hint" style="padding:12px;text-align:center">暂无错误记录</div>
      <div v-for="e in errors" :key="e.id" class="err-row">
        <div class="err-head">
          <span class="err-sev" :class="e.severity">{{ e.severity }}</span>
          <span class="err-time">{{ fmt(e.createdAt) }}</span>
          <span class="err-ctx" v-if="e.ctx">{{ e.ctx }}</span>
        </div>
        <div class="err-msg">{{ e.message }}</div>
        <details v-if="e.stack"><summary class="hint">堆栈</summary><pre class="err-stack">{{ e.stack }}</pre></details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.panel-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
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
</style>