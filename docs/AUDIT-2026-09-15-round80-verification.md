# round80 审计的独立验证与修复（不是复核结论，是用可执行复现重新定级）

> 用户要求：「去验证是否真实有效，有没有修的必要性」。
> 方法：**不看他们的结论表，先自己读代码 + 写复现脚本跑一遍**，再定级。脚本已删（结论固化进测试）。

---

## 一、最重要的更正：A1 的 **P1 定级不成立**

他们的原话是：「小样本给出高置信度校准结论……**直接驱动调度策略（下调目标保持率→减少复习量）**」。

**我的复现结果**（`calibrationStats` n=2 的结论 → 反馈链）：

| 步骤 | 实测结果 |
| --- | --- |
| `calibrationStats(2 条)` | ✅ 确实产出结论：`verdict='预测偏乐观（高估记忆）'`、`note='…应上调目标保持率，让复习更频繁'` |
| `calibrateFromStats(0.9, 该结论)` | **0.9 —— 原样返回，没有改**（被 `DEFAULT_MIN_SAMPLES=50` 挡住） |
| 边界 n=49 / n=50 | 49 → 0.9（挡住）；50 → 0.95（才允许反馈） |
| 唯一把 bias 接到调度的桥 | `analytics.getSubjectRetentionMap()` → **它调的就是 `calibrateFromStats`**（带门槛）→ `Review.vue` 把它作为 `desiredRetention` 传进 `review()` |

**结论**：`bias → 目标保持率 → 复习间隔` 这条链**本来就有 50 样本门槛**，n=2 时不会改变任何一张卡的间隔。
他们说的「只保护了一个消费端」不准确——**生产端到调度的唯一出口就是那个被保护的消费端**。

**真实影响**（仍然值得修，但级别是 P2）：`verdict/note` 会出现在
**① Stats 页**（`views/stats.calibVerdict '{verdict} —— {note}'`）、**② AI 工具**（`tools/index.js` 把 verdict/note 交给模型）。
所以用户/AI 会看到「预测偏乐观…应上调目标保持率」这种**2 个样本推出来的处方**。

**修法**（不删数字、只拦结论）：新增 `MIN_STATS_SAMPLES = 20`；`n < 20` 时 `verdict='样本不足'`、
`note` 改成「样本太少（N 条，建议 ≥20 条再校准）：偏差只能当参考」，并新增 `reliable` 字段；`n/brier/ece/bias` 照给。
> 顺带说明为什么门槛是 20 而不是 50：20 是「给方向性结论」的下限，50 是「允许自动改调度」的下限，两者刻意不同。
> 现有测试用的都是 n=100，**加门槛不破坏任何既有断言**（已实测）。

---

## 二、其余 4 条：全部复现成立

### A2（rating 缺失当「遗忘」）—— 成立，且真实入口可达
- 代码事实：`const actual = r.rating > 0 ? 1 : 0` → `undefined/null/NaN` 全落 0；
- 入口拦截检查：`computeCalibration` 只过滤 `type !== 'quick'`，**不校验 rating** → 复现成功
  （2 条记录里 1 条缺 rating → `n=1, bias=1`，相当于"预测 0.9，实际全忘"）。
- **修法**：`rating` 不在域 `{0,1,2}` 的行**整行剔除**（不猜、不计入 n）。**为什么不能只从 bias 剔除**：
  Brier/ECE 同样需要 actual，混着算会让三个指标口径不一致。注意 `rating=0` 是合法值（falsy 陷阱），
  故用域判断而不是 `!(r.rating)`——测试里专门钉了这条。

### A3（1 条记录就输出「黄金时段」）—— 成立，且**会显示在 Stats 页**
- 复现：`h[3]=1` → `label='你通常在 3:00 复习最集中，建议把复习安排在 1:00–4:00 黄金时段'`；
- 消费点核实：`Stats.vue:41` `goldenHint = goldenHours(stats.hourly).label` → **确实渲染给用户**。
- **修法**：新增 `MIN_HOURS_SAMPLES = 10`；不足时 `label` 降级为「复习记录还太少（N 条，建议 ≥10 条）…」，
  `peakHour/bestWindow` 数字保留，新增 `reliable`。

