<script setup>
// 悬浮球 AI 助手：每个页面右下角都能随时唤起，快速问一句
import { ref, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { chatAI, buildContext, hasAIKey } from '../ai.js';
import { useFabDrag } from '../composables/useFabDrag.js';

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

// 拖拽：与设置中心 / 通知中心共用 useFabDrag（rAF 节流 + transform 合成层 + 边界收敛 + 位置持久化）
const rootEl = ref(null);
const ballEl = ref(null);
// 面板相对球体往右上展开；球被拖到左/上边缘时翻转方向，避免面板溢出视口（手机窄屏尤其明显）
const flipX = ref(false);
const flipY = ref(false);
const PANEL_W = 320, PANEL_H = 380;
function onSettled(x, y, box) {
  // 球体在视口右半 → 面板向左展开（默认）；在左半 → 向右展开，始终朝屏幕内侧
  flipX.value = (x + box.w / 2) <= box.vw / 2;
  // 上方放不下整块面板时翻到球体下方
  flipY.value = (y + box.h - 64 - PANEL_H) < 8;
}
const { dragging, onDown } = useFabDrag({
  root: rootEl,
  handle: ballEl,
  storageKey: 'sxy_ai_pos',
  onTap: toggle,
  onSettled,
});
</script>

<template>
  <div class="fa-root no-print" ref="rootEl" :class="{ dragging, 'flip-x': flipX, 'flip-y': flipY }">
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
    <button ref="ballEl" class="fa-ball" :class="{ on: open }"
      @pointerdown="onDown" @touchstart="onDown" @mousedown="onDown">{{ open ? '×' : 'AI' }}</button>
  </div>
</template>

<style scoped>
/* touch-action: none 是移动端跟手的前提：不让浏览器先把它当滚动/缩放手势去判定，
   否则 pointermove 会被延迟下发甚至被页面滚动抢走，表现就是拖动一卡一卡 */
.fa-root {
  position: fixed; right: 18px; bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  z-index: 250; touch-action: none;
}
.fa-ball {
  width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--accent); color: #fff; font-weight: 700; font-size: 16px;
  box-shadow: 0 6px 20px rgba(0,0,0,.25); transition: transform .15s ease;
  display: flex; align-items: center; justify-content: center;
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.fa-ball:hover { transform: scale(1.08); }
.fa-ball.on { background: var(--red); font-size: 22px; }
/* 拖动中：① 提升为合成层，让位移只走合成不重排重绘；② 关掉过渡，
   避免 hover 缩放/点击反馈动画与拖动叠加造成视觉滞后（触屏 hover 会粘滞） */
.fa-root.dragging { will-change: transform; }
.fa-root.dragging .fa-ball,
.fa-root.dragging .fa-ball:hover { transition: none; transform: none; }
.fa-panel {
  position: absolute; right: 0; bottom: 64px; width: 320px; max-width: 86vw;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,.18); overflow: hidden;
  display: flex; flex-direction: column;
}
.fa-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.fa-box { height: 280px; overflow-y: auto; padding: 12px; }
.fa-input { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--line); }
.fa-input .input { flex: 1; min-width: 0; }
/* 球体被拖到左/上边缘时翻转面板展开方向，保证桌面窄窗口与手机窄屏都不溢出视口 */
.fa-root.flip-x .fa-panel { left: 0; right: auto; }
.fa-root.flip-y .fa-panel { top: 64px; bottom: auto; }
.msg { display: flex; margin-bottom: 8px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 82%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; }
.msg.user .bubble { background: var(--accent); color: #fff; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); }
.fa-enter-active, .fa-leave-active { transition: all .18s ease; }
.fa-enter-from, .fa-leave-to { opacity: 0; transform: translateY(10px); }

/* 窄屏（手机竖屏 / 桌面窗口收窄）：面板按视口宽度收敛，输入框不被挤掉 */
@media (max-width: 720px) {
  .fa-root { right: 14px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
  .fa-panel { width: calc(100vw - 28px); max-width: 340px; }
  .fa-box { height: 46vh; max-height: 280px; }
  .fa-input .input { min-height: 44px; }
}
/* 桌面窗口被拉到很窄时同样按窄屏处理，避免面板溢出（手机与桌面表现一致） */
@media (max-height: 520px) {
  .fa-box { height: 40vh; max-height: 200px; }
}
</style>