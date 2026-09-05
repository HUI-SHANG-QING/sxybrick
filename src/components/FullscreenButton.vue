<script setup>
// 全屏/非全屏切换按钮（复用 common.zoom.fullscreen / exitFullscreen 文案）
import { t } from '../i18n/index.js';
const props = defineProps({ active: { type: Boolean, default: false } });
const emit = defineEmits(['toggle']);
</script>

<template>
  <button class="fs-btn no-print" :title="active ? t('common.zoom.exitFullscreen') : t('common.zoom.fullscreen')" @click="emit('toggle')">
    {{ active ? '✕' : '⛶' }}
  </button>
</template>

<style scoped>
.fs-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.fs-btn:hover { background: var(--code-bg); }
</style>
