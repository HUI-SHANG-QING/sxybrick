# SxyBrick 多视角技术分析报告

> 分析性质声明：本报告**仅做技术审视与论证，不包含任何代码改动**。所有结论均基于项目当前真实代码状态（`new_card/` 目录，版本 `package.json@2.0.0`，`db.js` 已演进至 v12）的逐文件核查。
> 视角覆盖：软件开发工程师、架构设计师、前端开发工程师、后端开发工程师、算法开发工程师、AI（A 进程）应用开发、AI 架构开发，以及相关领域（学习科学 / 数据资产化）开发者。

---

## 0. 一页速览（给决策者的结论）

| 维度 | 结论 |
|---|---|
| 开发者水平 | **高级（Senior）个体 / 强小团队**；架构视野达到 Architect 级，工程严谨度（测试、可观测、运维）尚未达到 Principal 级 |
| 当前形态 | **纯前端 PWA + 浏览器内本地优先（IndexedDB）**；唯一"后端"是 `sync-hub/hub.js`（Node 局域网中继，非必选）；AI 计算全部发生在**用户配置的远程 LLM API**（DeepSeek/OpenAI 兼容端点） |
| 技术栈成熟度 | 主流且合理：Vue3 + Vite6 + Pinia + Element Plus + Dexie + ECharts + KaTeX + Three.js；AI 侧为自研轻量 Agent 框架 + 远程 LLM 适配 |
| 最大亮点 | `sync-manifest.js` 作同步"唯一事实来源"被前后端共用；双时间戳字段级合并 + 带 kind 墓碑，分布式同步正确性设计教科书级 |
| 最大硬伤 | 同步正确性 bug（错因 `wrongReason` 与短期巩固 `consolidation` 归类错误，跨设备可能静默丢失）；无离设备加密备份；测试仅覆盖 2 个纯函数模块；多处全表 O(n²) 主线程计算 |
| 商业化可行性 | **高**。本地优先内核可直接保留为"离线壳"，云后端（账号/云同步/付费/内容市场）为增量建设，不推倒重来 |

---

## 1. 开发者水平评估

### 1.1 判断依据（按视角拆解）

**（1）架构设计师视角 → 高级 / Architect 级视野**
- 用 `src/sync-manifest.js` 把"该同步哪些表、如何合并"收敛为**单一事实来源**，被浏览器端 `sync.js` 与 Node 端 `hub.js` 同时 import——从根上消灭"三处合并逻辑漂移"这类分布式系统经典 bug。这是**有分布式系统经验**的人才会主动做的事。
- 同步设计采用"内容字段按 `updatedAt`、SRS 字段按 `reviewedAt`"的**双时间戳字段级合并**，并引入带 `kind` 的墓碑传播。这等价于 CRDT-lite 的工程化取舍，方向正确。
- 分层清晰：`db / repo / analytics / agent / views` 各司其职，依赖方向单向（视图 → 业务 → 数据），耦合可控。

**（2）前端开发工程师视角 → 高级**
- Vite6 手动分包（`manualChunks`）+ 路由懒加载 + 重型依赖（Three/Markdown）按需加载，说明**懂首屏体积优化**。
- 主题系统演进到 Pinia store（`stores/theme.js`）解耦样式/模式，并引入 Element Plus 统一组件。
- PWA（`vite-plugin-pwa`，`autoUpdate`、离线壳）落地完整，说明具备"离线优先"产品思维。
- 不足：全量仍用**纯 JavaScript**（非 TS），24 个视图规模下类型安全缺失会在团队协作时放大维护成本。

**（3）后端开发工程师视角 → 中性偏正面（但当前无后端）**
- 当前**没有应用后端**，所有业务逻辑在浏览器跑。这意味着"后端能力"尚未被本仓库直接证明。
- 但 `sync-manifest` / 合并函数 `mergeRows` / `mergeTombstones` / `applyTombstones` 的纯函数化、可测、可复用，体现了**后端思维下沉到数据层**的良好习惯——一旦引入 Spring Boot，这些纯函数可被直接移植为服务端逻辑。

