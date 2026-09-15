# round59 深度审计报告（worker 生命周期 / 初始化时序 / 埋点层 + 共享快照协同验证）

- 日期：2026-09-15
- HEAD：`a688b37`（本轮提交：并行会话性能专项验收）
- 工作树：仅 `docs-suite/` 与 round53/55/56 三份并行报告未跟踪

## 一、本轮实货：验收并提交并行会话性能专项（8.6×）

并行会话交付了 round57 P2 性能修复（未提交，工作树挂着 4 个文件）。**我没有直接提交，先做了共享快照的数据协同深查**——这是本轮真正的审计价值：

### dashboardSnapshot() 共享引用安全性（逐调用点核验）

`repo.js:1140` 的 `dashboardSnapshot()` 返回的 `cards`/`reviews` 是**跨调用共享的同一份数组引用**（缓存命中直接返回 `_dashSnap`），任何消费方原地 `sort/push/splice` 都会污染所有后续消费者。

全仓 9 处调用点逐一核验：

| 调用点 | 用法 | 安全性 |
|---|---|---|
| repo.js `weakCards` | `rankWeakCards(cards, reviews)` → 内部 filter/map/sort 链式，产新数组 | ✅ |
| repo.js `getStats` | `computeStats` → 首行 `reviews.filter()` 产新数组 | ✅ |
| repo.js `getReviewSuggestion` | `buildReviewSuggestion(cards, realReviews(reviews))` → realReviews 是 filter | ✅ |
| analytics.js `getRecentMistakes` / `getForgetRisk` / `getAssetHealth` / `getCalibration` | 全部 `snap.reviews.filter(...)` 后用 | ✅ |
| analytics.js `prepareFsrsTrainingData` | **并行会话改为先 filter 再 sort**（原写法对共享数组原地 sort 是隐患） | ✅ |
| achievements.js `collectAchievementStats` | `filter` 后用 | ✅ |

**结论**：快照共享引用机制安全，并行会话的 filter-first 纪律正确且必要（它自己踩中了「共享数组原地 sort」的陷阱）。性能实证可信：3000 卡 / 6 万 review 下页面加载 1591.4ms → 185.7ms；全量 **1105/1105**（+4 回归）、lint 0、i18n 闸绿（基线 diff 仅行号漂移，count 45→45 无新增豁免）。已提交 `a688b37`。

## 二、新审计域（worker / 初始化 / 埋点）

### 2.1 analytics.worker.js（Web Worker 生命周期）

协议干净：`postMessage({id,fn,args})` → `{id,result}` / `{id,error}`。主线程侧四件套齐全：

- `offload()` 用 `_pending` Map 按 id 配对，`.catch(() => _FALLBACK)` 兜底；
- `onerror` 清空 worker + reject 全部 pending → 调用方回退 inline；
- `shutdownAnalyticsWorker()` 正确 await terminate（避免 node --test 子进程挂起，注释解释了 `--test-force-exit` 会吞真实断言的坑）；
- worker 内 `_analyticsWorker` 为 null → 直接走 inline，无循环递归。

### 2.2 main.js（初始化时序）

R2 模块求值期错误守卫（window error → logError）在 createApp 前注册 ✅；db 模式对齐在 import 期完成 ✅；unhandledrejection 记录 + preventDefault ✅。样式引入顺序有注释钉死（EP → 项目 → bridge → english-brand）。

### 2.3 telemetry.js（埋点批量层）

flush 的失败回填**已修**（round34 P2-8）：逐批 try、失败批 `_buffer.push(...batch)` 回填、500 条上限保护内存、break 留重试。我 grep 到的「批次回填但实际没做」是**注释在解释历史 bug**，当前实现正确。

## 三、问题清单（本轮无 P1/P2，3 个 P3 观察）

| 编号 | 问题 | 大白话 | 位置 | 建议 |
|---|---|---|---|---|
| N1 | worker 请求无超时 | 若 worker 端处理卡死（极端数据下 trainWeights 死循环），主线程等结果**永久挂起**，无超时兜底 | `analytics.js:41-48` | 维持观察：trainFsrs 大样本可能 >10s，超时设短会误回退 inline（主线程反而卡死），设长又失去意义 |
| N2 | worker 端 postMessage 在 try 外 | result 含不可克隆对象时 DataCloneError 崩 worker——但 onerror 会兜底 → 全部回退 inline | `analytics.worker.js:37-41` | 不修：实际触发概率趋近零（返回纯对象），已有兜底 |
| N3 | init/pruneTrash fire-and-forget | 启动时 appMode.init() 失败被静默吞掉——但 db 模式对齐在 import 期已完成，init 只补播种 | `main.js:61/67` | 不修：影响面仅「演示库空时未自动播种」，下次启动重试 |

## 四、根因观察

本轮三模块（worker/main/telemetry）质量高，是因为它们**已经被历轮审计修过**（round34 埋点回填、round54 死代码清理、P0-3 worker 化），且修后都留了「为什么这么修」的注释——新代码踩坑概率大幅下降。唯一共性弱点是「异步无超时」（N1），但该场景收益/成本比不划算。

## 五、验证与前序完整性

- 全量 **1105/1105**（含并行会话 +4 回归）· lint 0 · i18n 双闸绿 · dep:check 0
- 历轮修复抽查：round54 十二项 / round57 lunar 守卫 / round58 splitTasks / round57 导入配额 —— 全部健在
- 本轮无新增待办（N1-N3 观察级）

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round59 问题分布（四维 × 优先级）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [1, 1, 1, 0] }
  ]
}
```
