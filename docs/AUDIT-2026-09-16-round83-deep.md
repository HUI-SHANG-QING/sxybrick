# round83 深度审计报告（AI 写入/出题闭环 × 数据协同一致性 + 历史修复完整性）

- 日期：2026-09-16
- HEAD：`bef64f9`（round80 收口后）
- 全量测试：**1262/1262 全绿**（较上轮 +32）
- 方向：本轮聚焦最近三次迭代（0eccd3a AI 能写 / 413beab AI 出题可作答 / 6c5a3d9+bef64f9 算法收口）与既有系统在**数据流转、边界条件、历史修复完整性**三个切面的交叉，并实测验证并行会话 round81 遗留问题。

---

## 一、历史修复完整性验证（用户点名要求）

| 历史项 | 状态 | 证据 |
|---|---|---|
| round78 P2-1 `AbortSignal.timeout` ×9 无兜底 | ✅ **已修复** | `src/utils/abort.js` 兼容 helper（`typeof AbortSignal.timeout === 'function'` 检查 + 手动 AbortController），调用点全部走兼容版（round82 注释在码） |
| round78 P2-2 `structuredClone` ×2 无兜底 | ❌ **未修复** | `plugins/registry.js:223/258` 仍是裸 `structuredClone(args)`，无 typeof 兜底 |
| round54 P1 删卡→回收站还原丢图 | ✅ **已修复** | `repo.js:374-375` 快照含 `_images`、`:405` 表清单含 images、`:468` bulkPut 还原；注释明示 round54 P1 |
| round80 算法 8 项（MIN_STATS_SAMPLES / MIN_HOURS_SAMPLES / cards.map / front\|\|'' 等） | ✅ **全部在码** | calibration.js:98/129/144、golden-hours.js:13/44/53、mistakeAttribution.js:75/129/158 |
| round81 `AIAssistant.vue:131 buildFullContext is not defined`（lint） | ✅ **已修复** | AIAssistant.vue:10 已 import `buildFullContext`；npm run lint 通过 |
| round81 在途改动（i18n baseline / forecast 测试未同步） | ✅ 已随 bef64f9 收口 | HEAD 上 npm test 1262/1262 全绿，含 i18n 闸门 |

**结论：历史修复 8/9 健在，唯一漏网 = round78 的 structuredClone（见 P3-4）。**

---

## 二、新功能交叉面核查（已覆盖、无问题的面，供留档）

逐条实测后确认**设计正确**的交叉点（避免后人重复排查）：

1. **AI 写入 → 同步一致性**：AI 工具全部复用 `repo.js` 统一入口（createNote/updateNote/createDailyPlan/checkinDailyTask…），无旁路直写 db；notes/memos 的 `fieldTs` 在 `mergeRows('updatedAt')` 分支被消费（两端都有 fieldTs 时逐字段合并，任一侧缺失退化为整行 LWW，sync-manifest.js:661-664）——字段级时间戳不是死代码。
2. **AI 写入 → 仪表盘缓存**：`dashboardSnapshot()` 缓存 key 只含 `cards.count / reviews.count / 两表最新时间戳`，`getStats`/`weakCards`/`getReviewSuggestion` 也只消费这两表——notes/dailyPlans 等表写入**不需要** invalidateDashboardCache，无陈旧窗口（此前的怀疑经核验不成立）。
3. **LLM 重试幂等性（06175b3）**：只重试 429/5xx；只在**状态码阶段**（流式输出前）重试——重发不会产生重复内容；abort 绝不重试；指数退避 + Retry-After；失败时如实告知"已自动重试 N 次"。工具副作用不会被 HTTP 重试放大。
4. **AI 写入工具输入校验**：空内容/空 patch 显式报错；date 正则 `^\d{4}-\d{2}-\d{2}$`；status 白名单（done/partial/skipped）；title 模糊匹配失败时列出现有条目引导；description 层强制"先确认再写/不擅自扩写/回传 id 不许编/覆盖前告知"。
5. **review() 调度链**：rating 白名单（非 0/1/2 直接 throw）；卡不存在 throw '卡片不存在'（AI 幻觉 cardId 不会静默污染，AiQuizView catch → toast）；事务内读改写防 lost update；复习只写 SRS 字段不 bump updatedAt（防复习动作跨设备覆盖编辑）。

---

## 三、问题清单（本轮新发现 3 P3 + 1 P3 历史遗留）

### P3-1：AI 出题「未作答」默认记为「忘记」，一次误点即降级卡片

**位置**：`src/components/AiQuizView.vue:95`

```js
await review(q.cardId, picked.value[i] === q.answer ? 2 : 0);
```

**问题**：`picked[i]` 未选任何选项时是 `undefined`，`undefined === q.answer` 恒 false → 走 `review(cardId, 0)`（遗忘）。按钮 `:disabled` 只绑定 `recorded[i]`，**未作答也可点**。用户若想"把这道题纳入复习"而误点，卡片会被记为遗忘——FSRS 稳定性显著拉低、触发近期重排，且完全违背按钮语义（"记入复习" ≠ "我忘了"）。

