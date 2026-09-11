# SxyBrick 深度代码审查报告 — Round 42（交叉多角度）

> **审计日期**：2026-09-11
> **代码基线**：git HEAD `5ae2542`（当前 main 最新）
> **测试状态**：976/976 通过 · ESLint 0 · vite build ✓
> **审查视角**：算法设计 / 业务逻辑 / 数据协同 / 数据建模 / 边界·异常·性能
> **交叉取证文件**：src/sync.js(1274) · src/sync-manifest.js · src/fsrs.js · src/srs.js · src/algorithms/graph-resolve.js · src/algorithms/graphAuto.js · src/repo.js · src/word-repo.js

---

## 一、总评（大白话）

这库**相当成熟**。近 10 轮审计（round32→41）把 sync / 算法 / 图谱的 P0–P2 抓得很干净，代码里到处是"2026-08-xx 修复""roundXX P1 修复"的注释和护栏，工程质量明显是**被反复捶打过的**。

本轮我换了个不被前几轮重点覆盖的角度交叉查（同步**运行时引擎**而非声明清单、FSRS **训练回路**而非仅调度、SM-2/FSRS **双调度器是否打架**、图谱**混存 ID 空间**、引用完整性、字段级合并的**边界**），结论是：

- **没有发现任何新的 P0/P1/P2 阻断性缺陷**；
- 所有历史审计项的修复**逐条代码取证确认已落地**（见第二节）；
- 新发现的问题**全是 P3（轻微 / 理论层）**，不影响数据正确性，可排期优化。

下面第二节先交"修复完整性"的账（你点名要验），第三节给本论新发现。

---

## 二、其他审计项修复完整性核验（round32–41）

| 来源 | 问题 | 代码实证（当前 HEAD） | 结论 |
|---|---|---|---|
| round38 BUG-01 | 字段级平局不收敛 | `sync-manifest.js:465` `JSON.stringify(xr[k]) < JSON.stringify(cur[k])` 严格字典序收敛 | ✅ |
| round38 BUG-02 | imageRefs 死索引 | `db.js` 已删表；`repo.js` 删 `rebuildImageRefs` 及全部 `db.imageRefs` 调用 | ✅ |
| round38 BUG-03 | dashboardSnapshot 缺失效 | `repo.js` `invalidateDashboardCache()` + review/attach/sweep 调用 | ✅ |
| round38 BUG-04 | 墓碑 kind 硬编码 | `sync-manifest.js` `tombKindTable()` 从 SYNC_TABLES 自动派生 | ✅ |
| round38 BUG-05 | 训练拟合惰性维 w18 | `fsrs.js:65` `TRAINABLE_WEIGHT_COUNT=17`，梯度循环只跑 0..16 | ✅ |
| round39/40 NEW-01 | 学习时长同 id 冲突丢失 | `word-repo.js:649` id=`t-${date}-${deviceId}`，deviceId 存 db.meta 不入同步；读取按 date 求和 | ✅ |
| round39/40 NEW-02 | 通知已读不跨端 | `proactive.js:85,93` 读操作 bump updatedAt；`sync-manifest.js` notifications → updatedAt 策略 | ✅ |
| round39/40 NEW-03 | 通知删除不写墓碑 | `proactive.js:64,104,113` 三处删除包事务 + 墓碑 kind='notification' | ✅ |
| round39/40 NEW-04 | 通知语义矛盾 | 决策：全局已读（一处已读处处已读），merge 改 updatedAt | ✅ |
| round32 BUG-01 | graphAuto 边 id 漂移（原"架构级暂缓"） | `graphAuto.js:263-264` 写边已带 `fromCardId/toCardId`；`graph-resolve.js:53-54` 兜底 `cardById.has(e.from)` | ✅ 已闭环 |
| round32 BUG-02 | image 反向索引 | 同 BUG-02，表已删 | ✅ |

**两条"疑似风险"经核实为安全（重要结论）**：

