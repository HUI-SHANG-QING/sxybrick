// src/utils/abort.js
// 跨浏览器可用的中止信号工具（round82——修 round78 P2-1）。
//
// 为什么必须自己兜底：
//   `AbortSignal.timeout()` 是 **Safari 16+ / Chrome 103+** 才有的运行时 API；
//   本项目声明的构建目标 es2020（≈ chrome87 / safari14）**只保证语法转译，不 polyfill 运行时 API**
//   （vite 亦无 runtime polyfill）。于是在旧 Safari（iOS 15，2021–2022 机型）上直接调用会抛
//   `TypeError: AbortSignal.timeout is not a function`，让同步 / AI 对话 / 图片分析 / 资料解析**整条失效**。
//   更糟的是 sync.js 的 catch 会把这个 TypeError 归到「网络不通」，提示用户去查中枢、防火墙——
//   用户按提示排查半天，真实原因只是浏览器太老。
//   `AbortSignal.any()` 同属 Safari 16+。
//
// 兜底实现（AbortController + setTimeout）在所有目标浏览器都可用，**语义等价**：
//   超时中止时的 reason 仍是 `TimeoutError`（沿用 sync.js 等消费方既有的 e.name 判据）。

/**
 * `AbortSignal.timeout(ms)` 的兼容版。
 * @param {number} ms
 * @returns {AbortSignal}
 */
export function timeoutSignal(ms) {
  const t = Number(ms);
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(t);
  }
  const ac = new AbortController();
  const id = setTimeout(() => {
    const err = new Error('TimeoutError');
    err.name = 'TimeoutError'; // 与原生一致的判别名，消费方的 e.name === 'TimeoutError' 分支照旧生效
    ac.abort(err);
  }, t);
  // Node 下不要因为一个未触发的计时器吊住进程（测试里尤其明显）；浏览器里 unref 不存在
  id?.unref?.();
  return ac.signal;
}

/**
 * `AbortSignal.any(signals)` 的兼容版：**任一**输入中止即中止。
 * 注意语义：外部信号与超时是 AND 关系（任一触发都该中断），不是 OR。
 * @param {Array<AbortSignal|undefined|null>} signals
 * @returns {AbortSignal|undefined} 全部为空时返回 undefined（调用方按"无信号"处理）
 */
export function anySignal(signals) {
  const list = (Array.isArray(signals) ? signals : [signals]).filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list);
  }
  const ac = new AbortController();
  for (const s of list) {
    if (s.aborted) { ac.abort(s.reason); break; }
    // once：正常路径下中止后自动摘除；未中止的长命信号会残留监听器（本项目按请求作用域使用，可接受）
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
