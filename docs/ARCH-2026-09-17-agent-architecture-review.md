# Agent 体系架构评审 + 记忆架构专项（2026-09-17）

> 方法：三路独立代码测绘（运行时/调用链、记忆与检索、集成与可观测）+ **关键结论逐条实测复核**
> （不采信子代理结论与既有审计报告，凡下判断均附 `文件:行` 或可复现证据）。
> 本轮同时修掉一个实测确认的 P0（见 §6）。

---

## 1. 架构现状

### 1.1 分层（对外表现）

| 层 | 组件 | 职责 |
| --- | --- | --- |
| 入口层 | `AIAssistant.vue` / `AgentWorkbench.vue` / 图谱·导图视图 / 其余 11 视图 | 触发 AI 或 Agent |
| 编排层 | `orchestrator.js`（`runTask`、`routeIntent` 9 条规则）/ `pipeline.js`（多智能体）/ `blackboard.js` | 决定"谁来做"与"怎么协作" |
| 运行时 | `agents/base.js`（ReAct 循环）/ `registry.js`（注册表） | 循环、协议、工具装配 |
| 模型适配 | `agent/llm.js` → `utils/offlineAI.js` / `agent/local-answer.js` | 流式、重试、超时、降级 |
| 存储 | IndexedDB：业务表 + `aiMemories` / `embeddings` / `aiChats` / `aiUsage` / `errors` | 事实源与记忆 |

### 1.2 四条入口路径（判定条件）

| 入口 | 判定 | 结果 |
| --- | --- | --- |
| AI 助手 | `agentId:'assistant'` 写死在 `AIAssistant.vue:155` | `orchestrator.js:86` 跳过 pipeline、`:111` 跳过意图路由，**恒定 assistant** |
| Agent 工作台 | 选中 Agent → 直用；未选 → `shouldUsePipeline`(`pipeline.js:246`) 决定流水线或 `routeIntent` | 唯一能触发路由/流水线的入口 |
| 图谱 / 导图 | 写死 `graph-builder` / `cardsmith`，直调 `runTask` | 绕过 `ai.js` |
| 其余 11 视图 | 无 Agent | `ai.js:114 chatAI` 单次调用，无工具 |

### 1.3 装配规模

- **11 个 Agent**（`agents/index.js`）：tutor / analyst / cardsmith / quizmaster / planner / memorykeeper / mnemonist / mistake-analyst / graph-builder / smart-reviewer / assistant。
- **73 个工具**（`tools/index.js`），其中 `writesData:true` 17 个。
- 工具重复挂载严重：`search_cards` ×8、`get_card_detail` ×9、`get_weak_cards` ×6；tutor(37 工具) 与 assistant(46) 重叠约 34 个。
- **10 个工具无人挂载**（能力不可达）：`update_card` / `add_memo` / `update_plan_status` / `calibration_report` / `create_doc` / `ensure_index` / `rebuild_index` / `get_index_status` / `attribute_mistakes` / `auto_build_graph`。

### 1.4 ReAct 循环的机械细节（决定成本与稳定性的核心）

- **终止**：`<final>` 命中（`base.js:86`）→ 步数 `MAX_STEPS=12` 硬顶（`:235`，末格只收尾 `:251`）→ 工具预算提示 `:325` → 预算用尽走 `buildLocalAnswer`（`:363`）。
- **压缩**：工具级 `compactToolPayload`（`compact.js:70`：6000 字 / 20 条 / 单条 300 字 / 深 3）→ 会话级 `compactConvo`（`base.js:183`：48000 字上限，只压 tool 与 assistant，user/system 不动）。
- **工具结果回灌**：**以 `user` 角色**注入（`base.js:172`）——因为原生 `tool` 角色缺 `tool_calls` 会被服务端 400（`:158-170`）。
- **注入防护薄弱**：唯一防线是 `PROTOCOL:38` 一句"勿原样抄 JSON"，无定界符/转义；卡片正文可与 system 同级竞争。

### 1.5 多智能体协作

