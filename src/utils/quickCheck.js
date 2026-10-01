// 短期提取巩固（C6）：刚学的新卡在 10 分钟 ~ 1 小时内插入"快速校验"
// 认知科学依据：工作记忆 → 长期记忆的巩固需要短期重复提取
// 不计入 SRS 间隔重复（不调 computeNext），只记录一次"快速校验"行为
import { db, uid } from '../db.js';
// round122：改用共享快照（dashboardSnapshot）判窗口，并在写路径显式失效快照。
import { dashboardSnapshot, invalidateDashboardCache } from '../repo.js';

const QUICK_MIN = 10 * 60 * 1000;   // 10 分钟前
const QUICK_MAX = 60 * 60 * 1000;   // 1 小时前
// round118 审计：跳过（skip）的「推迟到窗口尾部」余量——把窗口锚点推到
// 「QUICK_MAX - QUICK_HOLD_MS 前」，即距窗口过期只剩 1 分钟：60s 轮询最多
// 再把它拉出 1 次，之后窗口自然过期（不再打扰）。第 2 次再跳过则直接放弃本轮。
const QUICK_HOLD_MS = 60 * 1000;

/**
 * 快速校验窗口锚点：从「该时刻起算 elapsed ∈ [10min, 1h]」进入窗口。
 * - 默认 = reviewedAt（最近一次正常复习时刻）；
 * - 跳过会把锚点推迟到窗口尾部（quickAnchorAt 被写为 now-59min，**变小**）；
 * - 正常复习（repo.review）会把锚点重置回最新复习时刻（quickAnchorAt=nowTs，**变大**）。
 * 为什么不能直接改 reviewedAt：它是 SRS 核心字段（FSRS 实际间隔 / 跨设备 SRS 竞争 /
 * 「距上次复习」统计都依赖它），篡改会污染排期与同步收敛。
 * @param {object} card
 * @returns {number} 锚点时间戳（0 = 无有效锚点）
 */
export function quickAnchorOf(card) {
  const a = Number.isFinite(card?.quickAnchorAt) ? card.quickAnchorAt : 0;
  if (a > 0) return a;
  return Number.isFinite(card?.reviewedAt) ? card.reviewedAt : 0;
}

/**
 * 单卡窗口判定（纯函数，便于测试）：
 * - level <= 1（刚学/学习中阶段）
 * - 距窗口锚点 10min~1h（锚点=最近复习，或被跳过推迟到尾部）
 * - 本周期内尚未快速校验过（quickCheckedAt <= 锚点）
 * @param {object} card
 * @param {number} now
 * @returns {boolean}
 */
export function isQuickDue(card, now) {
  if ((card?.level ?? 0) > 1) return false;
  if (!card?.reviewedAt) return false;
  const anchor = quickAnchorOf(card);
  if (!anchor) return false;
  const elapsed = now - anchor;
  if (elapsed < QUICK_MIN || elapsed > QUICK_MAX) return false;
  if (card.quickCheckedAt && card.quickCheckedAt > anchor) return false;
  return true;
}

/**
 * 查找需要快速校验的卡（复用 {@link isQuickDue}）
 */
export async function getQuickCheckDue() {
  const now = Date.now();
  // round122 审计（P1）：**去掉 dueAt 预筛**，改走共享快照。
  //   原写法 `db.cards.where('dueAt').belowOrEqual(now + 1天)` 是拿「排期字段」去筛
  //   「短期巩固窗口」，隐含假设「level≤1 的卡到期日必在 1 天内」。该假设只在 SM-2 下成立：
  //   FSRS 的 level 由稳定度 S 派生（fsrs.js:216 `S<3 → level 1`），而间隔
  //   `nextInterval(S,0.9) = 9*S*(1/0.9-1) ≈ S` 天 → level=1 的卡间隔是 **1.1~3.4 天**，
  //   必然落在「1 天」之外。实测：S=1 / 1.5 / 2 / 2.9 四种情形 isQuickDue() 全为 true，
  //   但预筛全为 false ⇒ **该弹的卡永远捞不到，且无报错无日志**（FSRS 用户功能静默失效）。
  //   改用共享快照后语义不再依赖任何排期假设，且**零额外全表读**——复习页/首页已物化过
  //   同一份快照，比原来的索引查询更省（与 round57 契约⑤ 同款纪律）。
  // ⚠️ 只读契约：快照的 cards 是**跨调用共享的数组实例**，只能先用 filter 产新数组再 sort，
  //   绝不能对快照数组本身做 sort/push/splice（会污染其他消费者）。
  const { cards } = await dashboardSnapshot();
  // 按锚点先后排（先复习/先到窗口尾部的先校验）
  const due = cards.filter((c) => isQuickDue(c, now));
  due.sort((a, b) => quickAnchorOf(a) - quickAnchorOf(b));
  return due.slice(0, 8); // 单次最多 8 张，避免疲劳
}

/**
 * 跳过一次快速校验的**决策**（纯函数，便于测试）：
 * - 首次跳过（锚点未被推迟过）：{ type:'defer', anchor } —— 锚点推到窗口尾部；
 * - 第 2 次跳过（锚点已被推迟过，即 quickAnchorAt ≠ reviewedAt）：{ type:'abandon' }。
 * @param {object} card
 * @param {number} now
 * @returns {{type:'defer', anchor:number}|{type:'abandon'}}
 */
