<template>
  <div class="empty-state" :class="{ compact }">
    <div class="es-art">
      <span v-if="icon" class="es-emoji">{{ icon }}</span>
      <svg v-else width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="42" y="16" width="60" height="48" rx="10" fill="currentColor" opacity="0.18"/>
        <rect x="30" y="30" width="60" height="48" rx="10" fill="currentColor" opacity="0.4"/>
        <rect x="18" y="44" width="60" height="48" rx="10" fill="currentColor"/>
        <circle cx="34" cy="64" r="5" fill="#fff"/>
        <rect x="44" y="62" width="22" height="4" rx="2" fill="#fff"/>
        <rect x="30" y="76" width="36" height="3" rx="1.5" fill="#fff" opacity="0.7"/>
        <rect x="30" y="84" width="26" height="3" rx="1.5" fill="#fff" opacity="0.5"/>
      </svg>
    </div>
    <h3 v-if="title">{{ title }}</h3>
    <p class="hint" v-if="message">{{ message }}</p>
    <div class="es-action"><slot /></div>
  </div>
</template>

<script setup>
// 统一空状态组件：替代各视图里 25+ 处手写空态。
// icon 传 emoji（如 '🗂️'）覆盖默认插画；title/message 为文案；默认 slot 放操作按钮。
defineProps({
  icon: { type: String, default: '' },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  compact: { type: Boolean, default: false },
});
</script>

<style scoped>
.empty-state { text-align: center; padding: 56px 16px; color: var(--blue); }
.empty-state.compact { padding: 28px 16px; }
.es-art { margin-bottom: 14px; }
.es-emoji { font-size: 48px; line-height: 1; }
.empty-state h3 { color: var(--ink); margin: 0 0 6px; font-size: 16px; font-weight: 600; }
.empty-state .hint { margin: 0 0 16px; color: var(--ink-2); font-size: 13px; }
.es-action { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
</style>
