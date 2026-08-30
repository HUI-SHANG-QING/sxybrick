// src/utils/locale-date.js —— 跟随界面语言的日期/时间格式化（收口 8+ 处 'zh-CN' 硬编码）
//
// 为什么单独一个文件：
//   1) src/utils/format.js 被数据层（repo.js / sync.js …）大量引用，必须保持零依赖，
//      不能因为一个「显示格式」把 vue 的响应式拉进 Node 可单测的纯函数链；
//   2) 显示层需要跟随 i18n 的 locale.value，模板里调用会自动追踪语言切换。
//
// 与 format.js 的分工：
//   format.js        —— 稳定的机器格式（YYYY-MM-DD / HH:mm:ss），用于文件名、日期索引、数值比较
//   locale-date.js   —— 面向人的显示格式，跟随界面语言（zh-CN → 2026/8/30；en → 8/30/2026）
import { locale } from '../i18n/index.js';

/** 当前界面对应的 Intl 语言标签 */
export function intlTag() {
  return locale.value === 'en' ? 'en-US' : 'zh-CN';
}

function toDate(ts) {
  if (ts == null || ts === '') return null;
  const d = ts instanceof Date ? ts : new Date(Number(ts));
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return null;
  return d;
}

/**
 * 日期（跟随语言）：zh → 2026/8/30，en → 8/30/2026
 * @param {number|Date} ts 毫秒时间戳；非法/缺失返回 '—'
 * @param {Intl.DateTimeFormatOptions} [opts] 覆盖默认选项
 */
export function fmtLocaleDate(ts, opts) {
  const d = toDate(ts);
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat(intlTag(), {
      year: 'numeric', month: 'numeric', day: 'numeric', ...opts,
    }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

/**
 * 时间（跟随语言）：zh → 19:48（24 小时制），en → 07:48 PM
 */
export function fmtLocaleTime(ts, opts) {
  const d = toDate(ts);
  if (!d) return '—';
  const en = intlTag() === 'en-US';
  try {
    return new Intl.DateTimeFormat(intlTag(), {
      hour: '2-digit', minute: '2-digit', hour12: en, ...opts,
    }).format(d);
  } catch { return d.toISOString().slice(11, 16); }
}

/**
 * 日期 + 时间（跟随语言）：zh → 2026/8/30 19:48，en → Aug 30, 2026, 7:48 PM
 */
export function fmtLocaleDateTime(ts, opts) {
  const d = toDate(ts);
  if (!d) return '—';
  const en = intlTag() === 'en-US';
  try {
    return new Intl.DateTimeFormat(intlTag(), {
      dateStyle: 'medium', timeStyle: 'short', hour12: en, ...opts,
    }).format(d);
  } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

/** 数字（跟随语言分组符）：1234567 → 1,234,567 */
export function fmtLocaleNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try { return new Intl.NumberFormat(intlTag()).format(v); } catch { return String(v); }
}
