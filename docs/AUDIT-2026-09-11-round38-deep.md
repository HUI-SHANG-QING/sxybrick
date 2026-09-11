# SxyBrick 深度代码审计报告 — Round 38

> **审计日期**：2026-09-11
> **代码基线**：git HEAD `189c0e8`（自 round32 基线 `e0a4b81` 起 22 次提交，102 文件变更，+2804/-689 行）
> **测试状态**：970/970 全部通过（较 round32 的 800 增加 170 用例），耗时 ~45.6s
> **审计维度**：算法正确性/复杂度/边界 · 业务逻辑规则一致性/异常路径/隐含假设 · 数据协同模块流转/状态同步/一致性风险 · 数据对象结构合理性/字段冗余缺失/模型耦合
> **上轮报告**：`docs/AUDIT-2026-09-04-round32-deep.md`

---

## 一、本轮迭代修复确认（round33~37）

本轮迭代是一次**大规模系统性修复**，覆盖了上轮审计的绝大多数发现。以下按维度归类确认：

### 1.1 算法层修复

| 上轮发现 | 修复状态 | 修复位置 |
|---|---|---|
| FSRS w15/w16 方向反向 | ✅ 已修复（round34 M12/M13） | `fsrs.js:120,127` D 钳制 [1,10] + easyBonus ≥1 结构护栏 |
| trainWeights fuzz 噪声致不收敛 | ✅ 已修复（A-2） | `fsrs.js:239-240,344` 训练期 w[17]=0 消噪，返回时恢复 |
| trainWeights 梯度发散 | ✅ 已修复（round33 B-2） | `fsrs.js:328` 梯度步双界 [0.01,100] |
| trainWeights 首步不降即 break | ✅ 已修复（round19 R19-5） | `fsrs.js:338-341` 学习率衰减 + plateau 耐心 |
| trainWeights 乱序输入 loss 失真 | ✅ 已修复（round30） | `fsrs.js:257` 每条复习按 reviewedAt 升序自保排序 |
| schedule() 用 `\|\|` 误替换 desiredRetention=0 | ✅ 已修复（H-1） | `fsrs.js:167` 改用 `??` |
| calibration DEFAULT_WEIGHTS 缺失 import | ✅ 已修复 | calibration.js 引用修正 |

### 1.2 业务逻辑层修复

| 上轮发现 | 修复状态 | 修复位置 |
|---|---|---|
| 错因 wrongReason 跨设备清空被顶回 | ✅ 已修复（round34 M1） | `sync-manifest.js:289-302` 清除语义胜出逻辑 |
| extFields 并集保护致清空不生效 | ⚠️ 部分修复 | modeQuestions 已加键级合并（P2-4）；其余 extFields 仍为并集保护（设计取舍，AI 生成字段不应被清空） |
| wordCards kind 改动不 bump fieldTs | ✅ 已修复（P2-3/P2-4） | `word-repo.js:225-230,199` create/update 均登记 kind |
| 单词侧 guessed 硬编码 false | ✅ 已修复（P1-1） | `word-repo.js:71` 透传 `!!opts.guessed` |
| 单词侧前测冷启动漏传 initialStability | ✅ 已修复（P2-1） | `word-repo.js:63-70` 读取 pretestStability meta |
| 回收站恢复后被墓碑二次删除 | ✅ 已修复（P1-2 round36） | `repo.js:392,402,421` links/cwLinks/tasks 恢复时 bump updatedAt |
| 回收站 _textLen 死代码 | ✅ 已修复（P3 round37） | `repo.js:347,410` 删除前取出 savedTextLen |
| RAG 向量重建在事务内触发 TransactionInactiveError | ✅ 已修复（F-3+D-8） | `repo.js:436-451` 移到事务提交后，卡片恢复也触发 indexCard |
| 资料型边 docId 匹配不到致幽灵边 | ✅ 已修复（A-1） | `repo.js:1763` 补 filter 全表兜住 docId |
| LLM 外部 signal 丢弃超时兜底 | ✅ 已修复（P2-5） | `agent/llm.js:52-57` AbortSignal.any 双信号 AND |
| SSE 流异常退出不释放 reader | ✅ 已修复 | `agent/llm.js:84-107` finally { reader.cancel() } |
| Agent 记忆注入无上限撑爆上下文 | ✅ 已修复（S-1） | `agent/memory.js:45-83` 条数/长度/总量三重上界 |
| 寒暄也付全量上下文成本 | ✅ 已修复（P2-10） | `agent/orchestrator.js:51-67,101-105` needsFullContext 启发式 |

