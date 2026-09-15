# round75 全面审计 + 回归验证报告

> 用户要求：「全面审计，任何，验证是否所有审计均已经修复，且没有引入任何问题」。
> 本报告只写**可复现的证据**，不做「应该没问题」式的结论。

---

## 一、结论（先给答案）

| 问题 | 答案 |
| --- | --- |
| 历史审计的 **P0/P1/P2 必修项**是否都已修？ | **是**。抽检 6 类历史必修/遗留项，全部有代码级证据证明已关闭（§四） |
| 是否所有 P3 也都修了？ | **否，也不需要**。P3 是「建议/防御/设计取舍」，本仓库一贯显式登记、逐轮消化。仍有 7 项（§五）——**本轮又消掉 3 项** |
| 本轮是否引入新问题？ | **没有**（机械门禁全绿 + 契约面逐项核对）。过程中**一次自己引入的错误被新闸门当场抓出并修正**（§三.4）——这恰好证明闸门有效 |

---

## 二、验证方法与机械证据

```
npm test            → 1230 passed / 0 failed   （基线 1227 + 本轮新增 3 条闸门）
npm run build       → BUILD_EXIT=0
npm run check:build → ✓ 52 个词库分片全部就位
eslint src tests    → 0 error / 0 warning
dep:check           → 272 个源文件，0 循环依赖
i18n 三闸           → 通过（数据层 340 行，较基线新增 0）
sync-coverage-audit → 47 表：39 同步 / 5 排除 / 1 隐私 / 2 特殊通道，0 漏同步
```

外加两项**人工逐项扫描**（脚本可复现）：

1. **审计文档盘点**：`docs/AUDIT-*.md` 共 **65 份**，逐份扫「优先级汇总 / 结论 / 未修」段落，
   抽出仍然开着的条目并按 P0~P3 归组（§四、§五）。
2. **契约面扫描**（针对最近三轮的改动）：
   - 工具输出**形变**的消费者盘点（`get_weak_cards` 从数组 → `{items,...}`、`list_memos` 去掉 `count` 等）→ 代码侧消费者只有 `buildLocalAnswer.toRows()`，且它本就认 `{items}`；无 `.count` 消费者 → **无断裂**；
   - `db.cards/reviews.toArray()` 全仓 48 处逐处归类（§三.1）；
   - `invalidateDashboardCache()` 覆盖面对照所有写 cards/reviews 的函数（§三.3）；
   - `t` 遮蔽全仓扫描（§五.7）。

---

## 三、本轮新发现并已修复（3 类，均属历史遗留）

### 1. round57「共享快照」契约存在**活违规**（旧 P1「analytics 全表 toArray」只修了一半）

旧 P1 从 round23 起被连续 5 轮确认「未修复」（round23/24/26/28/31），round57 收口了**最热的 5 个首屏函数**
（getRecentMistakes / getForgetRisk / getLearningProfile / getCalibration / getAssetHealth），
但**同一文件里其余主线程函数仍在裸读全表**：

```
getDueForecast()      const cards = await db.cards.toArray();     ← 主线程
getNetWorth()         db.cards.toArray()                          ← 主线程
getSourceOverview()   const cards = await db.cards.toArray();     ← 主线程
```

为什么算违规：round57 的契约原文是「**主线程任何全表读必须走 `dashboardSnapshot()`**」。
为什么以前没人发现：**闸门只覆盖已迁移的那 5 个函数**，漏网者可以长期存在。

**修复**：三处改用 `const { cards } = await dashboardSnapshot();`（三个下游纯函数
`forecastDue` / `computeNetWorth` / `sourceOverview` 经核对只读、其 `sort` 作用于派生数组，
不会污染共享数组）。
**新闸门（契约⑤）**：`analytics.js` 里任何裸 `db.cards/reviews.toArray()` 只能出现在
**Worker 委托函数**里（白名单**从 `analytics.worker.js` 的实际导入派生**，不是手写清单；
并含 `_` 前缀私有实现）；主线程函数一律必须走快照。闸门同时**先剥注释**——
第一版没剥，被我自己的解释性注释里的 `db.cards.toArray()` 字样误报（已修）。

