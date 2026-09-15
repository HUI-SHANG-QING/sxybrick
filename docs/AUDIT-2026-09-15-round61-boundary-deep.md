# SxyBrick 深度审计报告 — Round 61（边界条件 / 数据建模 / 算法不变量）

> **审计日期**：2026-09-15
> **审计基线**：git HEAD `ee799cb`
> **本轮性质**：全新维度——**用畸形/极值数据实证**核心统计与调度算法（不靠读代码猜）
> **方法**：`fake-indexeddb` 忠实复现 → 打印实际输出 → 断言不变量 → 修复 → 回归
> **上轮**：`docs/AUDIT-2026-09-15-round57-newdim-deep.md`

---

## 一、总评（大白话）

先说结论：**项目主体是结实的**，尤其是调度算法（FSRS/SM-2）——我用 12 种畸形卡片状态 × 3 种评分
轮番轰炸，**一个 NaN 都没漏出来**，护栏写得很到位。

**但统计层没有同等防护**，这是本轮挖到的东西。打个比方：调度器像机房装了 UPS，统计层却是裸奔——
一条来路不明的脏数据就能把"掌握度"这种全局指标搞成乱码，**而且不报错、不告警**。

本轮用实证抓到 **3 个 P2**（都能复现出错误输出）+ 1 个 P3，**全部已修 + 带 10 条回归测试**。

最关键的一条是：**"掌握度 NaN"会在下游被静默吃掉变成"掌握度 0%"**——
也就是说，用户明明在认真学习，系统却告诉他"你完全没掌握"。这种错最难发现，因为它看起来像个正常数字。

---

## 二、问题清单

| # | 严重度 | 位置 | 现象（实测） | 大白话 |
|---|---|---|---|---|
| **R61-1** | **P2** | `repo-core.js` `computeStats` 掌握度聚合 | rating 缺失 → `avgMastery = NaN`；`rating=5` → 掌握度 **250%**；`rating=-1` → **-50%**；`rating='2'`（字符串）→ NaN | 一条脏评分就能让"全局掌握度"变成乱码，还会静默变成 0% |
| **R61-2** | **P2** | 同上，`correct` / `stable` | 域外评级**只进分母不进分子** → 正确率被稀释（实测 100% → 67%） | 数据里有脏行时，你的正确率会被无辜拉低 |
| **R61-3** | **P2** | 同上，覆盖率 `coverage` | 1 张卡 + 1 条悬空复习 → **覆盖率 200%** | 删掉的卡还"算数"，覆盖率能超过 100% |
| **R61-4** | **P2** | 同上，热力图 / 小时分布 / 趋势分桶 | `reviewedAt: NaN` → 热力图出现键 `"NaN-NaN-NaN"`；`hourly[NaN]++` 把小时分布写成 NaN 属性 | 脏时间戳会在日历热力图上糊出一格"NaN" |
| **R61-5** | **P3** | `CardInsight.vue:103` | `new Date('2026-12-25')` 走 **UTC 午夜**；而项目别处（repo/planCharts/planSynergy/DailyPlanView）统一用 `+'T00:00:00'` 走**本地午夜** | 两套日期口径并存。中国（+8）无害，**负时区会差一天** |

> R61-1/2/3/4 是**同一个根因**（统计层没有输入域校验）的四个表现面，修在一处。

---

## 三、根因分析（含实证数据）

### 3.1 根因：统计层假设"入库数据一定合法"，但这个假设不成立

`computeStats` 的掌握度聚合原本只有一行：

```js
agg[key].sum += r.rating; agg[key].n += 1;   // ← 无任何域校验
```

`rating` 的设计域是 `{0,1,2}`（`ratingDist` 一直只认这三个键），但聚合处没有校验。于是：

- **NaN 传染**：`0 + undefined` → NaN；NaN 再进入加权平均
  `mWeighted += m.mastery * n` → **一条坏行污染全局 `avgMastery`**（不是只坏一个科目）。
- **静默降级**：下游 `const mastery = stats.avgMastery || 0` —— `NaN || 0` → **0**。
  用户看到的是"掌握度 0%"，而不是"数据异常"。这正是项目自己禁止的「静默降级」。
- **越界值**：`rating=5` → `5/(2×1)×100 = 250%`；`rating=-1` → `-50%`。这些会直接进图表与 AI 分析。

### 3.2 根因：覆盖率分子没跟"现存卡片"求交

```js
const reviewedCount = new Set(real.map(r => r.cardId)).size;   // ← 含悬空 cardId
const coverage = totalCards ? Math.round((reviewedCount / totalCards) * 100) : 0;
```

