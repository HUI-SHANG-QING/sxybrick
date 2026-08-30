// 每科自适应目标保持率（per-subject adaptive desired retention）
// 学习科学依据：掌握度低的科目应更频繁复习（更高保持率 → 更短间隔），
// 掌握度高的科目可适当放宽（更低保持率 → 更长间隔，省时）。
// 纯函数、确定性，Node 可直接单测。输出作为 FSRS schedule 的 desiredRetention。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;

export const RETENTION_MIN = 0.80; // 掌握度 100 时的下限
export const RETENTION_MAX = 0.95; // 掌握度 0 时的上限（复习最勤）

/**
 * 单科自适应保持率：掌握度 0 → RETENTION_MAX，掌握度 100 → RETENTION_MIN，线性插值。
 * @param {number|null} masteryPct 该科掌握度（0~100）；null/非法值回退 baseRetention
 * @param {number} baseRetention   无数据时的默认保持率（默认 0.9）
 */
export function adaptiveRetention(masteryPct, baseRetention = 0.9) {
  if (masteryPct == null || !Number.isFinite(Number(masteryPct))) return baseRetention;
  const m = clamp(Number(masteryPct), 0, 100);
  const retention = RETENTION_MAX - (m / 100) * (RETENTION_MAX - RETENTION_MIN);
  return round2(clamp(retention, RETENTION_MIN, RETENTION_MAX));
}

/**
 * 批量：把「各科掌握度」映射为「科目 → 保持率」。
 * @param {Array} masteryList [{ subject, mastery, noData?, reviews? }]
 * @param {number} baseRetention
 * @returns {Object} { [subject]: retention }
 */
export function subjectRetentionMap(masteryList, baseRetention = 0.9) {
  const map = {};
  for (const m of masteryList || []) {
    if (!m || !m.subject) continue;
    // 无数据的科目（近 90 天零复习）不该被当成「掌握度 0 → 最勤复习」：
    // 它只是没数据，用基准保持率即可。否则一个刚导入还没背的科目
    // 会被安排成全场最密的复习节奏（0.95），而真正学得差的科目反而更松。
    //   注意：`reviews` 字段缺省时（老调用方只传 {subject, mastery}）视为"有数据"，
    //   保持向后兼容 —— 是否无数据必须显式表达，不做隐式猜测。
    const noData = m.noData === true || (m.reviews !== undefined && !(m.reviews > 0));
    map[m.subject] = noData ? baseRetention : adaptiveRetention(m.mastery, baseRetention);
  }
  return map;
}

/**
 * 查询某科目的目标保持率，找不到回退 baseRetention。
 * @param {Object} map   subjectRetentionMap 的输出
 * @param {string} subject
 * @param {number} baseRetention
 */
export function retentionFor(map, subject, baseRetention = 0.9) {
  const s = subject || '未分类';
  return (map && typeof map[s] === 'number') ? map[s] : baseRetention;
}
