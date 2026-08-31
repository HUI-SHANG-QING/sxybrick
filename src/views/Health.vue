<script setup>
// 资产体检（E1 数字资产保值批）：重复卡 / 僵尸卡 / 孤儿图片 / 无标签卡 检测与清理
// 所有删除走 deleteCard（墓碑跨设备传播）+ 图片直接清理，保证多端一致
import { t } from '../i18n/index.js';
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getAssetHealth, getNetWorth, getSourceOverview } from '../agent/analytics.js';
import { deleteCard } from '../repo.js';
import { db } from '../db.js';
import { toast } from '../utils/toast.js';
import { T } from '../utils/telemetry.js';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();
const health = ref(null);
const networth = ref(null);
const sources = ref(null); // { bySource, variantCount, untraced, totalSources }
const busy = ref(false);

// P2-24 一键修复：统计可安全自动清理的项数（重复/僵尸/孤儿图片），用于按钮可用性
const fixableCount = computed(() => {
  const h = health.value; if (!h) return 0;
  return h.duplicates.reduce((s, g) => s + g.n - 1, 0) + (h.zombieCount || 0) + (h.orphanImageCount || 0);
});

// 跳转到 /cards + 指定筛选参数；默认全展开（背诵效果页，用户先预览再决定是否编辑）
function jumpCards(query) {
  const qs = new URLSearchParams(query).toString();
  router.push(`/cards?${qs}`);
}
function openUntagged() { jumpCards({ untagged: '1', expandAll: '1' }); }
function openZombies()  { jumpCards({ zombie: '1', expandAll: '1' }); }
function openDuplicates(g) { jumpCards({ dupGroup: g.key, expandAll: '1' }); }
function openOrphans() { jumpCards({ orphan: '1', expandAll: '1' }); }

async function load() {
  busy.value = true;
  try {
    const [h, nw, src] = await Promise.all([getAssetHealth(), getNetWorth(), getSourceOverview()]);
    health.value = h; networth.value = nw; sources.value = src;
    try { T.healthScan(); } catch {}
  }
  catch (e) { toast(e.message, 'error'); }
  finally { busy.value = false; }
}

// 合并重复组：保留最新编辑的一张，删除组内其余（复习记录随卡级联清理）
async function dedupeGroup(g) {
  if (!(await confirmDialog(t('views.health.dedupeGroupConfirm', undefined, { n: g.n, m: g.n - 1 })))) return;
  const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const remove = sorted.slice(1);
  for (const c of remove) await deleteCard(c.id);
  toast(t('views.health.dedupeGroupDone', undefined, { n: remove.length, name: sorted[0].front.slice(0, 20) }), 'success');
  await load();
}
async function dedupeAll() {
  if (!health.value?.duplicates.length) return;
  const total = health.value.duplicates.reduce((s, g) => s + g.n - 1, 0);
  if (!(await confirmDialog(t('views.health.dedupeAllConfirm', undefined, { n: total })))) return;
  let n = 0;
  for (const g of health.value.duplicates) {
    const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const c of sorted.slice(1)) { await deleteCard(c.id); n++; }
  }
  toast(t('views.health.dedupeAllDone', undefined, { n }), 'success');
  await load();
}
async function removeZombies() {
  if (!health.value?.zombies.length) return;
  if (!(await confirmDialog(t('views.health.removeZombiesConfirm', undefined, { n: health.value.zombies.length })))) return;
  for (const z of health.value.zombies) await deleteCard(z.id);
  toast(t('views.health.zombieCleaned'), 'success');
  await load();
}
async function cleanOrphanImages() {
  if (!health.value?.orphanImages.length) return;
  if (!(await confirmDialog(t('views.health.cleanOrphanConfirm', undefined, { n: health.value.orphanImages.length })))) return;
  for (const i of health.value.orphanImages) await db.images.delete(i.id);
  toast(t('views.health.orphanCleaned'), 'success');
  await load();
}