**（4）算法开发工程师视角 → 高级（应用层）/ 中等（ML 层）**
- SRS：在 SM-2 之上叠加"当日 6h + 隔日"短期巩固窗口，并引用 Roediger & Karpicke (2006) 提取练习理论——**认知科学方向正确**，不是拍脑袋参数。
- 算法层（弱卡排序、易混对挖掘、学习画像六维、质量评分、去重）均为**确定性启发式**，工程清晰、可解释、可控。
- 短板：语义检索引擎 `embedding.js` 是**哈希局部敏感类"伪向量"**（非真实 transformer embedding），`retrieval.js` 的混合检索在大规模语料下语义召回会显著弱于真 embedding——这是"算法正确但 ML 深度不足"的典型体现。

**（5）AI（A 进程）应用开发 / AI 架构视角 → 高级（系统观）/ 中等（工程落地）**
- 自研了一套**完整的轻量 Agent 基础设施**：Registry（Agent/工具注册）、ReAct 循环（`agents/base.js`）、多 Agent 流水线（`pipeline.js`：预设流水线 + LLM 自动分解 + 黑板共享 + 聚合）、主动智能体（`proactive.js`：后台调度器 + 通知 + 规则优先 + AI 增强）。
- 工具协议用文本 `<tool>..</tool><args>{}</args>` 而非原生 function calling，明确写注释"保证任意 OpenAI 兼容端点都能跑通"——这是**务实的兼容性工程决策**，值得肯定。
- 离线兜底 `offlineAI.js`（本地启发式组卡/变式 + 诚实引导）体现了对"AI 不可达时可用性"的工程敬畏。
- 短板：Agent 运行时**完全跑在浏览器主线程**，工具执行（如全表扫描 analytics）会阻塞 UI；无 agent 级别的**可观测性**（trace 仅面向 UI 展示，无结构化日志/评估）、无 LLM 缓存/降级熔断策略、无多租户隔离概念。

**（6）学习科学 / 数据资产化领域视角 → 高级**
- 把"提取练习 + 间隔重复 + 交错 + 测试效应"映射到具体功能（费曼、错题、变式、图谱、智能复习清单），不是堆功能。
- "数据主权归还用户"理念领先：多通道导出（JSON/CSV/Anki/署名卡组）+ 资产体检（`gistBackup`、同步清单）。
- 但"资产化"主张与"无离设备加密备份"形成**结构性矛盾**——这是后续商业化必须补齐的一环。

### 1.2 综合定级

> **定级：高级（Senior）个体开发者或小团队，架构视野达到 Architect 级，工程运营成熟度（测试金字塔、CI/CD 深度、可观测、安全）尚未达到 Principal 级。**
> 关键支撑：分布式同步正确性设计、自研 Agent 框架、离线优先 PWA、认知科学驱动的 SRS——这些都不是初级/中级能稳定产出的。限制其封顶的因素是：单人 bus-factor=1、测试广度不足、无后端、无运维与可观测体系。

---

## 2. 完整技术栈说明（含各自承担的角色）

### 2.1 前端（表现与交互层）
| 组件 | 版本 | 角色 |
|---|---|---|
| Vue 3 | ^3.5.13 | 核心框架，Composition API，24 个视图 + 组件 |
| Vue Router | ^4.4.5 | 前端路由（含懒加载） |
| Pinia | ^4.0.3 | 状态管理（当前仅 `stores/theme.js`，具备扩展空间） |
| Element Plus | ^2.14.5 | 统一 UI 组件库（替代自研 toast 等） |
| Vite | ^6.0.3 | 构建/Dev Server，手动分包优化 |
| @vitejs/plugin-vue | ^5.2.1 | Vue SFC 编译插件 |
| vite-plugin-pwa | ^0.21.1 | PWA/Service Worker/离线壳，`autoUpdate` |
| KaTeX | ^0.16.11 | 公式渲染（考研数一刚需） |
| marked + highlight.js | 4.3.0 / 11.10.0 | Markdown 渲染与代码高亮（AI 文档/讲解） |
| echarts + echarts-wordcloud | 5.5.1 / 2.1.0 | 统计图表、词云（学习画像、薄弱点） |
| three | ^0.180.0 | 3D 翻转卡 / 角色 / 黑神话风格视觉 |

