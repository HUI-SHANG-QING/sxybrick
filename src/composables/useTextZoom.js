// src/composables/useTextZoom.js
// 阅读文本的「字号重排式缩放」：学习场景里 AI 长回答/解析/笔记要放大专注阅读，
// 与图表的「画布缩放」是两套机制（见 SxyBrick-内容缩放支持范围与优先级）。
//
// 设计要点：
//  1) 改 font-size（em 相对单位）而非 CSS transform scale —— 内容自动重排，不产生横向滚动；
//  2) 阶梯步进 + 上下限钳制，避免字号失控；
//  3) 按模块持久化（localStorage），复习时反复回看保持同一字号；
//  4) Ctrl+滚轮快捷缩放，普通滚轮仍用于滚动（不拦截）。
import { ref, computed, watch } from 'vue';

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const storageKey = (moduleKey) => `sxy_zoom_${moduleKey}`;

/**
 * 在 ZOOM_STEPS 阶梯上步进（图表缩放与文本缩放共用同一套档位）。
 * @param {number} value 当前档位
 * @param {number} dir  +1 放大 / -1 缩小
 * @returns {number} 步进后的档位（钳在 [ZOOM_MIN, ZOOM_MAX]）
 */
export function stepZoom(value, dir) {
  const i = ZOOM_STEPS.indexOf(value);
  const base = i < 0 ? ZOOM_STEPS.indexOf(1) : i;
  const ni = dir > 0
    ? Math.min(ZOOM_STEPS.length - 1, base + 1)
    : Math.max(0, base - 1);
  return ZOOM_STEPS[ni];
}

/** 读取模块已存的字号（无记录/非法值 → 1） */
export function readZoom(moduleKey) {
  try {
    const v = parseFloat(localStorage.getItem(storageKey(moduleKey)));
    return ZOOM_STEPS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

/**
 * 文本缩放组合式函数。
 * @param {string} moduleKey 模块唯一键（用于持久化，如 'aiAssistant' / 'feynman'）
 * @returns {{scale, fontStyle, zoomIn, zoomOut, reset, onWheel}}
 */
export function useTextZoom(moduleKey) {
  const scale = ref(readZoom(moduleKey));

  watch(scale, (v) => {
    try { localStorage.setItem(storageKey(moduleKey), String(v)); } catch { /* 隐私模式忽略 */ }
  });

  const idx = computed(() => {
    const i = ZOOM_STEPS.indexOf(scale.value);
    return i < 0 ? ZOOM_STEPS.indexOf(1) : i;
  });

  function zoomIn() { if (idx.value < ZOOM_STEPS.length - 1) scale.value = ZOOM_STEPS[idx.value + 1]; }
  function zoomOut() { if (idx.value > 0) scale.value = ZOOM_STEPS[idx.value - 1]; }
  function reset() { scale.value = 1; }

  // 作用于内容容器的行内样式（em → 相对当前字号等比放大并重排）
  const fontStyle = computed(() => ({ fontSize: `${scale.value}em` }));

  // Ctrl/Cmd + 滚轮缩放；普通滚轮放行，保证长对话可正常滚动
  function onWheel(e) {
    if (!e || (!e.ctrlKey && !e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY < 0) zoomIn(); else zoomOut();
  }

  return { scale, fontStyle, zoomIn, zoomOut, reset, onWheel };
}
