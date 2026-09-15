# round64 深度审计报告（round63 计划修复验收 + 跨模块接缝不对称）

- 日期：2026-09-15
- HEAD：`536f1b6`（并行会话 round63：计划解析与提醒调度 6 缺陷）
- 工作树：`docs-suite/` + 并行报告 round53/55/56/60/61 未跟踪

## 一、验收并行会话 round63 修复（plan-parser / plan-reminder，6 缺陷）

并行会话 `536f1b6` 修了计划解析与提醒调度 6 个缺陷，带 241 行回归测试。我逐条独立验证：

| 编号 | 缺陷 | 大白话 | 修复核验 |
|---|---|---|---|
| B1 | 「12 点」三语境全错 | "晚上12点"被算成 19 点、"凌晨12点"算成正午 12 点——12 点这档在三种语境下全错且不显眼（兜底到关键词映射） | ✅ 夜间向→0 点、白天向→12 点、无前缀保守不变；1..11 点 +12 逻辑分离 |
| B2 | 负向断言误杀中文单位 | `(?![a-z\u4e00-\u9fff])` 把"做2小时数学"整句封死 → estimatedMinutes=null → 时长块退 defaultDur 兜底 → 全天安排系统性失真 | ✅ 只给英文单位（min/h）加边界，中文单位放行 |
| B3 | 四象限忽略否定词 | "不紧急"被当成"紧急"入象限 | ✅ 修复（量词/否定词双查） |
| B4 | 提醒提前量跨午夜失效 | 0 点任务 + 提前 10 分钟 → 窗口 [-10,5) 被钳到当天 00:00~00:05，用户设的"提前 10 分钟"变成"滞后" | ✅ 窗口按 1440 取模，跨日两段都算命中（23:50~23:59 与 00:00~00:04）+ tick 补查"明天"计划 |
| B5 | 考研高频量词漏检 | "做8道题/看2讲/刷100问/背5段/看3集"的 targetCount 静默丢失 | ✅ 补齐道/讲/问/段/集/课，附防误匹配说明 |
| B6 | 去重键只写不删 | 提醒去重标记残留 | ✅ 修复 |

**评价**：B2 是我 round58 扫 plan-parser 时**漏掉的真缺陷**（我只查了 splitTasks 的英文句号切分，没追到 timeRe 的负向断言对中文单位的误杀）——并行会话这次挖得比我在该模块更深。B4 的修法（取模双段命中 + tick 查明天）比我 round61 提的 `Math.max(0,...)` 方案更正确。**计划解析链路已达到相当高的防御密度。**

验证：全量 **1127/1127**（+12 回归）、lint 0、i18n 闸绿。

## 二、本轮新发现（聚焦"同一脏值源、两侧防护不对称"）

### P2-1：脏 scheduledHour 在提醒侧已防护、展示侧完全裸奔

**现象**：同步/导入/手改包带来的脏 scheduledHour（如 NaN、`"9:00"` 字符串）会让"今日日程表"课程表的格子**定位错乱**（top: NaN 渲染无效）。

**证据链**：
1. 并行会话自己在 round63 给 `plan-reminder.js` 加了 `!Number.isFinite(h) || h < 0 || h > 23 → return false`，注释原话："**手改的数据包与跨设备同步来的行可能带脏值**"——开发者已确认脏值真实存在。
2. 但同源脏值到展示侧 `planCharts.js:buildScheduleBoard`：守卫是 `sh < startHour || sh > endHour`——**对 NaN 恒 false**（NaN 任何比较都是 false），脏值直接穿透：
   - `"9:00" < 6` → false、`"9:00" > 23` → false → 进正常分支
   - `top = ("9:00" - 6) * rowH = NaN` → 课程表块 top:NaN → **布局错乱**
   - 同理 `estimatedMinutes` 是 `"abc"` 时 `Math.max(34, NaN)` = NaN → 块高 NaN