### 2.2 数据层（本地优先）
| 组件 | 版本 | 角色 |
|---|---|---|
| Dexie | ^4.0.8 | IndexedDB 封装，schema v12，11+ 张表（cards/reviews/images/tombstones/meta/aiChats/aiMemories/memos/plans/graphEdges/docs/pomoSessions/notifications/aiDocs 等） |
| sync-manifest.js | 自研 | **同步唯一事实来源**：`SYNC_TABLES` + `mergeRows/mergeTombstones/applyTombstones` 纯函数 |
| sync.js | 自研 | 浏览器端导出/导入/手动同步 |
| hub.js（Node） | 自研 | 局域网一键同步中继（**非应用后端**，仅本地网络内多设备合并） |

### 2.3 算法层
| 模块 | 角色 |
|---|---|
| `srs.js` | SM-2 变体：难度/遗忘曲线/错因惩罚 + 短期巩固窗口 |
| `analytics.js` | 跨模块数据访问层：弱卡、最近错题、易混对、学习画像六维、知识缺口、图驱动复习路径、自动计划 |
| `utils/genDeck.js` | 卡组生成的质量评分（0-100）、去重（dupScore）、题型决策（basic/cloze/choice） |
| `utils/genVariants.js` | 变式题模板（难度梯度 basic→applied→challenge） |
| `agent/embedding.js` + `retrieval.js` | 轻量"伪向量"embedding + 关键词/语义混合检索（RAG-lite） |

### 2.4 AI / A 进程层
| 模块 | 角色 |
|---|---|
| `agent/llm.js` | LLM 适配层：OpenAI 兼容 `/chat/completions`，支持流式 SSE；**不依赖原生 function calling**，工具以文本协议解析 |
| `agent/orchestrator.js` + `agents/base.js` | ReAct 执行循环（思考→工具→观察→最终） |
| `agent/pipeline.js` | 多 Agent 流水线：预设流水线 + LLM 分解 + 黑板（`blackboard.js`）共享 + 聚合 |
| `agent/agents/index.js` | 10 个内置专业 Agent（tutor/analyst/cardsmith/quizmaster/planner/memorykeeper/mnemonist/mistake-analyst/graph-builder/smart-reviewer） |
| `agent/tools/index.js` | ~40 个工具，分数据感知/卡片生产/测评/协同/RAG 检索/多 Agent 协作六类 |
| `agent/context.js` + `memory.js` | 跨模块上下文注入 + 长期记忆（core/preference/fact） |
| `agent/proactive.js` | 主动智能体：**浏览器内后台调度器**（visibilitychange + setTimeout）+ 规则优先建议引擎 + 可选每日 AI 总结 |
| `utils/offlineAI.js` | 离线兜底：本地启发式组卡/变式 + 诚实引导（无网络不伪装 AI） |
| 远程 LLM API | 实际 AI 算力落点（DeepSeek 默认，可换 OpenAI/本地 llama.cpp） |

### 2.5 基础设施 / 部署
| 项 | 说明 |
|---|---|
| GitHub Pages + Actions | 零成本托管/HTTPS/CI 构建 `dist/` 并发布 |
| base `/sxybrick/` | 子路径部署约定 |
| 测试 | `node --test` 仅覆盖 `srs.test.mjs` 与 `sync-manifest.test.mjs`（2 份） |
| 无后端/无 Python | 全仓库无独立后端服务、无 Python 代码 |

---

## 3. 分层架构设计分析

