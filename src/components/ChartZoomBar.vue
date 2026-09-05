<script setup>
// 图表（ECharts）缩放条：缩放指示（×N）+ 适应窗口复位 + 大图模式切换。
// 注意：图表缩放是「大图画布式缩放」（series.zoom + roam），不是 CSS transform —— 后者会糊。
// 本组件只负责展示与发事件，真正的 zoom 注入/重 init 由各图表组件处理。
// 关键：本组件自身 style 是 scoped（作用于自己的元素），即使被父组件 <teleport to="body">
// 渲染到 body 下，缩放条的样式依然生效；需要全屏铺满的遮罩/面板由父组件用内联样式实现。
import { computed } from 'vue';
import { t } from '../i18n/index.js';
import { ZOOM_MIN, ZOOM_MAX } from '../composables/useTextZoom.js';

const props = defineProps({
  zoom: { type: Number, default: 1 },
  fullscreen: { type: Boolean, default: false },
  // sankey 等不支持 roam/zoom 的系列 → 隐藏 A−/A+（仍可进大图模式看大图）
  canZoom: { type: Boolean, default: true },
  // 紧凑模式（图表内联小图）：只显示 大图 + 适应，节省横向空间
  compact: { type: Boolean, default: false },
});

const emit = defineEmits(['zoom-in', 'zoom-out', 'fit', 'toggle-fullscreen']);

const readout = computed(() => {
  const z = Number(props.zoom || 1);
  // 1 -> ×1，1.25 -> ×1.25，0.8 -> ×0.8
  return `×${z.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}`;
});
</script>

<template>
  <div class="cz-bar no-print">
    <button v-if="!compact" class="cz-btn" :disabled="!canZoom || zoom <= ZOOM_MIN" :title="t('common.zoom.out')" @click="emit('zoom-out')">A−</button>
    <span v-if="!compact" class="cz-val">{{ readout }}</span>
    <button v-if="!compact" class="cz-btn" :disabled="!canZoom || zoom >= ZOOM_MAX" :title="t('common.zoom.in')" @click="emit('zoom-in')">A+</button>
    <button class="cz-btn" :title="t('common.zoom.fit')" @click="emit('fit')">⤢</button>
    <button class="cz-btn cz-fs" :title="fullscreen ? t('common.zoom.exitFullscreen') : t('common.zoom.fullscreen')" @click="emit('toggle-fullscreen')">
      {{ fullscreen ? '✕' : '⛶' }}
    </button>
  </div>
</template>

<style scoped>
.cz-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
}
.cz-btn {
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.cz-btn:hover:not(:disabled) { background: var(--code-bg); }
.cz-btn:disabled { opacity: .4; cursor: not-allowed; }
.cz-val {
  min-width: 38px;
  text-align: center;
  font-size: 12px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.cz-fs { font-size: 14px; }
</style>