分子数的是"复习记录里出现过的 cardId"，分母数的是"现有卡片数"。两者口径不同源 →
只要存在**指向已删卡**的复习行，分子就会大于分母。

**可达性（这是关键）**：悬空复习是**真实存在**的状态，不是理论假设——
项目里专门有 `sweepOrphanRows()` 就是用来清理它的（跨设备删除后、本端还没跑到 sweep 之间，
库里就有悬空行）。所以覆盖率 200% 是**用户真能看到的**。

### 3.3 根因：时间戳未做有限性校验

`new Date(NaN)` 的 `getFullYear()/getMonth()/getDate()/getHours()` 全返回 NaN。
于是按日分桶的统计全部产出 NaN 键/属性：

```
heatmap 键样例 = [["NaN-NaN-NaN", 1], ["2027-09-15", 1]]
```

> 顺带一提：`2027-09-15` 这个**未来日期**桶也在热力图里（未来时间戳未被过滤）——
> 同属"未校验"家族，但影响仅多一格，未单独立项。

### 3.4 修复方式：两级过滤词汇（把「计数」与「评分数学」分开）

> **先记一次真实的返工**：我第一版修法是「一个过滤器管全部」——把所有 rating 非法的行从 `real` 里剔除。
> 结果**被既有测试当场抓住**：`tests/repo-core.test.mjs` 的夹具是「只有 `reviewedAt`、没有 `rating`」的
> 复习行，于是 `todayReviews` 从 2 变成了 0。
>
> 这说明「一条评分坏掉的复习记录」和「一次复习没发生过」是**两件事**。真正正确的模型是两级词汇：

在 `computeStats` 开头建立两个集合（单一事实源，各自只被对应用途消费）：

```js
const all = Array.isArray(reviews) ? reviews : [];
const isFiniteTs = (r) => Number.isFinite(Number(r?.reviewedAt));
const inRatingDomain = (r) => { const rt = r?.rating; return rt === 0 || rt === 1 || rt === 2; };
// ⚠️ 脏行不含 quick 行——那是合法业务数据，不是脏数据
const dirtyReviews = all.filter((r) => r.type !== 'quick' && (!isFiniteTs(r) || !inRatingDomain(r))).length;

const real  = all.filter((r) => r.type !== 'quick' && isFiniteTs(r));   // ① 计数类：今日/热力图/趋势/小时分布
const rated = real.filter(inRatingDomain);                              // ② 评分数学：掌握度/正确率/稳定度/遗忘率/评分分布
```

| 统计量 | 用哪个集合 | 为什么 |
|---|---|---|
| `todayReviews` / 热力图 / 趋势 / 小时分布 | `real` | 只关心「有没有发生复习 + 时间戳是否可用」，评分坏掉不影响"这天复习过"的事实 |
| `mastery` / `correct` / `stable` / `forgotTrend` / `ratingDist` | `rated` | 全是**评分数学**：坏评分只进分母不进分子会静默稀释比率（R61-2） |
| `coverage` 分子 | `rated` ∩ 本库现存卡 | 悬空 cardId 不能算"覆盖到的卡"（R61-3） |
| `dirtyReviews` | 计数（进 `stats` 暴露） | 不静默丢弃，沿用 `skippedImages` / `imageWriteFailed` 同纪律 |

**结果**：R61-1/2/3/4 四个表现面一并解决，且既有测试全部保持通过（含那条抓住我返工的用例）。

---

## 四、既有审计项修复复核

| 来源 | 项数 | 结果 |
|---|---|---|
| round54（含 P1 回收站还原丢图） | 12 | ✅ 全部在位（改动文件确在 `0214759`） |
| round57 备份路径（配额降级 / 结构校验 / 语义分离） | 3 | ✅ 在位（`sync.js` 有 `imageWriteFailed` + 「数据包结构损坏」校验） |
| round57 性能（共享快照 / 只读契约 / primaryKeys） | 3 | ✅ 在位（`export async function dashboardSnapshot` 存在，analytics/achievements 各 7/2 处引用） |
| round57 顺手修的 2 处原地 `sort` 陷阱 | 2 | ✅ 在位 |

**结论：此前修复零回退。**

---

## 五、维度覆盖与「零发现」记录（诚实交代）

