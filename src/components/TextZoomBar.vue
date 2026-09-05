<script setup>
// 阅读内容缩放条：文本内容用「字号重排式缩放」（A− / 百分比 / A+ / 复位）。
// 只负责展示与发事件，状态与持久化交给 useTextZoom（各模块复用同一套 UI）。
import { computed } from 'vue';
import { t } from '../i18n/index.js';
import { ZOOM_MIN, ZOOM_MAX } from '../composables/useTextZoom.js';

const props = defineProps({ scale: { type: Number, default: 1 } });
const emit = defineEmits(['zoom-in', 'zoom-out', 'reset']);

const percent = computed(() => `${Math.round(props.scale * 100)}%`);
</script>

<template>
  <div class="tz-bar no-print">
    <span class="tz-label">{{ t('common.zoom.label') }}</span>
    <button class="tz-btn" :title="t('common.zoom.out')" :disabled="scale <= ZOOM_MIN" @click="emit('zoom-out')">A−</button>
    <span class="tz-val">{{ percent }}</span>
    <button class="tz-btn" :title="t('common.zoom.in')" :disabled="scale >= ZOOM_MAX" @click="emit('zoom-in')">A+</button>
    <button class="tz-btn tz-reset" :title="t('common.zoom.reset')" @click="emit('reset')">⟲</button>
  </div>
</template>

<style scoped>
.tz-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
}
.tz-label { font-size: 12px; color: var(--ink-2); margin-right: 2px; }
.tz-btn {
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
.tz-btn:hover:not(:disabled) { background: var(--code-bg); }
.tz-btn:disabled { opacity: .4; cursor: not-allowed; }
.tz-val {
  min-width: 42px;
  text-align: center;
  font-size: 12px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.tz-reset { font-size: 14px; }
</style>
