<script setup>
// 资产体检（E1 数字资产保值批）：重复卡 / 僵尸卡 / 孤儿图片 / 无标签卡 检测与清理
// 所有删除走 deleteCard（墓碑跨设备传播）+ 图片直接清理，保证多端一致
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getAssetHealth, getNetWorth, getSourceOverview } from '../agent/analytics.js';
import { deleteCard } from '../repo.js';
import { db } from '../db.js';
import { toast } from '../utils/toast.js';
import { T } from '../utils/telemetry.js';

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
  if (!(await confirmDialog(`这组有 ${g.n} 张重复卡，保留最新编辑的 1 张、删除其余 ${g.n - 1} 张？`))) return;
  const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const remove = sorted.slice(1);
  for (const c of remove) await deleteCard(c.id);
  toast(`已删除 ${remove.length} 张重复卡（保留「${sorted[0].front.slice(0, 20)}…」）`, 'success');
  await load();
}
async function dedupeAll() {
  if (!health.value?.duplicates.length) return;
  const total = health.value.duplicates.reduce((s, g) => s + g.n - 1, 0);
  if (!(await confirmDialog(`共发现 ${total} 张重复卡（每组保留 1 张），全部清理？`))) return;
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
  if (!(await confirmDialog(`删除 ${health.value.zombies.length} 张「僵尸卡」（90 天以上从未复习且早已到期）？如只是暂时不用可忽略`))) return;
  for (const z of health.value.zombies) await deleteCard(z.id);
  toast('僵尸卡已清理', 'success');
  await load();
}
async function cleanOrphanImages() {
  if (!health.value?.orphanImages.length) return;
  if (!(await confirmDialog(`清理 ${health.value.orphanImages.length} 张无引用的孤儿图片（可释放本地空间）？`))) return;
  for (const i of health.value.orphanImages) await db.images.delete(i.id);
  toast('孤儿图片已清理', 'success');
  await load();
}