// P2-24 一键修复：串联可安全自动化的清理项（重复卡每组留最新 1 张 + 僵尸卡 + 孤儿图片），合并为单次确认
async function fixAll() {
  const h = health.value; if (!h) return;
  const dupTotal = h.duplicates.reduce((s, g) => s + g.n - 1, 0);
  const zombN = h.zombieCount || 0;
  const orphanN = h.orphanImageCount || 0;
  if (!dupTotal && !zombN && !orphanN) { toast(t('views.health.fixAllHealthy'), 'success'); return; }
  const detail = t('views.health.fixAllDetail1', undefined, { d: dupTotal, z: zombN, o: orphanN }) +
    t('views.health.fixAllDetail2', undefined, { u: h.untaggedCount || 0 });
  if (!(await confirmDialog(t('views.health.fixAllConfirm', undefined, { detail })))) return;
  busy.value = true;
  try {
    let n = 0;
    for (const g of h.duplicates) {
      const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const c of sorted.slice(1)) { await deleteCard(c.id); n++; }
    }
    for (const z of h.zombies) await deleteCard(z.id);
    for (const i of h.orphanImages) await db.images.delete(i.id);
    toast(t('views.health.fixAllDone', undefined, { n, z: zombN, o: orphanN }), 'success');
    await load();
  } catch (e) { toast(e.message || t('views.health.fixFail'), 'error'); }
  finally { busy.value = false; }
}

onMounted(load);
</script>

