// src/utils/clone.js
// 跨浏览器深拷贝（round82——修 round78 P2-2）。
//
// 为什么需要：`structuredClone` 是 **Safari 15.4+ / Chrome 98+** 才有的运行时 API，
// 而项目声明构建目标 es2020（≈ chrome87 / safari14），vite 只转译语法、不 polyfill 运行时 API。
// 旧 Safari 上装插件后，插件工具调用与事件钩子分发会直接抛
// `ReferenceError: structuredClone is not defined`（插件功能整块失效）。
//
// 取舍：JSON 往返**不支持** Blob / Date / Map / Set / undefined / 函数。
// 插件参数按约定是纯 JSON（见 plugins/ 的契约），故兜底路径足够；
// 若将来越过插件边界传 Blob，请显式换别的克隆路径，别指望这里。
export function deepClone(v) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      // 含不可结构化克隆的值（Proxy/函数）→ 退到 JSON 往返，至少不抛
    }
  }
  return JSON.parse(JSON.stringify(v ?? null));
}