### A4（`attributeMistakes(undefined)` 崩）—— 成立，守卫写错
- 原代码：`if (!cards || cards.length < 2) { return cards.map(...) }` → `!cards` 成立后仍 `cards.map` → **TypeError**；
- 复现：`undefined` / `null` 都抛 `Cannot read properties of ... (reading 'map')`；
- 消费点：工具层两处 `attributeMistakes(cards|pool)`（异常路径可能给到空值）。
- **修法**：先归一成数组再判断（非数组 → `[]`，不抛错）。

### A5（缺 front → 概念名 "undefined"）—— 成立，会喂给 AI/用户
- 复现：两张缺 `front` 的卡 → `concept: "undefined"`（`representative` 尚可）；
- 原代码：`tokenize(\`${card.front} …\`)` 缺守卫（而同一行的 `card.tags` 有 `|| []` 守卫——典型漏一个）；
- **修法**：`card?.front || ''`。

---

## 三、修复与闸门

| 项 | 文件 | 改动 |
| --- | --- | --- |
| A1 | `algorithms/calibration.js` | `MIN_STATS_SAMPLES=20` + `reliable` 字段 + 不足时不给定论与处方 |
| A2 | 同上 | `rating` 域校验（非法行整行剔除，`rating=0` 保留） |
| A3 | `algorithms/golden-hours.js` | `MIN_HOURS_SAMPLES=10` + 文案降级 + `reliable` |
| A4 | `algorithms/mistakeAttribution.js` | 入参归一（非数组 → `[]`，不崩） |
| A5 | 同上 | `card?.front \|\| ''` + `c?.subject` 守卫 |

**新闸门** `tests/round80-algo-guards.test.mjs`（7 条）——把「独立复现」固化成回归：
A1 小样本无定论 / **A1-b 反馈链 50 门槛**（含 n=49 挡住、n=50 才放行——这条直接钉住"P1 不成立"的判据）/
A2 脏 rating 剔除且 `rating=0` 仍算遗忘 / A3 一条记录不给作息建议 / A4 非数组不崩 / A5 无 "undefined" 概念名。

```
npm test            → 1255 passed / 0 failed   （1248 + 新增 7）
build + check:build → 通过（52 分词库分片）
eslint              → 0 error / 0 warning
i18n 三闸           → 通过（数据层 310 行；基线净增 1 行，已核为位移非新文案：
                       旧 `cards.map(…'未分类'…)` 行被改写、`'样本不足'` 复用既有词）
```

---

## 四、对他们报告的其它意见（不改，仅记录）

1. **A1 的定级建议改为 P2**，理由见 §一。定级偏高的代价是修错了地方（去动反馈链门槛，而那里本来是对的）；
   真正的缺口在**展示层**（Stats 页与 AI 工具直接照搬 verdict/note）。
2. A6~A13（8 条 P3）我抽看后**同意其存在**，但都属于「口径细节 / 极端脏数据」：`threshold=NaN`、
   单卡簇 score 口径、`Number(x) || 0.9` 吞显式 0、`peak.date=''` 空渲染等。
   建议**清单式收口**（一轮把 `Number(x) || 默认值` 全仓换成 `??`），不必逐条开单。
3. 他们没有覆盖的一点（我顺手核过）：`calibrationStats` 的 `reliable` 与
   `calibration-feedback.DEFAULT_MIN_SAMPLES` 现在是**两个独立门槛**，将来若有人把其中一个调小、
   另一个没跟上，就会出现「结论可信但反馈不生效」或反之。已在两处注释里写明二者分工（20 给结论 / 50 给调度）。