1. **SM-2 / FSRS 双调度器是否冲突？** —— 不冲突。`repo.review()` 经 `scheduleReview(card, …, { scheduler: cfg.scheduler, weights, … })`（`repo.js:920/925`）分发：
   - `scheduler==='fsrs'` → `fsrs.schedule`（消费训练权重算 `dueAt` + `fsrs` 状态）；
   - 否则 → SM-2 `computeNext`。
   - `scheduler` 标记本身随 `schedMeta`（含 scheduler/fsrsWeights/fsrsInfo/pretestStability）跨设备同步（`sync.js` `SCHED_META_KEYS`），所以"开 FSRS"会两端一致继承。SM-2 模式下 `fsrs` 状态只 bump `last` 冻结保留，切换时 `seedFsrsFromSm2` 用 `intervalDays` 反解重建——全程自洽，**没有双份调度互相覆盖**。

2. **时钟偏移是否只动了 updatedAt？** —— 不是，补偿很彻底。`shiftRowClock`（`sync-manifest.js:410-430`）把 `dueAt/reviewedAt/createdAt/wrongReasonAt/selfExplainAt/fieldTs` 等**全部时间戳字段**一并换算到本机帧再比较，不存在"部分字段跨帧"导致 LWW 误判。

---

## 三、本论新发现（均为 P3，按多角度归类）

### 算法设计

**F1 [P3] FSRS 训练首测评分退化（两路径不一致）**
- 位置：`fsrs.js:279`（`init` 分支）vs `:284`（`seed` 分支），同在 `lossOf` 内。
- 现象：`lossOf` 对"无历史 fsrs 的卡"（`init` 路径）设 `last = revs[0].reviewedAt`、`reps=1`，于是 j=0 进入 `if (reps>0)` 计分块 → `elapsed = reviewedAt - last = 0` → `R = (1+0)^-1 = 1`（**恒为 1，与 S0 无关**）。而"带种子态"的 `seed` 路径 `reps=0` 明确**跳过**首测计分。两条路径口径不一致。
- 根因：首测按"刚学完"建模本应 R=1，但模型无法从首测学到 S0 校准信号——首测永远预测"必记住"，若用户首测就忘（y=0）会贡献 `log(1e-6)≈13.8` 的巨量 loss，轻微拉偏权重。
- 影响：**有界、无 NaN、不崩**（p 已被 `clamp(1e-6, 1-1e-6)` 兜住）。仅轻微拖慢个性化收敛速度；首测多半是"记住了"（y=1，loss≈0），实际偏置很小。
- 建议：`init` 路径首测也按 `seed` 口径跳过计分（`reps=0` 分支），或首测用"真实间隔"而非 0。约 3 行改动。

**F2 [P3] 复习间隔 `nextInterval` 用 `Math.random()` 抖动 → 排程短期不可复现**
- 位置：`fsrs.js:151` `fuzz = 1 + (Math.random()-0.5)*2*w[17]`。
- 现象：训练路径已 `w[17]=0` 消噪（`fsrs.js:243`），但**实时调度 / forecast** 每次调用间隔差 ±20%，同一卡同一评分两次排程可能不同。
- 影响：设计权衡（避免同日堆积），非 bug；但预测/回放场景不可复现。
- 建议：如需确定性，给 `nextInterval` 注入可选 `rng` 种子（forecast 已用 `noFuzzWeights`，实时路径可同理）。非紧急。

### 业务逻辑

**F3 [P3] 卡片字段级合并对"未登记 fieldTs 的本地独有字段"存在丢失风险** ⭐（本论最实在一处）
- 位置：`sync-manifest.js:250` `mergeCardPair` 的 `out = {...content}`（content = 按 updatedAt 胜出的**一端**整行），`sync.js:855` `sameShape` 快速判定。
- 现象：合并时 `out` 以"胜出方整行"为基底，再逐字段（`CARD_CONTENT_FIELDS` ∪ 两端 `fieldTs` 键）覆盖。若本地卡有一个**不在** `CARD_CONTENT_FIELDS`、也**从未 bump `fieldTs`**、且**不在 `CARD_SRS_FIELDS`** 的字段 F，且本论"内容赢家"是对端（对端 updatedAt 更新、且对端没有 F），则 F 不会进 `out`；`sync.js` 的 `sameShape` 判定（old 键数 ≠ row 键数）为假 → 直接写 `row` → **F 在对端"赢"的合并中丢失**。
- 触发条件（较苛刻）：未来给卡片加了"非标准扩展字段"但没登记进 `CARD_CONTENT_FIELDS`、也没随写 bump `fieldTs`，且发生"对端同卡更新时间更新"的并发冲突。当前所有业务字段均已登记，**现有功能不可触发**；是给未来扩展埋的雷。
- 对比：`notes/memos/docs` 走 `mergeByFieldTs`，其基底是 `cur`（本地），天然保留本地独有字段——**只有卡片策略有此问题**，因为卡片基底是"胜出方"而非本地。
- 建议（约 5 行）：`mergeCardPair` 末位补一步"本地独有字段保留"——`for (const k of Object.keys(local)) if (!(k in out) && k!=='id') out[k]=local[k];`，或在新增扩展字段时一律 bump `fieldTs[f]`。

