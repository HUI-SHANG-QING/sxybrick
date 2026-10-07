// repo.js —— 数据层门面（facade）
//
// 原本这里是 2884 行、121 个函数的"大杂烩"。现按业务域物理拆分到 ./repo/*.js，
// 本文件只做再导出，**51 处外部依赖方的 import 路径完全不变**（零改动迁移）。
//
// 拆分原则：**只搬移、不改逻辑**。任何行为差异都只能来自搬移错误，门禁会当场拦下。
// 依赖方向：repo.js → repo/cards.js → db.js|srs.js|...（单向，见 dep-check 门禁）
//   · cards.js  最底层：卡片 / 复习 / 统计缓存 / 回收站 / 笔记资料 / 关联表 / 孤儿清理
//   · plans.js  每日计划与任务（→ cards）
//   · meta.js   剪枝 / 隐私 / 图谱边 / 番茄 / 操作日志（→ cards）
export * from './repo/cards.js';
export * from './repo/plans.js';
export * from './repo/meta.js';