```
┌─────────────────────────────────────────────────────────────┐
│ 表现层 (Presentation)  Vue3 + Pinia + Element Plus + PWA     │  24 视图 / 组件
├─────────────────────────────────────────────────────────────┤
│ 业务/领域层 (Domain)   repo.js · analytics.js · intelligence │  数据访问 + 跨模块分析
│                         · streak.js · genDeck.js              │
├─────────────────────────────────────────────────────────────┤
│ 算法层 (Algorithm)     srs.js · analytics(弱卡/易混/画像)     │  确定性启发式
│                         · genDeck评分去重 · retrieval/hybrid   │
├─────────────────────────────────────────────────────────────┤
│ AI 层 (A-Process)      agent/(orchestrator·pipeline·10 Agent  │  浏览器内 Agent 运行时
│                         ·40工具·proactive·offlineAI)           │  + 远程 LLM API
├─────────────────────────────────────────────────────────────┤
│ 数据层 (Data)          db.js(Dexie v12) · sync-manifest(唯一  │  IndexedDB + 同步事实源
│                        事实来源) · sync.js · hub.js(局域网)     │
└─────────────────────────────────────────────────────────────┘
        通信机制：视图→（组合式API/Pinia）→ repo/analytics → db(Dexie)
                  视图→ ai.js/agentSystem → llm.js → 远程 LLM（fetch）
                  同步：sync.js ↔ sync-manifest ↔ hub.js（局域网 HTTP）
```

### 3.1 表现层（为什么这样设计）
- **为什么**：考研复习是"高频、碎片化、强沉浸"场景，需要离线可用 + 多端一致 + 视觉激励（游戏级主题）。Vue3 组合式 API 适配"卡片翻转/3D/图谱"等富交互；PWA 离线壳保证地铁/图书馆无网也能背。
- **解耦**：视图只通过 `repo.js` / `analytics.js` / `ai.js` 的导入函数取数，**不直连 `db`**，保证数据访问策略可集中变更。主题用 Pinia store 而非散落 `ref+localStorage`，为后续多 store 扩展留口。

### 3.2 业务/领域层（为什么这样设计）
- **为什么**：`repo.js` 把所有 Dexie CRUD 收敛为语义化函数（`getStats/weakCards/createPlan/...`），`analytics.js` 作为"统一数据访问层"供所有 Agent 与视图取数。这样**算法与 AI 不重复写查询**，且一处优化全局受益。
- **解耦与通信**：业务层依赖数据层（单向）；被表现层与 AI 层双向调用——它是"领域中枢"。

### 3.3 算法层（为什么这样设计）
- **为什么**：SRS / 弱卡 / 易混对 / 画像全部是**纯函数 + 可解释启发式**，刻意不引入重 ML，换取可测、可控、离线可跑。`analytics.js` 的 `getConfusablePairs` 用"同科目 + 共享标签 + 双方均有答错记录"的确定性规则，零依赖即可产出。
- **通信**：算法层被业务层（`analytics.js` 既属业务又含算法）与 AI 工具层（`tools/index.js` 直接 import `getWeakCards/getConfusablePairs/...`）调用，是 AI 的"真实数据眼睛"。

### 3.4 AI / A 进程层（为什么这样设计）
- **为什么**：把 Agent 运行时放进浏览器，是为了**零成本 + 密钥在用户本地**（用户填自己的 API Key，平台不碰密钥、不担算力成本）。ReAct + 流水线 + 黑板是"可扩展多 Agent 协作"的最小完备实现；`registry` 满足开闭原则（新增 Agent/工具只 register，不改内核）。
- **解耦与通信**：Agent/工具通过 `ctx.chat` 抽象访问 LLM（可替换为离线兜底）；通过 `ctx.blackboard` 跨 Agent 传递；通过 `repo/analytics` 接入真实数据。与 UI 的边界是 `runAgentTurn({userInput,history,agentId,onTrace})`——**轨迹回调**实现 UI 实时渲染推理过程。
- **注意**：A 进程本质是"浏览器主线程内的一组定时器 + fetch 调用"，并非独立进程；`proactive.js` 的调度器用 `visibilitychange` 降频，是浏览器环境下"伪后台进程"的合理工程实现。

