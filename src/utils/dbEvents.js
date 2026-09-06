// src/utils/dbEvents.js
// 跨 tab 数据变更广播（审计 C3）。
//
// 背景：多 tab 共享同一 IndexedDB，但数据层此前无失效广播——Tab A 导入/同步写库后，
// Tab B 的组件仍持旧快照，用户可见陈旧数据；若继续编辑还可能以旧数据为基覆盖
// Tab A 刚写入的新内容。
//
// 方案：
//  1) BroadcastChannel('sxy-db-changed')：同源多 tab 之间实时互通知。
//  2) 另发 window CustomEvent('sxy:dbchanged')：供当前页面内其他模块（如需要即时刷新的
//     store/composable）监听，而不必逐视图接 BroadcastChannel。
// 兼容降级：不支持 BroadcastChannel 的环境（极旧浏览器）静默退化为仅本页 CustomEvent。
// 纯前端工具，Node 测试环境无 window/BroadcastChannel，调用方需自行 try/catch 或判断。

const CHANNEL = 'sxy-db-changed';
const WINDOW_EVENT = 'sxy:dbchanged';

/** 通知所有 tab：本地数据已变更，建议刷新视图 / 重新拉取统计。 */
export function notifyDbChanged(source = 'local') {
  if (typeof window === 'undefined') return;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.postMessage({ source, at: Date.now() });
      // postMessage 为异步投递；本 Channel 用完即关闭，避免常驻句柄泄漏
      setTimeout(() => { try { ch.close(); } catch { /* ignore */ } }, 0);
    }
  } catch { /* 隐私模式/被禁：静默忽略 */ }
  // 本页面自己也派发一次，方便统一入口
  try { window.dispatchEvent(new CustomEvent(WINDOW_EVENT, { detail: { source, at: Date.now() } })); } catch { /* ignore */ }
}

/**
 * 订阅跨 tab 数据变更（含本页派发的 WINDOW_EVENT）。
 * @param {(e: {source:string, at:number})=>void} cb
 * @returns {()=>void} 取消订阅函数
 */
export function subscribeDbChanged(cb) {
  if (typeof window === 'undefined') return () => {};
  const onBroadcast = (ev) => {
    const d = ev?.data || {};
    try { cb({ source: d.source || 'other-tab', at: d.at || Date.now() }); } catch { /* ignore */ }
  };
  const onWindow = (ev) => {
    const d = ev?.detail || {};
    try { cb({ source: d.source || 'local', at: d.at || Date.now(), windowEvent: true }); } catch { /* ignore */ }
  };
  let ch = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = onBroadcast;
    } catch { ch = null; }
  }
  window.addEventListener(WINDOW_EVENT, onWindow);
  return () => {
    if (ch) { try { ch.close(); } catch { /* ignore */ } }
    window.removeEventListener(WINDOW_EVENT, onWindow);
  };
}