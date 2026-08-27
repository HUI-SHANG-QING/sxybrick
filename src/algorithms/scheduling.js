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
  const nowTs = opts.now || Date.now();
  const desiredR = opts.desiredRetention || DEFAULT_DESIRED_RETENTION;
  const daysToExam = (examAt - nowTs) / DAY_MS;
  const s = card?.fsrs?.s ?? 1;
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

/**
 * 考试窗口压缩：若卡片 due 落在考试之后，把下次复习拉回考前窗口内。
 * 不改变 FSRS 真实稳定度，只在「展示/排程优先级」层面对 dueAt 做软约束。
 * @returns number 调整后的 dueAt
 */
export function compressIntoWindow(dueAt, examAt, opts = {}) {
  const nowTs = opts.now || Date.now();
  if (!examAt || dueAt <= examAt) return dueAt;
  // 考前至少保留半天缓冲；把 due 拉到 (examAt - 0.5 天) 之内最近的时点
  const cap = examAt - 0.5 * DAY_MS;
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
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ c, score }) => {
    c._examUrgency = score;
    return c;
  });
}

/** 把休息日弹性应用到一张卡的 dueAt（仅当落在休息日时顺延） */
export function applyElasticDue(dueAt, restCfg = {}) {
  return nextWorkDay(dueAt, restCfg);
}
