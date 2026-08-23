<script setup>
// 数据同步：手动导出/导入（数据包文件）+ 局域网一键同步（电脑端中枢）
import { ref, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import { downloadBackup, importBackup, syncWithHub, countData } from '../sync.js';

const counts = ref({ cards: 0, reviews: 0, images: 0 });
const hubUrl = ref(localStorage.getItem('sxy_hub') || location.origin);
const fileInput = ref(null);
const syncing = ref(false);
const importing = ref(false);
const lastBackup = ref(null);

async function loadCounts() {
  counts.value = await countData();
}

function fmt(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    toast(`导入完成：卡片 +${stats.cards}，复习 +${stats.reviews}，图片 +${stats.images}`, 'success');
  } catch (err) {
    toast(err.message || '导入失败，请检查文件格式', 'error');
  } finally { importing.value = false; }
}

function saveHub() {
  localStorage.setItem('sxy_hub', hubUrl.value);
  toast('已保存电脑端地址', 'success');
}

async function doSync() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const stats = await syncWithHub(hubUrl.value);
    await loadCounts();
    toast(`与电脑同步完成：卡片 +${stats.cards}，复习 +${stats.reviews}，图片 +${stats.images}`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally { syncing.value = false; }
}

function loadLastBackup() {
  try { lastBackup.value = JSON.parse(localStorage.getItem('sxy_last_backup') || 'null'); } catch {}
}

onMounted(() => { loadCounts(); loadLastBackup(); });
</script>

<template>
  <div style="max-width:720px;margin:0 auto">
    <h2 style="margin:0 0 4px">数据同步</h2>
    <div class="hint" style="margin-bottom:16px">
      本机：{{ counts.cards }} 张卡片 · {{ counts.reviews }} 条复习 · {{ counts.images }} 张图片
    </div>

    <!-- 手动同步 -->
    <div class="panel">
      <div class="panel-title">手动同步（数据包文件）</div>
      <p class="hint" style="margin-top:0">
        导出一份包含卡片、复习进度、图片的数据包文件，通过微信/QQ/网盘发到另一台设备导入即可。适合出门在外、不同 WiFi 时使用。
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
      <div class="hint">合并规则：同 id 的卡片按「最后修改时间」谁新听谁；删除会在设备间同步；图片按 id 自动去重。</div>
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
</style>