### 1.3 数据协同层修复

| 上轮发现 | 修复状态 | 修复位置 |
|---|---|---|
| 单模块同步推进全局水位致永久漏传 | ✅ 已修复 | `sync.js:503-540` 全局+每表独立水位拆分 |
| 多同步入口并发互污染 | ✅ 已修复（P2-5 round33） | `sync.js:547-565` _hubSyncInFlight 互斥锁 |
| 时钟偏移仅 mergeRows 生效，meta 分支遗漏 | ✅ 已修复（round37） | `sync.js:985,994,1006,1021` goal/examMeta/schedMeta 均减 skew |
| 调度配置四 key 不随同步走 | ✅ 已修复（P2-5 round37） | `sync.js:78-92,134,189,310-316,1016-1027` 全链路打通 |
| 考试日期 examAt 不随同步走 | ✅ 已修复（round35） | `sync.js:131-132,186-187,300-308,1003-1013` |
| 快照回滚污染 updatedAt 时间戳 | ✅ 已修复（P3 round37） | `sync.js:216-220,290-316` 存整行（值+原时间戳） |
| 词卡墓碑级联只删不记墓碑 | ✅ 已修复（P2-5 round34） | `sync.js:955-967` 补 wordReview/wordGroupLink/cardWordLink 墓碑 |
| 去重引用字段枚举易漏 | ✅ 已修复（BUG-04） | `sync-dedup.js` remapCardRefs 集中化 + 正文 wikilink 重定向（H2） |
| 墓碑表无限膨胀 | ✅ 已修复（M3 round34） | `repo.js:751-795` pruneTombstones 30天 TTL GC |
| hub 读失败误判文件损坏致清零 | ✅ 已修复（P1-1 round34） | `hub.js` 瞬态 IO 重试 + 二次确认才 recoverCorrupt |
| hub 同步 writeFileSync 阻塞事件循环 | ✅ 已修复（P4 round33） | `hub.js` fs/promises 异步原子写 |
| hub 半关闭连接致 promise 永不 settle | ✅ 已修复（P2-1 round36） | `hub.js` req.on('close') 兜底 + settled 标志 |
| hub test scope 隔离失效（无扩展名路径） | ✅ 已修复（P2-1 round34） | `hub.js` 去任意扩展名后拼接 |

### 1.4 数据对象层修复

| 上轮发现 | 修复状态 | 修复位置 |
|---|---|---|
| fieldTs 仅 cards 有，自由文本表整行 LWW 丢改 | ✅ 已修复（H1 round34） | notes/memos/plans/mindmaps 的 create/update 均维护 fieldTs，mergeRows 新增 mergeByFieldTs 分支 |
| BACKUP_VERSION 未随 schema 演进 bump | ✅ 已修复（M10 round34） | `sync-manifest.js:10` 7→8，导入侧拒绝过高版本 |
| wordSyllabusMeta idOnly 致元信息永不更新 | ✅ 已修复 | 改 updatedAt 策略 + `word-repo.js:520` saveSyllabusMetaRow 带 updatedAt |
| aiChats 整行 LWW 丢对端独有消息 | ✅ 已修复 | 改 chat 策略 + mergeChatPair 消息并集 |
| imageRefs 反向索引表缺失 | ✅ 已新增（v32） | `db.js:325-331`，但见 BUG-02 |
| cardWordLinks 通用卡↔词卡多对多链接 | ✅ 已新增（v31） | `sync-manifest.js:120-123`，id 确定性幂等 + 墓碑传播 |
| parking 判定全表扫描 cards | ✅ 已修复（P2-2 round32） | `repo.js:2522-2537` 移除 cards 全表，仅用 links+groups |
| Dashboard 三组件各自全表物化 | ✅ 已修复（C-2 round33） | `repo.js:1096-1118` dashboardSnapshot 共享缓存 + DB 模式隔离（H4） |
| reviewHistory 全表 allCards() 只为挂 front/back | ✅ 已修复（D-5 round33） | `repo.js:1069-1075` bulkGet 仅涉及的卡片 |
| streak/getTodayCount 全表 toArray | ✅ 已修复（D-4 round33） | `streak.js` reviewedAt 索引范围扫描 + 400天回溯上限 |
| quickCheck 行污染统计/训练/调度 | ✅ 已修复（P1-2 round33） | 全链路统一 realReviews/isRealReview 过滤（15+ 处） |
| 导出时间用 UTC toISOString 差一天 | ✅ 已修复（M2 round34） | `exporters.js` fmtLocal 本地时区 |
| wordCards missing dueAt 永不入队 | ✅ 已修复（M7/P3-2 round34-37） | `word-repo.js:519-545` 一次性差量修复 + meta 哨兵 |
| parking 旧词组无 status 字段致误判停车 | ✅ 已修复（P3 round37） | `word-repo.js:501` 反向判定 `!== 'archived'` |