### 3.5 数据层（为什么这样设计）
- **为什么**：`sync-manifest.js` 是**整个系统最关键的架构决策**——同步表清单 + 合并语义集中一处，浏览器与 Node 中继共用。配合"双时间戳字段级合并 + 带 kind 墓碑"，把"多设备最终一致"这件难事做成了可推演、可测试的工程。
- **通信**：`sync.js`（导出/导入/手动同步）与 `hub.js`（局域网合并）都 import 同一份 `sync-manifest`，保证**同步语义永不漂移**；数据落 Dexie，视图/业务/算法/AI 全部经 `repo/analytics` 间接读写。

### 3.6 各层解耦总评
- 优点：依赖方向单向、关键语义（同步/数据访问）集中、AI 与业务通过函数边界而非硬编码耦合。
- 风险：算法层部分全表 `O(n²)`（如 `getConfusablePairs` 双层循环、多处 `all()` 后 JS 过滤）在主线程跑，千卡级会卡顿；AI 工具执行同步阻塞 UI；A 进程无独立线程/Worker 隔离。

---

## 4. 迁移分析报告：转向中大型全栈 Web 商业项目

> 前置事实：**当前项目没有应用后端**。所谓"迁移到 Spring Boot"，本质是"从零引入一个云后端"，而非"重写现有后端"。本地优先内核（PWA + Dexie）应作为**离线壳保留**，新增云后端提供账号、云同步、付费、内容市场、管理后台。

### 4.1 后端迁移至 Java Spring Boot：改造路径与工作量

**路径 A（推荐）：保留浏览器内核，增量叠加 Spring Boot 云后端**
1. 账号与鉴权：`Spring Security + JWT/OAuth2`，用户体系从"本地 UID"升级为"云端账号 + 设备绑定"。
2. 云同步服务：把 `sync-manifest.js` 的合并语义**原样移植为 Spring Boot 服务端纯函数**（`MergeService`），提供 `/sync/pull` `/sync/push` REST；用 `hub.js` 的局域网合并逻辑作为参考实现。多设备改为"任意设备→云端"而非"局域网两两合并"。
3. 业务 CRUD：`repo.js` 的语义函数映射到 Spring `@Service` + JPA/MyBatis；数据源从 Dexie 换为 PostgreSQL（行级兼容 `updatedAt/reviewedAt` 字段语义）。
4. 付费与内容市场：`Spring Cloud` 或模块化单体 + 支付网关（Stripe/Paddle）；卡组 marketplace 复用现有导出包结构（署名卡组）。
5. 管理后台：用户、内容审核、风控、订阅。

**路径 B（不推荐）：把业务逻辑全搬到 Java 重写**
- 风险：重复实现 srs/analytics/genDeck，且破坏"离线优先"——客户端离线时无法复习。仅当彻底放弃离线场景才考虑。

**工作量评估（路径 A，小团队 4–6 人）**
| 阶段 | 内容 | 估算 |
|---|---|---|
| 数据模型 + 鉴权 | PG schema + Spring Security + 设备绑定 | 4–6 周 |
| 云同步（CRDT-lite 服务端化） | 移植 merge 语义 + pull/push + 冲突解决 | 4–8 周（最难点） |
| 业务服务化 | cards/reviews/plans/docs/agents 的 REST | 6–10 周 |
| 付费 + 市场 + 管理 | 支付、卡组市场、审核后台 | 6–10 周 |
| 合规 + 安全 + 压测 | PIPL/GDPR、加密、限流、性能 | 4–6 周 |
| **合计** | | **约 6–12 个月（1 个里程碑版）** |

### 4.2 算法端：留在 Java 内，还是拆为独立 Python 服务？

