// P3-2 PWA 离线优化：SW 注册 / 更新提示 / 在线状态 / Storage 配额监控
// 设计原则：
//  1) SW 注册走 vite-plugin-pwa 的 virtual:pwa-register（autoUpdate 模式），
//     新版本下载完毕后通过 onNeedRefresh 回调通知 UI，由用户决定何时刷新；
//  2) onOfflineReady 表示已可完全离线启动，UI 一次性轻提示；
//  3) 在线/离线状态用 navigator.onLine + online/offline 事件维护，
//     当从在线切到离线时提示用户「数据将保存在本地，联网后自动同步」；
//  4) IndexedDB quota 监控：当剩余可用空间 < 10% 时给出清理建议，
//     避免用户在不知情时写满导致数据丢失（浏览器会在 quota 超限时静默拒绝写入）。
// 所有函数均为幂等：可重复调用、可热重载，不会重复注册监听器。

import { registerSW } from 'virtual:pwa-register';

// ---------- 内部状态（模块级单例） ----------
const onlineCallbacks = new Set();
const updateCallbacks = new Set();
const offlineReadyCallbacks = new Set();
const quotaCallbacks = new Set();
let swRegistered = false;

// SW 是否需要刷新（onNeedRefresh 时置 true，用户点击刷新后置 false）
let needRefresh = false;
let offlineReady = false;
let lastQuotaWarnAt = 0; // quota 警告节流：同一会话最多每 30 分钟提示一次

/**
 * 初始化 PWA：注册 SW + 监听 online/offline + 启动 quota 周期检查
 * @param {object} [opts]
 * @param {number} [opts.quotaCheckIntervalMs] 配额检查周期，默认 5 分钟；0 = 不检查
 */
export function initPwa(opts = {}) {
  if (swRegistered) return;
  swRegistered = true;

  // 注册 SW：onNeedRefresh 在「新版本已下载完毕，等待激活」时触发；
  //   onOfflineReady 在「所有预缓存资源已就绪，可离线启动」时触发
  if (typeof registerSW === 'function') {
    registerSW({
      immediate: true,
      onNeedRefresh() {
        needRefresh = true;
        updateCallbacks.forEach(cb => { try { cb(true); } catch {} });
      },
      onOfflineReady() {
        offlineReady = true;
        offlineReadyCallbacks.forEach(cb => { try { cb(); } catch {} });
      },
      onRegisteredSW(swUrl, reg) {
        // autoUpdate 模式下 vite-plugin-pwa 会自动检查更新；这里仅记录日志便于排查
        // 不主动调用 update() 以避免与服务端产生额外请求
      },
      onRegisterError(err) {
        console.warn('[PWA] SW 注册失败（离线缓存不可用，应用仍可正常使用）:', err?.message || err);
      },
    });
  }

  // 在线 / 离线：navigator.onLine 只反映浏览器侧网络栈状态，
  //   真正的 API 可达性仍由各功能自行 try/catch；这里只做 UI 层提示
  const fireOnline = (isOnline) => onlineCallbacks.forEach(cb => { try { cb(isOnline); } catch {} });
  const onOnline = () => fireOnline(true);
  const onOffline = () => fireOnline(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  // 配额周期检查
  const intervalMs = Number.isFinite(opts.quotaCheckIntervalMs) ? opts.quotaCheckIntervalMs : 5 * 60 * 1000;
  if (intervalMs > 0 && navigator.storage?.estimate) {
    checkQuota(); // 启动时立即检查一次
    setInterval(checkQuota, intervalMs);
  }
}

/** 当前是否在线 */
export function isOnline() {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

/** 是否有新版本待激活 */
export function isNeedRefresh() { return needRefresh; }

/** 是否已可离线启动 */
export function isOfflineReady() { return offlineReady; }

/** 订阅在线/离线变化，返回取消订阅函数 */
export function subscribeOnline(cb) {
  onlineCallbacks.add(cb);
  return () => onlineCallbacks.delete(cb);
}

/** 订阅 SW 新版本可用，返回取消订阅函数 */
export function subscribeSwUpdate(cb) {
  updateCallbacks.add(cb);
  return () => updateCallbacks.delete(cb);
}

/** 订阅 SW 离线就绪，返回取消订阅函数（只触发一次） */
export function subscribeOfflineReady(cb) {
  offlineReadyCallbacks.add(cb);
  return () => offlineReadyCallbacks.delete(cb);
}

/** 订阅配额告警，返回取消订阅函数 */
export function subscribeQuotaWarn(cb) {
  quotaCallbacks.add(cb);
  return () => quotaCallbacks.delete(cb);
}

/**
 * 应用更新：让等待中的 SW 接管，并刷新页面加载新版本
 * 失败时静默降级为直接 reload，确保用户总能拿到新版
 */
export async function applyUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) {
        // 通知等待中的 SW 跳过 waiting，下次 controllerchange 时刷新
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        // 兜底：1.5s 后若 controllerchange 未触发，强制刷新
        setTimeout(() => { try { window.location.reload(); } catch {} }, 1500);
        return;
      }
    }
  } catch (e) {
    console.warn('[PWA] applyUpdate 失败，降级 reload:', e?.message || e);
  }
  window.location.reload();
}

/**
 * 查询当前源（origin）的存储配额
 * @returns {Promise<{usage:number, quota:number, usagePercent:number}|null>}
 */
export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const usagePercent = quota > 0 ? Math.round((usage / quota) * 100) : 0;
    return { usage, quota, usagePercent };
  } catch { return null; }
}

/**
 * 主动检查配额，超阈值时通过 subscribeQuotaWarn 通知
 * 默认阈值：使用率 ≥ 85% 或剩余 < 10% 触发；节流避免频繁打扰
 */
export async function checkQuota() {
  const est = await getStorageEstimate();
  if (!est) return;
  const { usagePercent, quota, usage } = est;
  const remainingPercent = 100 - usagePercent;
  const shouldWarn = usagePercent >= 85 || remainingPercent < 10;
  if (!shouldWarn) return;
  const now = Date.now();
  if (now - lastQuotaWarnAt < 30 * 60 * 1000) return; // 同会话 30 分钟内不重复
  lastQuotaWarnAt = now;
  quotaCallbacks.forEach(cb => {
    try { cb({ usage, quota, usagePercent }); } catch {}
  });
}

/**
 * 请求持久化存储：让浏览器把本源数据标记为「持久化」，
 * 避免在 quota 紧张时被回收（IndexedDB 不会被自动清理）
 * @returns {Promise<boolean>} true=已持久化或请求成功
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    const already = await navigator.storage.persisted?.();
    if (already) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}