---

## 二、需修复的缺陷

### BUG-01 [P2] mergeByFieldTs 平局收敛不一致，双端可永久不收敛

- **位置**：`src/sync-manifest.js:437` — `if (xt >= ct) out[k] = xr[k];`
- **问题描述**：自由文本表（notes/memos/plans/mindmaps）的字段级合并用 `>=`，平局无条件取 incoming。这与项目其它合并点的确定性收敛纪律不一致：
  - `mergeCardPair` 字段级合并：严格 `>` + 平局回退整行 updatedAt + 字典序 tiebreak（L250-257）
  - `mergeRows` 整行 updatedAt 分支：严格 `>` + 平局字典序收敛（L502-525）
  - `mergeTombstones`：严格 `>` + 平局字典序（L547-550）
  - `review` selfExplanation：严格 `>` + 平局字典序（L481-487）

  当两台设备同毫秒修改同一笔记的同一字段到不同值时：A 端收 B 的包（incoming=B）取 B 的值，B 端收 A 的包（incoming=A）取 A 的值——双端各自保留对方的值，**永久不一致**，且下一轮同步不会收敛（因为两端值不同但 fieldTs 相同，继续取 incoming=对方当前值，形成 A↔B 交换循环）。

- **影响范围**：notes/memos/plans/mindmaps 四张表。fieldTs 同毫秒概率低（需两台设备时钟同步到毫秒级且同时编辑同一字段），但与项目"所有合并点必须确定性收敛"的铁律不符，且 clockSkew 补偿后同毫秒碰撞概率实际升高（偏移被消除后，真实同时编辑的碰撞不再被 skew 错开）。
- **修复建议**：改为严格 `>` + 平局字典序收敛，与 mergeCardPair 同型：
  ```js
  if (xt > ct) out[k] = xr[k];
  else if (xt === ct && xr[k] !== cur[k]) {
    if (JSON.stringify(xr[k]) < JSON.stringify(cur[k])) out[k] = xr[k];
  }
  ```

### BUG-02 [P2] imageRefs 反向索引表"只写不读"，设计目标未兑现

- **位置**：`src/db.js:325-331`（表定义）、`src/repo.js:644-667`（rebuildImageRefs）、`src/repo.js:584-587,1602`（delete 时清理）
- **问题描述**：v32 新增 `imageRefs` 表，设计目标（db.js 注释明确写道）是让 `cleanupOrphanImages` / sync.js / hub GC 走索引查询，将 O(全表扫描) 降为 O(引用数)。但实际状态：
  1. `cleanupOrphanImages`（repo.js:600-619）和 `findOrphanImages`（repo.js:630-642）**已移除索引快速路径**（round26 D4，原因是"写路径不维护、索引可能过期"），统一走 6 表全表扫描。
  2. 全仓 grep 确认：**没有任何读路径查询 imageRefs 表**。
  3. 写路径也不维护——只有 `rebuildImageRefs()` 全量重建时写入，以及 deleteCard/deleteWordCard/deleteNote 时同步删除悬空引用（保持不累积孤儿）。
  4. `rebuildImageRefs` 本身也无调用方触发（grep 仅定义处）。

  结果：imageRefs 是一个**死索引**——占 IndexedDB 存储、占 schema 版本位、在 EXCLUDED_FROM_SYNC 里登记，但不产生任何查询收益。delete 路径的同步清理反而增加了每次删除的写放大。

- **影响范围**：存储浪费（万卡千图场景下 imageRefs 可能数千行）+ schema 复杂度 + 维护成本。不影响正确性（因为没人读它）。
- **修复建议**（二选一）：
  - **方案 A（兑现设计）**：补全写路径增量维护——createCard/updateCard/createNote/updateNote 等写入时增量更新 imageRefs（删旧引用+加新引用），然后 cleanupOrphanImages 改走 `db.imageRefs.where('imageId').anyOf(ids)` 快速判定。这是 db.js 注释承诺的架构。
  - **方案 B（精简）**：直接移除 imageRefs 表和相关代码，cleanupOrphanImages 维持全表扫描（图引用量级小，扫描成本可接受）。减少 schema 到 v33 或保留空表位兼容。

