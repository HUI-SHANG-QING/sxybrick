<script setup>
// 成就体系（借鉴 Progress AI，纯本地判定）：进入页面即时评估，新解锁自动落库并随数据包同步
// P4 学习成长树：把扁平成就按 category 分组渲染成一棵随解锁进度生长的 SVG 树
import { ref, computed, onMounted } from 'vue';
import { evaluateAchievements } from '../achievements.js';
import { unlockAchievement } from '../repo.js';
import { toast } from '../utils/toast.js';

const items = ref([]);
const unlockedCount = ref(0);
const checking = ref(true);
const treeOpen = ref(true);

function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function refresh() {
  checking.value = true;
  try {
    const all = await evaluateAchievements();
    const fresh = [];
    for (const a of all) {
      if (!a.unlocked && a.value >= a.goal) {
        if (await unlockAchievement(a.key)) fresh.push(a.name);
      }
    }
    items.value = await evaluateAchievements();
    unlockedCount.value = items.value.filter(x => x.unlocked).length;
    if (fresh.length) {
      toast(`🎉 解锁新成就：${fresh.join('、')}`, 'success', 4000);
    }
  } finally { checking.value = false; }
}

// 成长树：按 category 聚合为枝，计算每枝的生长进度
const BRANCH_ORDER = ['建卡', '复习', '打卡', '专注', '图谱', '文档', '计划', '记忆', '费曼', '导图', '复盘'];
const treeBranches = computed(() => {
  const map = new Map();
  for (const a of items.value) {
    const cat = a.category || '其他';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(a);
  }
  const branches = [];
  let i = 0;
  for (const cat of BRANCH_ORDER) {
    const arr = map.get(cat) || [];
    if (!arr.length) continue;
    const unlocked = arr.filter(a => a.unlocked);
    const ratio = arr.length ? unlocked.length / arr.length : 0;
    const side = i % 2 === 0 ? -1 : 1;     // 左右交替
    const yLevel = i;                       // 沿主干向上的层数
    branches.push({
      cat, side, yLevel,
      icon: unlocked.length ? unlocked[unlocked.length - 1].icon : arr[0].icon,
      total: arr.length, unlocked: unlocked.length, ratio,
      alive: unlocked.length > 0,
      len: 38 + ratio * 46,                // 枝条长度随该类进度增长
    });
    i++;
  }
  return branches;
});
const trunkRatio = computed(() => {
  const t = items.value.length || 1;
  return Math.min(1, unlockedCount.value / t);
});
const trunkH = computed(() => 70 + trunkRatio.value * 300);
const totalRatio = computed(() => Math.round(trunkRatio.value * 100));

// 成长树坐标辅助：枝条沿主干向上排布，左右交替伸出
const BASE_Y = 445;
const BRANCH_GAP = 30;
const BRANCH_START_OFFSET = 28;
function branchY(b) { return BASE_Y - BRANCH_START_OFFSET - b.yLevel * BRANCH_GAP; }
function branchEndX(b) { return 200 + b.side * b.len; }
function branchEndY(b) { return branchY(b) - 12; }
function branchLabelX(b) { return 200 + b.side * (b.len + 6); }
function branchPath(b) {
  const sy = branchY(b);
  const ex = branchEndX(b);
  const ey = branchEndY(b);
  const cx = 200 + b.side * (b.len * 0.5);
  const cy = sy - 4;
  return `M200 ${sy} Q${cx} ${cy} ${ex} ${ey}`;
}

onMounted(refresh);
</script>

