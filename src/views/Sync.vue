<script setup>
// 数据同步：手动导出/导入（数据包文件）+ 局域网一键同步（电脑端中枢）
import { ref, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import { downloadBackup, importBackup, syncWithHub, countData, downloadSubjectBackup, downloadAnkiText, parseAnkiLines, buildBackup } from '../sync.js';
import { getSubjects, createCard } from '../repo.js';
import { getErrors, clearErrors } from '../utils/errorLog.js';
import { verifyToken, createGistBackup, updateGistBackup, fetchGistBackup } from '../utils/gistBackup.js';

const counts = ref({ cards: 0, reviews: 0, images: 0, aiChats: 0, aiMemories: 0, memos: 0, plans: 0, graphEdges: 0, docs: 0, pomoSessions: 0, mindmaps: 0, weeklyReports: 0, achievements: 0, exams: 0 });
const hubUrl = ref(localStorage.getItem('sxy_hub') || location.origin);
const hubToken = ref(localStorage.getItem('sxy_hub_token') || '');
const fileInput = ref(null);
const syncing = ref(false);
const importing = ref(false);
const lastBackup = ref(null);
const lastReport = ref(JSON.parse(localStorage.getItem('sxy_last_sync_report') || 'null'));
const errors = ref([]);
async function loadErrors() { errors.value = await getErrors(30); }
async function clearErrs() { await clearErrors(); errors.value = []; toast('错误日志已清空', 'success'); }

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
  if (!confirm('将从 Gist 拉取备份并合并到本地库（保留本地较新内容）。继续？')) return;
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

function resetGist() {
  if (!confirm('清空本机的 Gist 配置（不影响云端 Gist）？')) return;
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
    saveReport('导入数据包', stats);
    const meta = backup.deckMeta;
    const metaText = meta?.author ? `（卡组作者：${meta.author}${meta.description ? ' · ' + meta.description.slice(0, 40) : ''}）` : '';
    toast(`导入完成：${fmtStats(stats)}${metaText}`, 'success');
  } catch (err) {
    toast(err.message || '导入失败，请检查文件格式', 'error');
  } finally { importing.value = false; }
}

function saveHub() {
  localStorage.setItem('sxy_hub', hubUrl.value);
  localStorage.setItem('sxy_hub_token', hubToken.value);
  toast('已保存电脑端地址和密码', 'success');
}

async function doSync() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const stats = await syncWithHub(hubUrl.value, hubToken.value);
    await loadCounts();
    saveReport('局域网一键同步', stats);
    toast(`与电脑同步完成：${fmtStats(stats)}`, 'success');
  } catch (e) {
    toast(e.message, 'error');
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

onMounted(() => { loadCounts(); loadLastBackup(); loadSubjects(); loadErrors(); });
</script>

<template>
  <div style="max-width:720px;margin:0 auto">
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

      <div class="field-label" style="margin-top:0">电脑端地址</div>
      <div class="row">
        <input v-model="hubUrl" class="input" placeholder="例如 http://192.168.1.5:4780" />
        <button class="btn small" @click="saveHub">保存</button>
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
</style>