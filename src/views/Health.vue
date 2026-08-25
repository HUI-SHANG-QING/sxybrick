<script setup>
// 资产体检（E1 数字资产保值批）：重复卡 / 僵尸卡 / 孤儿图片 / 无标签卡 检测与清理
// 所有删除走 deleteCard（墓碑跨设备传播）+ 图片直接清理，保证多端一致
import { ref, onMounted } from 'vue';
import { getAssetHealth } from '../agent/analytics.js';
import { deleteCard } from '../repo.js';
import { db } from '../db.js';
import { toast } from '../utils/toast.js';

const health = ref(null);
const busy = ref(false);

async function load() {
  busy.value = true;
  try { health.value = await getAssetHealth(); }
  catch (e) { toast(e.message, 'error'); }
  finally { busy.value = false; }
}

// 合并重复组：保留最新编辑的一张，删除组内其余（复习记录随卡级联清理）
async function dedupeGroup(g) {
  if (!confirm(`这组有 ${g.n} 张重复卡，保留最新编辑的 1 张、删除其余 ${g.n - 1} 张？`)) return;
  const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const remove = sorted.slice(1);
  for (const c of remove) await deleteCard(c.id);
  toast(`已删除 ${remove.length} 张重复卡（保留「${sorted[0].front.slice(0, 20)}…」）`, 'success');
  await load();
}
async function dedupeAll() {
  if (!health.value?.duplicates.length) return;
  const total = health.value.duplicates.reduce((s, g) => s + g.n - 1, 0);
  if (!confirm(`共发现 ${total} 张重复卡（每组保留 1 张），全部清理？`)) return;
  let n = 0;
  for (const g of health.value.duplicates) {
    const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const c of sorted.slice(1)) { await deleteCard(c.id); n++; }
  }
  toast(`已清理 ${n} 张重复卡`, 'success');
  await load();
}
async function removeZombies() {
  if (!health.value?.zombies.length) return;
  if (!confirm(`删除 ${health.value.zombies.length} 张「僵尸卡」（90 天以上从未复习且早已到期）？如只是暂时不用可忽略`)) return;
  for (const z of health.value.zombies) await deleteCard(z.id);
  toast('僵尸卡已清理', 'success');
  await load();
}
async function cleanOrphanImages() {
  if (!health.value?.orphanImages.length) return;
  if (!confirm(`清理 ${health.value.orphanImages.length} 张无引用的孤儿图片（可释放本地空间）？`)) return;
  for (const i of health.value.orphanImages) await db.images.delete(i.id);
  toast('孤儿图片已清理', 'success');
  await load();
}

onMounted(load);
</script>

<template>
  <div style="max-width:860px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">资产体检</h2>
      <span class="hint">数字资产健康度：重复 · 僵尸 · 断链 · 缺标签</span>
      <span style="flex:1"></span>
      <button class="btn small" :disabled="busy" @click="load">重新体检</button>
    </div>

    <div v-if="health" class="stat-cards" style="margin-top:14px">
      <div class="stat"><div class="num">{{ health.totalCards }}</div><div class="hint">总卡片（资产数）</div></div>
      <div class="stat"><div class="num" :style="{ color: health.duplicates.length ? 'var(--red)' : 'var(--green)' }">{{ health.duplicates.reduce((s, g) => s + g.n - 1, 0) }}</div><div class="hint">重复卡</div></div>
      <div class="stat"><div class="num" :style="{ color: health.zombieCount ? 'var(--amber)' : 'var(--green)' }">{{ health.zombieCount }}</div><div class="hint">僵尸卡</div></div>
      <div class="stat"><div class="num" :style="{ color: health.orphanImageCount ? 'var(--amber)' : 'var(--green)' }">{{ health.orphanImageCount }}</div><div class="hint">孤儿图片</div></div>
      <div class="stat"><div class="num">{{ health.untaggedCount }}</div><div class="hint">无标签卡</div></div>
    </div>

    <!-- 重复卡 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">重复卡（{{ health?.duplicates.length || 0 }} 组）</span>
        <span class="hint">相同正反面+科目的卡重复入库</span>
        <span style="flex:1"></span>
        <button v-if="health?.duplicates.length" class="btn small primary" @click="dedupeAll">全部清理（每组保留最新 1 张）</button>
      </div>
      <div v-if="health && !health.duplicates.length" class="hint" style="margin-top:8px">✅ 没有重复卡，资产很干净</div>
      <div v-for="g in health?.duplicates || []" :key="g.key" class="health-row">
        <span class="hint" style="flex:1">[{{ g.subject }}] {{ g.front.slice(0, 40) }} <b style="color:var(--red)">×{{ g.n }}</b></span>
        <button class="btn small" @click="dedupeGroup(g)">合并去重</button>
      </div>
    </div>

    <!-- 僵尸卡 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">僵尸卡（{{ health?.zombieCount || 0 }} 张）</span>
        <span class="hint">创建超 90 天、从未复习且早已到期</span>
        <span style="flex:1"></span>
        <button v-if="health?.zombieCount" class="btn small" @click="removeZombies">清理僵尸卡</button>
      </div>
      <div v-if="health && !health.zombieCount" class="hint" style="margin-top:8px">✅ 没有僵尸卡</div>
      <div v-for="z in health?.zombies || []" :key="z.id" class="health-row">
        <span class="hint" style="flex:1">[{{ z.subject }}] {{ z.front }}</span>
        <span class="hint">创建于 {{ new Date(z.createdAt).toLocaleDateString() }}</span>
      </div>
    </div>

    <!-- 孤儿图片 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">孤儿图片（{{ health?.orphanImageCount || 0 }} 张）</span>
        <span class="hint">已无任何卡片引用，占用本地存储</span>
        <span style="flex:1"></span>
        <button v-if="health?.orphanImageCount" class="btn small" @click="cleanOrphanImages">清理孤儿图片</button>
      </div>
      <div v-if="health && !health.orphanImageCount" class="hint" style="margin-top:8px">✅ 没有孤儿图片</div>
    </div>

    <div class="panel" style="margin-top:14px">
      <span class="field-label" style="margin:0">无标签卡（{{ health?.untaggedCount || 0 }} 张）</span>
      <p class="hint" style="margin-top:6px">标签是复习筛选、易混对决与 AI 上下文的关键资产元数据。建议按科目批量补标签（卡片页筛选出无标签卡后编辑，或建卡时养成加标签习惯）。</p>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.stat-cards { display: flex; gap: 12px; flex-wrap: wrap; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 22px; text-align: center; }
.stat .num { font-size: 24px; font-weight: 700; }
.health-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.health-row:last-child { border-bottom: none; }
</style>