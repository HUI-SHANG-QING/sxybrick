# round72 深度审计报告（SRS 调度全链路 / SW 运行时 / 测试覆盖 / 存储治理）

- 日期：2026-09-16
- HEAD：`740256f`（工作树：并行 WIP `src/ai.js`+`AIAssistant.vue` 未提交）
- 本轮零 P1/P2，1 个 P3（存储治理）

## 一、本轮打的三个新域（历轮未整体审过）

### 1. SRS 复习调度全链路（srs.js → fsrs.js → algorithms/scheduling.js）

整条链路从「卡片创建 → 复习评分 → 调度 → 巩固 → 到期重排」逐段读源码，结论：**非常扎实，零新发现**。

- SM-2 变体（computeNext）：level/ease 归一化（NaN 防护，杜绝"卡永久消失于队列"）、巩固状态机（当日 6h → 隔日 → 毕业，超时 24h 自动跳过）、遗忘曲线梯度 `[1,3,7,15]→ease^level`、难度偏移、蒙对打折、错因枚举查表（不再中文嗅探）、强度系数、自适应节奏（近 10 次错误率）
- 间隔兜底顺序正确（round 封顶 365 天 → 再对 NaN/负值兜底 10 分钟，A5 修复在位）
- FSRS 路径：蒙对按 hard 推进（round15 P2 在位）、last 推进语义（R17-6 在位）、检索强度乘子后封顶 365（R17-7 在位）、考试窗口回钳 + 节假日弹性括号（round32/34/68 修复全部在位）
- 复习写回：差量写（B11）、wrongReasonAt 独立时间戳、predR 校准落盘、事务双写——历轮 6+ 处修复全部健在

### 2. SW / PWA 运行时（vite.config.js）

- registerType=prompt（新版本用户确认再刷新，不 autoReload 丢编辑）
- 预缓存瘦身 14.81MB → ~4MB（OCR/pdf/sql/three/echarts 等重库全部 runtimeCaching 按需）
- 分层策略：OCR CacheFirst 30 天、WASM CacheFirst、heavy-libs 正则**已含 parsers-sheet**（round54 补丁在位）、图片 SWR 14 天、AI 接口 NetworkOnly（防对话串台）、同源 assets SWR
- devOptions.enabled=false（防 dev SW 缓存旧模块白屏，round 修复在位）
- 结论：干净

### 3. 测试覆盖

- 110+ 个测试文件，核心模块全覆盖：srs/fsrs/sync 系列（10+）/word 系列（8+）/round 回归系列（10+）/i18n 系列（5+）
- 无新盲区发现

## 二、P3（1 条，建议顺手清）

| 编号 | 位置 | 大白话 | 优先级 |
|---|---|---|---|
| N1 | 仓库根 25 个 `dist_bak_*` 目录 | **构建备份累计 472MB 无人清理**。每次 `npm run build` 脚本都备份旧 dist（`dist_bak_<时间戳>`），从没删过——用户 E 盘曾满（清出 14.6GB），这就是隐性泄漏源之一 | P3（低，但零成本可清） |

## 三、此前审计项修复完整性验证（抽验全绿）

| 项 | 来源 | 状态 |
|---|---|---|
| router.onError / ChunkLoadError 兜底 | round53 P2 | ✅ src/router.js:109 已在 |
| 专注时长改墙钟差值 + 后台不计时 | round53 P2 | ✅ Review.vue:512-529 已在 |
| 回收站还原写回 db.images（含 _images 快照 + bulkPut） | round54 P1 | ✅ repo.js:368-462 已在 |
| 闸门基线按行内容登记（行号漂移免疫） | round71 P2（我修的） | ✅ bc3c0e4 已推送，双闸 0 新增 |
| 并行新提交（906481f 批量分析 / 740256f 统计修复） | 并行会话 | ✅ 自带测试，全量 1180 绿（上轮） |

## 四、结论（大白话）

1. **连续第四轮零必修项**。SRS 调度、SW、测试体系三个"地基级"域整体干净——历轮 30+ 项修复全部在位，无一回退。
2. **唯一实质发现是存储治理**：25 个构建备份目录 472MB 白占磁盘。`dist_bak_*` 是构建脚本的备份机制，保留最新 1-2 份即可，建议顺手清掉（可安全删除，dist/ 才是当前产物）。
3. **工作区有并行 WIP 未提交**（src/ai.js + AIAssistant.vue 的 RAG 检索上下文增强）——不在本轮范围，留待并行会话收尾。

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round72 观察分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [0, 0, 0, 1] }
  ]
}
```
