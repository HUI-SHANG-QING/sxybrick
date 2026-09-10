// src/algorithms/scheduling.js
// 考试窗口感知 + 节假日弹性调度（离线，纯函数 + 轻量 db 读写）
//
// 解决的问题：
//   1) 考试窗口感知：当存在目标考试日期 examAt 时，确保「会在考前遗忘」的卡优先练，
//      且若卡片的 next due 落在考试之后，则把复习压缩进考前窗口。
//   2) 节假日弹性：用户设定的休息日（周几 / 具体日期）不打扰；due 落在休息日时顺延到最近的非休息日。
import { retrievability, DEFAULT_DESIRED_RETENTION } from '../fsrs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 判断某天是否为休息日
 * @param {number} ts 时间戳
 * @param {object} restCfg { weekdays?:number[] (0=周日..6=周六), dates?:string[] ('YYYY-MM-DD') }
 */
export function isRestDay(ts, restCfg = {}) {
  const d = new Date(ts);
  if (restCfg.weekdays && restCfg.weekdays.includes(d.getDay())) return true;
  if (restCfg.dates) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    if (restCfg.dates.includes(`${y}-${m}-${dd}`)) return true;
  }
  return false;
}

/** 把时间戳顺延到最近的非休息日（含当天） */
export function nextWorkDay(ts, restCfg = {}) {
  let t = ts;
  let guard = 0;
  while (isRestDay(t, restCfg) && guard < 14) {
    t += DAY_MS;
    guard++;
  }
  return t;
}

/**
 * 考试窗口紧迫度：0~1，越大越该在考前补。
 * @param {object} card { fsrs?:{s,last}, dueAt?, difficulty? }
 * @param {number} examAt 考试时间戳
 * @param {object} opts { now?, desiredRetention?, restCfg? }
 * @returns { urgency:number, atExamR:number, dueBeforeExam:boolean }
 */
export function examWindowUrgency(card, examAt, opts = {}) {
  const nowTs = opts.now ?? Date.now();
  // H-1：同 fsrs.js：|| 对 0 回退错误，统一 ?? 口径。
  const desiredR = Math.max(0.01, opts.desiredRetention ?? DEFAULT_DESIRED_RETENTION);
  const daysToExam = (examAt - nowTs) / DAY_MS;
  // round26 A2：fsrs.s 必须有限性守卫——NaN/Infinity 会让 retrievability 返回 NaN，
  // 经 rank/score 使该卡在考前队列排序中永不被选为最优（静默沉底）。
  const _s = card?.fsrs?.s;
  const s = Number.isFinite(_s) && _s > 0 ? _s : 1;
  const last = card?.fsrs?.last ?? nowTs;
  // 考试时刻的可提取性（用从「上次复习」到「考试」的间隔）
  const elapsedToExam = Math.max(0, (examAt - last) / DAY_MS);
  const atExamR = retrievability(s, elapsedToExam);
  const dueBeforeExam = (card?.dueAt ?? 0) <= examAt;
  // 紧迫度：考试临近 + 考时记忆留存不足 → 高紧迫
  const proximity = Math.max(0, Math.min(1, 1 - daysToExam / 21)); // 三周内线性上升
  const risk = Math.max(0, (desiredR - atExamR) / desiredR);
  const urgency = Math.max(proximity * 0.4, risk);
  return { urgency: Number(Math.min(1, urgency).toFixed(3)), atExamR: Number(atExamR.toFixed(3)), dueBeforeExam };
}

// round34 L4：考试窗口压缩保留的「考前缓冲」常数（天）。compressIntoWindow 与 srs.js 的
// 末位回钳必须共用同一值，否则弹性顺延把 due 推过缓冲后回钳到 examAt 会丢掉这半天缓冲。
export const EXAM_BUFFER_DAYS = 0.5;

/**
 * 考试窗口压缩：若卡片 due 落在考试之后，把下次复习拉回考前窗口内。
 * 不改变 FSRS 真实稳定度，只在「展示/排程优先级」层面对 dueAt 做软约束。
 * @returns number 调整后的 dueAt
 */
export function compressIntoWindow(dueAt, examAt, opts = {}) {
  const nowTs = opts.now ?? Date.now();
  if (!examAt || dueAt <= examAt) return dueAt;
  // 考前至少保留半天缓冲；把 due 拉到 (examAt - EXAM_BUFFER_DAYS 天) 之内最近的时点
  const cap = examAt - EXAM_BUFFER_DAYS * DAY_MS;
  return Math.max(nowTs, Math.min(dueAt, cap));
}

/**
 * 对一批待复习卡片做「考试优先」排序：urgency 高者在前。
 * @param {Array} cards 含 fsrs/dueAt/difficulty
 * @param {object} examAt 或 null
 * @returns 原数组（已排序），并附带 ._exam = { urgency, atExamR }
 */
export function prioritizeForExam(cards, examAt, opts = {}) {
  if (!examAt) return cards;
  const scored = cards.map(c => {
    const e = examWindowUrgency(c, examAt, opts);
    return { c, score: e.urgency };
  });
  // 审计 P3（round37）：考试窗口压缩会把一批卡的 dueAt 全部拉到 examAt-缓冲（同一毫秒）
  // → urgency 分数完全相同，排序退化为「数组原序」（实际是 FIFO），用户看不到优先差异。
  // 分数相同时用二级键给出确定性、且有意义（且与"更该先复习"一致）的顺序：
  // ① 失败次数多者优先；② id 字典序（跨设备稳定，避免两端顺序漂移）。
  scored.sort((a, b) => b.score - a.score
    || (b.c.failCount || 0) - (a.c.failCount || 0)
    || String(a.c.id).localeCompare(String(b.c.id)));
  return scored.map(({ c, score }) => ({ ...c, _examUrgency: score }));
}

/** 把休息日弹性应用到一张卡的 dueAt（仅当落在休息日时顺延） */
export function applyElasticDue(dueAt, restCfg = {}) {
  return nextWorkDay(dueAt, restCfg);
}
