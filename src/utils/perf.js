// 前端性能监控：基于 Long Tasks API 检测卡顿，自动进入降级模式
import { ref } from 'vue';

export const degraded = ref(false);
let recent = [];

export function startPerfMonitor() {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const po = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const e of list.getEntries()) recent.push(now);
      recent = recent.filter(t => now - t < 5000);
      if (recent.length >= 3 && !degraded.value) {
        degraded.value = true;
        console.warn('[perf] 检测到浏览器卡顿，已自动启用性能优化策略');
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* 浏览器不支持 longtask */ }
  setInterval(() => {
    const now = performance.now();
    recent = recent.filter(t => now - t < 5000);
    if (degraded.value && recent.length === 0) degraded.value = false;
  }, 10000);
}