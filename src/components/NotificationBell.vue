<script setup>
// 通知铃铛：主动智能体推送的建议/提醒入口。
// 浮动在右上角（紧邻设置 FAB 左侧），跨主题通用，使用 CSS 变量适配所有风格。
import { ref, reactive, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  clearAllNotifications,
  deleteNotification,
} from '../agent/proactive.js';
import { getProactiveScheduler } from '../agent/proactive.js';

const router = useRouter();
const open = ref(false);
const unread = ref(0);
const list = ref([]);
const loading = ref(false);

// 可拖动：位置存 localStorage；用 moved 标志区分拖动/点击（拖动不触发 toggle）
const DRAG_KEY = 'sxy_nb_pos';
function loadPos() {
  try {
    const p = JSON.parse(localStorage.getItem(DRAG_KEY) || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {}
  return null;
}
const bellStyle = reactive({});
function clampPos(x, y) {
  const mx = window.innerWidth - 52, my = window.innerHeight - 52;
  return { x: Math.max(8, Math.min(mx, x)), y: Math.max(8, Math.min(my, y)) };
}
function applyPos() {
  const p = loadPos();
  if (!p) { bellStyle.left = undefined; bellStyle.top = undefined; bellStyle.right = undefined; bellStyle.bottom = undefined; return; }
  const c = clampPos(p.x, p.y);
  bellStyle.position = 'fixed';
  bellStyle.left = c.x + 'px'; bellStyle.top = c.y + 'px';
  bellStyle.right = 'auto'; bellStyle.bottom = 'auto';
}
const bellEl = ref(null);
let dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0;
function onBellDown(e) {
  const pt = e.touches ? e.touches[0] : e;
  dragging = true; moved = false;
  startX = pt.clientX; startY = pt.clientY;
  const rect = bellEl.value.getBoundingClientRect();
  origX = rect.left; origY = rect.top;
  bellStyle.position = 'fixed'; bellStyle.left = origX + 'px'; bellStyle.top = origY + 'px';
  bellStyle.right = 'auto'; bellStyle.bottom = 'auto';
  document.addEventListener('pointermove', onBellMove);
  document.addEventListener('pointerup', onBellUp, { once: true });
  document.addEventListener('pointercancel', onBellUp, { once: true });
}
function onBellMove(e) {
  if (!dragging) return;
  const pt = e.touches ? e.touches[0] : e;
  const dx = pt.clientX - startX, dy = pt.clientY - startY;
  if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) moved = true;
  if (!moved) return;
  e.preventDefault?.();
  const c = clampPos(origX + dx, origY + dy);
  bellStyle.left = c.x + 'px'; bellStyle.top = c.y + 'px';
}
function onBellUp() {
  dragging = false;
  document.removeEventListener('pointermove', onBellMove);
  if (bellEl.value) {
    const r = bellEl.value.getBoundingClientRect();
    localStorage.setItem(DRAG_KEY, JSON.stringify({ x: r.left, y: r.top }));
  }
}

const hasItems = computed(() => list.value.length > 0);

async function refreshUnread() {
  try { unread.value = await unreadCount(); } catch { /* noop */ }
}

async function loadList() {
  loading.value = true;
  try { list.value = await listNotifications(50); } catch { /* noop */ }
  loading.value = false;
}

async function toggle() {
  if (moved) { moved = false; return; } // 拖动结束不触发面板
  open.value = !open.value;
  if (open.value) {
    await loadList();
  }
}

async function onItemClick(n) {
  if (!n.read) { await markRead(n.id); n.read = 1; unread.value = Math.max(0, unread.value - 1); }
  if (n.action?.target) {
    open.value = false;
    router.push('/' + n.action.target).catch(() => {});
  }
}

async function onMarkAll() {
  await markAllRead();
  list.value = list.value.map((n) => ({ ...n, read: 1 }));
  unread.value = 0;
}

async function onClearAll() {
  await clearAllNotifications();
  list.value = [];
  unread.value = 0;
}

async function onDelete(n) {
  await deleteNotification(n.id);
  list.value = list.value.filter((x) => x.id !== n.id);
  if (!n.read) unread.value = Math.max(0, unread.value - 1);
}

async function onTestPush() {
  await getProactiveScheduler().tickNow();
  await loadList();
  await refreshUnread();
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function typeIcon(type) {
  return {
    review: '📖', weak: '⚠️', stale: '⏳', marked: '❌',
    streak: '🍅', milestone: '🏆', ai: '🤖', info: '🔔',
  }[type] || '🔔';
}

let pollTimer = null;
function closeOnOutside(e) {
  const el = document.querySelector('.nb-root');
  if (el && !el.contains(e.target)) open.value = false;
}

onMounted(() => {
  applyPos();
  refreshUnread();
  pollTimer = setInterval(refreshUnread, 30000);
  document.addEventListener('click', closeOnOutside);
  window.addEventListener('resize', applyPos);
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  document.removeEventListener('click', closeOnOutside);
  window.removeEventListener('resize', applyPos);
  document.removeEventListener('pointermove', onBellMove);
});

defineExpose({ refreshUnread, loadList });
</script>

<template>
  <div class="nb-root no-print" :style="bellStyle">
    <button
      ref="bellEl"
      class="nb-bell"
      :class="{ hasunread: unread > 0, dragging: dragging }"
      :style="{ cursor: dragging ? 'grabbing' : 'grab' }"
      @pointerdown="onBellDown"
      @click="toggle"
      :title="unread > 0 ? `${unread} 条未读（可拖动）` : '通知（可拖动）'"
    >
      <span class="nb-icon">🔔</span>
      <span v-if="unread > 0" class="nb-badge">{{ unread > 99 ? '99+' : unread }}</span>
    </button>

    <transition name="nb">
      <div v-if="open" class="nb-panel">
        <div class="nb-head">
          <span class="nb-title">通知中心</span>
          <span class="nb-count" v-if="unread > 0">{{ unread }} 未读</span>
        </div>

        <div class="nb-body">
          <div v-if="loading" class="nb-empty">加载中…</div>
          <div v-else-if="!hasItems" class="nb-empty">
            <div class="nb-empty-icon">🌙</div>
            <div>暂无通知</div>
            <div class="nb-empty-sub">主动智能体会在合适时机推送复习/补卡/复盘建议</div>
            <button class="nb-test" @click="onTestPush">立即检查一次</button>
          </div>
          <div v-else>
            <div v-for="n in list" :key="n.id" class="nb-item" :class="{ unread: !n.read }" @click="onItemClick(n)">
              <span class="nb-item-icon">{{ typeIcon(n.type) }}</span>
              <div class="nb-item-main">
                <div class="nb-item-title">{{ n.title }}</div>
                <div class="nb-item-body">{{ n.body }}</div>
                <div class="nb-item-foot">
                  <span class="nb-time">{{ fmtTime(n.createdAt) }}</span>
                  <span v-if="n.action?.label" class="nb-action">{{ n.action.label }} →</span>
                </div>
              </div>
              <button class="nb-del" @click.stop="onDelete(n)" title="删除" aria-label="删除该通知">×</button>
            </div>
          </div>
        </div>

        <div v-if="hasItems" class="nb-foot">
          <button class="nb-btn" @click="onMarkAll" :disabled="unread === 0">全部已读</button>
          <button class="nb-btn" @click="onClearAll">清空</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.nb-root { position: fixed; top: 12px; right: 64px; z-index: 70; }
.nb-bell { position: relative; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); cursor: pointer; font-size: 18px; box-shadow: 0 2px 10px rgba(0,0,0,.12); transition: transform .18s, box-shadow .18s; }
.nb-bell:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,.16); }
.nb-bell.hasunread { animation: nb-ring 1.6s ease-in-out infinite; }
@keyframes nb-ring {
  0%, 70%, 100% { transform: rotate(0); }
  80% { transform: rotate(-12deg); }
  90% { transform: rotate(12deg); }
}
.nb-icon { display: inline-block; }
.nb-badge { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px; background: #e53935; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(229,57,53,.4); }

.nb-panel { position: absolute; top: 48px; right: 0; width: 360px; max-width: calc(100vw - 24px); max-height: 70vh; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.2); overflow: hidden; }
.nb-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--code-inline); }
.nb-title { font-weight: 700; font-size: 15px; }
.nb-count { font-size: 12px; color: var(--accent); font-weight: 600; }
.nb-body { flex: 1; overflow-y: auto; }
.nb-empty { padding: 32px 16px; text-align: center; color: var(--ink-2); font-size: 14px; }
.nb-empty-icon { font-size: 36px; margin-bottom: 8px; opacity: .6; }
.nb-empty-sub { font-size: 12px; margin-top: 6px; color: var(--ink-3); line-height: 1.6; }
.nb-test { margin-top: 12px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); font-size: 12px; cursor: pointer; }
.nb-test:hover { border-color: var(--accent); color: var(--accent); }

