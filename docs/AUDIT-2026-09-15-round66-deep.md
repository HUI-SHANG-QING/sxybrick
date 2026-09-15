# round66 交付报告：日历展示侧脏值护栏（补 round65 的第二道防线）

> 承接并行会话 round64 报告发现的 P2-1 / P3-2，以及 round65 的入口域校验。
> round65 从**源头**拦（新导入的脏值进不来），本轮补**展示侧**兜底（库里已存在的历史脏值不再炸布局）。

## 一、问题

脏 `scheduledHour`（`'9:00'` 字符串 / `NaN` / `25` / `9.5`）与脏 `estimatedMinutes`（`'abc'`）
在日历展示层**完全裸奔**，因为守卫写法有 JS 陷阱：

```js
if (sh == null || sh < startHour || sh > endHour) { … }   // ← 对 NaN 恒为 false
const durMin = t.estimatedMinutes || defaultDur;           // ← 'abc' 是 truthy，短路失效
```

后果：

- `top = (sh - startHour) * rowH` → **NaN** → 课程表格子定位错乱（整块布局崩）
- `buckets[t.scheduledHour]` → `buckets[25]` 取到 `undefined` → **TypeError**
- 散点 `value: [t.scheduledHour, y]` → NaN 坐标 / 被 `xAxis(max:24)` 裁到画布外 → 任务**视觉消失**（还不报错）

## 二、修法

统一口径：**先 `Number()` 归一化，再 `Number.isFinite` 显式校验**，非法值按"未排程 / 无计划"处理，
而不是放任它流进坐标计算。

| 位置 | 改动 |
|---|---|
| `buildScheduleBoard` | `sh` / `durMin` 归一化；非法值进 `unscheduled`；`label` 改用归一化后的 `hour`/`durMin`（不再回读原脏值） |
| `checkinTimelineOption` | 新增 `planHour[]` 归一化数组；散点坐标、`late` 判定、tooltip 一律用它 |
| `scheduleOption` | 桶索引访问前先 `Number.isInteger` + 范围校验（防 `buckets[9.5]` / `buckets[25]` 击穿） |
| `riskOption` | 时长改走 `safeDur()`（`'abc' \|\| 30` 会短路失效） |

新增共用辅助 `safeDur(v, fallback)` —— 单一实现，避免三处各写一份 `||` 兜底再各漏一处。

**注意**：`0` 是合法时长之外的边界（0 分钟无意义）→ 回落默认值；但 `scheduledHour = 0`（零点）是**合法**值，
判定用 `h >= 0` 而非 `!h`（falsy 陷阱）。

## 三、验证

| 项 | 结果 |
|---|---|
| `npm test` | **1158 passed / 0 fail**（1152 → +6） |
| 新增用例 | `tests/planCharts.test.mjs` +6：脏点位不落格 / 脏时长回落 / 字符串数字仍可解析 / 桶索引不炸 / 小数不击穿 / 散点无 NaN |
| 行尾 | 改动前先测：`planCharts.js` 是 LF、`planCharts.test.mjs` 是 CRLF —— **各自保持原样**（round65 的行尾事故已不再重演） |

## 四、说明

本轮**不改** `task` 对象的原值（`placed[].task` 仍是原任务引用），只在计算链路内使用归一化值——
避免在展示层悄悄改写数据。真正的数据清洗由 round65 的入口域校验负责，两层分工：

- **入口（round65）**：脏值进不了库（治本）
- **展示（本轮）**：库里已有的历史脏值也不会炸 UI（兜底）
