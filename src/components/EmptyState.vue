<template>
  <div class="empty-state">
    <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="42" y="16" width="60" height="48" rx="10" fill="currentColor" opacity="0.18"/>
      <rect x="30" y="30" width="60" height="48" rx="10" fill="currentColor" opacity="0.4"/>
      <rect x="18" y="44" width="60" height="48" rx="10" fill="currentColor"/>
      <circle cx="34" cy="64" r="5" fill="#fff"/>
      <rect x="44" y="62" width="22" height="4" rx="2" fill="#fff"/>
      <rect x="30" y="76" width="36" height="3" rx="1.5" fill="#fff" opacity="0.7"/>
      <rect x="30" y="84" width="26" height="3" rx="1.5" fill="#fff" opacity="0.5"/>
    </svg>
    <h3>{{ title }}</h3>
    <p class="hint">{{ message }}</p>
    <slot />
  </div>
</template>

<script setup>
defineProps({ title: { type: String, default: '' }, message: { type: String, default: '' } });
</script>

<style scoped>
.empty-state { text-align: center; padding: 60px 0; color: var(--blue); }
.empty-state svg { margin-bottom: 14px; }
.empty-state h3 { color: var(--ink); margin: 0 0 4px; }
.empty-state .hint { margin: 0 0 18px; color: var(--ink-2); }
</style>