# SxyBrick 深度审计报告（Round 32）

> **审计日期**
>
> ：2026-09-04
> **审计基线**
>
> ：facffb5（800/800 测试通过）
> **审计维度**
>
> ：算法正确性 / 业务逻辑 / 数据协同 / 数据对象
> **审计方法**
>
> ：核心源码逐文件精读 + 跨模块数据流追踪 + 边界条件推演
> **审计范围**
>
> ：fsrs.js/srs.js/sync-manifest.js/sync.js/repo.js/repo-core.js/retrieval.js/retrieval-core.js/embedding.js/base.js/pipeline.js/graphAuto.js/session.js/calibration.js/forecast.js 等 20+ 核心文件



***

## 一、需修复的缺陷（Bugs）

### BUG-01 \[P1] embedding 余弦相似度维度不匹配时静默截断



* **位置**：`src/agent/embedding.js:147-157`（`cosine` 函数）

* **问题描述**：



```
const len = Math.min(a.length, b.length);  // 静默取短
```

当 query 向量（远程 API 返回 1536 维）与存储向量（本地降级 256 维）维度不一致时，只比较前 `min` 维，余弦结果无意义但**不报错、不告警**。



* **触发路径**：用户先在无 API Key 状态下建立了本地 256 维索引 → 后续配置了 API Key → 新 query 为 1536 维 → `modelSig` 本应触发重建，但若用户未手动重建、或重建中断，检索结果全部失真。

* **影响**：RAG 检索返回完全不相关的卡片 / 文档，Agent 回答质量骤降，用户无从排查。

* **修复建议**：在 `cosine` 入口增加维度一致性校验，不一致时抛出明确错误或返回 0 并 `console.warn`；在 `semanticSearch` 加载行后检查 `rows[0].vector.length === qVec.length`。



***

### BUG-02 \[P1] graphAuto.autoBuildGraph 全表载入 + 主线程阻塞



* **位置**：`src/algorithms/graphAuto.js:89-294`

* **问题描述**：

1. `db.cards.toArray()` + `db.reviews.toArray()` 全表载入内存，2591 张卡时已可观，万卡级会显著占用内存。

2. `buildCandidates` 的 `maxPairs=200000/300000` 预算在大库下仍可能产生数十万候选对，每个候选对要做集合运算。

3. 整个过程**同步执行在主线程**，无 Web Worker 隔离，大库下 UI 冻结数秒。

4. `buildCandidates` 中 `inter.size > maxPairs` 时直接 `return inter`，但此时热门词桶可能还没处理，导致**冷门词优先、热门词缺失**的偏置。

* **影响**：大库用户触发 "重建图谱" 时浏览器卡顿；图谱边分布偏向冷门词。

* **修复建议**：① 将 autoBuildGraph 移入 Web Worker；② 候选对预算耗尽时应按 df 比例分配而非简单截断；③ 增加进度回调。



***

### BUG-03 \[P2] Agent parseToolCall 不支持多工具调用且 args 解析脆弱



* **位置**：`src/agent/agents/base.js:31-44`

* **问题描述**：

1. 正则只匹配**第一个**工具调用。虽然 prompt 要求 "每次仅一个"，但 LLM 实际输出可能违反，后续调用被静默丢弃。

2. `[\s\S]*?` 非贪婪匹配在 args 的 JSON 中如果包含 `</args>` 字符串，会提前截断导致 `JSON.parse` 失败 → 静默降级为 `{}`。

3. `thought` 提取用 `slice(0, m.index)`，如果工具调用前有残留文本，会被误判为思考。

* **影响**：Agent 在复杂任务中可能 "忘记" 执行第二个工具调用。

* **修复建议**：用 `matchAll` 支持多工具调用；args 解析失败时回灌错误信息给 LLM 让其修正，而非静默 `{}`。



***

### BUG-04 \[P2] 卡片去重引用字段枚举易漏（孤儿引用风险）



* **位置**：`src/sync.js:585-591`（`importBackup` 中的 `CARD_REF_FIELDS` 等）

