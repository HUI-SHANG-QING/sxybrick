# SxyBrick 深度代码审计报告 — Round 43

> **审计日期**：2026-09-14
> **代码基线**：git HEAD `a610a83`（13 模式无数据真根因 / 工具结果超长 / 全屏主题化 / 图片旋转 / 策略入口）
> **测试状态**：1068/1068 全部通过，耗时 ~52s
> **审查视角**：FSRS 训练回路边界 / 同步墓碑口径一致性 / 图片生命周期（GC·备份·占位符）/ AI 链路记账与富集边界 / 前端泄漏
> **交叉取证文件**：src/fsrs.js · src/sync-manifest.js · src/sync.js · src/repo.js · src/word-repo.js · src/agent/analytics.js · src/agent/analytics.worker.js · src/agent/llm.js · src/services/image-analysis.js · src/utils/ai-usage.js · src/images.js
> **上轮报告**：`docs/AUDIT-2026-09-11-round42-deep.md`

---

## 一、总评（大白话）

这库依旧**相当成熟**。round32→42 把同步墓碑、FSRS 调度、图谱 ID 空间的 P0–P2 抓得很干净，代码里到处是"roundXX P1 修复""审计 C5"的注释与护栏。本轮我换了前几轮没重点盯的角度：**FSRS 训练回路的空轨迹边界**、**图片"GC 扫描口径 vs 资产统计口径"是否一致**、**AI 链路在记账/富集上的边界**、**前端定时器/监听器泄漏**。

结论：

- **没有发现新的 P0/P1 阻断性缺陷**；
- **发现 1 个 P2**（`trainWeights` 空轨迹崩溃，已用可运行测试坐实）+ **5 个 P3**；
- 上轮 round42 指出的 **F1 / F3 两处已逐行取证确认落地且正确**（F1 的修法本身牵出 N1，见下）。

下面第二节先交"上轮修复完整性"的账，第三节给本轮新发现。

---

## 二、上轮（round42）缺陷修复状态核验

| 上轮编号 | 问题 | 代码实证（当前 HEAD `a610a83`） | 结论 |
|---|---|---|---|
| round42 F1 | FSRS 训练首测评分口径不一致 | `fsrs.js:279-282`：`init` 分支改走 `reps=0`（`initStability(revs[0].grade)`），与 seed 分支对齐，注释明确标注 round42 F1 | ✅ 已落地（但牵出 N1，见第三节） |
| round42 F2 | `nextInterval` 用 `Math.random()` 抖动不可复现 | `fsrs.js` 训练路径 `w[17]=0` 消噪（`:243-244`）；forecast 用 `noFuzzWeights`。实时调度保留抖动 | ✅ 设计权衡，已知 P3，保持 |
| round42 F3 | 卡片字段级合并丢"未登记本地独有字段" | `sync-manifest.js:353-361`：`mergeCardPair` 末位补 `for (const k of Object.keys(local)) if (k!=='id' && !(k in out)) out[k]=local[k]`，注释标注 round42 F3 | ✅ 已落地，逻辑正确（不覆盖已合并字段，仅补本地独有键） |
| round42 F4 | 单模块同步减包被 hub 全量回传抵消 | hub 全量包 + 客户端整体合并（架构权衡） | ✅ 已知 P3，保持 |
| round42 F5 | clockSkew 单次估计不持久化 | `sync.js` skew 仅本轮用 | ✅ 已知排期项，保持 |
| round42 F6 | wordStudyLog deviceId 并发竞态 | `word-repo.js:652-663`：`_deviceIdCache` 模块缓存 + `db.meta` 持久化；并发 miss 极小概率多一行 | ✅ 已知 P3，影响可忽略 |
| round42 F7 | importBackup 非大表仍全表 `toArray` | `sync.js:1207` `db[t.table].toArray()`（仅 userOps/embeddings 走 `bulkGet`） | ✅ 已知 P3，保持 |
| round42 F8 | 超长同毫秒并发文档 JSON.stringify 开销 | `sync.js:856` 平局分支已缓存串化结果 | ✅ 已知 P3，保持 |

