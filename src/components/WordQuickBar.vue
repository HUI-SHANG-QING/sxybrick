<script setup>
// 英语模块底部 5 个快捷入口（沉浸刷词 / 随身听 / 听写 / 随手拼 / 导出）
// 用于中心页、单词本、背诵页底部常驻；点击跳转对应模式或页面。
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';

const router = useRouter();

const entries = [
  { key: 'immerse', icon: '🌊', label: t('views.wordHub.quickImmerse'), to: '/english/study?mode=adaptive' },
  { key: 'listen', icon: '🎧', label: t('views.wordHub.quickListen'), to: '/english/study?mode=listenChoice' },
  { key: 'dictation', icon: '✍️', label: t('views.wordHub.quickDictation'), to: '/english/study?mode=listenSpell' },
  { key: 'spell', icon: '🔡', label: t('views.wordHub.quickSpell'), to: '/english/study?mode=cloze' },
  { key: 'export', icon: '🖨️', label: t('views.wordHub.quickExport'), to: '/english/export' },
];

function go(e) {
  router.push(e.to);
}
</script>

<template>
  <div class="word-quick-bar no-print">
    <button v-for="e in entries" :key="e.key" class="qb-item" @click="go(e)">
      <span class="qb-icon">{{ e.icon }}</span>
      <span class="qb-label">{{ e.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.word-quick-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 14px;
  z-index: 60;
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .14);
  max-width: 96vw;
  overflow-x: auto;
}
.qb-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 56px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  border-radius: 12px;
  cursor: pointer;
  color: var(--ink);
  transition: .15s;
}
.qb-item:hover { background: var(--code-inline); }
.qb-item:active { transform: scale(.94); }
.qb-icon { font-size: 20px; line-height: 1; }
.qb-label { font-size: 11px; color: var(--ink-2); white-space: nowrap; }
@media (max-width: 520px) {
  .qb-item { min-width: 48px; padding: 6px 6px; }
  .qb-label { font-size: 10px; }
}
</style>