`pipeline.js`：分解（预设 3 条 / 关键词 / LLM ≤4 步）→ **顺序 `for` 循环**（`:176`，非并行）→ 黑板注入（`blackboard.js:86`，findings 取 8 条 × 200 字）→ 汇总。`delegate_to_agent` 单轮调用目标 Agent 并写黑板。

---

## 2. 问题清单（分级，均带证据）

### P0 — 阻塞或必然失败

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| 1 | **流水线降级形同虚设** | `pipeline.js:156` 与 `orchestrator.js:88` 均无 try/catch；只有"分解解析为 null"才回退（`:157-161`） | 401/429/超时**直接抛给用户**，多智能体入口在弱网/限流下不可用 |
| 2 | **`chatAI` 入参误用（已修）** | `PrivacyData.vue:350` 传字符串 → `llm.js:151 messages.reduce` TypeError | 「AI 增强报告」按钮**必然失败**，且报错不可读（本轮已修，见 §6） |

### P1 — 能力缺失 / 数据风险

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| 3 | **路由系统近似死代码** | 助手入口写死 `assistant`（`AIAssistant.vue:155`）→ `orchestrator.js:86/:111` 永久跳过 | 9 条意图规则与预设流水线**只在工作台未选 Agent 时可达**；能力大量闲置 |
| 4 | **10/73 工具无人挂载** | 见 §1.3 | 含**全部 RAG 索引维护**（`ensure_index`/`rebuild_index`/`get_index_status`）→ 索引只能靠 `buildRAGContext` 内 20 卡/3 文档的配额补，用户无法主动重建 |
| 5 | **embeddings 存原文且跨设备同步** | `retrieval.js:71`（`text` 字段落库）+ `sync-manifest.js:99`（`merge:'idOnly'`） | 卡片/文档**原文副本**随同步与导出扩散到每台设备；删除源内容后副本不受墓碑约束 |
| 6 | **向量 id 随机 → 跨设备重复堆积** | `retrieval.js:179` `uid()` + `idOnly` 合并 | 多设备反复索引同一卡 → 行数倍增；**无 prune 上限**，只有 `FULLSCAN_ROW_LIMIT=3000` 抛错（`:220`） |
| 7 | **向量失效滞后** | `stale.js:14` 仅比较 `emb.updatedAt < item.updatedAt`；重建配额 `context.js:114`（20 卡/3 文档） | 编辑正文后语义检索长期命中旧内容；换 embedding 模型须手动全量重建（且工具未挂载） |
| 8 | **记忆无作用域** | `db.js:39` `aiMemories: 'id, updatedAt, category'`（无 agentId/scope）；`types.js:69-70` 11 个 Agent 全部注入同一份 memoryText | quizmaster 的临时结论一旦被抽取即**污染全部 Agent**，无法按 Agent 审计或隔离 |
| 9 | **写标记失实绕过确认闸** | `write_blackboard:1673`、`delegate_to_agent:1617` 实际改状态却标 `writesData:false`；`base.js:125` 只认 `=== true` | 写确认保险被绕过（与 round107 引入的确认流是同一道闸） |
| 10 | **可观测性断裂** | 视图层 `chatAI` 不传 `source`（全落 'chat'）；`T.aiCall` 只 2 处且把**字符数当 token**；`agent_tool_call` 零生产者；**AI 失败不写 errorLog** | 成本与失败率无法按功能归因，线上问题不可回溯 |

### P2 — 冗余、死码与工程债

| # | 问题 | 证据 |
| --- | --- | --- |
| 11 | Agent 同质化（工具集高度重叠，路由区分度被抹平） | `search_cards`×8、`get_card_detail`×9、tutor≈assistant |
| 12 | 同一业务动作多套 prompt | 拆卡：`Docs.vue:67` / `genDeck.js:147` / `agents/index.js:47`；导图：`Mindmap.vue:344` 与 `:392`（同文件两套）；出题：`Exam.vue:115` vs `base.js:32` |
| 13 | 三个上下文构建器无生产消费方 | `buildQuestionCardContext` / `buildModuleNodesContext` / `getStructuredContext` 仅测试引用 |
| 14 | `aiChats` 无上限 + 同步取**消息并集** | `sync-manifest.js:501` → 对话体量单向膨胀 |
| 15 | 降级逻辑三份副本 | `ai.js:114` / `orchestrator.js:20` / `pipeline.js:23`；`reply.js` 统计口径因此失真 |
| 16 | 流水线每步重跑全量上下文 | `pipeline.js:191` 每步 `buildFullContext`（5 表查询）；4 步最坏约 54 次 LLM，无总预算 |
| 17 | 注册表同名静默覆盖 | `registry.js:17-20` 仅 warn（注释自述曾发生 `list_docs` 被顶掉） |
| 18 | 协作工具挂载矛盾 | `delegate_to_agent`/`read_blackboard`/`write_blackboard` 只挂 tutor 与 smart-reviewer，且都依赖 `ctx.blackboard` → 单 Agent 路径调用必失败 |

