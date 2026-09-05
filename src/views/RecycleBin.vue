<script setup>
// P2-22 回收站：把原本对用户不可见的删除墓碑，变成可浏览、可 30 天恢复的本地回收站。
// 数据来自本地 trash 表（不进同步/备份），恢复时本地重插并 bump updatedAt（> 墓碑时间 → 下次同步判定复活），
// 同时清掉本地墓碑，使恢复在跨设备同步后仍成立。
import { ref, computed, onMounted } from 'vue';
import { db } from '../db.js';
import { restoreFromTrash, pruneTrash, TRASH_TTL_DAYS } from '../repo.js';
import { confirmDialog } from '../utils/confirm.js';
import { toast } from '../utils/toast.js';
import { t } from '../i18n/index.js';
import { fmtLocaleDateTime } from '../utils/locale-date.js';

const TRASH_DAYS = TRASH_TTL_DAYS; // TTL 唯一来源：repo.js（避免两处常量漂移）
function kindLabel(k) {
  const m = {
    card: 'views.recycleBin.kindCard', memo: 'views.recycleBin.kindMemo',
    note: 'views.recycleBin.kindNote', plan: 'views.recycleBin.kindPlan',
    doc: 'views.recycleBin.kindDoc', mindmap: 'views.recycleBin.kindMindmap',
    docFile: 'views.recycleBin.kindDocFile',
    wordCard: 'views.recycleBin.kindWordCard', wordGroup: 'views.recycleBin.kindWordGroup',
    cardGroup: 'views.recycleBin.kindCardGroup',
  };
  return m[k] ? t(m[k]) : k;
}
const items = ref([]);
const busy = ref(false);
const filterKind = ref('');

function previewOf(t) {
  const d = t.data || {};
  if (t.kind === 'card') return `[${d.subject || '未分类'}] ${d.front || ''}`.slice(0, 90);
  if (t.kind === 'memo') return (d.text || d.title || '').slice(0, 90);
  if (t.kind === 'note') return (d.title || '').slice(0, 90);
  if (t.kind === 'plan') return (d.title || '').slice(0, 90);
  if (t.kind === 'doc') return (d.name || d.title || '').slice(0, 90);
  if (t.kind === 'mindmap') return (d.title || d.name || '').slice(0, 90);
  // 资料：补一句规模提示，让用户判断「值不值得恢复」
  if (t.kind === 'docFile') {
    const n = d._textLen || (d._text || '').length || 0;
    const base = (d.name || '').slice(0, 70);
    return n ? `${base}（全文 ${n} 字）` : base;
  }
  // 单词卡 / 词组（v26 英语模块）：显示词条与释义，不再落到裸 JSON
  if (t.kind === 'wordCard') return `[${d.subject || '未分类'}] ${d.word || ''} — ${(d.meaning || '').slice(0, 60)}`.slice(0, 90);
  if (t.kind === 'wordGroup') return (d.name || '').slice(0, 90);
  // v40 卡组对等：普通卡组与词组同款预览（名称 + 成员数）
  if (t.kind === 'cardGroup') {
    const n = (d._groupLinks || []).length;
    return n ? `${d.name || ''}（${t('views.recycleBin.cardsInGroup', undefined, { n })}）` : (d.name || '');
  }
  return (JSON.stringify(d) || '').slice(0, 90);
}
function daysLeft(t) {
  const ms = TRASH_DAYS * 86400000 - (Date.now() - (t.deletedAt || 0));
  return Math.max(0, Math.ceil(ms / 86400000));
}
function expired(t) { return daysLeft(t) <= 0; }
// 资料快照恢复后没有原文件，确认文案要说清楚，否则用户恢复后点开预览会以为恢复失败
function confirmTextOf(item) {
  if (item.kind === 'docFile') {
    return t('views.recycleBin.confirmRestoreDocFile', '恢复这份「{kind}」？解析全文与图谱关联会一并回来；原文件需重新上传。', { kind: kindLabel(item.kind) });
  }
  return t('views.recycleBin.confirmRestore', '恢复这条「{kind}」？将重新放回原处。', { kind: kindLabel(item.kind) });
}

const availableKinds = computed(() => [...new Set(items.value.map(t => t.kind))]);
const filtered = computed(() => {
  const list = [...items.value].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  return filterKind.value ? list.filter(t => t.kind === filterKind.value) : list;
});
const restorableCount = computed(() => filtered.value.filter(t => !expired(t)).length);

async function load() {
  busy.value = true;
  try {
    // 过期清理统一走 repo.pruneTrash（同一份 TTL 与实现，应用启动时也会兜底跑一次）
    const cleaned = await pruneTrash();
    if (cleaned) {
      toast(t('views.recycleBin.autoCleaned', '已自动清理 {n} 条超过 {d} 天的记录', { n: cleaned, d: TRASH_DAYS }), 'info');
    }
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    items.value = (await db.trash.toArray()).filter(t => (t.deletedAt || 0) >= cutoff);
  } catch (e) { toast(e.message || t('views.recycleBin.loadFail'), 'error'); }
  finally { busy.value = false; }
}

