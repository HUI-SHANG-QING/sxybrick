<template>
  <Teleport to="body">
    <Transition name="remind-pop">
      <div v-if="queue.length" class="pr-layer" role="alert">
        <div class="pr-stack">
          <div v-for="(t, i) in queue" :key="t.id + '_' + i" class="pr-card" :style="{ animationDelay: (i * 0.12) + 's' }">
            <div class="pr-head">
              <span class="pr-badge">⏰ 日程提醒</span>
              <span class="pr-time" v-if="t.scheduledHour != null">{{ String(t.scheduledHour).padStart(2, '0') }}:00</span>
            </div>
            <div class="pr-title">{{ t.title }}</div>
            <div class="pr-meta">
              <span class="pr-type">{{ TYPE_ICON[t.type] }} {{ TYPE_LABEL[t.type] }}</span>
              <span v-if="t.subject" class="pr-sub">📚 {{ t.subject }}</span>
              <span v-if="t.targetCount" class="pr-sub">🎯 {{ t.targetCount }} 项</span>
            </div>
            <button class="pr-dismiss" @click="dismiss(t)">知道了 ✓</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
// 全局日程提醒浮层：监听 sxy-plan-due 事件，页面顶部大号提醒卡（视觉明显、默认静音）
import { ref, onMounted, onBeforeUnmount } from 'vue';

const TYPE_LABEL = { review: '复习', pomodoro: '番茄', doc: '资料', exam: '做题', note: '笔记', write: '写作', other: '其他' };
const TYPE_ICON = { review: '📖', pomodoro: '🍅', doc: '📚', exam: '📝', note: '📓', write: '✍️', other: '📌' };

const queue = ref([]);       // 待展示提醒队列（多条任务同时到期时排队）
const TITLE_PREFIX = '⏰ 日程提醒｜';
let originalTitle = '';
let titleTimer = null;

function show(task) {
  // 同类任务不重复入队
  if (queue.value.some(q => q.id === task.id)) return;
  queue.value.push(task);
  startTitleFlash();
}

function dismiss(t) {
  queue.value = queue.value.filter(q => q.id !== t.id);
  if (!queue.value.length) stopTitleFlash();
}

function onDue(ev) {
  show(ev.detail);
}

// document.title 闪烁，提醒"切走的标签页"
function startTitleFlash() {
  if (!originalTitle) originalTitle = document.title;
  if (titleTimer) return;
  titleTimer = setInterval(() => {
    document.title = document.title.startsWith(TITLE_PREFIX)
      ? originalTitle
      : TITLE_PREFIX + originalTitle;
  }, 1200);
}
function stopTitleFlash() {
  if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
  if (originalTitle) document.title = originalTitle;
}

onMounted(() => {
  window.addEventListener('sxy-plan-due', onDue);
});
onBeforeUnmount(() => {
  window.removeEventListener('sxy-plan-due', onDue);
  stopTitleFlash();
});
</script>

<style scoped>
.pr-layer {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(0, 0, 0, .38);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 7vh 16px 0;
  pointer-events: auto;
}
.pr-stack { display: flex; flex-direction: column; gap: 12px; width: min(520px, 94vw); }
.pr-card {
  background: var(--panel, #fff); border-radius: 16px; padding: 18px 20px;
  border: 2px solid var(--accent, #3a7afe);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .35);
  animation: prIn .3s cubic-bezier(.34, 1.56, .64, 1) both;
}
.pr-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.pr-badge {
  background: var(--accent, #3a7afe); color: #fff; font-size: 12px; font-weight: 700;
  padding: 3px 12px; border-radius: 999px; letter-spacing: .5px;
}
.pr-time { font-family: ui-monospace, monospace; font-size: 18px; font-weight: 700; color: var(--accent, #3a7afe); }
.pr-title { font-size: 18px; font-weight: 700; line-height: 1.5; word-break: break-word; margin-bottom: 8px; }
.pr-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2, #666); margin-bottom: 14px; }
.pr-sub { background: var(--code-inline, #f2f2f2); padding: 1px 8px; border-radius: 6px; }
.pr-dismiss {
  width: 100%; padding: 9px 0; border-radius: 999px; border: none; cursor: pointer;
  background: var(--accent, #3a7afe); color: #fff; font-size: 14px; font-weight: 600;
  transition: filter .15s;
}
.pr-dismiss:hover { filter: brightness(1.08); }
@keyframes prIn {
  from { opacity: 0; transform: translateY(-22px) scale(.95); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.remind-pop-leave-active { transition: opacity .2s, transform .2s; }
.remind-pop-leave-to { opacity: 0; transform: translateY(-16px); }
</style>
