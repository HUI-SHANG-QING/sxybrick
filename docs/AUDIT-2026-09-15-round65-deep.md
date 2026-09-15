# round65 交付报告：导入侧域校验 · Agent 结果可读化 · 提醒键清理

> 基线 HEAD `98d8590`（并行会话的 round64 审计报告）。三项均为「有真实后果」的收口修复，
> 非新审计发现——来源是 round63 改进建议 + 项目未修清单。
> 编号避让：并行会话已占用 round64 报告编号，本轮记 round65。

## 一、交付清单

| # | 项 | 严重度 | 改动文件 | 一句话效果 |
|---|---|---|---|---|
| ① | 导入侧行级域校验 | P2 | `sync-manifest.js` `sync.js` `sync-hub/hub.js` | 脏行在**入口**被洗净，不再入库、不再随同步扩散 |
| ② | Agent 结构化结果可读化 | P3 | `agent/reply.js` | 工具结果渲染成列表，不再把 JSON 源码甩给用户 |
| ③ | 提醒去重键清理 | P3 | `utils/plan-reminder.js` | 去重键不再无限膨胀（约 148KB/年 → 恒定一天量） |

测试：`tests/sync-domain.test.mjs`（新增 17 条）、`tests/reply.test.mjs`（+6）、
`tests/plan-reminder.test.mjs`（+2）、`tests/_env.mjs`（垫片补 `length`/`key(i)`）。

## 二、逐项说明

### ① 导入侧行级域校验（P2）

**问题**：round61 发现 `reviews.rating` 越界/非数字会让 `avgMastery` 变 NaN
（下游 `NaN || 0` 静默退化成「掌握度 0」＝判用户完全没掌握），且坏行只进
correct/stable 分母、静默稀释正确率。当时只在**读取侧**（`repo-core.computeStats`）
加了护栏——那只堵住「统计」一个出口：脏行照样入库，并**随同步传播到每一台设备**，
每个出口都得各自设防，漏一个就前功尽弃。

**修法**：把校验挪到**入口收口**，`sync-manifest.js` 新增纯函数
`sanitizeIncomingRow()` / `sanitizeIncomingTable()`，前端 `importBackup` 与
中枢 `hub.js` 的 merge **共用同一实现**（否则 hub 会把脏行存回去再回灌，
前端修复等于白做）。

三条设计原则：

1. **绝不丢行** —— 丢行 = 用户复习记录凭空消失（静默数据丢失）。只清洗字段值。
2. **只动明确非法的值** —— 合法值（含 `null`/`undefined`）原样放行，兼容老版本包。
3. **时间戳做可逆规范化** —— `'1757894400000'` → `1757894400000`；转不动的置 `null`。
   置 `null` 让该行永远输给对端（安全降级）；若留着字符串，`'2026-09-15' > 1757894400000`
   恒为 `false` → 该行成为「永不更新的僵尸行」，比置 null 更糟。

覆盖字段：

- 时间戳（全表通用）：`updatedAt` / `createdAt` / `deletedAt` / `addedAt` /
  `reviewedAt` / `selfExplainAt` / `wrongReasonAt` / `lastReviewedAt` / `dueAt`
- `reviews`：`rating` ∈ {0,1,2} 或空；`type` 必须字符串
- `dailyTasks`：`scheduledHour` ∈ [0,23]；`estimatedMinutes` ≥ 0

> `dailyTasks` 两项是**顺带纳入**：并行会话 round64 报告发现同源脏 `scheduledHour`
> 在展示侧 `planCharts.buildScheduleBoard` 裸奔——该处守卫写作 `sh < 6 || sh > 23`，
> **对 NaN 恒为 false**，压根拦不住 → `top: NaN` → 课程表整块布局错乱。
> 入口洗净是治本层；展示侧护栏作为第二道防线建议另行加固（见「四、遗留」）。

`importBackup` 会在 `stats.sanitized = { fields, tables }` 汇报修正数，供 UI 提示；
干净包不产生该键（不虚报）。

### ② Agent 结构化结果可读化（P3）

**问题**：`agent/reply.js` 把 agent/LLM 返回的「无 `text`/`content`/… 字段」的对象
直接 `JSON.stringify(r, null, 2)` 交给 MarkdownRenderer → 用户在对话里看到一坨
带引号和花括号的 JSON 源码。结构没丢，但完全不像「助手说的话」。

**修法**：新增 `humanizeStructured()`，按形状渲染：

- 数组 / `{items|list|rows|results: [...]}` → 逐行 `- 字段: 值`（标量上下文如 `total` 保留）
- `{ok, data}` 工具结果标准包装 → 解包后递归
- `{error}` → 显式错误提示
- 键值对象 → `- key: value`
- 形状不可识别 → 回退原 JSON 序列化（**信息优先于美观，绝不返回空**）

`fallback` 计数口径不变（对象回复仍计入 `reason='object'`），健康监控不受影响。

### ③ 提醒去重键清理（P3）

**问题**：`markReminded` 写 `sxy_plan_reminded_<date>_<taskId>` 做去重，但
**只写不删**（全项目 `removeItem` 调用 0 次）。键数随天数线性增长：
按每天 20 条任务估算，一年 ≈ 7000 键 / 148KB，长期占用 localStorage 配额。

**修法**：写入当天键时顺带扫掉其他日期的同类键（前缀含分隔下划线，不会误伤
`sxy_plan_remindedX_*` 之类的相邻键）。总量恒定在「当前一天」。
实现上是**先收集、后删除**——在 `for (i < length) + key(i)` 遍历中直接
`removeItem` 会实时改变索引、漏删一半。

## 三、验证

| 项 | 结果 |
|---|---|
| `npm test` | **1152 passed / 0 fail**（1127 → +25） |
| i18n 三道闸 | 0 新增（含修正 `reply.js` 一处新增硬编码中文，改为不产文案） |
| `dep-check` | 269 文件 0 环 |
| `sync-coverage-audit` | 47 表 0 漏同步 |
| `vite build` | ✓ built（沙箱 safe-delete 限制按既定流程先移开 dist 后构建） |
| hub 语法 | `node --check sync-hub/hub.js` 通过 |

**过程中的自我纠错**：`reply.js` 初版在 `_row()` 空对象分支写了中文文案 `'- (空)'`，
被 i18n 第三道闸（数据层硬编码）在 `reply.js:70` 精确拦下。该分支实际几乎不可达
（JSON 往返会清掉 `undefined`），改为返回空串由调用方过滤，既不产文案也不影响输出。

## 四、遗留 / 建议

1. **展示侧护栏（建议）**：`planCharts.js` 的 `buildScheduleBoard` / `checkinTimelineOption`
   仍应补 `Number.isFinite` 守卫。入口洗净拦得住**新导入**的脏行，但**库里已存在**的
   历史脏行（本轮之前导入的）不会被追溯清洗。属并行会话 round64 报告的范围。
2. **`stats.sanitized` 未接 UI**：目前只进 `stats`，未在导入结果弹窗提示「修正了 N 个异常字段」。
3. **`scheduleOption` 死导出**（`planCharts.js:191`，零调用方）：并行会话已记为 P3，未处理。