<template>
  <div style="max-width:860px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.health.title') }}</h2>
      <span class="hint">{{ t('views.health.subtitle') }}</span>
      <span style="flex:1"></span>
      <button class="btn small" :disabled="busy" @click="load">{{ t('views.health.recheck') }}</button>
      <button class="btn small primary" :disabled="busy || !fixableCount" @click="fixAll">{{ t('views.health.fixAll') }}{{ fixableCount ? t('views.health.fixAllCount', undefined, { n: fixableCount }) : '' }}</button>
    </div>

    <div v-if="health" class="stat-cards" style="margin-top:14px">
      <div class="stat"><div class="num">{{ health.totalCards }}</div><div class="hint">{{ t('views.health.statTotalCards') }}</div></div>
      <div class="stat clickable" :title="t('views.health.statDupTitle')" @click="jumpCards({dupGroup: '__all__', expandAll: '1'})"><div class="num" :style="{ color: health.duplicates.length ? 'var(--red)' : 'var(--green)' }">{{ health.duplicates.reduce((s, g) => s + g.n - 1, 0) }}</div><div class="hint">{{ t('views.health.statDuplicates') }}</div></div>
      <div class="stat clickable" :title="t('views.health.statZombieTitle')" @click="openZombies"><div class="num" :style="{ color: health.zombieCount ? 'var(--amber)' : 'var(--green)' }">{{ health.zombieCount }}</div><div class="hint">{{ t('views.health.statZombies') }}</div></div>
      <div class="stat clickable" :title="t('views.health.statOrphanTitle')" @click="openOrphans"><div class="num" :style="{ color: health.orphanImageCount ? 'var(--amber)' : 'var(--green)' }">{{ health.orphanImageCount }}</div><div class="hint">{{ t('views.health.statOrphanImages') }}</div></div>
      <div class="stat clickable" :title="t('views.health.statUntaggedTitle')" @click="openUntagged"><div class="num">{{ health.untaggedCount }}</div><div class="hint">{{ t('views.health.statUntagged') }}</div></div>
    </div>

    <!-- 知识净值（资产负债表） -->
    <div v-if="networth" class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">{{ t('views.health.networthTitle') }}</span>
        <span class="hint">{{ t('views.health.networthHint') }}</span>
      </div>
      <div class="stat-cards" style="margin-top:10px">
        <div class="stat"><div class="num">{{ networth.totalValue }}</div><div class="hint">{{ t('views.health.nwNetValue') }}</div></div>
        <div class="stat"><div class="num">{{ networth.idealValue }}</div><div class="hint">{{ t('views.health.nwCostValue') }}</div></div>
        <div class="stat"><div class="num" :style="{ color: networth.decayedValue > 0 ? 'var(--amber)' : 'var(--green)' }">{{ networth.decayedValue }}</div><div class="hint">{{ t('views.health.nwDecay') }}</div></div>
        <div class="stat"><div class="num" :style="{ color: networth.retentionRate >= 90 ? 'var(--green)' : networth.retentionRate >= 70 ? 'var(--amber)' : 'var(--red)' }">{{ networth.retentionRate }}%</div><div class="hint">{{ t('views.health.nwRetentionRate') }}</div></div>
        <div class="stat"><div class="num">{{ networth.masteredCount }}</div><div class="hint">{{ t('views.health.nwMastered') }}</div></div>
        <div class="stat"><div class="num">{{ networth.newCount }}</div><div class="hint">{{ t('views.health.nwNew') }}</div></div>
      </div>
      <div v-if="networth.bySubject.length" style="margin-top:14px">
        <div class="hint" style="margin-bottom:6px">{{ t('views.health.nwBySubjectHint') }}</div>
        <div v-for="s in networth.bySubject" :key="s.subject" class="health-row">
          <span class="hint" style="flex:1;min-width:150px">{{ s.subject }} <span style="color:var(--ink-2)">{{ t('views.health.countCards', undefined, { n: s.count }) }}</span></span>
          <div class="nw-track"><div class="nw-bar" :style="{ width: Math.max(4, s.retentionRate) + '%' }"></div></div>
          <span class="hint" style="min-width:150px;text-align:right">{{ t('views.health.nwValueLabel') }} {{ s.value }} {{ t('views.health.nwIdealLabel') }} {{ s.ideal }} · {{ s.retentionRate }}%</span>
        </div>
      </div>
    </div>

    <!-- 来源资产（源→卡→数据全血缘） -->
    <div v-if="sources" class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">{{ t('views.health.sourcesTitle') }}</span>
        <span class="hint">{{ t('views.health.sourcesHintPrefix') }}{{ t('views.health.sourcesHintSources', undefined, { n: sources.totalSources }) }}{{ sources.variantCount ? t('views.health.sourcesHintVariant', undefined, { n: sources.variantCount }) : '' }}{{ sources.untraced ? t('views.health.sourcesHintUntraced', undefined, { n: sources.untraced }) : '' }}{{ t('views.health.sourcesHintSuffix') }}</span>
      </div>
      <div v-if="sources.bySource.length" style="margin-top:10px">
        <div v-for="s in sources.bySource" :key="s.source" class="health-row">
          <span class="hint" style="flex:1;min-width:150px">{{ s.source }} <span style="color:var(--ink-2)">{{ t('views.health.countCards', undefined, { n: s.cards }) }}</span></span>
          <div class="nw-track"><div class="nw-bar" :style="{ width: Math.max(4, s.mastery) + '%' }"></div></div>
          <span class="hint" style="min-width:200px;text-align:right">{{ t('views.health.srcValuePrefix') }}{{ s.value }} {{ t('views.health.srcReviewed') }}{{ s.reviewed }}{{ s.due ? t('views.health.srcDue', undefined, { n: s.due }) : '' }}{{ s.marked ? t('views.health.srcMarked', undefined, { n: s.marked }) : '' }}</span>
        </div>
      </div>
      <EmptyState v-else compact icon="🧾" :title="t('views.health.sourceEmptyTitle')" :message="t('views.health.sourceEmptyMsg')" />
    </div>

    <!-- 重复卡 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">{{ t('views.health.dupTitlePrefix') }}{{ health?.duplicates.length || 0 }}{{ t('views.health.dupTitleSuffix') }}</span>
        <span class="hint">{{ t('views.health.dupHint') }}</span>
        <span style="flex:1"></span>
        <button v-if="health?.duplicates.length" class="btn small" @click="jumpCards({dupGroup: '__all__', expandAll: '1'})">{{ t('views.health.viewAll') }}</button>
        <button v-if="health?.duplicates.length" class="btn small primary" @click="dedupeAll">{{ t('views.health.dedupeAllBtn') }}</button>
      </div>
      <div v-if="health && !health.duplicates.length" class="hint" style="margin-top:8px">{{ t('views.health.dupEmpty') }}</div>
      <div v-for="g in health?.duplicates || []" :key="g.key" class="health-row clickable" @click="openDuplicates(g)">
        <span class="hint" style="flex:1">[{{ g.subject }}] {{ g.front.slice(0, 40) }} <b style="color:var(--red)">×{{ g.n }}</b></span>
        <span class="hint">{{ t('views.health.dupClickView') }}</span>
        <button class="btn small" @click.stop="openDuplicates(g)">{{ t('views.health.expandCompare') }}</button>
        <button class="btn small primary" @click.stop="dedupeGroup(g)">{{ t('views.health.mergeDedupe') }}</button>
      </div>
    </div>

    <!-- 僵尸卡 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">{{ t('views.health.zombieTitlePrefix') }}{{ health?.zombieCount || 0 }}{{ t('views.health.zombieTitleSuffix') }}</span>
        <span class="hint">{{ t('views.health.zombieHint') }}</span>
        <span style="flex:1"></span>
        <button v-if="health?.zombieCount" class="btn small" @click="openZombies">{{ t('views.health.zombieViewDetail') }}</button>
        <button v-if="health?.zombieCount" class="btn small" @click="removeZombies">{{ t('views.health.zombieClean') }}</button>
      </div>
      <div v-if="health && !health.zombieCount" class="hint" style="margin-top:8px">{{ t('views.health.zombieEmpty') }}</div>
      <div v-for="z in health?.zombies || []" :key="z.id" class="health-row clickable" @click="jumpCards({zombie:'1', expandAll:'1'})">
        <span class="hint" style="flex:1">[{{ z.subject }}] {{ z.front }}</span>
        <span class="hint">{{ t('views.health.zombieCreatedAt') }}{{ new Date(z.createdAt).toLocaleDateString() }}</span>
        <button class="btn small" @click.stop="openZombies">{{ t('views.health.browse') }}</button>
      </div>
    </div>

    <!-- 孤儿图片 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">{{ t('views.health.orphanTitlePrefix') }}{{ health?.orphanImageCount || 0 }}{{ t('views.health.orphanTitleSuffix') }}</span>
        <span class="hint">{{ t('views.health.orphanHint') }}</span>
        <span style="flex:1"></span>
        <button v-if="health?.orphanImageCount" class="btn small" @click="openOrphans">{{ t('views.health.orphanPreview') }}</button>
        <button v-if="health?.orphanImageCount" class="btn small" @click="cleanOrphanImages">{{ t('views.health.orphanClean') }}</button>
      </div>
      <div v-if="health && !health.orphanImageCount" class="hint" style="margin-top:8px">{{ t('views.health.orphanEmpty') }}</div>
    </div>

    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">{{ t('views.health.untaggedTitlePrefix') }}{{ health?.untaggedCount || 0 }}{{ t('views.health.untaggedTitleSuffix') }}</span>
        <span class="hint">{{ t('views.health.untaggedHint') }}</span>
        <span style="flex:1"></span>
        <button v-if="health?.untaggedCount" class="btn small primary" @click="openUntagged">{{ t('views.health.untaggedViewAll') }}</button>
      </div>
      <p class="hint" style="margin-top:6px">{{ t('views.health.untaggedSuggest') }}</p>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.stat-cards { display: flex; gap: 12px; flex-wrap: wrap; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 22px; text-align: center; cursor: default; }
.stat .num { font-size: 24px; font-weight: 700; }
.stat.clickable { cursor: pointer; transition: box-shadow .15s, border-color .15s, transform .15s; }
.stat.clickable:hover { border-color: var(--brand, var(--ink-2)); box-shadow: 0 2px 8px rgba(0,0,0,.08); transform: translateY(-1px); }
.health-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.health-row:last-child { border-bottom: none; }
.health-row.clickable { cursor: pointer; border-radius: 8px; padding: 8px 8px; }
.health-row.clickable:hover { background: var(--code-bg); border-color: var(--line); }
.nw-track { flex: 1; min-width: 100px; height: 8px; background: var(--code-bg); border-radius: 99px; overflow: hidden; }
.nw-bar { height: 100%; background: linear-gradient(90deg, var(--blue), var(--green)); border-radius: 99px; transition: width .4s ease; }
</style>