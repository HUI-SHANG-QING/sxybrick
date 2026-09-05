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

  function notify() {
    if (onChange) onChange(isFullscreen.value);
  }

  async function enter() {
    const el = targetRef.value;
    if (!el) return;
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
    isFullscreen.value = true;
    notify();
  }

  function exit() {
    if (fake.value) {
      fake.value = false;
      const el = targetRef.value;
      if (el) el.classList.remove('fake-fullscreen');
      isFullscreen.value = false;
      notify();
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().then(() => { isFullscreen.value = false; notify(); }).catch(() => {});
    } else {
      isFullscreen.value = false;
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
    if (!real && el) el.classList.remove('fake-fullscreen');
    notify();
  }

  onMounted(() => document.addEventListener('fullscreenchange', onFsChange));
  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', onFsChange);
    if (fake.value && targetRef.value) targetRef.value.classList.remove('fake-fullscreen');
  });

  return { isFullscreen, fakeFullscreen: fake, enter, exit, toggle };
}