### BUG-03 [P3] dashboardSnapshot 缺显式失效函数，与 failCountMap 纪律不对称

- **位置**：`src/repo.js:1096-1118`
- **问题描述**：`dashboardSnapshot()` 用 `count + 最新 updatedAt + 最新 reviewedAt + DB模式` 组缓存键，供 getStats/weakCards/getReviewSuggestion 三组件共享。所有正常写路径（updateCard/review/deleteCard）都 bump 时间戳，所以缓存自然失效。但：
  1. 没有与 `failCountMap` 对称的 `invalidateDashboardSnapshot()` 导出函数。
  2. `failCountMap` 的注释明确要求"写路径必须调 invalidateFailCountCache() 显式失效"（repo.js:1130），因为复合键本身不完备（原地改写非最新行时 count 和最新时间戳都不变）。
  3. dashboardSnapshot 有同样的不完备性——若未来新增"批量修复脚本"、"数据迁移逻辑"、"import 后差量 patch"等原地改写旧卡片非时间戳字段的路径，缓存会陈旧且无失效手段。
  4. 当前 importBackup 调用了 `invalidateFailCountCache()`（sync.js:848），但没有对应的 dashboard 失效——import 后 Dashboard 可能显示旧快照（直到下次写操作 bump 时间戳）。

- **影响范围**：低（当前所有写路径都 bump 时间戳，实际不会陈旧），但属于可维护性债务——新增写路径时容易遗漏。
- **修复建议**：导出 `invalidateDashboardSnapshot()`，在 importBackup、批量操作、迁移脚本中调用；与 failCountMap 的失效点对齐。

### BUG-04 [P3] TOMB_KIND_TABLE 枚举与 SYNC_TABLES 无自动对齐，新增 kind 漏登记致墓碑永不 GC

- **位置**：`src/repo.js:751-769`
- **问题描述**：`pruneTombstones` 用 `TOMB_KIND_TABLE`（26 种 kind→table 映射）判定墓碑对应的本地行是否仍存在，存在则跳过 GC（避免误删仍在等待传播的删除）。但：
  1. 该映射是**硬编码枚举**，与 `sync-manifest.js` 的 SYNC_TABLES（30+ 表，每张表有 kind 字段）没有自动派生关系。
  2. sync-manifest 已有"三查 checklist"注释（L53-75）提醒新增表时逐项登记，但 TOMB_KIND_TABLE 不在该 checklist 中——新增 kind 时极易漏登记。
  3. 漏登记的后果：该 kind 的墓碑 `table = undefined` → `if (!table) continue` 跳过 → **永远不被 GC**，墓碑表缓慢膨胀。
  4. 对照实际写墓碑的 kind（grep 确认）：card/groupLink/graphEdge/review/cardWordLink/embedding/image/userOp/memo/dailyPlan/dailyTask/note/plan/doc —— 均在 TOMB_KIND_TABLE 中。但 `wordCheckin`/`wordSetting`/`wordSyllabusMeta`/`syllabusMeaning`/`privacyRecord`/`pomoSession` 等表如果未来加删除墓碑，会漏。

- **影响范围**：低（当前所有 kind 均已登记），但属于枚举漂移风险——与上轮审计指出的"去重引用字段枚举易漏"是同类问题，上轮已通过 sync-dedup 集中化修复，此处尚未收口。
- **修复建议**：从 SYNC_TABLES 自动派生 kind→table 映射（`SYNC_TABLES.reduce((m,t)=>{m[t.kind]=t.table;return m;},{})`），消除硬编码枚举。PRIVACY_SYNC_TABLES 也纳入。

### BUG-05 [P3] fsrs trainWeights 仍拟合惰性维度 w[18]，浪费算力且干扰梯度归一化