### 数据协同

**F4 [P3] 单模块同步"减包"收益被 hub 全量回传抵消（非缺陷，提醒）**
- 位置：`sync.js:567` `syncWithHub` + hub 返回全量包 → `importBackup` 整体合并。
- 现象：单表同步只推进该表水位（`advanceWatermark` 单表分支），上传只带该表增量；但中枢返回**全量合并包**，客户端仍整体合并其余表。M5 注释已说明此权衡。逻辑正确，只是"单模块同步省流量"在 hub 通道上不彻底。
- 建议：hub 端支持按 `since` 增量回传才能真正减包（架构增强，非本端 bug）。

**F5 [P3] clockSkew 为单请求一次性估计、不持久化（已知排期项）**
- 位置：`sync.js:649` `clockSkew = _serverTs - _reqStart`，仅本轮 import 用。
- 现象：跨设备大时钟差时，首轮同步的 skew 估计只基于一次 `Date` 头；若两端长期不同时钟，需多轮收敛。`round41` 已记为排期优化（持久化渐进校准）。非缺陷。

### 数据建模

**F6 [P3] wordStudyLog deviceId 生成并发竞态（已知，极低概率）**
- 位置：`word-repo.js:649` `localDeviceId()` 模块级缓存 `_deviceIdCache`。
- 现象：两个 `recordWordStudyTime` 并发首次调用可能都走 miss 各自生成不同 deviceId 并写两行；`db.meta.put` 幂等（后写覆盖），但可能短暂出现"同设备两行"。后果仅"同设备多一行"，`wordStudyTimeToday` 按 date 求和无影响。
- 影响：可忽略。`round41` 已记录在案。

### 边界 / 异常 / 性能

**F7 [P3] importBackup 非大表仍全表 `toArray` 进内存**
- 位置：`sync.js:841` `const base = await db[t.table].toArray()`（仅 `userOps`/`embeddings` 走了 `bulkGet` 优化，`:833`）。
- 现象：万级 `notes`/`docs`/`reviews` 同步时，主线程把整表读进内存再 `mergeRows`。功能正确，大库导入有卡顿感。
- 建议：后续对"只读不改"的表可改用游标/分批；非紧急。

**F8 [P3] 超长同毫秒并发文档的 JSON.stringify 开销**
- 位置：`sync.js:856` `JSON.stringify(old) !== JSON.stringify(row)`。
- 现象：round38 已把平局分支的串化结果缓存复用（`sync-manifest.js:553-554`），仅"键数相同但内容不同"的极端场景（万字段文档 + 同毫秒并发编辑）才整串比较。概率极低，纯性能。
- 建议：未来可对长文本先比长度/哈希再全串；非紧急。

---

## 四、结论

1. **当前代码库：成熟、稳定，无可阻断 P0/P1/P2 缺陷。** 近 10 轮审计的修复 100% 完整（第二节已逐条代码取证）。
2. **本论交叉审查新发现均为 P3**：F1（训练首测评分口径）、F2（间隔随机不可复现）、F3（卡片未登记字段合并丢失⭐）、F4/F5（协同权衡与已知排期项）、F6（已知并发竞态）、F7/F8（性能非紧急）。
3. **最值得修的是 F3**：它是唯一"未来扩展可能真丢字段"的隐患，且修复成本极低（约 5 行 + 1 测试）。F1 次之（训练质量微调）。

---

## 五、是否要我修

以上全部为 P3，**不紧急、不影响当前正确性**。若你愿意，我可以一次性修 **F1 + F3**（约 15 行改动 + 2 个回归测试），其余保持观察。

- F1：`fsrs.js` `lossOf` init 路径首测跳过计分（与 seed 口径一致）。
- F3：`sync-manifest.js` `mergeCardPair` 末位保留本地独有字段（防未来扩展字段在跨设备冲突合并中丢失）。

要我动手就说一声；不动的话，本报告即本次审查交付。
