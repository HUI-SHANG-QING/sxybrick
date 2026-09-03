// 悬浮按钮拖拽统一实现（设置中心 🎨 / 通知中心 🔔 / AI 对话 💬 三处共用）
//
// 移动端 60fps 跟手的六个关键点（三处旧实现各缺一部分，表现就是"只有 AI 球卡顿"）：
//   1. touch-action: none 必须在 CSS 上静态声明 —— 否则移动端浏览器按下后要先判定
//      这是滚动还是拖动手势，pointermove 会被延迟下发甚至被滚动抢占，表现就是一卡一卡。
//      运行时再设 body.style.touchAction 已经太晚，手势判定在 pointerdown 时就已开始。
//   2. pointermove 只记录坐标，写样式统一放进 requestAnimationFrame —— 每帧最多一次
//      样式写入，避免高频事件下同一帧内多次布局。
//   3. 用 transform: translate3d 定位（走合成层，只合成不重排重绘），而不是 left/top
//      （left/top 每帧触发 Layout + Paint，大阴影的球体尤其明显）。
//   4. 拖动全程直接操作 DOM，完全不走 Vue 响应式 —— 拖动期间 0 次组件重渲染、0 次
//      VNode diff。旧的三种写法（对象整体替换 / reactive 属性赋值）都仍会重建 VNode。
//   5. 拖动中关闭 transition 并临时开 will-change —— 避免 hover 缩放动画与拖动叠加；
//      will-change 只在拖动期间存在，不常驻占用合成层内存。
//   6. 兼容 touch 与 mouse：优先 Pointer Events（现代浏览器统一模型），
//      老设备无 PointerEvent 时回退 touch + mouse 两套监听，行为完全一致。
//
// 行为契约（三处保持一致）：
//   - 位移 ≤ CLICK_DIST 或 按下-抬起 ≤ CLICK_MS → 判定为点击，回调 onTap
//   - 拖动结束后位置按视口边界收敛（margin）并写入 localStorage（传了 storageKey 时）
//   - 窗口尺寸变化（含桌面浏览器手动缩放窗口、手机横竖屏切换）后重新测量并收敛位置

import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';

// 曼哈顿总位移 14 以内视为点击（手指点按天然抖动，欧式约 10px）
const CLICK_DIST = 14;
// 250ms 内按下-抬起无条件算点击（避免抖动误判成拖动）
const CLICK_MS = 250;

function pointOf(e) {
  if (e.touches) return e.touches[0] || (e.changedTouches && e.changedTouches[0]) || e;
  return e;
}

/**
 * @param {object}  opts
 * @param {import('vue').Ref} opts.root        被移动的元素（transform 作用对象）
 * @param {import('vue').Ref} [opts.handle]    接收按下事件的元素，默认同 root
 * @param {string}  [opts.storageKey]          位置持久化键名，不传则不保存
 * @param {number}  [opts.margin=8]            距视口边缘最小留白
 * @param {Function}[opts.onTap]               判定为点击（非拖动）时的回调
 * @param {Function}[opts.onSettled]           落位回调 (x, y, box)，用于面板翻转等低频布局决策
 * @returns {{ dragging: import('vue').Ref<boolean>, onDown: Function }}
 */