- **位置**：`src/fsrs.js:59-61`（w18 注释）、`src/fsrs.js:314-328`（梯度循环）
- **问题描述**：DEFAULT_WEIGHTS 的 w[18] 注释明确标注为"惰性维度——当前实现未引用该维（MAX_STABILITY=365 为硬编码常量），训练仍会拟合它造成'看似已调优'的假象"。但 `trainWeights` 的梯度循环（L315-321）遍历全部 19 维，对 w[18] 也做 `up/dn` 两次 lossOf 评估：
  1. w[18] 不被 `stabilityAfterRecall`/`stabilityAfterForget`/`nextInterval`/`retrievability` 任何公式引用，其梯度恒为 0（lossOf 对 w[18] 不敏感）。
  2. 每次迭代浪费 2 次 lossOf 评估（19维×2=38次/轮，可省 2 次≈5.3% 训练时间）。
  3. 更关键的是 `Math.hypot(...grad)` 归一化时，w[18] 的 0 梯度不影响方向，但如果未来某维梯度极小（接近 0），19 维里混一个恒 0 维会轻微拉低归一化因子——虽不影响收敛方向，但属于"已知无效维度仍参与训练"的不洁净状态。
  4. 返回的 weights 包含 w[18]（训练中未变化，等于初始值），`serializeUserWeights` 校验通过后落盘——用户看到"权重已个性化训练"，但 w[18] 实际是默认值，与注释"看似已调优的假象"吻合。

- **影响范围**：性能浪费（训练时间 +5%）+ 透明度问题（用户以为 19 维都调了）。不影响调度正确性。
- **修复建议**：训练时 mask 掉惰性维度——梯度循环跳过 w[18]，或在梯度计算后强制 `grad[18]=0` 且 `next[18]=weights[18]`（不更新）。同时在 fsrsInfo 里标注"已调优维度：18/19"。

---

## 三、可优化的性能与可维护性改进点

### OPT-01 [P2] cleanupOrphanImages / findOrphanImages 每次删除全表扫描 6 张表

- **位置**：`src/repo.js:600-642`
- **现状**：每次 deleteCard / deleteWordCard / deleteNote 都调用 `findOrphanImages`，内部 `Promise.all` 全表物化 cards+wordCards+notes+docs+memos+mindmaps 六张表，然后 `JSON.stringify(c)` 逐行提取图片 id。
- **问题**：万卡 + 千笔记场景下，每次删除都是 O(N) 全表物化 + O(N) JSON 序列化。删除是低频操作，但批量删除（如清空科目、回收站清空）时会重复 N 次全表扫描。
- **优化方向**：与 BUG-02 联动——若补全 imageRefs 写路径维护，可改为 `db.imageRefs.where('imageId').anyOf(candidateIds)` 索引查询，O(引用数) 判定。批量删除时先收集所有候选图 id，再做一次统一判定。

### OPT-02 [P2] fieldTs 未覆盖 docs/exams/aiMemories/weeklyReports/graphEdges，仍走整行 LWW

- **位置**：`src/sync-manifest.js` SYNC_TABLES 中这些表的 merge='updatedAt'
- **现状**：fieldTs 字段级合并已推广到 cards/wordCards/notes/memos/plans/mindmaps（H1 round34），但 docs（name/status/subject/sizeText 多字段）、exams（title/questions/scores 多字段）、aiMemories（content/category 多字段）、weeklyReports 仍走整行 LWW。
- **问题**：两台设备并发编辑同一 doc 的不同字段（A 改 name、B 改 status），后同步端覆盖先端，一端修改静默丢失。与 round29 修复的 cards 整行 LWW 丢改是同类问题。
- **优化方向**：推广 fieldTs 到这些表的 create/update 路径，mergeRows 的 updatedAt 分支已自动支持（`if (cur.fieldTs && xr.fieldTs)` 检测，无需改合并逻辑）。只需在 repo.js 的 createDoc/updateDoc/createExam/updateExam 等写入点 bump fieldTs。

### OPT-03 [P3] pruneTombstones 全表 toArray + 内存过滤，缺 deletedAt 索引

- **位置**：`src/repo.js:771-773`
- **现状**：`const all = await db.tombstones.toArray()` 然后 `filter(t => (t.deletedAt || 0) < cutoff)`。db.js 的 tombstones 索引是 `'id, kind'`，**没有 deletedAt 索引**。
- **问题**：墓碑表 30 天窗口内可能累积数千至数万条（每次删除写墓碑，userOps 批量清理也写）。每次 prune 全表物化 + 内存过滤。
- **优化方向**：在 db.js schema 给 tombstones 加 `deletedAt` 索引（或复合索引 `kind, deletedAt`），prune 改用 `db.tombstones.where('deletedAt').below(cutoff)` 范围查询。注意 Dexie 索引变更需要 version bump。

### OPT-04 [P3] sync.js importBackup 的 userOps/embeddings 快路径绕过 mergeRows，与主路径不一致

