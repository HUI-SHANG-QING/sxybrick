// src/utils/time.js
// 时刻解析与比较（纯函数，可单测）
//
// 背景（P0 修复）：原实现在 App.vue 里用「字符串字典序」比较时刻：
//     const now = `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`  // "9:05"
//     if (now >= t) ...                                                        // t = "21:30"
// 小时未补零 → "9:05" >= "21:30" 逐字符比 "9" vs "2" → 恒为 true，
// 于是设 21:30 的提醒会在上午 9:05 就触发，并占掉当日唯一名额，真正的提醒永不触发。
// 即便用户输入补零的 "09:30"，"9:05" >= "09:30" 依旧成立（"9" > "0"）。
//
// 铁律：时刻一律转成「当日分钟数」再比较，禁止字符串比较。

/** 把 Date 转为当日分钟数 0..1439 */
export function toMinutesOfDay(d) {
  if (!d) return NaN;
  const date = d instanceof Date ? d : new Date(d);
  const t = date.getTime();
  if (!Number.isFinite(t)) return NaN;
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * 解析 "H:mm" / "HH:mm" 为当日分钟数；非法返回 null。
 * 宽容处理：允许前后空格、允许 H:mm 与 HH:mm、允许全角冒号。
 */
export function parseHm(text) {
  const s = String(text ?? '').trim().replace(/[：]/g, ':');
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 当前时刻是否已到目标时刻（分钟级数值比较） */
export function hasReached(targetHm, now = new Date()) {
  const target = parseHm(targetHm);
  if (target == null) return false;
  const cur = toMinutesOfDay(now);
  if (!Number.isFinite(cur)) return false;
  return cur >= target;
}

/** 把分钟数格式化为 "HH:mm"（用于回显与测试） */
export function formatHm(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const m = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