**修复质量评价**：F3 的兜底写得很克制——`!(k in out)` 保证绝不覆盖字段级合并已决定的值，只把"本地有、结果里没有"的键补回来，同时让 `out` 键集更贴近本地，提升 `sameShape` 命中率。F1 把 init 分支的 `reps` 从 1 改 0、首测不计分，与 seed 路径完全对齐，方向正确。

**重要衔接**：F1 的修法（`fsrs.js:282`）依赖 `revs[0]` 存在。这个依赖在 F1 之前同样存在（旧代码是 `revs[0].reviewedAt`），所以**空轨迹崩溃不是 F1 引入的回归，而是 F1 之前就缺的长度守卫**——本轮在第三节 N1 给出可运行复现。

---

## 三、本轮新发现

### ⭐ N1 [P2] FSRS 训练 `trainWeights` 对"空轨迹卡"抛 TypeError（已用可运行测试坐实）

- **位置**：`fsrs.js:262-272`（构建 `cardTrajectories` 不做 `revs.length` 守卫）+ `:282`（`initStability(revs[0].grade, …)` 直接取 `revs[0]`）。
- **现象（可运行复现，已执行）**：
  ```js
  // c1 新卡（无 fsrs 历史 → init=null），其唯一一条复习是 quick 或 reviewedAt 非有限
  // 被 :269 的过滤器滤空；c2 老卡补足 ≥8 条越过 :248 的早退门槛
  trainWeights(reviews, cardsById, { iters: 3 })
  // → TypeError: Cannot read properties of undefined (reading 'grade')
  //   at lossOf (src/fsrs.js:282:29)
  ```
  对照组（同卡有一条有效复习）正常返回 loss，证明触发条件精确为"`init=null` 且 `revs=[]`"。
- **生产可达性（已核实两条调用链）**：
  - worker 链：`App.vue:300 trainFsrsModel()` → `analytics.js:190 offload('trainFsrs')` → `analytics.worker.js:24-27` `prepareFsrsTrainingData()` → `trainWeights`；
  - inline 兜底链：`analytics.js:189-194` 同路径。
  两条链都走 `prepareFsrsTrainingData`（`analytics.js:180-187`）——它**只过滤 `type==='quick'` 的复习行，不剔除"过滤后轨迹为空的卡"**（`cardsById` 仍含该卡）。
- **数据前提（已核实）**：`review()` 正常写入 `reviewedAt: nowTs`（`repo.js:996`，恒有限）；但 `fsrs.js:265-266` 的注释明确承认库中**可能存在 reviewedAt 缺失/NaN 的复习行**（正是 :269 `Number.isFinite` 自保过滤的动机）。因此：只要某张**无 fsrs 历史的新卡**的全部复习行都是 `quick` 类型或 reviewedAt 脏值，且全库有效复习 ≥8，训练即崩。触发条件不苛刻（quick 检测 + 新卡并存是常态），但需要 ≥8 条有效样本垫底——属于**偶发但真实的 P2**。
- **影响**：训练抛错 → `offload` 的 Promise reject → `trainFsrsModel` 的调用方（`App.vue:298-300` 有 try/catch，弹 toast 降级）不会白屏，但**本轮个性化训练静默失败**，且 worker 链的 reject 是否会落回 inline 兜底取决于 `offload` 实现（`analytics.js:40+` 的 reject 路径未回退 `_FALLBACK`）——即 worker 存在时**连兜底都没有**，直接失败。
- **建议（约 4 行 + 1 回归测试）**：`fsrs.js:271` push 前加 `if (!sorted.length) continue;`（或 push 后 `cardTrajectories = cardTrajectories.filter(t => t.reviews.length)`）；`lossOf` 的 `init=null` 分支再补 `if (!revs.length) continue;` 双保险。回归测试：构造"1 张全 quick 的新卡 + 9 条有效复习"断言不抛且 samples=9。

### N2 [P3] 图片孤儿 GC 的"扫描口径"与"资产统计口径"不一致（docFiles/aiChats/plans 未纳入 GC 扫描）