.nb-item { display: flex; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); cursor: pointer; transition: background .12s; position: relative; }
.nb-item:hover { background: var(--code-inline); }
.nb-item.unread { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.nb-item.unread::before { content: ''; position: absolute; left: 4px; top: 50%; transform: translateY(-50%); width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.nb-item-icon { font-size: 18px; flex: none; margin-top: 2px; }
.nb-item-main { flex: 1; min-width: 0; }
.nb-item-title { font-size: 13px; font-weight: 600; color: var(--ink); line-height: 1.4; }
.nb-item-body { font-size: 12px; color: var(--ink-2); margin-top: 3px; line-height: 1.5; }
.nb-item-foot { display: flex; gap: 10px; align-items: center; margin-top: 6px; }
.nb-time { font-size: 11px; color: var(--ink-3); }
.nb-action { font-size: 11px; color: var(--accent); font-weight: 600; }
.nb-del { position: absolute; right: 8px; top: 8px; width: 22px; height: 22px; border: none; background: transparent; color: var(--ink-3); font-size: 16px; cursor: pointer; border-radius: 6px; opacity: 0; transition: opacity .12s, background .12s; }
.nb-item:hover .nb-del { opacity: 1; }
.nb-del:hover { background: var(--code-inline); color: var(--ink); }

.nb-foot { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--code-inline); }
.nb-btn { flex: 1; padding: 7px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink-2); font-size: 12px; cursor: pointer; transition: .12s; }
.nb-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.nb-btn:disabled { opacity: .5; cursor: not-allowed; }

.nb-enter-active, .nb-leave-active { transition: opacity .18s, transform .18s; transform-origin: top right; }
.nb-enter-from, .nb-leave-to { opacity: 0; transform: translateY(-6px) scale(.96); }

@media (max-width: 720px) {
  .nb-root { top: 12px; right: 60px; }
  .nb-panel { width: calc(100vw - 24px); }
}
</style>