**对比分析**
| 算法类别 | 性质 | 最佳落点 | 理由 |
|---|---|---|---|
| SRS（SM-2 变体） | 确定性、无 ML | **Java（Spring Boot）** | 规则明确、需与复习事务同库，放服务端保证多端一致 |
| 弱卡/易混对/学习画像 | 确定性统计 | **Java** | 本质是 SQL 聚合 + 轻规则，PG 直接算，无需 Python |
| genDeck 质量评分/去重 | 启发式 | **Java**（或前端保留） | 规则可解释，无 ML 依赖 |
| embedding / 语义检索 / RAG | **真 ML** | **Python（FastAPI）** | Java 的 LLM/RAG 生态（DL4J 等）远弱于 Python 的 sentence-transformers、LangChain、LlamaIndex、vLLM |
| LLM 编排 / Agent 运行时 | AI 工程 | **Python（FastAPI）** | Agent 框架、tool calling、向量库、可观测（LangSmith 类）生态在 Python 最成熟 |

**推荐方案：混合架构（行业标准拆法）**
- **Spring Boot = 系统之记录（System of Record）+ API 网关 + 业务 + 鉴权 + 付费 + 同步**。承担所有确定性、强一致、需事务的业务。
- **Python（FastAPI）微服务 = "AI 大脑"**：真实 embedding（bge/ multilingual-e5）、向量库（pgvector / Milvus / Qdrant）、LLM 编排（LangGraph 式多 Agent）、RAG、内容理解。通过内网 gRPC/HTTP 被 Spring Boot 调用，或前端经网关直连 AI 服务（带鉴权）。
- **收益**：Java 守稳定与规模，Python 守 AI 迭代速度；两者解耦，AI 服务可独立扩缩容、独立替换模型。

### 4.3 A 进程（AI 进程）迁移 / 替换方案

**当前 A 进程的真实形态**
- 浏览器内 Agent 运行时（orchestrator/pipeline/proactive）+ 远程 LLM API + 本地启发式兜底。**没有独立进程，无密钥隔离，无多租户，无服务端工具执行，无成本/限流/审计。**

**商业化替换方案（优先级从高到低）**

1. **把 Agent 运行时迁到后端 AI 服务（Python FastAPI + Agent 框架）**
   - 浏览器 → 你的 AI 网关 → LLM 供应商。**密钥留在服务端**，用户不再自填 Key（或作为 BYOK 可选），平台统一计费、限流、审计。
   - 服务端工具执行可直连 DB（更安全、更快），流式结果经 SSE/WebSocket 回传前端。
   - 保留现有 ReAct/流水线/黑板/工具协议设计（这些是**好的抽象**，应平移而非重写）。

2. **保留浏览器内"离线 AI 兜底"作为降级**
   - `offlineAI.js` 的本地启发式组卡/变式可继续留在前端，作为"无网络/未订阅"时的可用性保障——这是商业产品的差异化卖点（离线也能学）。

3. **引入 Agent 编排中间件（可选）**
   - 自研轻框架已够用；若团队不强，可换 LangGraph / AutoGen / 托管平台（但会增加供应商绑定）。**建议保留自研 + 借鉴其模式**，因当前设计已贴合教育场景。

4. **可观测与成本治理（必须补）**
   - Agent trace 结构化落库、LLM token 计量、降级熔断、缓存（相同 query 命中缓存），这是"玩具 Agent"与"商业 Agent"的分水岭。

**结论**：A 进程应从"浏览器内脚本"演进为"**后端 AI 微服务（Python）+ 前端离线兜底（JS）**"的双层结构，密钥与算力上云，体验与降级留端。

### 4.4 目标架构（商业化）示意

（见下方内联架构图：客户端 PWA 壳 + Spring Boot 系统之记录 + Python AI 大脑 + 远程 LLM + 向量/对象存储）

---

## 5. 商业化转型路线图