- **位置**：`src/sync.js:815-822`
- **现状**：对 userOps/embeddings 两张大表，用 `bulkGet` 存在性判定 + `bulkAdd` 替代整表 toArray + mergeRows，避免十万级行的全表物化。
- **问题**：快路径跳过了 mergeRows 的 strip/clockSkew/exportFilter 处理。当前这两张表无 strip 字段、clockSkew 对 idOnly 表无影响（不比较时间戳）、exportFilter 已在 exportRows 应用，所以**当前是安全的**。但未来若给 userOps 加 strip 字段、或 embeddings 加 exportFilter，快路径会静默遗漏——与主路径的行为分叉是隐性维护债务。
- **优化方向**：在快路径入口加断言注释"此表必须无 strip/exportFilter，否则须走 mergeRows"，或抽一个 `mergeIdOnlyFast(baseTable, incoming, strip)` 函数统一处理。

### OPT-05 [P3] hub.js merge 函数中 goal/examMeta/schedMeta 合并逻辑与 sync.js 重复，双端维护风险

- **位置**：`sync-hub/hub.js:358-420` vs `src/sync.js:987-1027`
- **现状**：goal/examMeta/schedMeta 的"严格 LWW + clockSkew + 字典序平局"逻辑在 hub.js（中枢合并）和 sync.js（客户端导入）各实现一份。
- **问题**：两处逻辑必须保持一致，否则中枢合并结果与客户端直接导入结果不同（同一数据包走两条通道得到不同状态）。当前已对齐（round37 同步修复），但未来修改一处容易漏另一处。
- **优化方向**：把 meta 合并抽成纯函数 `mergeMetaPair(local, incoming, skew)` 放进 sync-manifest.js（该文件已被 hub.js 和 sync.js 共同 import），双端共用。与 mergeCardPair/mergeChatPair 的组织方式一致。

---

## 四、适合拓展新功能的扩展点

### EXT-01 [P2] imageRefs 索引启用 → 图片引用关系可视化与管理

- **基础**：imageRefs 表已建（v32），schema 含 `imageId, refTable, refId`。
- **扩展方向**：补全写路径维护后（见 BUG-02 方案 A），可支持：
  - "某张图片被哪些卡片/笔记引用"反向查询（当前只能全表扫）
  - "未被引用的图片"一键清理建议（替代 cleanupOrphanImages 的全表扫描）
  - 图片替换功能（把某张图的所有引用批量替换为新图 id）
  - 资料库图片占用空间统计与 Top N 排行

### EXT-02 [P2] fieldTs 全表推广 → 真正的字段级 CRDT 同步，为多人协作打基础

- **基础**：fieldTs 机制已在 cards/wordCards/notes/memos/plans/mindmaps 验证可行，mergeByFieldTs 纯函数已实现。
- **扩展方向**：推广到 docs/exams/aiMemories/weeklyReports 后（见 OPT-02），所有可编辑表都实现字段级合并。这是从"单用户多设备 LWW"迈向"多用户实时协作"的关键基础设施——字段级合并是 CRDT 的基础形态，后续可叠加操作变换（OT）或 Conflict-free Replicated Data Type。

### EXT-03 [P1] schedMeta 同步 → 调度配置版本化与 A/B 测试

- **基础**：scheduler/fsrsWeights/fsrsInfo/pretestStability 四 key 已实现跨设备同步（round37 P2-5），含 updatedAt 时间戳。
- **扩展方向**：
  - **权重历史版本**：每次 trainWeights 完成后存档一份带时间戳的快照，支持"回滚到上周的权重"（当前只有最新一份，训练失败可能丢失之前的个性化参数）。
  - **A/B 测试**：按科目或卡片分组应用不同权重/目标保持率，对比校准曲线（calibration.js 已有分桶对比能力），用数据驱动调度参数选择。
  - **调度配置导出/分享**：把优秀的权重配置打包成可分享的"调度预设"，社区共享。

### EXT-04 [P2] dashboardSnapshot → 通用表级快照缓存层

- **基础**：dashboardSnapshot 已实现 count+时间戳缓存键 + 并发 Promise 共享 + DB 模式隔离，供三组件复用。
- **扩展方向**：抽象为通用 `tableSnapshot(tables, keyFn)` 工具，供更多聚合查询（bestWorstPartners、getLearningProfile、getAssetHealth 等当前各自全表 toArray 的函数）复用。减少 Dashboard 之外页面的全表物化次数，万卡级数据量下页面切换更流畅。

