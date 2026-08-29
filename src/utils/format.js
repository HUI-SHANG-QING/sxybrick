// src/utils/format.js —— 统一格式化函数（P1-18：消除全局 15+ 处重复实现）
// 之前每个模块都自带一份 `const p = n => String(n).padStart(2,'0')` / fmtSize / fmtSize，
// 签名与行为各自为政。集中到此处，统一语义、便于维护与测试。
export const pad2 = (n) => String(n ?? 0).padStart(2, '0');

/** 时间戳 → 本地日期 YYYY-MM-DD（ts 缺省取当前） */
export function formatDate(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 时间戳 → 本地日期时间 YYYY-MM-DD HH:mm:ss */
export function formatDateTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${formatDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 时间戳 → 本地时间 HH:mm（分钟级数值比较用得到，见 App.vue 提醒逻辑） */
export function formatTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 字节 → 人类可读（如 1.21 MB）。与 Sync.vue 旧 fmtSize 行为一致。 */
export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 秒 → 人类可读时长（如 1h23m / 45s） */
export function formatDuration(sec = 0) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}