* **问题描述**：导入时对 "异 id 同内容" 卡片去重后，需要把所有引用了 "被跳过 id" 的字段重定向到 "保留 id"。这些字段是**硬编码枚举**，代码注释自己承认："任何新卡片引用字段都必须同步加进 CARD\_REF\_FIELDS，否则被去重跳过的卡在对应表里留下孤儿行"。

* **触发路径**：未来新增任何含 cardId 引用的表 / 字段，如果忘记加枚举，导入去重后产生孤儿引用。

* **影响**：数据一致性隐患，属于 "定时炸弹" 型缺陷。

* **修复建议**：建立集中的 "卡片引用字段注册表"，新增表时必须声明引用字段；或在导入后做孤儿引用扫描作为兜底校验。



***

### BUG-05 \[P2] WORD\_EXT\_FIELDS 并集保护导致 "用户清空" 不生效



* **位置**：`src/sync-manifest.js:201-207`（`mergeCardPair` 的 extFields 合并）

* **问题描述**：AI 扩展字段采用 "任一端有值即保留" 的并集保护。但如果用户在一端**主动清空**了某个字段（如删除了不满意的 mnemonics），该字段值变为 `undefined`，另一端的旧值会被保留，**用户的删除操作跨设备不生效**。

* **影响**：用户清理 AI 生成内容后，同步回来又出现了。

* **修复建议**：区分 "字段不存在"（`undefined`）和 "字段显式清空"（`null` 或空字符串）。并集保护只对 `undefined` 生效。



***

### BUG-06 \[P2] pipeline.decomposeTask JSON 解析无 schema 校验



* **位置**：`src/agent/pipeline.js:99-117`

* **问题描述**：

1. 用正则提取 JSON 数组，如果 LLM 输出包含多个数组，会提取到错误的数组。

2. 解析出的 steps 没有做 schema 校验：`agent` 字段是否指向已注册 Agent？`instruction` 是否为非空字符串？无效步骤会被静默跳过。

* **影响**：自动分解任务时可能产生空步骤或无效 Agent。

* **修复建议**：解析后校验每个 step 的 agent 在 registry 中存在、instruction 非空；无效步骤过滤并在 trace 中记录。



***

### BUG-07 \[P2] repo.cleanupOrphanImages 每次删卡全表扫描



* **位置**：`src/repo.js:356-366`

* **问题描述**：每次删除卡片都要 `allCards()` 全表扫描 + 逐卡提取图片 ID，只为判断几张图片是否被其他卡引用。删一张卡的成本是 O (全部卡片 × 平均图片数)。

* **影响**：大库下删除卡片变慢；批量删除时重复扫描 N 次。

* **修复建议**：维护 `imageId → Set<cardId>` 的反向索引表，删卡时只检查被删卡引用的图片。



***

### BUG-08 \[P3] review.predR 计算未校验 elapsedDays 非负



* **位置**：`src/repo.js:506-510`

* **问题描述**：只校验了 `s` 和 `last` 的有限性，但 `elapsedDays = (nowTs - last) / 86400000` 可能为负数（系统时钟回拨）。`retrievability` 中 t 为负时 R > 1，语义错误。

* **影响**：校准分析中出现 predR > 1 的异常数据点。

* **修复建议**：增加 `elapsedDays >= 0` 校验，负值时 predR 记为 null。



***

### BUG-09 \[P3] listDailyPlanSummary 在循环里串行 await



* **位置**：`src/repo.js:710-724`

* **问题描述**：30 天计划摘要要做 30+ 次串行 IndexedDB 查询。

* **修复建议**：`db.dailyTasks.where('planId').anyOf(planIds).toArray()` 一次查询后内存分组。



***

### BUG-10 \[P3] retrieval-core.fuseResults O (n×m) 查找



* **位置**：`src/agent/retrieval-core.js:59-64`

* **问题描述**：merged 数组构建时，对每个 item 用 `sem.find()` 和 `kw.find()` 做 O (n) 查找。

* **修复建议**：先构建 `Map<sourceId, score>`，O (1) 查找。



***

## 二、可优化的性能与可维护性改进点

### OPT-01 \[P1] repo.js 单文件 86KB / 100+ 函数职责过载



* **位置**：`src/repo.js`（86.1 KB，101 个函数）