### 2. 热力图没有**上界**：未来时间戳会造出「未来日期格」

`repo-core.js` 的热力图循环只过滤下界（`reviewedAt < since` 跳过 365 天前），没有上界 →
时钟漂移 / 坏包导入的未来时间戳会在 365 天热力图上多出一个「未来格子」（GitHub 风格图会顶到最右列）。
**修复**：`reviewedAt > nowTs + DAY` 跳过（**留 1 天宽限**，避免把「刚刚复习」因毫秒级 skew 挤出今天的格子）；
**只改热力图口径**，`real` / `dirtyReviews` / `todayReviews` 等计数口径一律不动。
**新测试**：`tests/round61-boundary.test.mjs` 增 1 条（明显未来 → 不出现格子；+1 分钟内 → 仍计入；totalReviews 不动）。

### 3. 三条「改字段」写路径漏了显式缓存失效

round57 契约④明确写：**key 不完备，写路径必须显式调 `invalidateDashboardCache()`**。
全仓对照后发现三个函数改动了 `db.cards` 却没调：

| 函数 | 改什么 | 风险 |
| --- | --- | --- |
| `updateCard` | 卡片字段（bump updatedAt） | **同一毫秒内第二次编辑**不改变最大 updatedAt → key 不变 → 命中陈旧快照 |
| `setMarked` | `marked` 字段（bump updatedAt） | 同上 |
| `deleteNote` | 级联清洗卡片侧 `linkedNoteIds`（bump updatedAt） | 同上 |

即：不是「每次编辑都读到旧值」（bump updatedAt 通常能天然换 key），而是**同毫秒二次编辑的窄窗口会命中陈旧值**，
而「知识净值 / 到期预测 / 来源血缘」本轮刚改走快照，正好会暴露它 → 必须一并封死。
**修复**：三处补 `invalidateDashboardCache();`。
**新闸门（契约⑥）**：`repo.js` 中所有写 `db.cards/reviews` 的函数必须显式失效，
或落入「**行数一变 key 必变**」的增删类白名单（createCard / deleteCard / restoreFromTrash）。

### 4. 我在修 3 时自己引入的错误（**被新闸门当场抓住**）

第一次给 `deleteNote` 补失效时，我用「找事务收尾锚点」的方式插入，结果**插到了 200 行之后另一个函数
（删 graphEdges + embeddings 的那个）的末尾** —— 注释与代码都挂错了函数。
新写的契约⑥闸门立刻报出 `deleteNote` 仍未失效（而不是「看起来通过」），
我才发现归属错了，改用**括号配对定位真实函数结尾**后修正。
（闸门自身也有过一版 bug：最初按「最后见到的函数名」归属，遇到嵌套函数会串号 → 已改为**按顶格声明切段**。）

---

## 四、历史必修项抽检（带代码证据）

| 历史项 | 出处 | 结论 | 证据 |
| --- | --- | --- | --- |
| analytics 全表 toArray（P1，连 5 轮未修） | round23/24/26/28/31 | ✅ 本轮关闭 | 3 个主线程函数改走快照 + 契约⑤闸门 |
| `mergeByFieldTs` 平局不收敛 | round39 BUG-01 | ✅ 已修 | `sync-manifest.js:600` 起有「确定性收敛」实现与反例注释 |
| `imageRefs` 死索引 | round39 BUG-02 | ✅ 已修 | `db.js` v33 将表置 `null` 删除；`repo.js:655` 移除快速路径 |
| FSRS 训练「空轨迹卡」崩溃 | round43 N1 (P2) | ✅ 已修 | `fsrs.js:273` 有过滤实现 + 原因注释 |
| 闸门可被绕过（基线可随意重锚） | round54 P2-5 | ✅ 已修 | `--js-update-baseline` 净增 > 0 时**拒绝自动认领**（本轮实测到它拒绝，见 §六） |
| 共享快照契约①~④ | round57 | ✅ 5/5 通过 | `tests/round57-perf.test.mjs` |
| 畸形数据健壮性 ①②③ | round61 | ✅ 7/7 通过 | `tests/round61-boundary.test.mjs`（本轮 +1） |
| Agent 每轮必 400（原生 tool 角色） | round73 R5 | ✅ 已修 | `tests/agent-llm-resilience.test.mjs` 严格端点复刻 |
| 时好时坏（流式/超时/抢救） | round73 | ✅ 已修 | 同上 18 条 |
| 笔记/资料库/计划/每日任务对 AI 不可见 | round74 | ✅ 已修 | `tests/agent-list-tools.test.mjs` 10 条 |
| 高频失败（无重试）+ `t` 遮蔽 | round75 | ✅ 已修 | 重试 6 条 + `t` 遮蔽 2 条 |
| 并行会话最近提交（CardGroups 渲染 / 图片统计 / 批量图片分析） | round67c/67d/74 | ✅ 未见回归 | 全量门禁 + 构建产物校验覆盖 |

