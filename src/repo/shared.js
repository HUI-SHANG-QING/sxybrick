// src/repo/shared.js —— 数据层内部的**共享常量与纯函数**单一来源（round142）
//
// 为什么有这个文件：拆分成 cards/plans/meta 三块时，有 6 个「原本是 repo.js 顶层、
// 被多个域共用」的常量/纯函数。为了避免抽到 cards.js 造成 plans/meta 反向依赖
// （进而成环），当时按「无状态纯值」的原则**各复制了一份**。
// 复制是安全的（值相同、无状态），但**埋了一个维护隐患**：
// 将来若要改这些量的取值，改一处漏另一处 ⇒ 两侧行为漂移且**不会有任何报错**。
// 本文件把它们收成单一来源，从根上消除该隐患。
//
// ⚠️ 依赖铁律：本文件**只能依赖底层模块**（db.js / sync-manifest.js / utils/*），
//    **严禁 import ./cards.js**，否则 cards → shared → cards 成环。
//
// 导出策略：**只 export 真正需要跨模块用的**。
//   · `plain` / `now` / `localDateStr` / `MAX_ESTIMATED_MINUTES` / `TOMB_KIND_TABLE`
//     在原 repo.js 里都是**模块私有**（无 export）—— 保持私有，只在需要它的模块间流转，
//     **不**经门面 re-export，否则会给对外 API 凭空多出 5 个符号（有撞名风险）。
//   · `fireHook` 同样原为私有。
import { tombKindTable } from '../sync-manifest.js';
import { dateKey as createDateKey } from '../utils/time.js';
import { triggerHook } from '../plugins/registry.js';

/** 单次计划/任务的预计分钟上限（1 天）。域：plans + cards（计划建卡时校验） */
export const MAX_ESTIMATED_MINUTES = 1440;

/** 当前时刻（原本就是 repo.js 顶层箭头函数，语义单一） */
export const now = () => Date.now();

/** 剥离 Vue 响应式代理：Dexie put 前转纯对象，避免 reactive proxy 触发结构化克隆失败 */
export const plain = (x) => JSON.parse(JSON.stringify(x));

/** 本地日期键（YYYY-MM-DD），供按天聚合的统计使用 */
export const localDateStr = (d) => createDateKey(d ? new Date(d).getTime() : undefined);

/** 墓碑种类映射表（由 sync-manifest 的 tombKindTable 派生，**单一来源在此**） */
export const TOMB_KIND_TABLE = tombKindTable();

/**
 * 插件事件钩子分发（fire-and-forget + 吞错）。
 * ⚠️ 原为 repo.js 模块私有函数：plans.js 拆分时因无法 import cards.js 的非导出符号
 *   而内联了一份副本 —— 本文件把它收成单一来源，两处共用同一实现。
 */
export function fireHook(event, ...args) {
  triggerHook(event, ...args).catch(() => {});
}