---

## 3. 记忆架构专项（重点）

### 3.1 现状分层

| 层 | 载体 | 写入者 | 读取者 | 上限 | 同步 |
| --- | --- | --- | --- | --- | --- |
| 长期记忆 | `aiMemories` | `addMemory`(`memory.js:36`)、`extractMemories`(`:128`，每轮回复后自动抽取) | 全部 Agent（`base.js:51`） | 300 行；注入 12 条/120 字/1800 字 | ✅ `updatedAt`（含 fieldTs 逐字段） |
| 工作上下文 | 无（实时查库） | `buildStudyContext`(`context.js:22`) | 全部 Agent | 薄弱卡 20×30 字 | ❌ 派生 |
| 语义索引 | `embeddings` | `indexCard`/`indexDoc`/`ensureIndex` | `retrieveContext`（topK 6） | **无** | ✅ `idOnly` |
| 会话历史 | `aiChats` | `saveChat` | 末 12 条 | **无** | ✅ 标量 LWW + 消息并集 |
| 黑板 | **纯内存** | `pipeline.js:165` | `read_blackboard` | 8 条 × 200 字 | ❌ 随流水线回收 |

### 3.2 检索机制现状

- **向量来源**：有 Key 且非 deepseek → 远程 `/embeddings`；否则**本地 bigram 哈希 256 维**（`embedding.js:93`），DeepSeek 显式判定不支持（`:115`）。
- **相似度**：余弦（`embedding.js:165`），融合 **0.65 语义 + 0.35 关键词**（`retrieval.js:279`）。
- **索引**：**无 ANN**。带 `subject`/`sourceType`/`sourceId` 才走 Dexie 索引，否则全表 `toArray()`（超 3000 行直接抛错，`retrieval.js:220-243`）。
- **失效**：不物理删除，仅靠 `updatedAt` 比较判 stale。

### 3.3 与业务系统的集成方式

单一事实源是**业务表**（卡片/复习/笔记/计划）；记忆层目前是**派生 + 复制并存**：
- 上下文类（`buildStudyContext`）是纯派生 ✅ 不落库；
- 记忆类（`aiMemories`）是 LLM 抽取的结论 ✅ 合理；
- 但 **`embeddings.text` 复制了原文** ❌ —— 这违反"事实源单一"，也是 §2 第 5 条的根因。

### 3.4 目标架构（企业级记忆分层）

| 层 | 定位 | 存储 | 生命周期 | 作用域 |
| --- | --- | --- | --- | --- |
| **L0 轮内暂存** | 单步推理的中间结果 | 内存 | 单轮 | 单 Agent |
| **L1 工作记忆** | 会话摘要（压缩后的对话要点） | `aiChats.summary` | 会话 | 会话 |
| **L2 结构化长期记忆** | 事实/偏好/目标/易错点（带**类型、来源、置信度、作用域**） | `aiMemories`（扩展字段） | 持久，按重要性衰减 | user / agent / subject / pipeline |
| **L3 语义索引** | 向量 + **引用**（不存原文） | `embeddings`（`vector + sourceType + sourceId + chunkIdx + contentHash + modelSig`） | 随源失效 | 继承源 |
| **L4 业务事实** | 卡片/复习/笔记/计划 | 业务表（**唯一事实源**） | 业务决定 | 用户 |