// P2-24 一键修复：串联可安全自动化的清理项（重复卡每组留最新 1 张 + 僵尸卡 + 孤儿图片），合并为单次确认
async function fixAll() {
  const h = health.value; if (!h) return;
  const dupTotal = h.duplicates.reduce((s, g) => s + g.n - 1, 0);
  const zombN = h.zombieCount || 0;
  const orphanN = h.orphanImageCount || 0;
  if (!dupTotal && !zombN && !orphanN) { toast('资产已健康，无需修复', 'success'); return; }
  const detail = `删除 ${dupTotal} 张重复卡（每组保留最新 1 张）、清理 ${zombN} 张僵尸卡、清理 ${orphanN} 张孤儿图片` +
    `（无标签卡 ${h.untaggedCount || 0} 张需手动补标签，不在自动列）`;
  if (!(await confirmDialog(`一键修复将：${detail}。确认执行？`))) return;
  busy.value = true;
  try {
    let n = 0;
    for (const g of h.duplicates) {
      const sorted = [...g.cards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const c of sorted.slice(1)) { await deleteCard(c.id); n++; }
    }
    for (const z of h.zombies) await deleteCard(z.id);
    for (const i of h.orphanImages) await db.images.delete(i.id);
    toast(`一键修复完成：清理 ${n} 张重复卡、${zombN} 张僵尸卡、${orphanN} 张孤儿图片`, 'success');
    await load();
  } catch (e) { toast(e.message || '修复失败', 'error'); }
  finally { busy.value = false; }
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
      <button class="btn small primary" :disabled="busy || !fixableCount" @click="fixAll">一键修复{{ fixableCount ? `（${fixableCount}）` : '' }}</button>
    </div>

    <div v-if="health" class="stat-cards" style="margin-top:14px">
      <div class="stat"><div class="num">{{ health.totalCards }}</div><div class="hint">总卡片（资产数）</div></div>
      <div class="stat clickable" title="查看全部重复卡" @click="jumpCards({dupGroup: '__all__', expandAll: '1'})"><div class="num" :style="{ color: health.duplicates.length ? 'var(--red)' : 'var(--green)' }">{{ health.duplicates.reduce((s, g) => s + g.n - 1, 0) }}</div><div class="hint">重复卡</div></div>
      <div class="stat clickable" title="查看僵尸卡" @click="openZombies"><div class="num" :style="{ color: health.zombieCount ? 'var(--amber)' : 'var(--green)' }">{{ health.zombieCount }}</div><div class="hint">僵尸卡</div></div>
      <div class="stat clickable" title="查看孤儿图片" @click="openOrphans"><div class="num" :style="{ color: health.orphanImageCount ? 'var(--amber)' : 'var(--green)' }">{{ health.orphanImageCount }}</div><div class="hint">孤儿图片</div></div>
      <div class="stat clickable" title="查看无标签卡" @click="openUntagged"><div class="num">{{ health.untaggedCount }}</div><div class="hint">无标签卡</div></div>
    </div>

    <!-- 知识净值（资产负债表） -->
    <div v-if="networth" class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">知识净值</span>
        <span class="hint">卡片库「资产负债表」：资产原值 − 遗忘折旧 = 净值（按记忆保持度 R 折算）</span>
      </div>
      <div class="stat-cards" style="margin-top:10px">
        <div class="stat"><div class="num">{{ networth.totalValue }}</div><div class="hint">知识净值</div></div>
        <div class="stat"><div class="num">{{ networth.idealValue }}</div><div class="hint">资产原值</div></div>
        <div class="stat"><div class="num" :style="{ color: networth.decayedValue > 0 ? 'var(--amber)' : 'var(--green)' }">{{ networth.decayedValue }}</div><div class="hint">遗忘折旧</div></div>
        <div class="stat"><div class="num" :style="{ color: networth.retentionRate >= 90 ? 'var(--green)' : networth.retentionRate >= 70 ? 'var(--amber)' : 'var(--red)' }">{{ networth.retentionRate }}%</div><div class="hint">知识保持率</div></div>
        <div class="stat"><div class="num">{{ networth.masteredCount }}</div><div class="hint">已掌握</div></div>
        <div class="stat"><div class="num">{{ networth.newCount }}</div><div class="hint">待复习(新)</div></div>
      </div>
      <div v-if="networth.bySubject.length" style="margin-top:14px">
        <div class="hint" style="margin-bottom:6px">按科目净值（保持率条越长 = 记得越牢）</div>
        <div v-for="s in networth.bySubject" :key="s.subject" class="health-row">
          <span class="hint" style="flex:1;min-width:150px">{{ s.subject }} <span style="color:var(--ink-2)">（{{ s.count }} 张）</span></span>
          <div class="nw-track"><div class="nw-bar" :style="{ width: Math.max(4, s.retentionRate) + '%' }"></div></div>
          <span class="hint" style="min-width:150px;text-align:right">净值 {{ s.value }} / 原值 {{ s.ideal }} · {{ s.retentionRate }}%</span>
        </div>
      </div>
    </div>

    <!-- 来源资产（源→卡→数据全血缘） -->
    <div v-if="sources" class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">来源资产</span>
        <span class="hint">卡片按「来源」聚合的资产视图（{{ sources.totalSources }} 个来源{{ sources.variantCount ? ` · ${sources.variantCount} 张变式卡` : '' }}{{ sources.untraced ? ` · ${sources.untraced} 张无来源` : '' }}）</span>
      </div>
      <div v-if="sources.bySource.length" style="margin-top:10px">
        <div v-for="s in sources.bySource" :key="s.source" class="health-row">
          <span class="hint" style="flex:1;min-width:150px">{{ s.source }} <span style="color:var(--ink-2)">（{{ s.cards }} 张）</span></span>
          <div class="nw-track"><div class="nw-bar" :style="{ width: Math.max(4, s.mastery) + '%' }"></div></div>
          <span class="hint" style="min-width:200px;text-align:right">净值 {{ s.value }} · 已复习 {{ s.reviewed }}{{ s.due ? ` · 待背 ${s.due}` : '' }}{{ s.marked ? ` · 错题 ${s.marked}` : '' }}</span>
        </div>
      </div>
      <div v-else class="hint" style="margin-top:8px">暂无卡片来源数据。</div>
    </div>

    <!-- 重复卡 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">重复卡（{{ health?.duplicates.length || 0 }} 组）</span>
        <span class="hint">相同正反面+科目的卡重复入库</span>
        <span style="flex:1"></span>
        <button v-if="health?.duplicates.length" class="btn small" @click="jumpCards({dupGroup: '__all__', expandAll: '1'})">查看全部</button>
        <button v-if="health?.duplicates.length" class="btn small primary" @click="dedupeAll">全部清理（每组保留最新 1 张）</button>
      </div>
      <div v-if="health && !health.duplicates.length" class="hint" style="margin-top:8px">✅ 没有重复卡，资产很干净</div>
      <div v-for="g in health?.duplicates || []" :key="g.key" class="health-row clickable" @click="openDuplicates(g)">
        <span class="hint" style="flex:1">[{{ g.subject }}] {{ g.front.slice(0, 40) }} <b style="color:var(--red)">×{{ g.n }}</b></span>
        <span class="hint">点击查看完整组</span>
        <button class="btn small" @click.stop="openDuplicates(g)">展开对比</button>
        <button class="btn small primary" @click.stop="dedupeGroup(g)">合并去重</button>
      </div>
    </div>

    <!-- 僵尸卡 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">僵尸卡（{{ health?.zombieCount || 0 }} 张）</span>
        <span class="hint">创建超 90 天、从未复习且早已到期</span>
        <span style="flex:1"></span>
        <button v-if="health?.zombieCount" class="btn small" @click="openZombies">查看详情（展开背诵效果）</button>
        <button v-if="health?.zombieCount" class="btn small" @click="removeZombies">清理僵尸卡</button>
      </div>
      <div v-if="health && !health.zombieCount" class="hint" style="margin-top:8px">✅ 没有僵尸卡</div>
      <div v-for="z in health?.zombies || []" :key="z.id" class="health-row clickable" @click="jumpCards({zombie:'1', expandAll:'1'})">
        <span class="hint" style="flex:1">[{{ z.subject }}] {{ z.front }}</span>
        <span class="hint">创建于 {{ new Date(z.createdAt).toLocaleDateString() }}</span>
        <button class="btn small" @click.stop="openZombies">浏览</button>
      </div>
    </div>

    <!-- 孤儿图片 -->
    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">孤儿图片（{{ health?.orphanImageCount || 0 }} 张）</span>
        <span class="hint">已无任何卡片引用，占用本地存储</span>
        <span style="flex:1"></span>
        <button v-if="health?.orphanImageCount" class="btn small" @click="openOrphans">预览/批量清理</button>
        <button v-if="health?.orphanImageCount" class="btn small" @click="cleanOrphanImages">清理孤儿图片</button>
      </div>
      <div v-if="health && !health.orphanImageCount" class="hint" style="margin-top:8px">✅ 没有孤儿图片</div>
    </div>

    <div class="panel" style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="field-label" style="margin:0">无标签卡（{{ health?.untaggedCount || 0 }} 张）</span>
        <span class="hint">标签是复习筛选、易混对决与 AI 上下文的关键资产元数据。</span>
        <span style="flex:1"></span>
        <button v-if="health?.untaggedCount" class="btn small primary" @click="openUntagged">全部查看（默认全展开背诵效果）</button>
      </div>
      <p class="hint" style="margin-top:6px">建议按科目批量补标签（卡片页筛选出无标签卡后编辑，或建卡时养成加标签习惯）。</p>
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