### 阶段 0：巩固内核（1–2 个月，当前可做）
- 修复 P0 同步 bug（`wrongReason`/`consolidation` 合并归类，见上份评审 R1/R2）。
- 补齐离设备**加密备份**（当前 `gistBackup` 为可选非加密，需 AES + 用户口令）。
- 测试广度：从 2 份纯函数测试扩展到 analytics/retrieval/agent 工具层的 Vitest 套件。
- 引入 **TypeScript**（存量 JS 渐进迁移），降低规模化协作风险。

### 阶段 1：云后端 + 账号 + 云同步（3–6 个月）
- Spring Boot 落地（路径 A），把"局域网同步"升级为"任意设备云同步"。
- 订阅/付费（免费本地版 + 云同步/AI 高级版分层）。
- 数据合规（PIPL/GDPR、加密存储、最小采集）。

### 阶段 2：AI 大脑 + 内容市场（6–12 个月）
- 拆分 Python AI 微服务，引入真实 embedding + 向量库 + RAG + 服务端 Agent 编排。
- **数据资产化真正闭环**：用户卡组可署名上架、交易、订阅——把"本地资产"变成"可流通资产"，形成平台网络效应。
- 多端（Web/PWA/小程序/App）统一账号与同步。

### 阶段 3：规模化与硬化（持续）
- 团队配置：前端 2、Java 后端 2–3、Python AI/ML 1–2、DevOps 1、产品/设计 1、QA 1。
- 性能：主线程 O(n²) 全表计算 → 服务端索引查询 + Web Worker 离线计算；PWA 壳 + 服务端数据混合。
- 安全：OWASP 防护、密钥管理（Vault/KMS）、内容审核（用户生成卡组）、限流防刷、SOC2-lite。
- 可观测：前端埋点 + 后端 APM + AI trace/token 计量。

### 技术与选型调整清单
| 维度 | 当前 | 商业化建议 |
|---|---|---|
| 语言 | 纯 JS | 前端渐进 TS；后端 Java/Kotlin + Python |
| 后端 | 无（仅 Node 局域网中继） | Spring Boot（系统之记录）+ FastAPI（AI） |
| 存储 | IndexedDB（单机） | PostgreSQL + pgvector + 对象存储（资源） |
| 同步 | 局域网 hub / 手动 | 云端 pull/push（CRDT-lite 服务端化） |
| AI | 浏览器内 + 用户自填 Key | 后端 AI 网关（密钥隔离/计费/审计）+ 前端离线兜底 |
| 测试 | 2 份 node:test | Vitest + 服务端 JUnit + AI 评估集 |
| 部署 | GitHub Pages 静态 | K8s / 托管 PaaS + CDN + 边缘 |
| 付费 | 无 | Stripe/Paddle（跨境）+ 国内支付 |

---

## 6. 交叉视角的总评（Top 5 风险与 Top 5 机会）

**Top 5 风险**
1. 同步正确性 bug（错因/短期巩固跨设备静默丢失）—— P0。
2. 无离设备加密备份——与"数据资产化"主张直接矛盾。
3. 测试广度不足（仅 2 个纯函数模块），重构无安全网。
4. 主线程重计算（`O(n²)` 全表），千卡级以上体验风险。
5. 单人 bus-factor=1，无后端/运维/可观测体系，规模天花板明显。

**Top 5 机会**
1. 本地优先 + 云同步的"离线壳 + 在线服务"架构，天然适合教育场景（图书馆/地铁）。
2. 自研 Agent 框架（ReAct/流水线/黑板/工具协议）已是**可平移资产**，商业 AI 产品可直接复用抽象。
3. `sync-manifest` 单一事实来源设计，使"局域网→云端"同步演进成本可控。
4. 认知科学驱动的 SRS + 错题/费曼/变式/图谱闭环，构成真实学习闭环（非功能堆砌）。
5. 数据资产化 + 内容市场，可把"工具"升级为"平台+网络效应"。

---

*报告完。本文件为纯分析产物，未对任何源码进行修改。如需进一步针对某一项（如 Spring Boot 数据模型草案、Python AI 服务接口契约、或同步语义的服务端移植方案）做更深入的设计，可在此基础上继续。*