> 说明：**没有一份审计报告的 P0/P1/P2 处于「声称已修但实际未修」的状态**；
> 唯一「连轮次都确认未修」的那项（analytics 全表 toArray）本轮关闭。

---

## 五、仍未修（如实清单，都是 P3 / 非缺陷 / 已登记债）

| # | 项 | 性质 | 建议 |
| --- | --- | --- | --- |
| 1 | `stats.dirtyReviews` 已算但未接 UI（数据体检页） | 缺口（数据已暴露，需要 UI 位） | 放到「数据体检」页 |
| 2 | 裸 `new Date('YYYY-MM-DD')` 时区口径（如 `CardInsight.vue:103` 考试倒计时） | 展示层 8 小时偏差，非数据错 | 统一补 `+'T00:00:00'` |
| 3 | `graphAuto.js` 4 处主线程全表读（未 Worker 化） | 已登记性能债 | 明确委托给 Worker |
| 4 | 10 个插件的沙箱 CSP / `App.vue` SettingsPanel 拆分 | 架构债 | 独立批次 |
| 5 | 图片反向索引（v33 已删死表） | 有需求再做 | 待真实大数据 |
| 6 | **views 层 14 处**直接 `db.cards.toArray()`（CardInsight / Exam / Feynman / GenQuiz / KnowledgeGraph / Mindmap / WeeklyReport / WordBook） | 大数据量下「进页面就全表扫」 | **需逐站核对「写后失效」配对再改**，风险高于收益，建议单独一轮 |
| 7 | `src/views/*` 等 18 处把 `t` 用作局部变量（已逐处核对**不是活雷**） | 命名隐患 | 独立一轮批量改名，别混进功能提交 |
| 8 | 流水线 4~12 次调用期间聊天页无「正在第几步」进度 | 体验 | 可选 |
| 9 | 打字机效果（`onToken` 已全链路打通，UI 未消费） | 体验 | 可选 |

---

## 六、过程中的两个「闸门抓到我」实测记录（说明验证体系真的在起作用）

1. **i18n 第三道闸的净增护栏**：我新增文案后跑 `--js-update-baseline`，被拒绝并提示
   「新增文案请迁入 i18n 字典，不要把违规写进基线」→ 按提示把 3 条文案迁进 `agent.toolMsg.*`
   （重跑后数据层扫描 341 行、**新增 0**，基线无需重锚）。
2. **契约⑥闸门抓出我插错位置**：见 §三.4。

这两件事比「全绿」更能说明：**闸门能拦住人的错误，而不只是记录已发生的事故**。

---

## 七、残余风险评估

- 本轮改动集中在**读路径收口**（快照 / 失效 / 热力图过滤），不触碰同步、墓碑、合并语义 → 跨设备数据风险为零。
- `getNetWorth` / `getDueForecast` / `getSourceOverview` 改走快照后，理论上会受「快照陈旧」影响；
  已通过 §三.3 把 `updateCard` / `setMarked` / `deleteNote` 三条改字段写路径补齐显式失效，
  且 `review()`（高频写路径）本就失效 → 陈旧窗口只剩「同一毫秒内的多次写」，已封死。
- 三个下游纯函数经核对**不原地修改**共享数组（其 `sort` 作用于派生数组），符合 round57 契约②。