export function skipDecision(card, now) {
  const rev = Number.isFinite(card?.reviewedAt) ? card.reviewedAt : 0;
  // 复习（repo.review）会把 quickAnchorAt 重置为 == reviewedAt → 视为未推迟；
  // 跳过会把它写成 now-59min（≠ reviewedAt）→ 视为已推迟（第 2 次跳过）。
  const deferred = Number.isFinite(card?.quickAnchorAt) && card.quickAnchorAt > 0 && card.quickAnchorAt !== rev;
  if (deferred) return { type: 'abandon' };
  return { type: 'defer', anchor: now - (QUICK_MAX - QUICK_HOLD_MS) };
}

/**
 * 跳过一次快速校验（round118 方案 B：推迟到窗口尾部，最多再出现 1 次）
 * - 首次跳过：把窗口锚点推到「距过期 1 分钟」——卡不再 1 分钟后又弹，
 *   而是到窗口尾部最多再被拉出 1 次，然后自然过期；
 * - 第 2 次跳过（尾部那次再弹时用户仍不想做）：写 quickCheckedAt 视为本轮
 *   已尝试（放弃），彻底不再打扰，等 consolidation/SRS 的 dueAt 正常到期。
 * 为什么必须有第 2 次上限：窗口是 [10min,1h] 的硬区间，任何「推迟」若不跨过
 * 60min 都会在下一次轮询继续命中；只有落一个终止标记才能切断无限重弹。
 * @param {string} cardId
 * @returns {Promise<'deferred'|'abandoned'|null>} 本次跳过的处置结果（null=卡不存在）
 */
export async function skipQuickCheck(cardId) {
  const now = Date.now();
  const res = await db.transaction('rw', db.cards, async () => {
    const card = await db.cards.get(cardId);
    if (!card) return null;
    const d = skipDecision(card, now);
    if (d.type === 'abandon') {
      // 第 2 次跳过：本轮放弃。只写 quickCheckedAt（保持锚点不变），
      // quickCheckedAt(now) > 锚点 → 窗口判定不再命中。
      await db.cards.update(cardId, {
        quickCheckedAt: now,
        updatedAt: now,
        fieldTs: { ...(card.fieldTs || {}), quickCheckedAt: now },
      });
      return 'abandoned';
    }
    // 首次跳过：推迟到窗口尾部（距过期 1 分钟）。不改 reviewedAt / quickCheckedAt。
    await db.cards.update(cardId, {
      quickAnchorAt: d.anchor,
      updatedAt: now,
      fieldTs: { ...(card.fieldTs || {}), quickAnchorAt: d.anchor },
    });
    return 'deferred';
  });
  // round122：本函数只 bump updatedAt（行数不增不减）。若同一毫秒内连续跳过两张卡，
  // 第二次写的 updatedAt 与「当前最大值」相同 → 快照 key 四项全不变 → 命中陈旧快照。
  // 显式失效把这条例外封死（与 updateCard / setMarked / rescheduleCardToNow 同口径）。
  invalidateDashboardCache();
  return res;
}

/**
 * 记录一次快速校验行为
 * @param {string} cardId
 * @param {boolean} remembered 是否记住
 */
export async function recordQuickCheck(cardId, remembered) {
  const now = Date.now();
  // v35 审计修正：校验记录与卡片标记必须在**同一个事务**——
  //   此前 reviews.put 在事务外、卡片标记另起一个事务：若后者失败（配额满等），
  //   校验记录已落库但卡未标 quickCheckedAt → 窗口判定仍命中 → **快速校验重复弹**，
  //   且统计里多出一条 type='quick'。与同文件 skipQuickCheck（整段单事务）统一口径。
  // 卡片更新仍走**差量写**（审计 P1-2 / round34）：get + 整行 put 会把窗口期内
  //   repo.review() 提交的 SRS 进度（ease/level/dueAt/fsrs）用旧快照回滚，
  //   是 B11 差量写改造的最后一个漏网点；只动 quickCheckedAt/updatedAt/fieldTs。
  // 先取卡：不存在则**连校验记录也不写**，避免留下指向幽灵卡的孤儿 reviews。
  await db.transaction('rw', db.cards, db.reviews, async () => {
    const card = await db.cards.get(cardId);
    if (!card) return;
    // 记录到 reviews 表（type='quick'，便于统计但不计入 SRS 排期计算）
    await db.reviews.put({
      id: uid(),
      cardId,
      reviewedAt: now,
      rating: remembered ? 2 : 0,
      type: 'quick',
    });
    // 在卡片上标记本次校验时间（Dexie 动态字段，不需 schema 变更）
    await db.cards.update(cardId, {
      quickCheckedAt: now,
      updatedAt: now,
      fieldTs: { ...(card.fieldTs || {}), quickCheckedAt: now },
    });
  });
  // round122：与 skipQuickCheck 同口径，写路径统一显式失效（不依赖「行数/最大时间戳」推断）。
  invalidateDashboardCache();
}