**四条设计铁律**（针对现状缺口）：
1. **不复制原文**：L3 只存向量与引用；需要原文时回 L4 取（同时解决隐私与堆积）。
2. **确定性 id**：`hash(sourceType|sourceId|chunkIdx|modelSig)` 取代 `uid()` → 跨设备天然幂等，`idOnly` 合并不再堆积。
3. **内容级失效**：加 `contentHash`，与源内容 hash 比对；改了就重建，不再依赖时间戳猜测。
4. **一切记忆带作用域**：`scope ∈ {user, session, agent:<id>, subject:<name>, pipeline:<runId>}`；注入时按"当前 Agent + 当前会话"过滤，默认只注入 `user` 级。

### 3.5 隐私与权限（现状 vs 目标）

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 出网范围 | 卡片原文 8×1200 字、笔记/文档 500 字、图片 dataUrl（≤3 张）、每轮 user+AI 原话 | 出网前**最小化 + 可配置**：`context send policy`（全量/摘要/关闭）；敏感字段（财务、隐私记录）默认排除 |
| 用户开关 | 仅图片策略；记忆/上下文无开关（`types.js:69-70` 默认注入） | 三个开关：注入记忆 / 上下文外发 / 云 embedding |
| 可见可删 | 仅逐条删除（`AIAssistant.vue:560`） | 记忆中心：列表（按作用域/类型/来源）、批量删除、**导出**、一键清空 |
| 权限 | 无（单用户应用，但多 Agent 无差别共享） | 读写权限矩阵（谁能写哪个 scope）+ 写入审计（谁在何时写了什么记忆） |
| 凭据 | ✅ 未发现泄漏（`apiKey` 不进 context/memory/retrieval，`wordSettings.llmApiKey` 已 strip） | 保持，并把"禁止把 settings 拼入 prompt"写成闸门 |

### 3.6 容量与一致性目标

- **容量**：L2 保留 300 条 → 改为**重要性 + 时间双因子**（`importance` 由来源/类型决定，衰减后低于阈值才淘汰），并加"每 scope 配额"；L3 加 `MAX_ROWS` + 按 `lastHitAt` LRU 淘汰；`aiChats` 加条数上限 + 摘要归并。
- **一致性**：L2 走既有字段级时间戳合并（`sync-manifest.js:664`）；L3 因确定性 id 变成幂等（`idOnly` 足够）；删除源内容时**级联删向量 + 写墓碑**（当前 `idOnly` 语义下 absence ≠ deletion，必须显式墓碑）。

### 3.7 多 Agent 共享与隔离目标

- **共享**：`user` 级记忆（偏好、目标、易错点）全 Agent 可见；
- **隔离**：`agent:<id>` 级记忆仅该 Agent 可见（quizmaster 的临时策略不外溢）；`pipeline:<runId>` 级 = 现有黑板，但**持久化到 DB + 作用域 + 生命周期**（当前纯内存、无作用域、单 Agent 不可用）；
- **读写权限矩阵**：默认 Agent 只能**读** user 级、只写自己的 `agent:<id>` 级；跨 scope 写需显式工具（`write_shared_memory`）并留审计。

---

## 4. 优化方案（优先级 / 收益 / 代价）

