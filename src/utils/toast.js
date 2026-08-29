// 全局轻提示：基于 Element Plus 的 ElMessage（2026-08-29 起随 EP 主力 UI 库回归）
// 外观由 src/styles/element-bridge.css 桥接到项目 token，因此自动跟随
// 「11 种界面风格 × 3 种配色模式」，不会像原生 EP 那样出现固定蓝/白"出戏"。
//
// 保持既有调用签名不变（全项目 360+ 处调用点零改动）：
//   toast(message)                 默认 info
//   toast(message, 'error', 5000)  指定类型与时长
//   toast.success/error/warning/info(message, duration)
import { ElMessage } from 'element-plus';

// 项目类型名 → EP type（两者同名，此处显式列出以便将来扩展自定义类型）
const TYPE_MAP = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

export function toast(message, type = 'info', duration = 3000) {
  if (typeof document === 'undefined') return undefined; // SSR / 测试环境兜底
  const t = TYPE_MAP[type] || 'info';
  // grouping：相同内容的消息合并计数，避免连续操作刷屏
  return ElMessage({
    message: String(message ?? ''),
    type: t,
    duration,
    grouping: true,
    showClose: false,
  });
}

toast.success = (message, duration) => toast(message, 'success', duration);
toast.error = (message, duration) => toast(message, 'error', duration);
toast.warning = (message, duration) => toast(message, 'warning', duration);
toast.info = (message, duration) => toast(message, 'info', duration);
toast.dismiss = () => ElMessage.closeAll?.();

export default toast;