| 维度 | 方法 | 结论 |
|---|---|---|
| **算法设计** | 12 种畸形卡片状态 × 3 评分 × 2 套调度器（FSRS `schedule` + SM-2 `computeNext`） | ✅ **零发现**——`dueAt` 全部有限且在未来、间隔 ∈ [0.01, 365]、单调性成立（again ≤ hard ≤ good）；`desiredRetention=0` 未被 `\|\|` 误回退 |
| **quickCheck 统一口径** | 穷举 38 个 `db.reviews` 读取点 | ✅ **零发现**（3 处未过滤候选均定性正确：删卡快照/清孤儿行**必须**含 quick 行） |
| **异常吞噬** | 172 处空 `catch` 抽查 | ✅ **零发现**——均属安全降级；`genVariants` 虽吞单条异常，但调用方汇报**真实生成数量**，部分失败对用户可见 |
| **数据对象建模 / 类型一致性** | 时间戳/日期/评分字段全量扫描 | ⚠️ 1 项 P3（R61-5 日期解析双口径） |
| **边界条件** | 空库 / 单卡 / 悬空引用 / 极值 / NaN / 字符串 | ❌ 3 项 P2（R61-1~4） |
| **性能** | 上轮已收口（8.6×），本轮复查 | ✅ 无新增全表扫 |

---

## 六、被否证的假设（避免误报，同样有价值）

| # | 读代码时很像 bug | 实证结论 |
|---|---|---|
| 1 | `computeNext(null)` 抛 `TypeError: Cannot destructure 'level' of null` → 疑似崩溃 | **不可达**：`repo.review:947` 有 `if (!card) throw new Error('卡片不存在')` 守卫；且 `computeNext` 本身已对 `level/ease` 归一化（源码注释写的就是"NaN → 卡永久消失"）。凭空造不可达输入 = 假阳性 |
| 2 | `genVariants` 在循环里 `catch {}` 吞异常 → 疑似静默半生成 | 调用方 `Cards.vue` 汇报 `created.length`（"已生成 {n} 张"）→ **部分失败对用户可见** |
| 3 | `repo.js` 有 3 处 `db.reviews` 读取未过滤 quick 行 | 定性均正确：`deleteCard` 回收站快照与 `sweepOrphanRows` 清理**必须**含全部行，否则还原不完整 / 清理不干净 |

---

## 七、改进建议

### 7.1 已随本轮落地

1. `computeStats` 统一输入域过滤（✓ 见 §3.4）。
2. 回归测试 **10 条**：
   - `tests/round61-boundary.test.mjs`（6 条）：越界 rating / 缺失 rating / 分母稀释 / 畸形时间戳 / 悬空引用覆盖率 / **正常数据防误伤**
   - `tests/round61-algo-invariants.test.mjs`（4 条）：调度器不变量（有限性/单调性/`??` 语义/畸形卡片）

### 7.2 建议后续处理（本轮未做，附理由）

| 建议 | 优先级 | 理由与做法 |
|---|---|---|
| **把 `dirtyReviews` 接到「数据体检」页** | P3 | 现在只在 `stats` 里，没界面。建议在 Health 页加一条"发现 N 条异常复习记录（时间戳/评分非法）"，并提供清理入口。工作量：1 个 UI 位 + 2 个 i18n 键 |
| **统一日期字符串解析口径** | P3 | 建议在 `utils/format.js` 加 `parseLocalDate(str)`（内部 `str + 'T00:00:00'`），把 `CardInsight.vue:103` 等**裸解析**点全部改造；并对 `<input type="date">` 的 4 个绑定点做一次统一 |
| **导入侧加行级域校验** | P2 | 本轮只在**统计消费端**兜住了脏数据。更彻底的做法是在 `importBackup` 合并前对 `reviews.rating` / `reviewedAt` 做一次归一化（非法行丢弃并计数），从源头不放进库。注意要**先与同步合并语义对齐**（墓碑/字段级 LWW），否则可能误删合法行 |
| **未来时间戳过滤** | P4 | 热力图会出现未来日期格。若认为"补复习"是合法场景则不用改 |

---

## 八、交付物

| 文件 | 变更 |
|---|---|
| `src/repo-core.js` | `computeStats` 统一输入域过滤（时间戳有限性 + rating 域）、覆盖率分子与现存卡求交、新增 `stats.dirtyReviews` |
| `scripts/i18n-js-hardcode-baseline.json` | 行号重锚（**纯位移**：4 行逐条核对 HEAD 零净增，计数 437/28 不变） |
| `tests/round61-boundary.test.mjs` | 新增 6 条边界回归 |
| `tests/round61-algo-invariants.test.mjs` | 新增 4 条算法不变量回归 |

---

*审计完成时间：2026-09-15 | 基线：ee799cb | 测试：1115/1115 pass | 本轮新发现 5（4 P2 + 1 P3，P2 全部已修+回归） | 否证假设 3 | 既有修复零回退*
