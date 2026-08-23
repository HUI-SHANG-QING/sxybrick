// 全局轻提示
import { ref } from 'vue';

export const toasts = ref([]);
let seq = 0;

export function toast(message, type = 'info', duration = 3000) {
  const id = ++seq;
  toasts.value.push({ id, message, type });
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, duration);
}