### EXT-05 [P2] clockSkew 补偿 → 持久化偏移估计与渐进式校准

- **基础**：已实现单次 HTTP Date 头估算偏移（sync.js:629-631），incoming 时间戳减偏移换算到本机帧。
- **扩展方向**：
  - **多次采样取中位数**：单次测量受 RTT 影响（LAN 下毫秒级，可接受；但跨网络或高负载时误差增大）。可在同步时采 3~5 次 Date 头取中位数，降低抖动。
  - **持久化偏移估计**：当前每次同步重新估算，不持久化。可把偏移估计存 localStorage，下次同步用加权平均（新测量 0.3 + 旧估计 0.7）渐进校准，设备时钟漂移时平滑过渡。
  - **偏移异常检测**：若估算偏移 > 5 分钟（明显时钟错误），在 UI 提示用户检查设备时间，而非静默补偿。

### EXT-06 [P3] pruneTombstones / pruneUserOps / pruneAiUsage → 统一本地 TTL 清理框架

- **基础**：已有三个独立的 prune 函数（tombstones 30天、userOps 365天、aiUsage 90天、privacyRecords 180天），importBackup 后依次调用。
- **扩展方向**：抽成统一的 `LocalTTL` 注册表——每张表声明 `{ ttlDays, indexField }`，启动时或 import 后统一执行清理。新增需 TTL 的表只需注册一行，无需写独立 prune 函数和在 importBackup 里加调用。与 sync-manifest 的"清单即唯一事实来源"理念一致。

---

## 五、跨维度交叉发现

### X-1 [P2] "枚举漂移"是本项目系统性风险，已部分收口但未根治

- **表现**：上轮审计指出"去重引用字段枚举易漏"（sync-dedup），本轮已通过 remapCardRefs 集中化 + sync-manifest"三查 checklist"修复。但同类问题仍存在于：
  - TOMB_KIND_TABLE（BUG-04）：kind→table 硬编码枚举
  - CLOCK_TS_FIELDS（sync-manifest.js:384-387）：时钟偏移换算的字段枚举，新增时间字段需同步加
  - LIVENESS_FIELDS（sync-manifest.js:568-577）：墓碑复活判定的时间字段枚举
  - cleanupOrphanImages 的 6 表扫描列表（repo.js:608-611）：新增含图引用的表需同步加
- **根因**：项目采用"清单即唯一事实来源"（SYNC_TABLES），但衍生枚举（引用字段、时间字段、kind 映射、扫描表列表）没有从清单自动派生，靠人工 checklist 维护。
- **建议**：中长期目标是让所有衍生枚举从 SYNC_TABLES 的元数据自动派生（如在 SYNC_TABLES 条目里加 `clockFields: ['updatedAt','reviewedAt']`、`hasImageRefs: true`、`tombstoneKind: 'card'` 等声明式字段），消除人工同步点。

### X-2 [P2] "写路径不维护派生索引"是反复出现的架构取舍

- **表现**：
  - imageRefs（BUG-02）：建了表但写路径不维护，只能全量重建，最终快速路径被移除
  - failCountMap：不是持久字段，靠缓存 + 显式失效维持
  - dashboardSnapshot：靠时间戳缓存键自然失效，无显式失效
- **根因**：项目倾向于"派生数据不持久化、需要时重算"，但 imageRefs 是个例外——建了持久化表却不维护写路径，导致"最尴尬的中间态"。
- **建议**：明确架构原则——派生数据要么（a）写路径增量维护 + 读路径走索引，要么（b）完全不持久化 + 需要时全量重算。imageRefs 当前是（a）的表 +（b）的读路径，必须二选一。

### X-3 [P1] 本轮迭代质量极高，测试覆盖从 800→970 是核心保障

- **观察**：22 次提交、+2804 行改动、涉及同步/调度/Agent/数据层四大核心模块，但 970 测试全绿。每处修复都有对应的注释标注（round33/34/36/37 编号），可追溯性强。
- **风险**：测试用例增长主要来自修复对应的回归测试，但**并发/时钟偏移/多设备时序**这类异步竞态场景仍难以用单测覆盖。BUG-01（mergeByFieldTs 平局不收敛）就是一个单测难捕获的问题——需要构造双端同毫秒场景才能触发。
- **建议**：补充"双端模拟"集成测试层——用两个独立的 Dexie 实例模拟 A/B 设备，交替执行 mergeRows，断言最终一致性（convergence property）。这能系统性捕获所有合并点的收敛问题，而不依赖逐个构造边界用例。

