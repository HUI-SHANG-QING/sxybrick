// src/composables/useFullscreen.js
// 真正的「全屏 / 非全屏」切换：优先用浏览器 Fullscreen API（requestFullscreen），
// 在 iframe / CSP 拦下时退化为 CSS 铺满（.fake-fullscreen），保证「全屏/非全屏」始终可用。
//
// 与之前的「缩放」是两回事：全屏是让内容占满整个屏幕专心阅读/复习，不改变字号、不重排。
// 图表进入全屏后必须 resize（容器尺寸变了），通过 onChange 回调通知调用方。
import { ref, onMounted, onBeforeUnmount } from 'vue';

/**
 * @param {import('vue').Ref<HTMLElement|null>} targetRef 要全屏的元素
 * @param {(isFullscreen:boolean)=>void} [onChange] 全屏状态变化回调（图表在此 resize）
 */
export function useFullscreen(targetRef, onChange) {
  const isFullscreen = ref(false);
  const fake = ref(false);
  let exitBtn = null; // D13：fake 模式浮动退出按钮（目标外按钮被铺满层压住，必须注入可点出口）

  function notify() {
    if (onChange) onChange(isFullscreen.value);
  }

  // D13：fake 全屏时目标元素 fixed 铺满（z-95），位于其外的 FullscreenButton
  // 被压在底层 → 唯一出口是刷新页面。向 body 注入浮动退出按钮（z-9999 高于铺满层），
  // 并监听 ESC（真实全屏由浏览器自带 ESC，这里只兜 fake 路径）。
  function showFakeExitBtn() {
    removeFakeExitBtn();
    exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'fake-fs-exit no-print';
    exitBtn.title = '退出全屏（Esc）';
    exitBtn.textContent = '✕';
    exitBtn.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;min-width:32px;height:32px;'
      + 'padding:0 10px;border:1px solid var(--line,#ddd);border-radius:8px;'
      + 'background:var(--panel,#fff);color:var(--ink,#222);font-size:14px;cursor:pointer;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.18);';
    exitBtn.onclick = () => exit();
    document.body.appendChild(exitBtn);
  }
  function removeFakeExitBtn() {
    if (exitBtn && exitBtn.parentNode) exitBtn.parentNode.removeChild(exitBtn);
    exitBtn = null;
  }
  function onKey(e) {
    if (e.key === 'Escape' && fake.value) exit();
  }

  async function enter() {
    const el = targetRef.value;
    if (!el) return;
    // 全屏元素自带的透明背景会被浏览器渲染成近黑色底（图表全屏后黑屏）。
    // 进入全屏前先落一个不透明白底，退出/取消全屏时再还原。
    el.style.background = '#fff';
    if (el.requestFullscreen) {
      try {
        await el.requestFullscreen();
        fake.value = false;
        isFullscreen.value = true;
        notify();
        return;
      } catch (e) {
        // 被 iframe / CSP 拦下 → 退化成 CSS 全屏
      }
    }
    // 退化：CSS fixed 铺满（仍可「全屏/非全屏」切换）
    fake.value = true;
    el.classList.add('fake-fullscreen');
    showFakeExitBtn();
    isFullscreen.value = true;
    notify();
  }

  function exit() {
    removeFakeExitBtn();
    if (fake.value) {
      fake.value = false;
      const el = targetRef.value;
      if (el) { el.classList.remove('fake-fullscreen'); el.style.background = ''; }
      isFullscreen.value = false;
      notify();
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().then(() => {
        isFullscreen.value = false;
        if (targetRef.value) targetRef.value.style.background = '';
        notify();
      }).catch(() => {});
    } else {
      isFullscreen.value = false;
      if (targetRef.value) targetRef.value.style.background = '';
      notify();
    }
  }

  function toggle() {
    if (isFullscreen.value) exit();
    else enter();
  }

  function onFsChange() {
    // 真实全屏变化（含用户按 ESC 退出）；fake 模式不走这个事件
    fake.value = false;
    const el = targetRef.value;
    const real = !!document.fullscreenElement && document.fullscreenElement === el;
    isFullscreen.value = real;
    if (!real && el) { el.classList.remove('fake-fullscreen'); el.style.background = ''; }
    if (!real) removeFakeExitBtn(); // 状态漂移时兜住残留按钮
    notify();
  }

  onMounted(() => {
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('keydown', onKey);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('keydown', onKey);
    removeFakeExitBtn();
    if (fake.value && targetRef.value) targetRef.value.classList.remove('fake-fullscreen');
  });

  return { isFullscreen, fakeFullscreen: fake, enter, exit, toggle };
}
