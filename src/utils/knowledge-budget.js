// src/utils/knowledge-budget.js
// 「喂给 LLM 的知识点」的字符预算 + 水填式收窄（**零依赖叶子模块**，便于单测与闸门）。
//
// ⭐ round132（2026-09-23）立此模块的原因：
//   `genQuiz.js` 此前对每张卡硬砍「题干 120 字 / 答案 150 字」——那是卡片上限还只有
//   数千字时代的保守假设。卡片上限提到 50000（round129）后该假设失效：
//   用户写满的长卡，喂进去仍只有开头一小段（**写 50000 字与写 200 字，AI 看到的一样多**），
//   出题依据严重残缺。
//   用户诉求（原文）：「卡片实际多少字，AI 出题就应该能看到多少字，而不是直接 50000 或 120」。
//
// 规则：**按实际长度喂；只有真的装不下才收窄，且收窄得尽量公平。**
//   · 总量 ≤ 预算 → 一个字都不砍（原数组直接返回）；
//   · 总量 > 预算 → 二分求统一阈值 cap，使 Σ min(len_i, cap) ≤ 预算 ⇒
//     **短卡（≤ cap）全文保留**，只有真正超长的那些被等比例收窄。
//   为什么不用「每张都砍到 预算/张数」：那会把本来就不长的卡片也砍掉内容，
//   正是旧实现「每张砍到 120」的同一种错，只是数字变大。
//
// 为什么仍需一个总量预算（而不是真的不限）：
//   请求体受模型上下文窗口硬约束，超了会 400。但注意 —— 预算只在**卡组总量真的很大**时
//   才起作用；普通卡组（几十张卡、每张几百字）总量仅数千字，**根本不会触发收窄**，
//   所以这个数字对绝大多数使用场景是无感的保险丝，不是"又一个拍脑袋的上限"。
//
// ⚠️ 本模块必须保持**零依赖叶子模块**：任何 import 都可能把消费方卷入循环依赖
//   （round35 的 TDZ 事故由 offlineAi ↔ genDeck 大环引发，见 scripts/dep-check.mjs）。

/**
 * 单次出题请求里「知识点」部分的字符预算。
 *
 * 取值依据：项目默认模型族（DeepSeek V4 Flash/Pro）上下文窗口约 384K token，
 * 中文保守估 1 token ≈ 1.5 字 ⇒ 约 57 万汉字；再为 system 提示词与模型输出
 * （用户可设到 131072）留出余量，取 20 万字符（≈13 万 token）。
 * 换用小窗口模型（8K/16K）时仍可能超限，此时由 fitKnowledge 保证请求体被压进预算，
 * 而不是像旧的固定 120 字那样一刀切掉每一张卡的内容。
 */
export const KNOWLEDGE_CHAR_BUDGET = 200000;

/**
 * 把知识点列表压进字符预算：装得下原样返回，装不下才收窄。
 *
 * 「水填式」= 找最大的统一阈值 cap，使 Σ min(len_i, cap) ≤ budget。
 * 于是只有超过 cap 的长卡被收窄，短卡一字不动。
 *
 * @param {Array<{q: string, a: string}>} items 已清洗的知识点（q=题干、a=答案）
 * @param {number} [budget] 字符预算，默认 {@link KNOWLEDGE_CHAR_BUDGET}
 * @returns {Array} 与入参同构；超长项被等比例收窄，其余按原引用返回
 */
export function fitKnowledge(items, budget = KNOWLEDGE_CHAR_BUDGET) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return items;

  const lens = items.map((it) => String(it?.q ?? '').length + String(it?.a ?? '').length);
  const total = lens.reduce((n, l) => n + l, 0);
  if (total <= b) return items; // 装得下：一个字都不砍

  // 二分最大可行阈值 cap：单调（cap 越大，Σ min(len, cap) 越大）。
  let lo = 0;
  let hi = Math.max(...lens);
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    const used = lens.reduce((n, l) => n + Math.min(l, mid), 0);
    if (used <= b) lo = mid;
    else hi = mid;
  }
  const cap = lo;

  return items.map((it, i) => {
    const len = lens[i];
    if (len <= cap) return it; // 短卡：原文保留
    const k = cap / len; // 长卡：题干 / 答案等比例收窄
    const q = String(it?.q ?? '');
    const a = String(it?.a ?? '');
    return {
      ...it,
      // 下限 1 字：cap 被压到 0 的极端情况（预算小到连每卡 1 字都放不下）也留一点内容，
      // 让模型至少能看出这张卡"有东西"，而不是拿到一个空字符串。
      q: q.slice(0, Math.max(1, Math.floor(q.length * k))),
      a: a.slice(0, Math.max(1, Math.floor(a.length * k))),
    };
  });
}