* **问题**：横跨 15+ 领域，单文件维护困难。

* **建议**：按领域拆分为 `repo/cards.js`、`repo/daily.js`、`repo/notes.js` 等子模块，`repo.js` 作为 re-export 入口。



***

### OPT-02 \[P1] 全表 toArray 模式普遍存在，缺增量统计



* **位置**：`repo.js`（getStats/weakCards）、`graphAuto.js`、`retrieval.js`

* **问题**：多个统计函数全表载入 + 内存计算，万卡级下内存峰值高。

* **建议**：引入 materialized view 表，复习 / 增删卡时增量更新；优先用 Dexie 索引聚合。



***

### OPT-03 \[P1] 向量检索无 ANN 索引，3000 条硬上限



* **位置**：`src/agent/retrieval.js:211`（`FULLSCAN_ROW_LIMIT = 3000`）

* **问题**：semanticSearch 全量向量加载 + 逐条余弦 O (n×d)，超过 3000 条直接抛错。

* **建议**：引入 HNSW WASM 索引，支持万级向量亚秒检索。



***

### OPT-04 \[P1] Agent 核心层零单元测试



* **位置**：`src/agent/`（orchestrator/base/pipeline/context/memory/llm）

* **问题**：最复杂的 AI 逻辑缺回归网，历史缺陷多为人工发现。

* **建议**：优先补 `parseToolCall`、`runReActAgent`、`decomposeTask`、`fuseResults` 单测。



***

### OPT-05 \[P2] 配置常量分散，缺统一配置中心



* **位置**：ai.js/embedding.js/llm.js 各自读 localStorage；事件名各处硬编码

* **建议**：建立 `src/config/` 和 `src/constants/` 统一管理。



***

### OPT-06 \[P2] 墓碑表无限增长，无 GC 机制



* **位置**：`db.tombstones`

* **问题**：墓碑只在复活时清除，删除后永不回收，长期使用后可能超过实际数据表。

* **建议**：增加墓碑 GC（超过 90 天且已同步的墓碑可清理）。



***

### OPT-07 \[P2] 重复工具函数未全量收口



* **位置**：多处（pad2 / 字节格式化 / EmptyState）

* **建议**：全量推广 `utils/format.js` 和 `EmptyState` 组件。



***

### OPT-08 \[P3] 部分视图定时器 / 监听器未清理



* **位置**：Review.vue/ DailyPlanView.vue 等大文件

* **建议**：全局审查 setInterval/setTimeout/db.\$subscribe 的清理配对。



***

## 三、适合拓展新功能的扩展点

### EXT-01 插件系统 → 远程 MCP 服务接入



* **现状**：本地 ES Module 插件，MCP 协议兼容。

* **扩展**：接入远程 MCP Server（SSE/WebSocket），调用外部工具。

### EXT-02 FSRS 权重训练 → 持续学习 + 个性化推荐



* **现状**：手动触发的批处理训练。

* **扩展**：在线增量学习 / 按科目分别训练 / 推荐最优 desiredRetention。

### EXT-03 知识图谱 → 学习路径生成 + 知识缺口诊断



* **现状**：前置依赖回溯 + 智能出题。

* **扩展**：拓扑排序学习路径 / 孤立节点诊断 / 掌握度热力图。

### EXT-04 RAG 检索 → 多模态检索



* **现状**：仅文本 embedding。

* **扩展**：图片 OCR 文本入索引 / LaTeX 公式语义检索。

### EXT-05 同步引擎 → 端到端加密云同步



* **现状**：局域网 Hub 明文 + 手动加密备份。

* **扩展**：E2EE 自动同步 / WebDAV/S3 中继 / 冲突可视化。

### EXT-06 复习数据 → 学习行为深度分析



* **现状**：基础统计（热力图 / 遗忘曲线 / 校准）。

* **扩展**：最佳复习时段分析 / 疲劳曲线检测 / 注意力转移模式。

### EXT-07 每日规划 → 智能日程自动编排



* **现状**：手动 / 口述任务 + 四象限 + 打卡。

* **扩展**：结合到期预测自动生成复习任务 / 任务时长预估 / 考试倒推排程。

### EXT-08 双调度器 → A/B 实验框架