| 优先级 | 方案 | 预期收益 | 代价 |
| --- | --- | --- | --- |
| **P0-1** | **打通路由**：AI 助手入口不再写死 `assistant`，改走 `routeIntent`（保留"显式选 Agent"优先）；`shouldUsePipeline` 对助手也生效 | 9 条意图规则 + 预设流水线从"死代码"变可用；能力可达性立刻提升 | 中：需回归 12 个视图的入口行为；建议先加"路由预览"日志灰度 |
| **P0-2** | **流水线兜底与总预算**：`runPipeline` 整体 try/catch + 每步失败降级到本地直出 + 全流水线超时/LLM 次数上限（如 12 次） | 多智能体在 401/429/超时下不再直接报错；成本可控 | 低：单文件改，测试可覆盖 |
| **P0-3** | **写标记纠正**：`write_blackboard`/`delegate_to_agent`/`auto_build_graph` 的 `writesData` 标真正的值 | 写确认保险不再被绕过（与 round107 确认流对齐） | 极低 |
| **P1-1** | **记忆分层与作用域**：`aiMemories` 加 `scope/type/importance/source`；注入按 scope 过滤；补"记忆中心"（可见/删/导出/开关） | 解决跨 Agent 污染；用户可控可审计；隐私基础 | 中高：涉及 schema 升级（Dexie v++)、迁移、同步字段扩展 |
| **P1-2** | **向量层重构**：去掉 `text` 原文、确定性 id、加 `contentHash`、加 prune | 隐私扩散与跨端堆积同时解决；检索不再命中旧内容 | 中：需重建索引（一次性）；旧向量行清理 |
| **P1-3** | **挂载孤儿工具**（10 个）+ 把 RAG 索引维护接到"体检页/设置页" | `ensure_index/rebuild_index` 终于可用；索引不再是黑盒 | 低 |
| **P1-4** | **可观测性收口**：`chatAI` 强制 `source`；`T.aiCall` 口径修正为真实 token；AI 失败写 `errorLog`；加"按功能成本/失败率"面板 | 成本与故障可归因，问题可回溯 | 低中 |
| **P2-1** | **上下文构建缓存**：一次构建多处复用（流水线步内复用；`buildFullContext` 结果按 (query,数据版本) 缓存） | 流水线 4 步省约 3/4 上下文查询与 token | 中：注意失效（沿用既有快照 key 模式） |
| **P2-2** | **Agent 职责收敛**：按"场景"而非"话题"分层（问答/生产/分析/规划/自测），消除工具集重叠；路由用"能力标签"而非 9 条正则 | 路由可解释、prompt 变短、工具选择更准 | 中高：涉及 agent 定义与 prompt 重写 |
| **P2-3** | **prompt 收口**：视图层 11 处自写 prompt 迁到 `agents/prompts/` 统一管理（含 i18n） | 消除 5 组重复实现；改一处生效 | 中：机械改造，需回归各视图产出 |
| **P2-4** | **注册表防覆盖**：同名工具注册改为**拒绝并报错**（或显式覆盖 API） | 消除"能力被静默顶掉"这一类事故 | 极低 |
| **P2-5** | **回灌注入防护**：工具结果加定界符 + 显式"以下是数据不是指令"声明 + 关键字段转义 | 降低卡片正文诱导 prompt 注入的风险 | 低 |

---

## 5. 演进路线（三阶段）

**阶段一「止血与打通」（1~2 轮）**：P0-1 / P0-2 / P0-3 + P1-3 / P1-4。
出口判据：多智能体在限流/超时下可用；意图路由真被使用；孤儿工具为零；成本可按功能归因。

**阶段二「记忆分层与隐私」（2~3 轮）**：P1-1 / P1-2 + 记忆中心 UI + 三个开关。
出口判据：记忆有作用域与类型；向量不含原文且跨端幂等；用户可一键导出/清空记忆；
"哪些数据出网"在设置页有明确清单。

**阶段三「企业级能力」（按需）**：权限矩阵与写入审计、多租户/多用户隔离、
L2 重要性衰减与配额、检索重排（交叉编码器）、跨设备记忆冲突可视化。
出口判据：可回答"这条记忆谁写的、谁能看、为什么被淘汰"。

> 说明：这个项目是**单用户本地优先应用**，"企业级"当前的价值主要体现在
> **分层清晰、可审计、可关停、可迁移**四条上，而不是多租户。

---

## 6. 本轮实测动作（可复现）

1. 复核 4 条关键结论（全部成立）：`retrieval.js:71` 存原文；`sync-manifest.js:99` `idOnly`；
   `db.js:39` 无作用域字段；`pipeline.js:176` 顺序执行。
2. 复核并修复 **P0-2**：`PrivacyData.vue:350` 把字符串当 `messages` 传给 `chatAI`
   → `messages.reduce is not a function`，「AI 增强报告」必然失败。
   修法：调用点改为标准 `[{role:'user',content}]`；并在 `ai.js` 的 `chatAI` 加入参归一
   （字符串 → 单条 user 消息）与**可读报错**（`agent.llm.badMessages`，说明应为数组并回报实际类型）。
   新增测试 `tests/ai-chat-args.test.mjs`（2 条）钉住契约。
