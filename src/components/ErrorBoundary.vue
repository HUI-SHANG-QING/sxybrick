<script setup>
// 错误边界（#16）：捕获子组件渲染异常，显示降级 UI，防止整页白屏
import { ref, onErrorCaptured } from 'vue';
import { logError } from '../utils/errorLog.js';
import { useRoute } from 'vue-router';

const route = useRoute();
const hasError = ref(false);
const errorMsg = ref('');

onErrorCaptured(async (err, instance, info) => {
  hasError.value = true;
  errorMsg.value = String(err?.message || err);
  await logError(err, { component: instance?.$options?.__name || instance?.type?.name, route: route?.path, info });
  return false; // 阻止错误继续向上传播（不让整页白屏）
});

function reload() { hasError.value = false; errorMsg.value = ''; }
</script>

<template>
  <div v-if="hasError" class="eb-fallback">
    <div class="eb-icon">⚠️</div>
    <div class="eb-title">这一块出错了</div>
    <div class="eb-msg">{{ errorMsg }}</div>
    <button class="btn primary" @click="reload">重试</button>
    <p class="eb-hint">错误已记录到本地日志（可在「同步」页导出反馈）。</p>
  </div>
  <slot v-else />
</template>

<style scoped>
.eb-fallback { text-align: center; padding: 60px 20px; color: var(--ink-2); }
.eb-icon { font-size: 40px; margin-bottom: 8px; }
.eb-title { font-size: 16px; font-weight: 600; color: var(--ink); margin-bottom: 6px; }
.eb-msg { font-size: 13px; color: var(--red); margin-bottom: 14px; word-break: break-all; max-width: 500px; margin-left: auto; margin-right: auto; }
.eb-hint { font-size: 11px; color: var(--ink-2); margin-top: 12px; }
</style>