- **位置**：`repo.js:626-633`（`cleanupOrphanImages`）与 `:647-654`（`findOrphanImages`）——两函数都**只扫 6 张表**：`cards/wordCards/notes/docs/memos/mindmaps`；而 `image-analysis.js:171-179`（`statImageAssets`）的资产统计**扫 4 张表**：`cards/notes/memos/docFiles`（含 `r.content`）。
- **现象**：`docFiles`（资料库文件的文字摘录/解析文本）正文若含 `sxy-img://` 占位符，GC 不认为该图"在用"→ 删卡/删笔记后可能把**仍被资料文件引用的图**当孤儿删掉。备份侧 `sync.js:95-99` 的 `collectPackImageIds` 注释自称"与本地 GC 扫 6 表口径对齐"，同样不含 docFiles。
- **当前影响评估**：已核实 `statImageAssets` 主动扫 `docFiles.content`，说明设计上承认 docFiles 正文**可以**含占位符（资料解析/用户粘贴）；但目前无 UI 路径把 `sxy-img://` 写进 docFiles 正文（图片进资料库走 `sxy-doc://` 独立协议，`tools/index.js:976-979`）。所以这是**口径漂移的定时炸弹**：哪天资料解析开始内嵌卡片图占位符，GC 就开始误删图。
- **建议**：把 `db.docFiles.toArray()`（+ 保险起见 `db.aiChats`）加进 `cleanupOrphanImages`/`findOrphanImages` 的 6 表清单，并与 `collectPackImageIds`、`statImageAssets` 三处统一成一张"图片引用表清单"常量，避免四处各写一份。约 6 行。

### N3 [P3] `sweepOrphanRows` 清孤儿复习行不写墓碑（与 deleteCard 的墓碑纪律不对称）

- **位置**：`repo.js:676-679`：`delReviews`/`delWord` 直接 `bulkDelete`，**不写** `kind='review'`/`'wordReview'` 墓碑。
- **对比**：`deleteCard` 删复习**写墓碑**（`repo.js:555-561`，round16 R16-1 注释明说"物理删行不写墓碑 → 对端残留 review 行随增量包反复回传"）；导入侧 wordCard 级联删**也写墓碑**（`sync.js:972-988`，round34 P2-5）。
- **现状评估**：`sweepOrphanRows` 是 fire-and-forget 兜底（`sync.js:1083-1088`），只在"父卡墓碑已应用、孤儿行本地残留"时清本地——**正常多设备流程里这些行应由墓碑机制在对端先删**，走到 sweep 的孤儿是"对端也没墓碑"的边缘残留（老包/bridge 通道）。此时 sweep 清完本地后，若对端旧行仍在且无墓碑，下次同步可能回灌一次——与 round34 P2-5 描述的"幽灵复习复活"同源。
- **建议**：sweep 删除前同样 `bulkPut` 墓碑（`kind` 按表取 `review`/`wordReview`），与源端删除纪律对齐。约 6 行 + 1 测试。

### N4 [P3] `estimateTokens` 对多模态数组 content 静默失真 → AI 用量账本 token/费用偏低

- **位置**：`utils/ai-usage.js:24-30`：`String(text || '')` 把对象/数组强转（数组 `['a','b']` → `'a,b'` 还行，但 `[{type:'text'...},{type:'image_url'...}]` → `'[object Object],[object Object]'`）。调用点 `llm.js:32`：`messages.reduce((n,m) => n + estimateTokens(m?.content ?? ''), 0)`。
- **触发条件**：`usage` 缺失（OpenAI 兼容端点常不带 `usage`）且末条消息 content 是**多模态数组**（`enrichForLlm` 恰好会把末条 user 的 content 变成数组，`image-analysis.js:503-507`）。
- **影响**：promptTokens 估算几乎为 0 → `aiUsage` 账本 token/费用偏低；仅影响统计展示，不影响功能。
- **建议**：`estimateTokens` 开头加 `if (Array.isArray(text)) text = text.map(p => p?.text || (p?.type==='image_url' ? '【image】' : '')).join(' ')`；或 `llm.js:32` 处先把数组展平为 text 再估算。约 4 行。

### N5 [P3] `enrichForLlm` OCR 路径逐图 30s 超时、无总预算（多图标卡/多图会话可叠加到分钟级）

