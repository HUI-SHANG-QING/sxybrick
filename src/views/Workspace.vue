<script setup>
// 个人工作台 V2（基于 v1 二次开发升级）：覆盖全部 30 模块的可视化指挥中心。
// 分层：Workspace.vue（渲染）→ src/workspace/overview.js（数据聚合）→ analytics/repo/db（只读）。
// 单向调用：唯一刷新入口 loadAll()，各区块由 computed 独立派生，渲染函数之间零互调（防循环）。
// 数据安全：只读不写库，不新增数据表，单模块指标失败显示 — 不影响整页。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { getWorkspaceOverview } from '../workspace/overview.js';
import { MODULE_GROUPS } from '../workspace/modules.js';
import { listNotifications, unreadCount } from '../agent/proactive.js';
import { db } from '../db.js';

const router = useRouter();

const data = ref(null);
const loading = ref(true);
const filter = ref('');
const notifications = ref([]);
const unread = ref(0);
const recentActivity = ref([]);

// ---------- 唯一刷新入口（铁律 9：各渲染块独立读数据，互不调用） ----------
async function loadAll() {
  loading.value = true;
  try { data.value = await getWorkspaceOverview(); } catch (e) { console.error('[workspace] 聚合失败', e); }
  await Promise.all([loadNotifications(), loadActivity()]);
  loading.value = false;
}
async function loadNotifications() {
  try {
    notifications.value = await listNotifications(12);
    unread.value = await unreadCount();
  } catch { /* noop */ }
}
async function loadActivity() {
  try {
    const reviews = await db.reviews.orderBy('reviewedAt').reverse().limit(8).toArray();
    const ids = [...new Set(reviews.map(r => r.cardId))];
    const cards = await db.cards.bulkGet(ids);
    const map = new Map(cards.filter(Boolean).map(c => [c.id, c]));
    recentActivity.value = reviews.map(r => ({
      id: r.id, front: (map.get(r.cardId)?.front || '').slice(0, 36),
      rating: r.rating, at: r.reviewedAt,
    }));
  } catch { recentActivity.value = []; }
}

// ---------- 派生数据（纯计算） ----------
const metric = (key) => data.value?.modules?.[key] || { n: null, warn: false };
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const SUFFIX = { stats: '%' };
const metricText = (key) => {
  const v = metric(key).n;
  return v == null ? '—' : fmtNum(v) + (SUFFIX[key] || '');
};

const dueToday = computed(() => data.value?.stats?.dueToday || 0);
const overdue = computed(() => data.value?.overdue || 0);
const doneToday = computed(() => data.value?.stats?.todayReviews || 0);
const avgMastery = computed(() => data.value?.stats?.avgMastery || 0);
const profileScore = computed(() => data.value?.profile?.score ?? null);
const profileLevel = computed(() => data.value?.profile?.level || '');
const online = computed(() => data.value?.meta?.online ?? true);
const lastSync = computed(() => data.value?.meta?.lastSync || 0);

const kpis = computed(() => [
  { label: '学习画像分', value: profileScore.value == null ? '—' : profileScore.value, icon: '🧭', path: '/health', hint: profileLevel.value },
  { label: '卡片总数', value: fmtNum(data.value?.stats?.totalCards), icon: '🗂️', path: '/cards', hint: '全科目' },
  { label: '今日待复习', value: fmtNum(dueToday.value), icon: '📖', path: '/review', hint: dueToday.value ? '快去清' : '今日无到期' },
  { label: '今日已复习', value: fmtNum(doneToday.value), icon: '✅', path: '/stats', hint: '去重计数' },
  { label: '平均掌握度', value: avgMastery.value + '%', icon: '🎯', path: '/stats', hint: '近 90 天' },
  { label: '今日番茄', value: fmtNum(data.value?.insight?.pomodoro?.today), icon: '🍅', path: '/pomodoro', hint: '专注次数' },
]);

// 模块矩阵：分组 + 搜索过滤（过滤只影响展示，不触发其它渲染）
const groups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return MODULE_GROUPS.map(g => ({
    ...g,
    modules: g.modules.filter(m => !q || m.label.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q)),
  })).filter(g => g.modules.length);
});

