// 全局轻提示：使用 Element Plus 的 ElMessage（企业级 UI 风格）
// 注意：只在 toast.js 按需导入 ElMessage 的「组件级样式」，不整包引入 Element Plus，
// 保证打包体积最小化。
import { ElMessage } from 'element-plus';
import 'element-plus/es/components/message/style/css';

export { ElMessage };

const typeMap = { success: 'success', error: 'error', warning: 'warning', info: 'info' };

export function toast(message, type = 'info', duration = 3000) {
  ElMessage({ message: String(message ?? ''), type: typeMap[type] || 'info', duration });
}