export function useFabDrag({ root, handle = null, storageKey = null, margin = 8, onTap = null, onSettled = null } = {}) {
  const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
  // 仅用于挂载/结束两个时刻切换 class（关 transition + 开 will-change），拖动过程中不再变化
  const dragging = ref(false);

  let rootEl = null;
  let handleEl = null;
  let originLeft = 0, originTop = 0;  // 元素在 transform: none 时的左上角（定位基准）
  let elW = 0, elH = 0;               // 元素尺寸（拖动期间不变，测量一次即可）
  let baseLeft = 0, baseTop = 0;      // 本次拖动开始时的视觉左上角
  let startX = 0, startY = 0;         // 按下时的指针坐标
  let targetX = 0, targetY = 0;       // 待提交的目标位置（视口坐标）
  let curX = 0, curY = 0;             // 最近一次已提交的位置
  let moved = false, downAt = 0, activeId = null;
  let rafId = 0, pressId = null;
  // 触摸设备上浏览器会在 touchend 后补发一次 mousedown（兼容鼠标事件），
  // 这段时间内的 mousedown 一律忽略，否则一次点击会残留一个没有抬起配对的"按下"
  let suppressMouseUntil = 0;

  // 测量定位基准：临时去掉 transform 读一次 rect。
  // 只在初始化与 resize 时调用（拖动期间绝不调用，避免每帧强制同步布局）。
  function measureOrigin() {
    if (!rootEl) return;
    const prev = rootEl.style.transform;
    rootEl.style.transform = 'none';
    const r = rootEl.getBoundingClientRect();
    rootEl.style.transform = prev;
    originLeft = r.left;
    originTop = r.top;
    elW = r.width;
    elH = r.height;
  }

  function clamp(x, y) {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const maxX = Math.max(margin, vw - elW - margin);
    const maxY = Math.max(margin, vh - elH - margin);
    return {
      x: Math.max(margin, Math.min(maxX, x)),
      y: Math.max(margin, Math.min(maxY, y)),
    };
  }

  // 唯一的样式写入口：把视口坐标换算成相对基准的偏移，用 translate3d 提交
  function paint(x, y) {
    if (!rootEl) return;
    curX = x;
    curY = y;
    rootEl.style.transform = `translate3d(${Math.round(x - originLeft)}px, ${Math.round(y - originTop)}px, 0)`;
  }

  function commit() {
    rafId = 0;
    paint(targetX, targetY);
  }

  // rAF 节流：一帧内的多次 pointermove 只保留最后一次
  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(commit);
  }

  function readSaved() {
    if (!storageKey) return null;
    try {
      const p = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch { /* 存档损坏时退回默认位置 */ }
    return null;
  }

  function save() {
    if (!storageKey || !moved) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ x: Math.round(curX), y: Math.round(curY) })); } catch { /* 存储不可用不影响使用 */ }
  }

  // 落位后通知使用方（低频：拖动结束 / 初始化 / resize），便于做面板翻转等布局决策
  function notifySettled() {
    if (typeof onSettled !== 'function') return;
    onSettled(curX, curY, {
      w: elW, h: elH,
      vw: window.innerWidth || document.documentElement.clientWidth || 0,
      vh: window.innerHeight || document.documentElement.clientHeight || 0,
    });
  }

  function onDown(e) {
    if (!rootEl) return;
    // 同一次按下在部分浏览器会同时派发 pointerdown 与 touchstart/mousedown，
    // 已在拖动中则直接忽略，避免重复初始化把起点坐标冲掉
    if (dragging.value) return;
    // 忽略触摸后补发的鼠标事件
    if (e.type === 'mousedown' && Date.now() < suppressMouseUntil) return;
    // 鼠标只响应左键（触摸事件没有 button 字段，跳过判断）
    if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return;
    const pt = pointOf(e);
    if (!pt || pt.clientX == null) return;

    measureOrigin();
    const r = rootEl.getBoundingClientRect();
    baseLeft = r.left;
    baseTop = r.top;
    targetX = curX = baseLeft;
    targetY = curY = baseTop;
    startX = pt.clientX;
    startY = pt.clientY;
    moved = false;
    downAt = Date.now();
    activeId = e.pointerId != null ? e.pointerId : null;
    pressId = e.pointerType || (e.touches ? 'touch' : 'mouse');
    dragging.value = true;

    // 指针捕获：手指滑出按钮范围也能继续收到事件（触屏拖动不断线的关键）
    try {
      if (activeId != null && handleEl?.setPointerCapture) {
        handleEl.setPointerCapture(activeId);
      }
    } catch { /* 捕获失败可降级到 document 监听 */ }

    if (hasPointer) {
      // passive: false —— 否则 e.preventDefault() 会被浏览器静默忽略
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      // 部分平板/WebView（尤其 iPadOS/Safari 在 touch 的 pointerdown 阶段调用
      // setPointerCapture 后、或某些国产 Android WebView）对 touch 的 Pointer Events
      // 支持不完整：pointerdown 正常派发，但 pointerup/pointercancel 可能被吞掉，而
      // 原生 touch 事件不受影响、touchend/touchcancel 仍会派发。这里补上 touch 监听
      // 兜底，确保点按（onTap）与拖动落位不会被漏掉。onUp 已用 dragging 做幂等守卫，
      // 正常设备上 pointerup 与 touchend 双触发只会执行一次、不会二次触发 onTap。
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      document.addEventListener('touchcancel', onUp);
      // 鼠标拖出浏览器窗口外松开时 pointerup 不会回到页面，dragging 会永久卡住 →
      // 用 window 的 blur / pointerup 兜底收尾（触屏手指移出屏幕同理）
      window.addEventListener('blur', onUp);
    } else {
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      document.addEventListener('touchcancel', onUp);
      document.addEventListener('mousemove', onMove, { passive: false });
      document.addEventListener('mouseup', onUp);
    }
  }

  function onMove(e) {
    if (!dragging.value) return;
    const pt = pointOf(e);
    if (!pt || pt.clientX == null) return;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    const elapsed = Date.now() - downAt;
    if (!moved && Math.abs(dx) + Math.abs(dy) > CLICK_DIST && elapsed > 60) moved = true;
    if (!moved) return;
    // 禁用浏览器默认滚动/缩放手势，否则拖动会被页面滚动抢走
    try { e.preventDefault?.(); } catch { /* 部分浏览器不可取消 */ }
    const c = clamp(baseLeft + dx, baseTop + dy);
    targetX = c.x;
    targetY = c.y;
    schedule();
  }

  function onUp() {
    if (!dragging.value) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    paint(targetX, targetY);

    if (hasPointer) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
      window.removeEventListener('blur', onUp);
    } else {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    try {
      if (activeId != null && handleEl?.releasePointerCapture) handleEl.releasePointerCapture(activeId);
    } catch { /* 已自动释放 */ }
    activeId = null;
    const wasTouch = pressId === 'touch' || !hasPointer;
    pressId = null;
    dragging.value = false;

    // 判定为点击只看位移，不看按下时长。
    // 不能用「按下-抬起 ≤ 250ms 就算点击」兜底：快速甩动（flick）同样在 250ms 内完成，
    // 那样一次长距离拖动会被误判成点击而弹出面板。位移才是可靠信号——
    // moved 已要求「位移 > 14px 且按下超过 60ms」，足以容忍手指点按的轻微抖动。
    const isClick = !moved;
    if (wasTouch) suppressMouseUntil = Date.now() + 500;
    save();
    notifySettled();
    if (isClick && typeof onTap === 'function') onTap();
  }

  function onResize() {
    if (!rootEl) return;
    const saved = readSaved();
    measureOrigin();
    if (saved) {
      const c = clamp(saved.x, saved.y);
      paint(c.x, c.y);
    } else {
      // 没有存档时回到 CSS 默认位（right/bottom 锚定会随视口变化自动跟随）
      rootEl.style.transform = '';
      const r = rootEl.getBoundingClientRect();
      curX = r.left;
      curY = r.top;
    }
    notifySettled();
  }

  onMounted(async () => {
    await nextTick();
    rootEl = root?.value || null;
    handleEl = handle?.value || rootEl;
    if (!rootEl) return;
    measureOrigin();
    const saved = readSaved();
    if (saved) {
      const c = clamp(saved.x, saved.y);
      paint(c.x, c.y);
    } else {
      const r = rootEl.getBoundingClientRect();
      curX = r.left;
      curY = r.top;
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    notifySettled();
  });

  onBeforeUnmount(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if (hasPointer) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
      window.removeEventListener('blur', onUp);
    } else {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
  });

  return { dragging, onDown };
}