<template>
  <div class="ach-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">成就</h2>
      <span class="hint">{{ checking ? '评估中…' : `已解锁 ${unlockedCount} / ${items.length}` }}</span>
      <span style="flex:1"></span>
      <button class="btn small" @click="refresh">重新评估</button>
    </div>
    <p class="hint" style="margin:4px 0 14px">跟着你的学习足迹自动解锁：建卡、复习、打卡、专注、图谱、文档、计划……成就数据保存在本机并跨设备同步。</p>

    <!-- P4 学习成长树 -->
    <div class="tree-panel" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span class="tree-title">🌳 学习成长树</span>
        <span class="hint">主干高度 = 总解锁进度 {{ totalRatio }}%</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="treeOpen = !treeOpen">{{ treeOpen ? '收起' : '展开' }}</button>
      </div>
      <div v-if="treeOpen" class="tree-svg-wrap">
        <svg viewBox="0 0 400 460" class="tree-svg" preserveAspectRatio="xMidYMax meet">
          <!-- 地面 -->
          <ellipse cx="200" cy="445" rx="120" ry="14" fill="var(--code-inline)" />
          <!-- 主干：随总解锁进度长高 -->
          <path :d="`M200 445 L198 ${445 - trunkH} Q200 ${445 - trunkH - 8} 202 ${445 - trunkH - 6}`"
                :stroke="trunkRatio > 0 ? 'var(--green)' : 'var(--ink-3, #bbb)'" stroke-width="10"
                :stroke-linecap="'round'" fill="none" />
          <!-- 树冠光晕（解锁越多越亮） -->
          <circle v-if="trunkRatio > 0.05" cx="200" :cy="445 - trunkH - 4" :r="18 + trunkRatio * 26"
                  fill="var(--green)" opacity="0.12" />
          <!-- 分枝 -->
          <g v-for="(b, i) in treeBranches" :key="b.cat">
            <!-- 每层 y：从主干下方向上排布 -->
            <path :d="branchPath(b)"
                  :stroke="b.alive ? 'var(--green)' : 'var(--ink-3, #bbb)'" stroke-width="3.5"
                  stroke-linecap="round" fill="none" />
            <!-- 果实/花蕾 -->
            <text :x="branchEndX(b)" :y="branchEndY(b) + 6" text-anchor="middle"
                  :font-size="b.alive ? 22 : 16" :opacity="b.alive ? 1 : 0.4">{{ b.alive ? b.icon : '🌱' }}</text>
            <!-- 分类标签 -->
            <text :x="branchLabelX(b)" :y="branchEndY(b) + 22" text-anchor="middle"
                  font-size="10" fill="var(--ink-2)">{{ b.cat }} {{ b.unlocked }}/{{ b.total }}</text>
          </g>
        </svg>
        <p class="hint" style="text-align:center;margin:6px 0 0">
          每条枝代表一个学习维度，结出果实 = 该类已有成就解锁；主干越高 = 整体成长越深。
        </p>
      </div>
    </div>

    <div class="ach-grid">
      <div v-for="a in items" :key="a.key" class="ach-card" :class="{ unlocked: a.unlocked }">
        <div class="ach-icon">{{ a.icon }}</div>
        <div class="ach-name">{{ a.name }}</div>
        <div class="ach-desc">{{ a.desc }}</div>
        <div v-if="a.unlocked" class="ach-date">解锁于 {{ fmtDate(a.unlockedAt) }}</div>
        <div v-else class="ach-progress">
          <div class="bar"><div class="fill" :style="{ width: Math.round(a.progress * 100) + '%' }"></div></div>
          <div class="ach-num">{{ Math.round(Math.min(a.value, a.goal)) }} / {{ a.goal }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ach-wrap { max-width: 900px; margin: 0 auto; }
.tree-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
.tree-title { font-weight: 700; font-size: 15px; }
.tree-svg-wrap { max-width: 420px; margin: 0 auto; }
.tree-svg { width: 100%; height: auto; display: block; }
.ach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.ach-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 14px; text-align: center; opacity: 0.75; }
.ach-card.unlocked { opacity: 1; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.ach-icon { font-size: 30px; }
.ach-name { font-weight: 700; margin-top: 6px; }
.ach-desc { font-size: 12px; color: var(--ink-2); margin-top: 4px; min-height: 30px; }
.ach-date { font-size: 11px; color: var(--green); margin-top: 6px; }
.ach-progress { margin-top: 8px; }
.bar { height: 6px; background: var(--code-inline); border-radius: 999px; overflow: hidden; }
.fill { height: 100%; background: var(--accent); border-radius: 999px; }
.ach-num { font-size: 11px; color: var(--ink-2); margin-top: 4px; }
</style>