const riskTop = computed(() => (data.value?.risks || []).slice(0, 3));
const healthItems = computed(() => {
  const h = data.value?.health;
  if (!h) return [];
  return [
    { label: '重复卡', n: h.duplicates?.length || 0, path: '/health' },
    { label: '僵尸卡', n: h.zombieCount || 0, path: '/health' },
    { label: '孤儿图片', n: h.orphanImageCount || 0, path: '/health' },
  ];
});
const diagTop = computed(() => [...(data.value?.diag || [])].sort((a, b) => a.mastery - b.mastery).slice(0, 3));

// ---------- 交互 ----------
function go(path) { router.push(path); }
function ratingLabel(r) { return r === 2 ? '答对' : r === 1 ? '模糊' : '答错'; }
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), diff = Date.now() - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtSync(ts) {
  if (!ts) return '未同步';
  const d = new Date(ts);
  return `同步于 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let timer = null;
onMounted(() => {
  loadAll();
  timer = setInterval(loadNotifications, 20000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="ws-wrap">
    <!-- 头部：标题 + 同步状态 + 备份/刷新 -->
    <div class="ws-head">
      <div>
        <h1 class="ws-title">个人工作台</h1>
        <p class="ws-sub">全模块可视化指挥中心 · {{ groups.reduce((s, g) => s + g.modules.length, 0) }}/30 模块</p>
      </div>
      <div class="ws-head-actions">
        <span class="ws-sync" :class="online ? 'on' : 'off'" :title="online ? fmtSync(lastSync) : '当前离线'">
          <i class="ws-sync-dot"></i>{{ online ? fmtSync(lastSync) : '离线模式' }}
        </span>
        <button class="ws-btn" @click="go('/export')">💾 备份</button>
        <button class="ws-btn primary" @click="loadAll" :disabled="loading">{{ loading ? '加载中…' : '↻ 刷新' }}</button>
      </div>
    </div>

    <!-- 今日要处理（置顶，逾期标红 + 一键处理 + 顺延提示） -->
    <section class="ws-today">
      <div class="ws-today-main">
        <div class="ws-today-due">{{ fmtNum(dueToday) }}</div>
        <div class="ws-today-label">今日待复习</div>
        <button class="ws-today-go" @click="go('/review')">{{ dueToday ? '开始复习 →' : '今日无到期，去复习 →' }}</button>
        <p v-if="overdue" class="ws-today-overdue">⚠️ 昨日遗留 {{ fmtNum(overdue) }} 张未清，已顺延至今天，优先处理</p>
      </div>
      <div class="ws-today-side">
        <div class="ws-mini"><span class="ws-mini-n">{{ fmtNum(doneToday) }}</span><span class="ws-mini-l">今日已复习</span></div>
        <div class="ws-mini"><span class="ws-mini-n">{{ avgMastery }}%</span><span class="ws-mini-l">平均掌握度</span></div>
        <div class="ws-mini" :class="{ warn: riskTop.length }"><span class="ws-mini-n">{{ riskTop.length }}</span><span class="ws-mini-l">遗忘风险</span></div>
      </div>
    </section>

    <!-- 关键指标看板 -->
    <section class="ws-kpis">
      <div v-for="k in kpis" :key="k.label" class="ws-kpi" @click="go(k.path)">
        <span class="ws-kpi-icon">{{ k.icon }}</span>
        <div class="ws-kpi-body">
          <div class="ws-kpi-value">{{ k.value }}</div>
          <div class="ws-kpi-label">{{ k.label }}</div>
          <div class="ws-kpi-hint">{{ k.hint }}</div>
        </div>
      </div>
    </section>

    <!-- 模块矩阵（全部 30 模块可视化面板） -->
    <section class="ws-matrix">
      <div class="ws-sec-row">
        <h3 class="ws-sec">模块矩阵</h3>
        <input v-model="filter" class="ws-filter" type="text" placeholder="🔍 搜索模块…" aria-label="搜索模块" />
      </div>
      <div v-for="g in groups" :key="g.id" class="ws-group">
        <div class="ws-group-label">{{ g.label }}</div>
        <div class="ws-tiles">
          <button v-for="m in g.modules" :key="m.key" class="ws-tile" :class="{ warn: metric(m.key).warn }" @click="go(m.path)">
            <i v-if="metric(m.key).warn" class="ws-tile-dot" title="有预警"></i>
            <span class="ws-tile-icon">{{ m.icon }}</span>
            <div class="ws-tile-main">
              <div class="ws-tile-head"><span class="ws-tile-label">{{ m.label }}</span><span class="ws-tile-metric">{{ metricText(m.key) }}</span></div>
              <div class="ws-tile-desc">{{ m.desc }}</div>
            </div>
          </button>
        </div>
      </div>
      <div v-if="!groups.length" class="ws-empty">没有匹配的模块</div>
    </section>

    <!-- 风险 / 健康 / 单科诊断 -->
    <section class="ws-risk">
      <div class="ws-card">
        <h3 class="ws-sec">遗忘风险 TOP3</h3>
        <div v-if="riskTop.length">
          <div v-for="r in riskTop" :key="r.id" class="ws-risk-item" @click="go('/review')">
            <span class="ws-risk-front">{{ r.front }}</span>
            <span class="ws-risk-n">风险 {{ r.risk }}%</span>
          </div>
        </div>
        <div v-else class="ws-empty">暂无遗忘风险卡</div>
      </div>
      <div class="ws-card">
        <h3 class="ws-sec">资产健康</h3>
        <div v-if="healthItems.length">
          <div v-for="h in healthItems" :key="h.label" class="ws-health" @click="go(h.path)">
            <span>{{ h.label }}</span><span class="ws-health-n" :class="{ bad: h.n > 0 }">{{ fmtNum(h.n) }}</span>
          </div>
        </div>
        <div class="ws-empty">体检数据加载中…</div>
      </div>
      <div class="ws-card">
        <h3 class="ws-sec">薄弱科目诊断</h3>
        <div v-if="diagTop.length">
          <div v-for="d in diagTop" :key="d.subject" class="ws-diag" @click="go('/cards?subject=' + encodeURIComponent(d.subject))">
            <div class="ws-diag-head"><span>{{ d.subject }}</span><span>{{ d.mastery }}% · 到期 {{ d.due }}</span></div>
            <div class="ws-diag-track"><div class="ws-diag-fill" :style="{ width: d.mastery + '%' }"></div></div>
          </div>
        </div>
        <div v-else class="ws-empty">暂无科目数据</div>
      </div>
    </section>

    <!-- 通知中心 + 最近动态 -->
    <section class="ws-bottom">
      <div class="ws-card">
        <div class="ws-sec-row">
          <h3 class="ws-sec">通知中心</h3>
          <span v-if="unread" class="ws-badge">{{ unread }} 未读</span>
        </div>
        <div v-if="!notifications.length" class="ws-empty">暂无通知，智能体会在合适时机推送建议</div>
        <ul v-else class="ws-notify">
          <li v-for="n in notifications" :key="n.id" :class="{ unread: !n.read }">
            <i class="ws-dot" :class="n.read ? 'read' : 'unread'"></i>
            <div class="ws-notify-main">
              <div class="ws-notify-title">{{ n.title }}</div>
              <div class="ws-notify-body">{{ n.body }}</div>
              <div class="ws-notify-time">{{ fmtTime(n.createdAt) }}</div>
            </div>
          </li>
        </ul>
      </div>
      <div class="ws-card">
        <h3 class="ws-sec">最近复习动态</h3>
        <div v-if="!recentActivity.length" class="ws-empty">还没有复习记录，去「开始复习」试试</div>
        <ul v-else class="ws-activity">
          <li v-for="a in recentActivity" :key="a.id">
            <span class="ws-tag" :class="a.rating === 2 ? 'ok' : a.rating === 1 ? 'warn' : 'fail'">{{ ratingLabel(a.rating) }}</span>
            <span class="ws-activity-front">{{ a.front || '(已删除卡片)' }}</span>
            <span class="ws-activity-time">{{ fmtTime(a.at) }}</span>
          </li>
        </ul>
      </div>
    </section>

    <div v-if="loading" class="ws-loading">正在聚合各模块数据…</div>
  </div>
</template>

<style scoped>
.ws-wrap { max-width: 1080px; margin: 0 auto; padding-bottom: 32px; }
/* 头部 */
.ws-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.ws-title { font-size: 22px; font-weight: 800; color: var(--ink); margin: 0; }
.ws-sub { font-size: 13px; color: var(--ink-2); margin: 4px 0 0; }
.ws-head-actions { display: flex; align-items: center; gap: 8px; }
.ws-sync { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; }
.ws-sync-dot { width: 8px; height: 8px; border-radius: 50%; background: #b0b8c4; }
.ws-sync.on .ws-sync-dot { background: #2cbe4e; box-shadow: 0 0 6px #2cbe4e88; }
.ws-sync.off .ws-sync-dot { background: #e53935; }
.ws-btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); border-radius: 8px; padding: 7px 14px; cursor: pointer; font-size: 13px; min-height: 36px; }
.ws-btn:hover { border-color: var(--accent); color: var(--accent); }
.ws-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.ws-btn.primary:hover { opacity: .9; color: #fff; }

/* 今日要处理 */
.ws-today { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; margin-bottom: 14px; }
.ws-today-main { background: linear-gradient(135deg, var(--accent), #2cbe4e); border-radius: 16px; padding: 20px; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ws-today-due { font-size: 52px; font-weight: 800; line-height: 1; }
.ws-today-label { font-size: 13px; opacity: .9; margin: 4px 0 12px; }
.ws-today-go { background: #fff !important; color: var(--accent) !important; border: none; font-weight: 600; border-radius: 8px; padding: 9px 18px; cursor: pointer; min-height: 44px; }
.ws-today-overdue { margin: 10px 0 0; font-size: 13px; background: rgba(255, 255, 255, .2); border-radius: 8px; padding: 6px 12px; }
.ws-today-side { display: grid; grid-template-rows: repeat(3, 1fr); gap: 10px; }
.ws-mini { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; min-height: 44px; }
.ws-mini.warn { border-color: #e53935; }
.ws-mini-n { font-size: 22px; font-weight: 700; color: var(--accent); }
.ws-mini.warn .ws-mini-n { color: #e53935; }
.ws-mini-l { font-size: 12px; color: var(--ink-2); }

/* 关键指标看板 */
.ws-kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.ws-kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: flex; gap: 10px; align-items: center; cursor: pointer; transition: .15s; min-height: 44px; }
.ws-kpi:hover { border-color: var(--accent); transform: translateY(-2px); }
.ws-kpi-icon { font-size: 22px; }
.ws-kpi-value { font-size: 20px; font-weight: 700; color: var(--ink); line-height: 1.1; }
.ws-kpi-label { font-size: 11px; color: var(--ink-2); }
.ws-kpi-hint { font-size: 10px; color: var(--ink-3); }

/* 模块矩阵 */
.ws-matrix { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
.ws-sec { font-size: 15px; font-weight: 700; margin: 0 0 12px; color: var(--ink); }
.ws-sec-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 10px; flex-wrap: wrap; }
.ws-sec-row .ws-sec { margin: 0; }
.ws-filter { border: 1px solid var(--line); background: var(--code-inline); border-radius: 8px; padding: 8px 12px; font-size: 16px; color: var(--ink); min-width: 160px; }
.ws-filter:focus { outline: none; border-color: var(--accent); }
.ws-group { margin-bottom: 14px; }
.ws-group-label { font-size: 12px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; letter-spacing: .5px; }
.ws-tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.ws-tile { position: relative; display: flex; gap: 8px; align-items: flex-start; text-align: left; border: 1px solid var(--line); background: var(--code-inline); border-radius: 10px; padding: 10px; cursor: pointer; transition: .15s; min-height: 44px; }
.ws-tile:hover { border-color: var(--accent); transform: translateY(-1px); }
.ws-tile.warn { border-color: #e53935aa; }
.ws-tile-dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: #e53935; }
.ws-tile-icon { font-size: 20px; }
.ws-tile-main { min-width: 0; }
.ws-tile-head { display: flex; align-items: baseline; gap: 6px; }
.ws-tile-label { font-size: 13px; font-weight: 600; color: var(--ink); }
.ws-tile-metric { font-size: 13px; font-weight: 700; color: var(--accent); }
.ws-tile-desc { font-size: 11px; color: var(--ink-2); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 风险 / 健康 / 诊断 */
.ws-risk { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 14px; }
.ws-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.ws-empty { font-size: 13px; color: var(--ink-2); text-align: center; padding: 18px 8px; }
.ws-risk-item { display: flex; justify-content: space-between; gap: 8px; padding: 8px 4px; border-bottom: 1px solid var(--line); cursor: pointer; }
.ws-risk-front { font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-risk-n { font-size: 11px; color: #e53935; font-weight: 600; flex: none; }
.ws-health { display: flex; justify-content: space-between; padding: 8px 4px; border-bottom: 1px solid var(--line); cursor: pointer; font-size: 13px; color: var(--ink); }
.ws-health-n { font-weight: 700; }
.ws-health-n.bad { color: #e53935; }
.ws-diag { margin-bottom: 12px; cursor: pointer; }
.ws-diag-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; color: var(--ink); }
.ws-diag-track { height: 8px; background: var(--code-bg); border-radius: 999px; overflow: hidden; }
.ws-diag-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #2cbe4e); border-radius: 999px; }

/* 通知 + 动态 */
.ws-bottom { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ws-badge { font-size: 12px; color: var(--accent); font-weight: 600; }
.ws-notify { list-style: none; margin: 0; padding: 0; max-height: 280px; overflow-y: auto; }
.ws-notify li { display: flex; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--line); }
.ws-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 5px; }
.ws-dot.unread { background: var(--accent); }
.ws-dot.read { background: var(--line); }
.ws-notify-main { min-width: 0; }
.ws-notify-title { font-size: 13px; font-weight: 600; color: var(--ink); }
.ws-notify-body { font-size: 12px; color: var(--ink-2); margin-top: 2px; line-height: 1.5; }
.ws-notify-time { font-size: 11px; color: var(--ink-3); margin-top: 4px; }
.ws-activity { list-style: none; margin: 0; padding: 0; }
.ws-activity li { display: flex; align-items: center; gap: 12px; padding: 9px 4px; border-bottom: 1px solid var(--line); }
.ws-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; flex: none; }
.ws-tag.ok { background: #e6f6ea; color: #2cbe4e; }
.ws-tag.warn { background: #fff2cc; color: #b8860b; }
.ws-tag.fail { background: #fde9e8; color: #e53935; }
.ws-activity-front { flex: 1; font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-activity-time { font-size: 11px; color: var(--ink-3); flex: none; }

.ws-loading { text-align: center; color: var(--ink-2); font-size: 13px; padding: 12px; }

/* 响应式（铁律 4：<760px 单列堆叠，按钮/输入 ≥44px / ≥16px） */
@media (max-width: 900px) { .ws-tiles { grid-template-columns: repeat(3, 1fr); } .ws-kpis { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 760px) {
  .ws-today { grid-template-columns: 1fr; }
  .ws-today-side { grid-template-rows: none; grid-template-columns: 1fr 1fr 1fr; }
  .ws-kpis { grid-template-columns: repeat(2, 1fr); }
  .ws-tiles { grid-template-columns: repeat(2, 1fr); }
  .ws-risk { grid-template-columns: 1fr; }
  .ws-bottom { grid-template-columns: 1fr; }
  .ws-tile { min-height: 48px; }
  .ws-btn, .ws-today-go, .ws-filter { min-height: 44px; }
  .ws-filter { width: 100%; font-size: 16px; }
}
</style>