async function restore(item) {
  if (expired(item)) { toast(t('views.recycleBin.expiredFail'), 'error'); return; }
  if (!(await confirmDialog(confirmTextOf(item)))) return;
  busy.value = true;
  try {
    const ok = await restoreFromTrash(item);
    if (ok) { toast(t('views.recycleBin.restored'), 'success'); items.value = items.value.filter(x => x.id !== item.id); }
    else toast(t('views.recycleBin.unsupported'), 'error');
  } catch (e) { toast(e.message || t('views.recycleBin.restoreFail'), 'error'); }
  finally { busy.value = false; }
}

async function purge(item) {
  if (!(await confirmDialog(t('views.recycleBin.confirmPurge')))) return;
  busy.value = true;
  try {
    await db.trash.delete(item.id);
    items.value = items.value.filter(x => x.id !== item.id);
    toast(t('views.recycleBin.purged'), 'success');
  } catch (e) { toast(e.message || t('views.recycleBin.deleteFail'), 'error'); }
  finally { busy.value = false; }
}

async function restoreAll() {
  const restorable = filtered.value.filter(t => !expired(t));
  if (!restorable.length) return;
  if (!(await confirmDialog(t('views.recycleBin.confirmRestoreAll', '恢复全部 {n} 条可恢复记录？', { n: restorable.length })))) return;
  busy.value = true;
  try {
    let n = 0;
    for (const t of restorable) { if (await restoreFromTrash(t)) n++; }
    toast(t('views.recycleBin.restoredN', '已恢复 {n} 条', { n }), 'success');
    await load();
  } catch (e) { toast(e.message || t('views.recycleBin.restoreFail'), 'error'); }
  finally { busy.value = false; }
}

async function purgeAll() {
  if (!filtered.value.length) return;
  if (!(await confirmDialog(t('views.recycleBin.confirmPurgeAll', '永久清空回收站（{n} 条）？不可恢复。', { n: filtered.value.length })))) return;
  busy.value = true;
  try {
    await db.trash.clear();
    items.value = [];
    toast(t('views.recycleBin.purgedAll'), 'success');
  } catch (e) { toast(e.message || t('views.recycleBin.clearFail'), 'error'); }
  finally { busy.value = false; }
}

onMounted(load);
</script>

<template>
  <div style="max-width:880px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.recycleBin.title') }}</h2>
      <span class="hint">{{ t('views.recycleBin.hint', '被删除的内容会暂存在这里 {n} 天，过期自动清空（删除仍会跨设备同步）', { n: TRASH_DAYS }) }}</span>
      <span style="flex:1"></span>
      <button class="btn small" :disabled="busy" @click="load">{{ t('views.recycleBin.refresh') }}</button>
      <button class="btn small primary" :disabled="busy || !restorableCount" @click="restoreAll">{{ t('views.recycleBin.restoreAll') }}</button>
      <button class="btn small" :disabled="busy || !filtered.length" @click="purgeAll">{{ t('views.recycleBin.clearAll') }}</button>
    </div>

    <div v-if="availableKinds.length" class="mode-row" style="margin-top:14px">
      <button class="chip" :class="{ on: !filterKind }" @click="filterKind = ''">{{ t('views.recycleBin.all', '全部（{n}）', { n: items.length }) }}</button>
      <button v-for="k in availableKinds" :key="k" class="chip" :class="{ on: filterKind === k }" @click="filterKind = k">
        {{ kindLabel(k) }}（{{ items.filter(t => t.kind === k).length }}）
      </button>
    </div>

    <div v-if="!filtered.length" class="panel" style="margin-top:14px">
      <p class="hint" style="margin:0">{{ t('views.recycleBin.emptyTip') }}</p>
    </div>

    <div v-for="item in filtered" :key="item.id" class="panel trash-row" style="margin-top:12px">
      <div style="flex:1;min-width:0">
        <div class="trash-head">
          <span class="tag">{{ kindLabel(item.kind) }}</span>
          <span class="hint">{{ t('views.recycleBin.deletedAt', '删除于 {time}', { time: fmtLocaleDateTime(item.deletedAt) }) }}</span>
          <span v-if="expired(item)" class="tag expired">{{ t('views.recycleBin.expired') }}</span>
          <span v-else class="tag left">{{ t('views.recycleBin.daysLeft', '剩 {n} 天', { n: daysLeft(item) }) }}</span>
        </div>
        <div class="preview">{{ previewOf(item) || t('views.recycleBin.noPreview') }}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small primary" :disabled="busy || expired(item)" @click="restore(item)">{{ t('views.recycleBin.restore') }}</button>
        <button class="btn small" :disabled="busy" @click="purge(item)">{{ t('views.recycleBin.purge') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 18px; }
.hint { font-size: 13px; color: var(--ink-2); }
.mode-row { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); background: var(--code-inline); color: var(--ink); padding: 5px 14px; border-radius: 999px; cursor: pointer; font-size: 13px; transition: .15s; }
.chip:hover { border-color: var(--accent); }
.chip.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.trash-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.trash-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.tag { font-size: 12px; padding: 2px 8px; border-radius: 6px; background: var(--code-inline); color: var(--ink-2); }
.tag.left { color: var(--amber); background: color-mix(in srgb, var(--amber) 16%, transparent); }
.tag.expired { color: var(--red); background: color-mix(in srgb, var(--red) 16%, transparent); }
.preview { font-size: 14px; color: var(--ink); word-break: break-word; }
.btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 6px 14px; border-radius: 8px; cursor: pointer; transition: .15s; }
.btn:hover { border-color: var(--accent); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.small { padding: 4px 12px; font-size: 13px; }
.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
