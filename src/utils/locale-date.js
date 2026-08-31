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

// 2024-01-07 是周日：以它为基准 +i 天即可稳定取到「周日…周六」的本地化名称，
// 不用依赖运行时是星期几（否则同一段代码在不同日期跑出的数组顺序会不同）。
const WEEK_BASE = new Date(2024, 0, 7);

/**
 * 星期名称数组（下标 0 = 周日，与 Date.getDay() 对齐）
 * @param {'long'|'short'|'narrow'} [style] 缺省 'short'：zh → 周日…周六，en → Sun…Sat。
 *   注意 en 的 'narrow' 是 S,M,T,W,T,F,S（S/T 各出现两次，有歧义），图表轴请用 'short'。
 */
export function weekdayNames(style = 'short') {
  try {
    const f = new Intl.DateTimeFormat(intlTag(), { weekday: style });
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(WEEK_BASE);
      d.setDate(d.getDate() + i);
      return f.format(d);
    });
  } catch { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六']; }
}

/**
 * 月份名称数组（下标 0 = 1 月）：zh → 1月…12月，en → Jan…Dec
 * @param {'long'|'short'|'narrow'|'numeric'} [style] 缺省 'short'
 */
export function monthNames(style = 'short') {
  try {
    const f = new Intl.DateTimeFormat(intlTag(), { month: style });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(2024, i, 1)));
  } catch { return Array.from({ length: 12 }, (_, i) => `${i + 1}月`); }
}

// RelativeTimeFormat 实例按语言标签缓存：构造成本不低，而相对时间在列表里会被高频调用
const rtfCache = new Map();
function rtf(tag) {
  let f = rtfCache.get(tag);
  if (!f) { f = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }); rtfCache.set(tag, f); }
  return f;
}

// 从细到粗的梯度；阈值取「下一级单位的半格」，避免 45 分钟被说成"1 小时前"
// 阈值刻意不取满格（分→时 45min、时→天 23h、月→年 330d）：
// 满格会让 59 分钟显示成"60 分钟前"、23.5 小时显示成"24 小时前"，
// 进位到上一级（"1 小时前"/"昨天"）才符合人的读数习惯。
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000, MONTH = 2_592_000_000;
const REL_STEPS = [
  { unit: 'minute', ms: MIN, limit: 45 * MIN },
  { unit: 'hour', ms: HOUR, limit: 23 * HOUR },
  { unit: 'day', ms: DAY, limit: 30 * DAY },
  { unit: 'month', ms: MONTH, limit: 330 * DAY },
  { unit: 'year', ms: 31_536_000_000, limit: Infinity },
];

/**
 * 相对时间（跟随语言）：zh → 现在 / 5分钟前 / 3小时前 / 昨天；en → now / 5 minutes ago / yesterday
 *
 * 为什么用 Intl.RelativeTimeFormat 而不是自己拼 'N 分钟前'：
 *   自拼的串在英文界面下会原样显示中文（Workspace 曾因此整块不跟随语言），
 *   且 en 需要复数（1 minute ago / 2 minutes ago）与昨天/明天这类特例，手写必错。
 *
 * @param {number|Date} ts 目标时刻
 * @param {number} [nowMs] 参考时刻，缺省 Date.now()（测试可注入固定值）
 * @returns {string} 非法输入返回 '—'
 */
export function fmtLocaleRelative(ts, nowMs = Date.now()) {
  const d = toDate(ts);
  if (!d) return '—';
  const base = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const diff = d.getTime() - base;
  const abs = Math.abs(diff);
  const tag = intlTag();
  try {
    // 45 秒以内按"现在/now"处理（numeric:'auto' 下 format(0) 即这个语义）
    if (abs < 45_000) return rtf(tag).format(0, 'second');
    for (const s of REL_STEPS) {
      if (abs < s.limit) {
        // 不足 1 个下级单位时按 1 计（如 50 秒 → "1 分钟前"，而不是"0 分钟前"）
        const n = Math.max(1, Math.round(abs / s.ms));
        return rtf(tag).format(Math.sign(diff) * n, s.unit);
      }
    }
    return rtf(tag).format(Math.round(diff / REL_STEPS.at(-1).ms), 'year');
  } catch { return fmtLocaleDateTime(d); }
}