**根因**：判分映射（答对 2 / 答错 0）没有考虑"未作答"这一第三态；按钮缺少"未作答禁用"或"未作答二次确认"。

**建议**：① 未作答时按钮 `:disabled`；或 ② 未作答点击时提示"尚未作答，将记为『忘记』，确定？"。改动 3 行。

### P3-2：AI 出题「记入复习」防重仅组件内，切页/刷新后同一题可重复记入

**位置**：`AiQuizView.vue:60`（`const recorded = ref({})`）、`:91-97`

**问题**：`recorded` 是组件级 ref，组件卸载（切页/刷新/切换对话）即丢失。同一道题再次渲染时可再次点"记入复习" → 对同一 cardId 多次 `review(2)` → 稳定性被连续虚增（同一天重复计"记住了"）。

**根因**：防重状态没有持久化（如写入 `aiChats` 消息元数据或 localStorage），只存在于内存。

**建议**：把 `recorded` 以 `quizId+题号` 为键持久化（随会话消息存，或至少 sessionStorage），重挂载后恢复。影响有限（需用户主动重复点），P3 合理。

### P3-3：addDailyTask 的 scheduledHour 无 0-23 范围校验——同类参数一个 clamp 一个裸存

**位置**：`src/repo.js:1457`

```js
scheduledHour: Number.isFinite(task.scheduledHour) ? Math.floor(task.scheduledHour) : null,
```

**问题**：`estimatedMinutes` 有 `clampEstimatedMinutes` 防护，而 `scheduledHour` 只做 isFinite + Math.floor，**没有 0-23 范围钳制**。AI 工具层参数描述写了"0-23"但 execute 不校验；若模型传 25 / -1 / 99.7，将原样入库 → 后续渲染"25:00"、四象限排布错乱、统计口径被污染。属"同类参数规则不一致"。

**建议**：`Math.max(0, Math.min(23, Math.floor(n)))`（或非法值置 null），与 estimatedMinutes 同纪律。

### P3-4（历史遗留）：round78 P2-2 `structuredClone` 仍未兜底——旧 Safari 装插件即功能挂

**位置**：`src/plugins/registry.js:223`、`:258`

**问题**：`structuredClone` 是 Safari 15.4+ API。两处调用**无 typeof 兜底**（round78 报告的 P2-2，并行会话只修了 AbortSignal.timeout 这半边）。旧 Safari（<15.4）上：
- `callPluginTool`：`Promise.resolve().then(() => fn(structuredClone(args), ctx))` 内抛 ReferenceError → 插件工具调用直接失败（有错误隔离，不崩应用，但功能挂）；
- `triggerHook`：被各插件 task 的 try/catch 吞掉 → 插件事件钩子**静默失效**，用户无感知地丢失插件行为。

**根因**：round78 修复只覆盖了 AbortSignal 族（9 处），structuredClone 族（2 处）被遗漏——"顺手补"补了一半。

**建议**：`const clone = typeof structuredClone === 'function' ? structuredClone : (x) => JSON.parse(JSON.stringify(x));` 两处替换，5 分钟。

---

## 四、备忘级（不修，记录）

- **M1**：`create_daily_plan` 工具对"当天已有计划"的覆盖重建依赖模型自觉（description 约束"必须先告知"），execute 不自动预检已有计划。有回收站快照 + 事务保护，数据不丢，仅依赖模型纪律。可考虑 execute 内检测已有计划并返回提示（可选优化）。

---

## 五、根因分析（三类通病）

1. **UI 状态与业务状态的第三态缺失**（P3-1）：判分映射只有"对/错"两态，漏了"未作答"。SRS 系统的评分入口必须穷举用户可达状态，否则误操作直接污染记忆模型。
2. **防重状态的持久化范围小于风险窗口**（P3-2）：防重记在内存，风险窗口却跨组件生命周期。凡"防重"语义，应默认持久化到与风险窗口等长的存储层。
3. **历史修复的"半覆盖"模式**（P3-4）：同一审计轮里多族 API 问题（AbortSignal 族 + structuredClone 族），只修了被重点描述的那族。**修复类审计应产出一个"可执行复现闸门"**（像 round80 那样），把"该修的 API 无裸调"变成 CI 断言，杜绝半覆盖。

---

## 六、总体判断（大白话）

**新功能（AI 写入 + AI 出题）的骨架非常稳**：写入走统一 repo 入口、同步 fieldTs 到位、重试幂等、幻觉 cardId 有 throw 兜底、工具输入全校验——作为新增面，工程质量高于项目均值。

本轮挖到的都是**体验级/数据质量级 P3**，没有 P1/P2。最有价值的发现是**历史修复不完整**（P3-4：round78 的 structuredClone 漏修），说明"修复审计"需要闸门化才能闭环。

**建议**：P3-1/P3-3/P3-4 三条各 5-10 分钟，顺手清掉；P3-2 看是否想持久化防重（10 分钟）。四条约半小时，无风险。

---

*round83 · 覆盖：AI 写入/出题闭环 × 数据协同一致性 + 历史修复完整性 · 0 P1/P2，4 P3（1 项历史遗留）*
