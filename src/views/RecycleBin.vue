<script setup>
// P2-22 回收站：把原本对用户不可见的删除墓碑，变成可浏览、可 30 天恢复的本地回收站。
// 数据来自本地 trash 表（不进同步/备份），恢复时本地重插并 bump updatedAt（> 墓碑时间 → 下次同步判定复活），
// 同时清掉本地墓碑，使恢复在跨设备同步后仍成立。
import { ref, computed, onMounted } from 'vue';
import { db } from '../db.js';
import { restoreFromTrash } from '../repo.js';
import { confirmDialog } from '../utils/confirm.js';
import { toast } from '../utils/toast.js';

const TRASH_DAYS = 30;
const KIND_LABEL = { card: '卡片', memo: '备忘', note: '笔记', plan: '计划', doc: '文档', mindmap: '导图' };
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
  return (JSON.stringify(d) || '').slice(0, 90);
}
function daysLeft(t) {
  const ms = TRASH_DAYS * 86400000 - (Date.now() - (t.deletedAt || 0));
  return Math.max(0, Math.ceil(ms / 86400000));
}
function expired(t) { return daysLeft(t) <= 0; }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }

const availableKinds = computed(() => [...new Set(items.value.map(t => t.kind))]);
const filtered = computed(() => {
  const list = [...items.value].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  return filterKind.value ? list.filter(t => t.kind === filterKind.value) : list;
});
const restorableCount = computed(() => filtered.value.filter(t => !expired(t)).length);

async function load() {
  busy.value = true;
  try {
    const all = await db.trash.toArray();
    // 30 天自动过期：快照不再可恢复，直接清除（墓碑保留以继续跨设备删除）
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    const expiredOnes = all.filter(t => (t.deletedAt || 0) < cutoff);
    if (expiredOnes.length) {
      await db.trash.bulkDelete(expiredOnes.map(t => t.id));
      toast(`已自动清理 ${expiredOnes.length} 条超过 ${TRASH_DAYS} 天的记录`, 'info');
    }
    items.value = all.filter(t => (t.deletedAt || 0) >= cutoff);
  } catch (e) { toast(e.message || '加载失败', 'error'); }
  finally { busy.value = false; }
}

async function restore(t) {
  if (expired(t)) { toast('已过期，无法恢复', 'error'); return; }
  if (!(await confirmDialog(`恢复这条「${KIND_LABEL[t.kind] || t.kind}」？将重新放回原处。`))) return;
  busy.value = true;
  try {
    const ok = await restoreFromTrash(t);
    if (ok) { toast('已恢复', 'success'); items.value = items.value.filter(x => x.id !== t.id); }
    else toast('该类型暂不支持恢复', 'error');
  } catch (e) { toast(e.message || '恢复失败', 'error'); }
  finally { busy.value = false; }
}

async function purge(t) {
  if (!(await confirmDialog('永久删除这条记录？此操作不可恢复。'))) return;
  busy.value = true;
  try {
    await db.trash.delete(t.id);
    items.value = items.value.filter(x => x.id !== t.id);
    toast('已永久删除', 'success');
  } catch (e) { toast(e.message || '删除失败', 'error'); }
  finally { busy.value = false; }
}

async function restoreAll() {
  const restorable = filtered.value.filter(t => !expired(t));
  if (!restorable.length) return;
  if (!(await confirmDialog(`恢复全部 ${restorable.length} 条可恢复记录？`))) return;
  busy.value = true;
  try {
    let n = 0;
    for (const t of restorable) { if (await restoreFromTrash(t)) n++; }
    toast(`已恢复 ${n} 条`, 'success');
    await load();
  } catch (e) { toast(e.message || '恢复失败', 'error'); }
  finally { busy.value = false; }
}

async function purgeAll() {
  if (!filtered.value.length) return;
  if (!(await confirmDialog(`永久清空回收站（${filtered.value.length} 条）？不可恢复。`))) return;
  busy.value = true;
  try {
    await db.trash.clear();
    items.value = [];
    toast('回收站已清空', 'success');
  } catch (e) { toast(e.message || '清空失败', 'error'); }
  finally { busy.value = false; }
}

onMounted(load);
</script>

<template>
  <div style="max-width:880px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">🗑️ 回收站</h2>
      <span class="hint">被删除的内容会暂存在这里 {{ TRASH_DAYS }} 天，过期自动清空（删除仍会跨设备同步）</span>
      <span style="flex:1"></span>
      <button class="btn small" :disabled="busy" @click="load">刷新</button>
      <button class="btn small primary" :disabled="busy || !restorableCount" @click="restoreAll">全部恢复</button>
      <button class="btn small" :disabled="busy || !filtered.length" @click="purgeAll">清空</button>
    </div>

    <div v-if="availableKinds.length" class="mode-row" style="margin-top:14px">
      <button class="chip" :class="{ on: !filterKind }" @click="filterKind = ''">全部（{{ items.length }}）</button>
      <button v-for="k in availableKinds" :key="k" class="chip" :class="{ on: filterKind === k }" @click="filterKind = k">
        {{ KIND_LABEL[k] || k }}（{{ items.filter(t => t.kind === k).length }}）
      </button>
    </div>

    <div v-if="!filtered.length" class="panel" style="margin-top:14px">
      <p class="hint" style="margin:0">✅ 回收站是空的，没有可恢复的内容。</p>
    </div>

    <div v-for="t in filtered" :key="t.id" class="panel trash-row" style="margin-top:12px">
      <div style="flex:1;min-width:0">
        <div class="trash-head">
          <span class="tag">{{ KIND_LABEL[t.kind] || t.kind }}</span>
          <span class="hint">删除于 {{ fmtDate(t.deletedAt) }}</span>
          <span v-if="expired(t)" class="tag expired">已过期</span>
          <span v-else class="tag left">剩 {{ daysLeft(t) }} 天</span>
        </div>
        <div class="preview">{{ previewOf(t) || '（无预览）' }}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small primary" :disabled="busy || expired(t)" @click="restore(t)">恢复</button>
        <button class="btn small" :disabled="busy" @click="purge(t)">永久删除</button>
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
