<script setup>
// 悬浮球 AI 助手：每个页面右下角都能随时唤起，快速问一句
import { ref, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { chatAI, buildContext, hasAIKey } from '../ai.js';

const open = ref(false);
const messages = ref([]);
const input = ref('');
const loading = ref(false);
const box = ref(null);

function scroll() { nextTick(() => { box.value?.scrollTo({ top: box.value.scrollHeight }); }); }

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  if (!hasAIKey()) { toast('请先在「AI 助手页」里配置密钥', 'error'); return; }
  input.value = '';
  messages.value.push({ role: 'user', content: text });
  loading.value = true;
  scroll();
  try {
    const ctx = await buildContext();
    const reply = await chatAI([
      { role: 'system', content: '你是「SxyBrick」学习助手，结合下面真实学习数据用中文简洁回答。\n\n' + ctx },
      ...messages.value,
    ]);
    messages.value.push({ role: 'assistant', content: reply });
  } catch (e) {
    toast(e.message, 'error');
    messages.value.push({ role: 'assistant', content: '（出错：' + e.message + '）' });
  } finally { loading.value = false; scroll(); }
}

function toggle() { open.value = !open.value; }

// 拖拽（pointer 事件统一鼠标/触摸）—— 与通知铃铛/主题 FAB 一致的移动端丝滑拖动
const rootEl = ref(null);
const pos = ref(null);
let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, downAt = 0, activePointerId = null;
const DRAG_CLICK_DIST = 14;
const DRAG_CLICK_MS = 250;
function onPointerDown(e) {
  const pt = e.touches ? e.touches[0] : e;
  dragging = true; moved = false; sx = pt.clientX; sy = pt.clientY; downAt = Date.now();
  activePointerId = e.pointerId;
  const r = rootEl.value.getBoundingClientRect();
  ox = r.left; oy = r.top;
  try { e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  try { document.body.style.touchAction = 'none'; document.documentElement.style.overflow = 'hidden'; } catch (err) {}
  document.addEventListener('pointermove', onDocMove, { passive: false, capture: false });
  document.addEventListener('pointerup', onDocUp, { once: true, capture: false });
  document.addEventListener('pointercancel', onDocUp, { once: true, capture: false });
}
function onDocMove(e) {
  if (!dragging) return;
  const pt = e.touches ? e.touches[0] : e;
  const dx = pt.clientX - sx, dy = pt.clientY - sy;
  const dist = Math.abs(dx) + Math.abs(dy);
  const elapsed = Date.now() - downAt;
  if (dist > DRAG_CLICK_DIST && elapsed > 60) moved = true;
  if (moved) {
    try { e.preventDefault && e.preventDefault(); } catch (err) {}
    pos.value = { left: ox + dx, top: oy + dy };
  }
}
function onPointerMove() {}
function onDocUp() {
  document.removeEventListener('pointermove', onDocMove);
  document.removeEventListener('pointerup', onDocUp);
  document.removeEventListener('pointercancel', onDocUp);
  if (activePointerId != null) {
    try {
      const btn = rootEl.value && rootEl.value.querySelector && rootEl.value.querySelector('button');
      btn && btn.releasePointerCapture && btn.releasePointerCapture(activePointerId);
    } catch (err) {}
  }
  activePointerId = null;
  try { document.body.style.touchAction = ''; document.documentElement.style.overflow = ''; } catch (err) {}
  const elapsed = Date.now() - downAt;
  const wasClick = elapsed <= DRAG_CLICK_MS || !moved;
  dragging = false;
  if (wasClick) toggle();
}
function onPointerUp() {}
</script>

<template>
  <div class="fa-root" ref="rootEl" :style="pos ? { left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' } : {}">
    <transition name="fa">
      <div v-if="open" class="fa-panel">
        <div class="fa-head">
          <span style="font-weight:600">AI 助手</span>
          <button class="btn small" @click="toggle">收起</button>
        </div>
        <div ref="box" class="fa-box">
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role"><div class="bubble">{{ m.content }}</div></div>
          <div v-if="loading" class="msg assistant"><div class="bubble">思考中…</div></div>
        </div>
        <div class="fa-input">
          <input v-model="input" class="input" placeholder="快速问一句…" @keydown.enter="send" />
          <button class="btn primary small" @click="send">发送</button>
        </div>
      </div>
    </transition>
    <button class="fa-ball" :class="{ on: open }" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp">{{ open ? '×' : 'AI' }}</button>
  </div>
</template>

<style scoped>
.fa-root { position: fixed; right: 18px; bottom: 20px; z-index: 250; }
.fa-ball {
  width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--accent); color: #fff; font-weight: 700; font-size: 16px;
  box-shadow: 0 6px 20px rgba(0,0,0,.25); transition: transform .15s ease;
  display: flex; align-items: center; justify-content: center;
}
.fa-ball:hover { transform: scale(1.08); }
.fa-ball.on { background: var(--red); font-size: 22px; }
.fa-panel {
  position: absolute; right: 0; bottom: 64px; width: 320px; max-width: 86vw;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,.18); overflow: hidden;
  display: flex; flex-direction: column;
}
.fa-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.fa-box { height: 280px; overflow-y: auto; padding: 12px; }
.fa-input { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--line); }
.fa-input .input { flex: 1; }
.msg { display: flex; margin-bottom: 8px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 82%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; }
.msg.user .bubble { background: var(--accent); color: #fff; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); }
.fa-enter-active, .fa-leave-active { transition: all .18s ease; }
.fa-enter-from, .fa-leave-to { opacity: 0; transform: translateY(10px); }
</style>