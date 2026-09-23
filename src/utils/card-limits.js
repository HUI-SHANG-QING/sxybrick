// src/utils/card-limits.js
// 卡片正 / 背面长度上限的**单一来源**。
//
// ⭐ round129（2026-09-23）：上限由 8000 提升到 50000，同时做了一次收敛。
//   此前这个数字散落在 8 处硬编码 —— 本应只有「写入校验」一处权威，但 UI 字数统计
//   （CardModal.vue）与 6 条 AI 生成链路的产物截断（genDeck / genCardDeck /
//   genVariants / offlineAI / wrongToCards / WrongBook）都各自写死了 8000
//   （genCardDeck 的正面还单独写死 2000），导致「改一处必漏一处」。
//   现在全部改为 import 本模块，禁止再写字面量；
//   有闸门 tests/card-limit-single-source.test.mjs 兜底。
//
// 为什么是这个量级（而不是不限）：
//   卡片存 IndexedDB（不占 localStorage 的 5MB 配额），同步服务端单请求允许 50MB
//   （sync-hub/hub.js readBody limitBytes），50000 个中文字约 150KB UTF-8，
//   在存储与同步上毫无压力。同时保留上界，避免误粘贴整份 PDF 文本导致翻卡渲染卡顿。
//
// ⚠️ 本模块必须是**零依赖叶子模块**：任何 import 都可能把消费方卷入循环依赖
//   （round35 的 TDZ 事故即由 offlineAI ↔ genDeck 大环引发，见 scripts/dep-check.mjs）。

export const CARD_MAX_CHARS = 50000;

// 接近上限的预警阈值（90%）：UI 用它提示「接近上限，请注意精简」。
// 由上限派生，避免两处各写一个数字再次漂移。
export const CARD_WARN_CHARS = Math.floor(CARD_MAX_CHARS * 0.9); // 45000