### X-4 [P3] 注释密度极高，是资产也是负担

- **观察**：核心文件（fsrs.js 380行含约 80 行注释、sync-manifest.js 610行含约 150 行注释、sync.js 1257行含约 200 行注释）的注释密度 >20%，且每条修复都标注了 round 编号和问题描述。这对可追溯性极好，但也意味着：
  - 注释与代码可能不同步（如 w18 注释说"惰性维度"但训练器仍在拟合——BUG-05）
  - 新读者需要消化大量历史上下文才能理解当前行为
- **建议**：定期（每 5~10 轮审计）做一次注释清理——把已成为"历史"的修复注释迁移到 CHANGELOG 或审计报告，代码内只保留"当前行为为什么这样设计"的注释，减少认知负荷。

---

## 六、优先级汇总表

| 编号 | 类型 | 优先级 | 位置 | 一句话摘要 |
|---|---|---|---|---|
| BUG-01 | 缺陷 | P2 | sync-manifest.js:437 | mergeByFieldTs 平局取 incoming，双端可不收敛 |
| BUG-02 | 缺陷 | P2 | db.js:325, repo.js:644 | imageRefs 死索引，只写不读 |
| BUG-03 | 缺陷 | P3 | repo.js:1096 | dashboardSnapshot 缺显式失效函数 |
| BUG-04 | 缺陷 | P3 | repo.js:751 | TOMB_KIND_TABLE 枚举易漏，缺自动对齐 |
| BUG-05 | 缺陷 | P3 | fsrs.js:315 | trainWeights 拟合惰性维度 w18，浪费算力 |
| OPT-01 | 优化 | P2 | repo.js:600 | cleanupOrphanImages 每次删除全表扫 6 表 |
| OPT-02 | 优化 | P2 | sync-manifest SYNC_TABLES | fieldTs 未覆盖 docs/exams/aiMemories |
| OPT-03 | 优化 | P3 | repo.js:771 | pruneTombstones 全表 toArray，缺 deletedAt 索引 |
| OPT-04 | 优化 | P3 | sync.js:815 | userOps/embeddings 快路径绕过 mergeRows |
| OPT-05 | 优化 | P3 | hub.js vs sync.js | meta 合并逻辑双端重复 |
| EXT-01 | 扩展 | P2 | imageRefs | 图片引用可视化与管理 |
| EXT-02 | 扩展 | P2 | fieldTs | 全表字段级合并→多人协作基础 |
| EXT-03 | 扩展 | P1 | schedMeta | 调度配置版本化与 A/B 测试 |
| EXT-04 | 扩展 | P2 | dashboardSnapshot | 通用表级快照缓存层 |
| EXT-05 | 扩展 | P2 | clockSkew | 持久化偏移估计与渐进校准 |
| EXT-06 | 扩展 | P3 | prune* | 统一本地 TTL 清理框架 |
| X-1 | 交叉 | P2 | 多文件 | 枚举漂移系统性风险 |
| X-2 | 交叉 | P2 | 多文件 | 派生索引写路径维护原则不统一 |
| X-3 | 交叉 | P1 | 测试层 | 需补双端一致性集成测试 |
| X-4 | 交叉 | P3 | 多文件 | 注释密度高，定期清理历史注释 |

---

## 七、审计结论

本轮迭代（round33~37）是一次**高质量的系统性修复**，上轮审计的 10 个缺陷中 8 个已确认修复，2 个部分修复（extFields 并集保护是设计取舍、imageRefs 建了但未启用——转为 BUG-02）。测试覆盖从 800 增至 970，核心模块（同步/调度/Agent/数据层）的健壮性显著提升。

**剩余风险集中在三个方向**：
1. **合并收敛一致性**（BUG-01）：fieldTs 新合并路径的平局处理与老路径不一致，是本轮新引入代码里最值得修的问题。
2. **派生索引架构原则**（BUG-02 + X-2）：imageRefs 处于"建了不用"的中间态，需决策是补全写路径还是移除。
3. **枚举漂移**（BUG-04 + X-1）：多处硬编码枚举与主清单无自动对齐，是长期维护债务。

**建议修复顺序**：BUG-01（10行改动，收敛正确性）→ BUG-02 方案决策（架构对齐）→ OPT-02（fieldTs 推广，与 BUG-01 同文件可联动）→ 其余 P3 项按排期处理。

---

*审计完成时间：2026-09-11 | 审计基线：189c0e8 | 测试：970/970 pass*
