# round61 深度审计报告（调度 / 前置解析 / 导入导出 / 提醒 / 用量账本 + 半提交事故验证）

- 日期：2026-09-15
- HEAD：`ee799cb`（并行会话半提交事故修复，已验证）
- 工作树：`docs-suite/` + round53/55/56/60 四份并行报告未跟踪

## 一、开工侦察：半提交事故（必须记录）

并行会话提交 `a688b37`（性能专项）时**只提交了消费方、漏了提供方**（repo.js 的 `dashboardSnapshot` 导出），HEAD 一度处于链接期硬错误（`does not provide an export named 'dashboardSnapshot'`）。并行会话随后补 `ee799cb` 修复。**我实测验证：全量 1105/1105 绿，HEAD 完整。** 这是"并行会话提交必须独立验收"的又一实例——若直接信任提交信息而不跑测试，事故会带病上线。

并行会话的 round60 报告（事件驱动核验 6 个新提交 + 工作区改动）已读，逐项内容与事实一致（lunar / splitTasks / 备份导入 / 性能专项 / 缓存契约更正）。

## 二、新审计域（6 模块，均首次深扫）

### scheduling.js（考试窗口 + 弹性调度）

**重点排查了一个数据对象污染疑点**：`prioritizeForExam` 对每张卡浅拷贝并附加 `_examUrgency` 字段（`{...c, _examUrgency: score}`）。若该字段随卡片对象写回 db.cards，会污染数据模型（同步包、schema 校验、其他消费方）。

**逐链路排除**：
- repo.js `reviewQueue` 返回 queue（含 `_examUrgency`）→ 消费方 Review.vue 只渲染；
- Review.vue 的所有写库操作（复习/标记/对决）**全部 `db.cards.get(id)` 重查库**，不用队列对象；
- `repo.review()` 事务内 `db.cards.get(cardId)` 读原始行，写回基于库内行。

**结论：`_examUrgency` 不进库，无污染。** 唯一瑕疵是 JSDoc 写"@returns 原数组（已排序）"，实际返回新数组（注释级，无害）。

### prereq.js（前驱依赖 BFS）

干净：头指针游标遍历 O(V+E)（round 审计 A7 已修，数组 shift 出队 O(n) 已移除）、visited 防环、`fromCardId || from` 双 ID 格式兼容。

### apkg.js（Anki 导入）

干净：sql.js 懒加载单例、finally 关闭 DB、SQL 常量无注入面。**P3 观察：`JSZip.loadAsync` 无大小/条目数守卫**——超大 .apkg 或 zip bomb 直接爆内存（本地导入自己的文件，风险低）。

### exporters.js（导出）

干净且扎实：RFC 4180 转义（含 `,` `"` 换行加引号双倍转义）、`sheetCellGuard` 中和公式注入（`= + - @ \t \r` 开头前置单引号，防 HYPERLINK/DDE 钓鱼）、中文 CSV 带 BOM。

### plan-reminder.js（日程提醒）

干净。`sxy-plan-due` 事件有 PlanReminderLayer 监听 + onUnmounted 清理（无死事件）。**2 个 P3**：
- **P3a（真实边界缺陷）**：`dueTasksOf` 的窗口是 `[scheduled*60 - advanceMin, +15min)`。若**提前量 ≥ 任务时刻**（如凌晨 1 点任务 + 90 分钟提前量 → due = -30），窗口 `[-30, -15)` 恒在过去 → **任务到达时刻也不在窗口内，永不提醒**。修复方案 `Math.max(0, ...)` 会把提醒挪到 0:00-0:15（提前量近似截断），但该场景实际几乎不存在，建议维持观察。
- **P3b**：`isReminded/markReminded` 的 localStorage 键 `sxy_plan_reminded_<date>_<taskId>` **无清理**，长期累积膨胀（数十年才到上限，纯卫生问题）。

### ai-usage.js（AI 用量账本）

干净：多模态 token 估算（round43 修）、recordUsage 吞错不阻塞主流程、clearUsage 写墓碑防对端复活、聚合无原地修改。**P3 观察：aiUsage 表无自动保留/清理策略**——每次 AI 调用一行，随行数增长同步包与聚合查询变重。

### reset.js（清空全部数据）

干净：OPFS 原文件在清表**之前**删（round18 修，顺序正确）、事务内原子清表、localStorage 按 `sxy*` 前缀清理、清空后 `_dashSnap`/`_failCountCache` 缓存 key 因 count 变化自动失效（round34 的 key 设计兜底，无需显式重置）。

## 三、问题清单（本轮无 P1/P2，5 个 P3 观察）

| 编号 | 问题 | 大白话 | 位置 | 建议 |
|---|---|---|---|---|
| N1 | 提醒窗口被提前量推入过去 | 凌晨任务 + 大提前量（≥任务时刻）→ 永不提醒 | `plan-reminder.js:66-74` | 维持观察（场景极罕见）；若修，`Math.max(0, due)` 一行 |
| N2 | apkg 导入无 zip 守卫 | 超大/恶意 .apkg 直接爆内存 | `apkg.js:33` | 低优先：本地文件，加个 500MB 上限即可 |
| N3 | 提醒去重键无清理 | localStorage 长期累积（数十年才达上限） | `plan-reminder.js:79-89` | 随大版本迭代顺手清 |
| N4 | aiUsage 表无自动清理 | 同步包/聚合查询随行数变重 | `ai-usage.js:53-71` | 建议：仅保留近 90 天 + 按日聚合行 |
| N5 | prioritizeForExam JSDoc 与实现不符 | 注释说"原数组"，实际返回新数组 | `scheduling.js:87` | 注释级，改一行注释 |

## 四、根因观察

本轮唯一值得一提的深层结论：**"队列对象携带展示字段"与"写库路径重新查库"是项目事实上的两条纪律**（session/queue 层可以随便加展示字段，写库一律 `db.cards.get(id)` 重读），这让 `_examUrgency` 这类临时字段天然隔离在数据模型之外。这不是注释约定的，而是**调用结构强制保证的**（review 的入参是 cardId 而非对象）——这是数据对象建模的正面案例，值得在毕设论文里写。

## 五、验证与前序完整性

- 全量 **1105/1105** · lint 0 · i18n 双闸绿
- ee799cb（半提交修复）实测通过；并行 round60 报告内容核验一致
- 历轮修复抽查：lunar 守卫 / splitTasks / 备份导入 / 共享快照 —— 全部健在
- 本轮无新增待办（N1-N5 观察级）

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round61 问题分布（四维 × 优先级）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [1, 3, 0, 1] }
  ]
}
```