* **现状**：FSRS/SM-2 全局切换。

* **扩展**：按科目分配调度器 / A/B 对比保留率 / 参数可视化。



***

## 四、跨维度交叉发现

### 交叉发现 1："引用字段枚举" 是系统性风险



* 涉及：数据协同 + 数据对象

* 表现：去重引用字段、LIVENESS\_FIELDS、级联删除表集合都是硬编码枚举，新增表 / 字段漏改一处就是一致性缺陷。

* 建议：建立 "表元数据注册表"，同步 / 去重 / 删除逻辑从注册表派生。

### 交叉发现 2："全表 toArray" 是性能债的共同根源



* 涉及：算法 + 业务逻辑

* 表现：统计 / 图谱 / 检索 / 删卡 / 去重都依赖全表载入，万卡级会全面卡顿。

* 建议：将 "增量 / 索引查询" 作为下一阶段统一性能主题。

### 交叉发现 3：Agent 层是质量覆盖的最大盲区



* 涉及：业务逻辑 + 数据协同

* 表现：最复杂、外部依赖最多的部分零测试，LLM 输出直接落库缺校验。

* 建议：建立 "工具参数 schema 校验 + 执行结果标准化" 中间层。

### 交叉发现 4：本地优先架构的 "时钟信任" 假设



* 涉及：算法 + 数据协同

* 表现：FSRS elapsedDays、同步时间戳比较、墓碑判定都信任本地时钟，时钟回拨会产生负间隔 / 合并方向错误 / 墓碑误判。

* 建议：关键时间戳操作增加单调性校验。



***

## 五、优先级汇总



| 优先级 | 编号     | 类型 | 简述                            |
| --- | ------ | -- | ----------------------------- |
| P1  | BUG-01 | 缺陷 | embedding 维度不匹配静默截断           |
| P1  | BUG-02 | 缺陷 | graphAuto 全表载入 + 主线程阻塞        |
| P1  | OPT-01 | 优化 | repo.js 86KB 拆分               |
| P1  | OPT-02 | 优化 | 全表 toArray → 增量统计             |
| P1  | OPT-03 | 优化 | 向量检索 ANN 索引                   |
| P1  | OPT-04 | 优化 | Agent 层补单元测试                  |
| P2  | BUG-03 | 缺陷 | parseToolCall 不支持多工具调用        |
| P2  | BUG-04 | 缺陷 | 去重引用字段枚举易漏                    |
| P2  | BUG-05 | 缺陷 | extFields 并集保护致清空不生效          |
| P2  | BUG-06 | 缺陷 | decomposeTask 无 schema 校验     |
| P2  | BUG-07 | 缺陷 | cleanupOrphanImages 全表扫描      |
| P2  | OPT-05 | 优化 | 配置常量统一收口                      |
| P2  | OPT-06 | 优化 | 墓碑 GC 机制                      |
| P2  | OPT-07 | 优化 | 重复工具函数收口                      |
| P3  | BUG-08 | 缺陷 | predR 未校验 elapsedDays 非负      |
| P3  | BUG-09 | 缺陷 | listDailyPlanSummary 串行 await |
| P3  | BUG-10 | 缺陷 | fuseResults O (n×m) 查找        |
| P3  | OPT-08 | 优化 | 定时器清理审查                       |



***

## 六、审计结论

本轮深度审计覆盖 20+ 核心文件、四个维度，**未发现 P0 级阻断性缺陷**，代码库整体质量在 round31 基础上保持稳定。发现的 10 个缺陷以 P2/P3 为主，集中在三个系统性主题：



1. **"枚举硬编码" 的一致性风险** — 随功能扩张会持续产生新缺陷

2. **"全表载入" 的性能债** — 当前数据量下可控，万卡级会成为瓶颈

3. **"Agent 层" 的质量盲区** — 最复杂的逻辑缺测试，LLM 输出缺校验

建议下一阶段以 **OPT-04（Agent 测试）+ BUG-01（embedding 校验）+ 交叉发现 1（表元数据注册表）** 为优先切入点，这三项投入产出比最高。



***

*报告归档于&#x20;*`docs/AUDIT-2026-09-04-round32-deep.md`