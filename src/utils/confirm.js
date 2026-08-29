// 统一的二次确认对话框，替代原生 confirm()。
// 原生 confirm 阻塞线程、风格与 Element Plus 不一致、无法跟随主题/国际化，
// 且无障碍支持差。这里统一走 ElMessageBox.confirm，返回 Promise<boolean>。
import { ElMessageBox } from 'element-plus';

/**
 * @param {string|{message?:string,title?:string,confirmText?:string,cancelText?:string,type?:string}} opts
 * @returns {Promise<boolean>} 用户点确定返回 true，取消/关闭返回 false
 */
export async function confirmDialog(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  const message = o.message ?? '';
  const title = o.title ?? '请确认';
  const confirmText = o.confirmText ?? '确定';
  const cancelText = o.cancelText ?? '取消';
  const type = o.type ?? 'warning';
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: confirmText,
      cancelButtonText: cancelText,
      type,
      // 提示文案均来自应用内部常量（无外部 HTML 注入），不使用 HTML 渲染
      dangerouslyUseHTMLString: false,
      // 允许 Esc 关闭与点击遮罩关闭（无障碍 / 键盘可达）
      closeOnClickModal: true,
      closeOnPressEscape: true,
    });
    return true;
  } catch {
    return false;
  }
}

export default confirmDialog;
