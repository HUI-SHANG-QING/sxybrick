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

/**
 * round26 D2：为 Dexie 实例装配「写后广播」hooks（creating/updating/deleting）。
 * - 150ms 节流：批量写（导入/同步/初始化）不会产生广播风暴；
 * - 回调本身只读刷新（视图订阅方不得回写），无循环风险；
 * - Node 测试环境 window 缺失时 notifyDbChanged 自动空转。
 * @param {import('dexie').Dexie} dbInstance
 */
export function armDbNotify(dbInstance) {
  // 重复装配防护（HMR / 多次调用）：hook 会累积，防成广播风暴
  if (!dbInstance || !Array.isArray(dbInstance.tables) || dbInstance.__dbNotifyArmed) return;
  dbInstance.__dbNotifyArmed = true;
  let timer = null;
  const fire = () => { timer = null; notifyDbChanged('local'); };
  // 审计 P2-3（2026-09-14）：trailing 节流——每次写都重置计时器，
  // 广播发生在「最后一次写后安静 150ms」，而非「第一次写后 150ms」。
  // 旧实现单发不重置：批量导入/同步持续写库时，广播可能落在写完成之前，
  // 其他 tab 收到通知去刷新却读到中间态（数据还没落完）。
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(fire, 150); };
  // round125 审计（P0 修复）：**必须装在 Table 级 hook 上**。
  //   实测（Dexie 4.0.8 + fake-indexeddb）：`db.on('creating'|'updating'|'deleting')`
  //   **直接抛错** —— `Cannot read properties of undefined (reading 'subscribe')`：
  //   实例级 `db.on()` 只接受 populate / ready / versionchange，
  //   而 CRUD 这三个事件是 **Table 级** 的 `table.hook(ev, cb)`。
  //   原来的 try/catch 把这个错**静默吞掉**：装配时「看似成功」，运行时**一次都不触发**
  //   ⇒ 整套「跨 tab 数据变更广播」名存实亡：
  //     · intelligence 的卡片缓存收不到失效通知（退化为 5s TTL 兜底）；
  //     · WordBook / WordPhrases / WordGroups 在别的 tab 写库后**永不自动刷新**。
  //   修后实测：写 / 改 / 删各触发 1 次（见 tests/db-events-arm.test.mjs）。
  //   hook 回调只 setTimeout，不抛错、不改写数据 ⇒ 绝不影响写事务。
  for (const table of dbInstance.tables) {
    for (const ev of ['creating', 'updating', 'deleting']) {
      try { table.hook(ev, () => { schedule(); }); }
      catch { /* 个别表在特殊环境下不支持 hook：跳过该表，不影响其它表与主流程 */ }
    }
  }
}