- **位置**：`image-analysis.js:390-411`：`for (const id of ids)` 每张图 `AbortSignal.timeout(30000)` 逐张 OCR，**没有**"最多 OCR N 张"的总量护栏（vision 发送有 `visionLimit` 上限，OCR 文字化没有）。
- **触发条件**：一条消息正文含大量 `sxy-img://` 占位符（如 AI 回显了带图卡片上下文、RAG 拼了多张带图卡）+ OCR 端点慢/挂。
- **影响**：`chat()` 是所有 AI 链路唯一出口（`llm.js:12`），此路径卡住会拖慢所有 AI 调用；无崩溃（单张有超时），但无上限。
- **建议**：OCR 循环加 `OCR_TEXT_LIMIT`（如 8 张，超出的替换为"未识别（超出本次上限）"），与 vision 的 `visionLimit` 对称。约 5 行。

### N6 [P3] `localDeviceId()` 并发首写竞态可产生同设备多行（已知，影响可忽略，仅确认未回退）

- **位置**：`word-repo.js:652-663`：`_deviceIdCache` miss 时 `uid().slice(0,12)` → `db.meta.put`。两个并发 `recordWordStudyTime` 首次调用可能各自生成不同 id 写两行。
- **确认**：与 round41 描述一致，`db.meta.put` 幂等收敛、读取按 date 全行求和（`word-repo.js:644-647` 注释），**统计不虚增不丢失**，仅同设备可能多一行历史。无回退。
- **建议**：维持现状即可（若要彻底消掉，可在模块加载时一次性 await 初始化 deviceId）。

---

## 四、优先级汇总

| 编号 | 优先级 | 位置 | 说明 | 建议成本 |
|---|---|---|---|---|
| **N1** | **P2** | `fsrs.js:262-272,282` | `trainWeights` 空轨迹卡 → TypeError，worker 链无兜底，个性化训练偶发失败（已可运行复现） | ~4 行 + 1 测试 |
| N2 | P3 | `repo.js:626-654` vs `image-analysis.js:171-179` | 图片 GC 扫描 6 表漏 docFiles/aiChats，与资产统计口径漂移（当前无实害，属定时炸弹） | ~6 行 |
| N3 | P3 | `repo.js:676-679` | `sweepOrphanRows` 删孤儿复习不写墓碑，与 deleteCard/导入侧级联的墓碑纪律不对称 | ~6 行 + 1 测试 |
| N4 | P3 | `ai-usage.js:24-30` + `llm.js:32` | 多模态数组 content 被 `String()` 强转 → token/费用账本失真 | ~4 行 |
| N5 | P3 | `image-analysis.js:390-411` | OCR 逐图 30s 无总量上限，多图消息可叠加到分钟级拖慢全部 AI 链路 | ~5 行 |
| N6 | P3 | `word-repo.js:652-663` | deviceId 并发首写竞态（已知，影响可忽略，确认未回退） | 维持 |

---

## 五、审计结论

1. **代码库依旧成熟稳定**：round42 的 F1/F3 修复逐行取证确认落地且正确；1068/1068 测试全绿。
2. **本轮唯一 P2 是 N1**（FSRS 训练空轨迹崩溃）——触发条件不苛刻（新卡 + quick 检测并存 + ≥8 条有效样本），且 worker 链失败时无 inline 兜底，建议优先修。
3. **N2/N3 是"口径一致性"类隐患**（图片 GC 漏表、sweep 不写墓碑）——当前无实害，但都是"某条新链路接通后突然变实害"的雷，修复成本极低，建议与 N1 一批处理。
4. **N4/N5 是 AI 链路的记账与性能边界**——不影响正确性，排期即可。

### 建议修复批次

- **本批（~20 行 + 2 测试）**：N1 + N3（同属"边界守卫 + 墓碑纪律"，一个 PR）。
- **次批（~11 行）**：N2 + N4 + N5（口径统一 + 记账修正 + 总量护栏）。

---

*审计完成时间：2026-09-14 | 审计基线：a610a83 | 测试：1068/1068 pass | N1 已用 node --test 环境可运行复现*
