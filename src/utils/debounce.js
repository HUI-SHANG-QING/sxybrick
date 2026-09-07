// 通用防抖（纯函数式，无依赖）：用于搜索框等高频触发场景。
// 背景：词组/单词搜索此前是直接 `watch(q, load)`，每敲一个字符触发一次全表查询，
// 词库 5000+ 时输入明显卡顿（审计 U-1）。这里提供零依赖 debounce 供各处复用。
/**
 * @param {Function} fn 被防抖的函数
 * @param {number} wait 静默等待毫秒数
 * @returns {Function} 防抖后的函数（带 .cancel()）
 */
export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}
