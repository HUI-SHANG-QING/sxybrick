<script setup>
import { toasts } from './utils/toast.js';
import { degraded } from './utils/perf.js';
</script>

<template>
  <div class="app-shell" :class="{ 'no-anim': degraded }">
    <nav class="app-nav no-print">
      <span class="brand">SxyBrick 记忆卡片</span>
      <router-link to="/">我的卡片</router-link>
      <router-link to="/review">背诵</router-link>
      <router-link to="/stats">数据</router-link>
      <router-link to="/export">导出打印</router-link>
      <router-link to="/sync">同步</router-link>
    </nav>
    <main class="app-main">
      <router-view />
    </main>
    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
    </div>
    <div v-if="degraded" class="hint" style="position:fixed;bottom:8px;right:12px;z-index:200">
      已启用性能优化模式
    </div>
  </div>
</template>