3. 模板直接消费：`DailyPlanView.vue:634` `board.totalHeight`、`:640` `v-for board.placed`（computed → 每次任务变化重算）。

**根因**：写入侧（repo.js:1389 round30 clamp）只护"正常解析路径"；同步 merge / 外部导入是**行级 upsert，不走 clamp**；展示侧靠 `NaN 比较恒 false` 这个 JS 陷阱兜底——**兜不住**。提醒侧（round63）与展示侧（本轮）是同一脏值源的两个出口，一个修了一个漏了，典型跨模块接缝不对称。

**建议**（与 plan-reminder 同款防护，几行）：
```js
const sh = Number(t.scheduledHour);
const dur = Number(t.estimatedMinutes);
if (!Number.isFinite(sh) || sh < startHour || sh > endHour) { unscheduled.push(t); continue; }
// dur 同样 isFinite 校验后取 defaultDur
```

**优先级**：P2（触发条件真实存在——开发者自认；影响是日程表整块错乱而非静默）。

### P3-1：`scheduleOption` 是全仓无调用方的死导出

`planCharts.js:191` 定义了按 scheduledHour 分桶的时间轴 option，但全仓 grep **零调用方**（实际用 `checkinTimelineOption`）。且它内部 `buckets[t.scheduledHour].tasks` 对越界 hour 会 TypeError——目前因无调用方崩不了，但属于"会爆炸的死代码"。建议删除，或修复后接入（若时间轴 UI 是待办功能）。

### P3-2：`checkinTimelineOption` 脏 hour 画到图外

scatter 的 `value: [t.scheduledHour, y]`，xAxis `max: 24`——脏值 25 的点被画到画布外**视觉消失**（任务"不见"但不崩）。同源问题，随 P2-1 一并防护即可。

## 三、已扫模块（全部干净，含本轮 6 模块）

hub-auth（HMAC 挑战响应，token 永不上网）· gistBackup（乐观并发 + 404/5xx 区分 + token 仅本地）· quickCheck（索引收窄 + 差量事务）· ocr-cache（LRU 200 + sig 版本签名，图片替换自动失效）· ocr.js 纯函数（isOcrEmpty 的 \p{P}\p{S} 正确、fitCanvasSize 长边压 2000）· img-compress（1568px + q0.8，canvas 归零释放，Node 降级）

## 四、此前审计项修复完整性验证

| 项 | 状态 |
|---|---|
| round63（536f1b6）计划解析 6 缺陷 + 241 行回归 | ✅ 全量 1127/1127 |
| round61（401f40d）统计层 4 P2（两级过滤/比率/覆盖率/热力图） | ✅ 上轮已验收，本轮复跑全绿 |
| round54 P1 回收站还原图（_images 快照 + restore 写回） | ✅ repo.js:361-383 在码 |
| round48/49/50/51/57/59 修复标记 | ✅ 抽查健在 |
| 我的 round62 报告被并行会话覆盖改写 | ✅ 已归档（f59369d，内容为并行会话版，标注来源） |

## 五、结论（大白话）

1. **并行会话本轮打得准**：计划解析 6 缺陷（含我 round58 漏掉的 timeRe 中文单位误杀）修复质量高，1127/1127 全绿。
2. **本轮真发现 1 个 P2**：同一个脏 scheduledHour，提醒侧已被 round63 防护，展示侧课程表还在"裸奔"——NaN 比较恒 false 这个 JS 陷阱让守卫形同虚设，脏数据会带着 NaN 进布局。**修法几行，与提醒侧对齐即可。**
3. 顺手确认 2 个 P3：一个死导出（会爆炸但没接电）、一个图外裁剪。
4. 工具层六个模块（凭证/备份/快检/OCR/压缩）全部干净——安全与数据卫生防线在位。

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round64 新发现分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 1, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [0, 1, 1, 0] }
  ]
}
```
