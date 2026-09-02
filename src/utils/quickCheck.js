// 短期提取巩固（C6）：刚学的新卡在 10 分钟 ~ 1 小时内插入"快速校验"
// 认知科学依据：工作记忆 → 长期记忆的巩固需要短期重复提取
// 不计入 SRS 间隔重复（不调 computeNext），只记录一次"快速校验"行为
import { db, uid } from '../db.js';

const QUICK_MIN = 10 * 60 * 1000;   // 10 分钟前
const QUICK_MAX = 60 * 60 * 1000;   // 1 小时前

/**
 * 查找需要快速校验的卡：
 * - level <= 1（刚学/学习中阶段）
 * - 最后一次正常复习在 10min~1h 前
 * - 本次复习周期内尚未快速校验过（quickCheckedAt < reviewedAt）
 */
export async function getQuickCheckDue() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  // 新卡通常 1 天内到期，先按 dueAt 索引过滤减小数据量
  const near = await db.cards.where('dueAt').belowOrEqual(now + DAY).toArray();
  const due = [];
  for (const c of near) {
    if ((c.level ?? 0) > 1) continue;
    if (!c.reviewedAt) continue;
    const elapsed = now - c.reviewedAt;
    if (elapsed < QUICK_MIN || elapsed > QUICK_MAX) continue;
    // 本次复习后是否已校验过
    if (c.quickCheckedAt && c.quickCheckedAt > c.reviewedAt) continue;
    due.push(c);
  }
  // 按复习时间先后排（先复习的先校验）
  due.sort((a, b) => a.reviewedAt - b.reviewedAt);
  return due.slice(0, 8); // 单次最多 8 张，避免疲劳
}

/**
 * 记录一次快速校验行为
 * @param {string} cardId
 * @param {boolean} remembered 是否记住
 */
export async function recordQuickCheck(cardId, remembered) {
  const now = Date.now();
  // 记录到 reviews 表（type='quick'，便于统计但不计入 SRS 排期计算）
  await db.reviews.put({
    id: uid(),
    cardId,
    reviewedAt: now,
    rating: remembered ? 2 : 0,
    type: 'quick',
  });
  // 在卡片上标记本次校验时间（Dexie 动态字段，不需 schema 变更）
  const card = await db.cards.get(cardId);
  if (card) {
    // M1 时间戳漏 bump：只写 quickCheckedAt 的话，该校验动作无任何活跃时间字段推进，
    // 卡片不随内容侧增量包上传、对端永远看不到这次校验。quickCheckedAt 随内容侧合并
    // （非 SRS 排期字段），故 bump updatedAt 而非 reviewedAt。
    await db.cards.put({ ...card, quickCheckedAt: now, updatedAt: now });
  }
}
