# round80 深度审计报告（算法数学专项：src/algorithms/ 全目录 + fsrs.js 残面）

- 日期：2026-09-16
- HEAD：`7b62eac`
- 背景：用户质询"算法审计了吗"——诚实回答：SRS/FSRS 调度主链审过（round68），但 `src/algorithms/` 16 个文件（2240 行）从未做专门数学审计，仅 round44/48 顺带扫过。本轮补齐。
- 方法：2 个并行探查子代理（归因/溯源组 + 预测/校准组），主会话亲读 session.js 全文与 fsrs.js trainWeights/schedule 残面交叉验证。

## 一、问题清单（新发现 1 P1 + 4 P2 + 8 P3）

### P1 — 1 项

| # | 位置 | 问题 | 触发场景 |
|---|---|---|---|
| A1 | calibration.js:115-118 | **小样本给出高置信度校准结论**：`calibrationStats` 只有 n===0 护栏，n=1~4 照样输出「校准良好/偏乐观」verdict + 定制建议，直接驱动调度策略（下调目标保持率→减少复习量）。作者在 calibration-feedback.js 设了 `DEFAULT_MIN_SAMPLES=50` 门槛，但生产端 stats 本身没设——知道风险却只保护了一个消费端 | 用户只复习 2 次（1 忘 1 记）→ bias=-0.5 → UI 建议下调保持率 |

### P2 — 4 项

| # | 位置 | 问题 |
|---|---|---|
| A2 | calibration.js:107 | **rating 缺失被静默计为「遗忘」**：`r.rating > 0 ? 1 : 0` 对 undefined/null/NaN 全落 0 → 老/导入数据无 rating 时 bias 系统性偏「高估记忆」→ 反馈链错误上调 desiredRetention（与 A1 同链放大） |
| A3 | golden-hours.js:39-44 | **1 条记录就输出「黄金时段」建议**：total=1 时 peakHour=3 → 「建议安排 3:00–5:00」，误导性文案无最小样本门槛 |
| A4 | mistakeAttribution.js:72 | `cards` 为 undefined 时 `cards.map` 直接 TypeError（守卫只判 length） |
| A5 | mistakeAttribution.js:144 | `card.front` 无 `\|\| ''` 守卫 → undefined 拼出 token `"undefined"`，可当选 concept 名，用户看到「undefined」知识点 |

### P3 — 8 项（摘要）

| # | 位置 | 摘要 |
|---|---|---|
| A6 | mistakeAttribution.js:73/165 | 单卡簇 score 口径不一致（单元素分支硬编码 1，≥2 卡孤立簇 0）；两路径排序键不一致（size vs size+score），跨 500 卡分块边界时簇顺序可能变化 |
| A7 | mistakeAttribution.js:71 | threshold 为 NaN 时 `sim >= NaN` 恒 false → 全部退化单卡簇，静默无簇 |
| A8 | source-trace.js:62 | traceCardLineage 对 null card 守卫不一致（:59 可选链、:62 直接取 id） |
| A9 | calibration-feedback.js:24 | `Number(baseRetention) \|\| 0.9` 把显式 0 吞掉——与 fsrs.js H-1 已修的同类 bug 模式自相矛盾 |
| A10 | forecast.js:127-128 | 全零预测返回 `peak={date:'',count:0}`，UI 直渲染显示空白 |
| A11 | networth.js:52 | fsrs.last 与 reviewedAt 均缺的脏数据下 elapsed=0 → R 恒 1，净值虚高不折旧 |
| A12 | networth.js:108 | masteredCount 不要求 isReviewed，导入数据带 level 时与 reviewedCount 口径不一致 |
| A13 | pretest.js:72 | `card.fsrs.reps` 为 undefined（旧序列化）时误判冷启动，覆盖已有状态 |

## 二、根因分析（横向）

1. **A1/A2/A3 同根：统计层"样本量责任"缺位**。三项都在"用小样本输出确定性结论"，且 A1/A2 会经 calibration-feedback 反馈链**放大成调度策略变更**（影响每张卡的间隔）。根因是算法层只算了数学、没算"这个结论配多少数据"。修法：统一加 minSamples 门槛（建议 calibration n<20 → verdict='样本不足'；golden-hours total<10 → 降级文案；rating 非有限值的行直接剔除而非记 0）。
2. **A4/A5/A8 同根：纯函数层入参守卫稀疏**。算法层假设调用方给完整数据，而数据来自导入/旧版本，可能缺字段。与 round61"入口设防"是同一课——算法层作为统计出口同样需要行级净化。
3. **A9 是模式复发**：`\|\| default` 吞显式 0，fsrs.js:169 已用 `??` 修过同类（H-1），calibration-feedback 漏改——建议全仓 grep `Number(.*)) \|\| 0\.` 做一次清单式排查。
4. **已验证扎实的部分（明示覆盖）**：session.js 交错贪心（O(n) 惩罚计算、rank 含 1e-6 稳定序、urgency 与 basePenalty 同号、窗口计数 Map 语义等价）；mistakeAttribution 的向量归一化（norm‖1）、cosine 天然 [0,1]、C(n,2) 加权、union-find 路径减半、O(n²) 被 MAX_CLUSTER_INPUT=500 分块控制；calibration ECE 样本量加权；forecast 外推边界（due>=end 提前退出、idx 越界保护）；fsrs schedule 兜底层（NaN→S/D/reps 三级回退）与 trainWeights 消噪（w[17]=0）、乱序排序自保、空轨迹丢弃。

## 三、修复优先级建议

1. **A1 + A2**（同文件同链，一起修：minSamples 门槛 + rating 有限值过滤）——唯一会改变调度行为的一组
2. **A3**（golden-hours 降级文案，一行）
3. **A4/A5**（mistakeAttribution 入参守卫，两行）
4. A6-A13 备忘级，清单式收口或记录不动

## 四、历轮修复完整性

- round68 对 fsrs.js 的覆盖经本轮交叉确认无遗漏面（schedule/nextInterval/trainWeights 本轮亲读复核，兜底层与消噪在码）。
- 回答用户质询的完整结论：**调度算法（决定每张卡何时出现的核心）历轮已审透；本轮补齐的是"分析展示类"算法（校准/预测/归因/聚类），发现 1 P1——恰好在之前"顺带扫过"与"专门审计"的缝隙里**。
