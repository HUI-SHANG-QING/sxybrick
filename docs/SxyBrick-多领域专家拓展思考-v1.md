# SxyBrick 多领域专家拓展思考（v1）

> 生成时间：2026-08-27 · 基线：main @ ee8b39c（145 项单测全绿）
> 方法：站在七个领域的顶级专家位置，审视当前资产（代码/数据/架构），找出可拓展、可联动、可交叉的方向。每个方向都锚定到已有代码与数据表——不做空中楼阁。

## 当前资产盘点（思考的事实基础）

| 资产 | 位置 | 状态 |
|---|---|---|
| FSRS-4.5 调度器 + 19 权重训练器 | fsrs.js / analytics worker | ✅ 可用，25 项单测 |
| 双调度器（SM-2 可切换）+ 字段级合并 | srs.js / sync.js | ✅ |
| 复习会话编排：三维交错 + 检索分级 + 间隔效应 | algorithms/session.js | ✅ 7+ 项单测 |
| 10 个 Agent + 工具协议（registerTool/registerAgent 运行时扩展点） | agent/ | ✅ |
| 12 张数据表（含 userOps 埋点、privacyRecords、graphEdges） | db.js v6 | ✅ |
| 统一数据访问层 + 纯函数层 | analytics.js / repo-core.js | ✅ 刚抽完 |
| 同步链路：墓碑 + 双时间戳字段合并 + 局域网 hub | sync-manifest.js / hub.js | ✅ |
| 已有模块：易混对决 / 费曼 / 番茄 / 模考 / 思维导图 / 周报 / 成就 / 主动提醒 / 单科诊断 / 资产健康度 / 自动计划 | views/ | ✅ |
| 前测冷启动（pretestStability） | algorithms/pretest.js | ✅ |

---

## 一、学习科学专家视角（Bjork / Pashler / Karpicke 的位置）

**已有的认知科学武器**：间隔重复（FSRS）、交错练习、测试效应（前测+复习即测试）、检索难度分级、精细性提问（错因分类）。

### 可拓展

**1. 校准回测（Calibration Curve）—— 最高杠杆**
学习科学最硬的检验是「预测 vs 实测」。我们有 FSRS 的可提取性 R(t)，也有每条复习记录的实际结果（rating）。把历史复习按预测 R 分桶（如 0.5-0.6、0.6-0.7…），画出「预测记忆概率 vs 实际正确率」曲线：
- 若曲线偏离对角线 → 说明权重训练有问题，直接指导 FSRS 调参；
- 这是**纯函数**（输入 reviews + cards 的 fsrs 状态，输出分桶统计），完全符合 N9 抽取模式，一次开发两处受益（dashboard 可视化 + agent 工具 `calibration_report`）。
- 数据已全部存在（reviews.rating + cards.fsrs.{s,d,last}），零新增采集成本。

**2. 期望难度自动化（Desirable Difficulty 调节器）**
Bjok 的核心洞见：最优学习发生在「快忘但还没忘」的临界点。现在 desiredRetention 是全局配置 → 可做成**每科自适应**：某科遗忘率高 → 自动下调目标留存率（更密集）；掌握度高的科 → 上调（更省时）。`getStats().forgotTrend` + `mastery` 数据已齐。

**3. 反馈延迟选项（Delayed Feedback）**
即时反馈不总是最优（Kornell & Metcalfe：错题延迟反馈促进辨别学习）。实现成本低：错题模式下延迟 N 秒揭示答案 + 延迟期间显示「再想 10 秒」提示。一个 Review.vue 开关 + repo.review 一个参数。

**4. 生成性练习（Generative Learning）升级**
费曼是生成学习的特例。可加：
- **自我解释钩子**：卡片答错后强制 30 秒「用自己的话解释为什么错」（文本存入 review 记录，成为错因分析的语料）；
- **绘图回忆**（dual coding）：纯概念卡（如计组结构图）支持「先画后看」——画板用 SVG path 记录，与原图叠加对比。

**5. 昼夜节律调度（已有数据未被利用）**
`getStats().hourly` 已记录 24 小时复习分布 → 反向输出「你的黄金复习时段」推荐 + `bestWorstPartners` 已有骨架。番茄模块联动：在高效时段弹出「现在复习效率最高」提醒（proactive.js 已有通知管道）。

---

## 二、SRS 领域专家视角（FSRS 作者 / Anki 社区的位置）

**1. 到期洪峰预测（Due Forecast）**
现在每日负载只在当天计算。加一个纯函数 `forecastDue(cards, days)`：按 dueAt 直方图 + 假想复习推进，预测未来 30 天每日到期量 → 「下周三将有 210 张到期」预警 → 提前触发自动计划重排。数据（dueAt/intervalDays/fsrs.s）已全有，纯函数可单测。

**2. 顽错卡（Leech）语义治理**
`isWrongFreq: wrong >= 3` 已有标记。下一步：顽错卡自动聚类——按 tags + subject + 失败时错因分组，交给 cardsmith agent 批量生成「辨析卡」（同组易混概念放一张对比表卡）。现有 graphEdges.contrast 边正好承载。

**3. 预测-实测回归（与校准回测互补）**
对每张卡画「理论遗忘曲线（fsrs.s）vs 实际复习散点（rating 时间序列）」——CardInsight 页已有 ForgettingCurve 组件，只差把实测点叠上去。

**4. 增量阅读（Incremental Reading 的最小版）**
SuperMemo 的杀手锏。docs 表 + extract 已具备雏形：读一篇 AI 文档 → 划选段落 → 一键「转卡或待重读」，重读队列也走 SRS 调度（docs 表加 srs 字段即可，sync-manifest 加一行）。这是**资料资产化**与**复习调度**的交叉点。

---

## 三、资料资产化专家视角（Building a Second Brain 的位置）

**核心叙事升级：从「卡片库」到「知识资产负债表」**

**1. 知识净值（Knowledge Net Worth）仪表盘**
卡片 = 资产，复习 = 维护投入，遗忘曲线 = 折旧曲线。用 fsrs.s（稳定度）加权每张卡的「当前价值」= R(t)×内容权重（difficulty/来源稀缺度）→ 总和即知识净值。日趋势线 = 你今天赚/亏了多少记忆。ECharts 已引入，`getAssetHealth` 已有资产盘点骨架——本质是把 `asset health` 从「找坏账」升级为「算总账」。

**2. 源→卡→数据 全血缘**
- 卡已有 `source`（来源）与 `sourceCardId`（变式溯源）；
- 补齐：每张卡回链到原文档（docs.id）→ 任何错题可一键「回到原文语境」，AI 问答时 context.js 注入原文段落而非仅卡片摘要；
- 数据结构零改动（source 字段复用），主要是导入管道在拆卡时写血缘。

**3. Anki .apkg 真解析导入——资产化的最大入口**
现在只有文本互通。.apkg 本质是 zip(collection.anki2 = SQLite)。方案：
- 零依赖路线：`fflate`（14KB）解压 + 卡片数据用正则/结构化解析（SQLite 文件解析可用 `sql.js` WASM，按需加载不进首屏）；
- 价值：一次导入即迁移百万 Anki 用户的存量资产——这是获客级功能，且完全本地（符合本地优先人设）。
- 反向：备份格式已是 JSON，写一份公开 schema spec + 版本号，第三方可写导出器。

**4. 渐进总结分层（Progressive Summarization）**
docs 阅读器加三层标注：原文 → 加粗 → 高亮 → 转卡。标注数据存 docs.annotations（新表，manifest 加一行）。与增量阅读（二.4）合并成一个「资料工作台」特性。

---

## 四、交叉融合领域（组合创新）

| 交叉点 | 已有 A | 已有 B | 融合产物 |
|---|---|---|---|
| 学习 × 行为经济学 | streak/成就 | 变式卡 | **变量奖励抽卡**：每日首答全对抽一张「稀有变式卡」（稀缺性驱动启动） |
| 番茄 × SRS | pomoSessions | reviewQueue | **专注模式自动排程**：开 25 分钟番茄时自动按「R 值临界卡」组队，结束即小结 |
| 图谱 × 游戏 | graphEdges | 成就系统 | **知识领地**：图谱节点按科目着色，全部前置掌握即「点亮省份」，仪表盘变成认知地图 |
| 对决 × 社交 | 易混对决（单机） | 局域网 hub | **双人易混对决**：hub 广播题目、双方抢答——hub 已有 WebSocket 基础，纯增量 |
| 语音 × 费曼 | 语音评测 applyCardFeedback | 费曼练习 | **口语背诵卡**：正面→口述答案→语音相似度评分直接作为 rating 输入 SRS |
| 埋点 × Agent | userOps | context.js | **行为画像 agent**：bestWorstPartners 的 16 组合已有，让 planner agent 直接消费并给出个性化建议 |

**最有含金量的交叉**：知识领地。它把 graphEdges（结构性数据）、掌握度（mastery）、成就（情感反馈）三者已有的数据用一层皮肤连起来——**零新增数据采集，纯可视化层开发**。

---

## 五、产品二次开发领域（平台化视角）

**1. 用户脚本插件系统（把 registerTool/registerAgent 暴露给终端用户）**
架构已具备运行时注册扩展点，缺的是「安全暴露」：
- 声明式 spec（JSON 描述工具名/参数 schema/提示词）+ 表单自动生成 UI；
- 用户脚本跑在受限 eval（无 localStorage/db 直写，只能经白名单工具）；
- 卡片类型渲染器注册表：mermaid 图卡、代码填空卡、听写卡——每种只是「渲染 + 校验」一对函数，注册即用。
- 这让 SxyBrick 从「功能固定产品」变成「学习工具操作系统」。

**2. repo.js 门面 = 天然 SDK**
repo.js 是稳定门面（148 行注释清晰）。导出 `window.SxyBrick = repo API`（开发模式）→ 用户可在控制台/油猴脚本操作自己的数据——高级用户的自服务入口，成本一行。

**3. 主题系统**
styles.css 已大量 CSS variables → 补「自定义主题 JSON」（存 meta 表，同步链路免费带走）。

---

## 六、产品生产领域（从 demo 到可托付产品的差距）

这是当前**最弱的一环**：145 项单测全部是纯函数层，还没有一条集成测试。

**1. E2E 测试（最高优先级）**
- Playwright + GitHub Actions（免费额度充足）；
- `fake-indexeddb` 补充 Node 下集成层测试（importBackup 全流程、同步合并、复习→统计闭环——这些正是最近重构最多的地方）；
- 先写 3 条黄金路径：新建卡→复习→到期再出现；导入备份→冲突合并正确；删除→墓碑→另一设备同步删除。

**2. 数据安全**
- **客户端加密备份**：Web Crypto AES-GCM + passphrase，备份导出时可选加密（现在 hub token 是明文本地网络）；
- 备份提醒：已有 streak，加「距上次备份 N 天」的 proactive 提醒（管道已有）。

**3. 可观测性**
userOps 已是 A 级埋点 → 加 `window.onerror` ring buffer（最近 50 条错误存 meta），设置页一键导出诊断包（隐私优先：本地存储、用户主动导出）。

**4. 性能压力线**
万卡规模基准脚本（Node + fake-indexeddb）：reviewQueue、computeStats、hybridSearch 在 10k 卡下的耗时回归门禁。防止性能腐化无感知。

**5. 发布工程**
tag → 自动 changelog（conventional commits 已在用）→ GitHub Release 附备份 schema spec 文档。

---

## 七、项目拓展领域（影响力与复用）

**1. 开源运营硬伤先行**
仓库根目录混乱（new_card/ vs 旧 server/ web/）：把 new_card 提升为仓库根、旧代码归档到 legacy/ 分支，README 重写（30 秒说清：本地优先考研 SRS + 在线 demo 链接 + 三行特性）。这是**所有后续传播的前置条件**。

**2. 学习科学的「活论文」**
unique 优势：interleave on/off、retrieval grading on/off 都是天然 A/B 开关（localStorage 配置）+ userOps 已记录行为。写一个「导出匿名实验数据」功能 → 用户自己跑 n=1 实验，数据可以汇总成社区报告。学术性与产品叙事双赢。

**3. 垂直领域预设包**
内核通用、错因分类/科目模板/预设 Agent 人格可打包：法考（错因=法条混淆）、医学（错因=鉴别诊断）、语言（错因=搭配误用）。复用 repo-core + agent registry，各领域只是配置。

**4. 全离线 AI（WebLLM/transformers.js）**
llm.js 已是 OpenAI 兼容端点抽象 → 接 WebGPU 本地推理端点，实现「断网也有 AI 拆卡」——与本地优先人设完全自洽，且是差异化的技术展示。

---

## 优先级建议（按质量杠杆排序）

| # | 事项 | 领域 | 成本 | 理由 |
|---|---|---|---|---|
| 1 | 校准回测（纯函数+可视化） | 学习×SRS | 低 | 检验整个调度器科学性的唯一硬指标，数据已全有 |
| 2 | E2E + fake-indexeddb 集成测试 | 生产 | 中 | 145 单测全是纯函数层，黄金路径无守护；最近重构最多处恰是风险最高处 |
| 3 | Due Forecast 到期洪峰预测 | SRS | 低 | 纯函数可测，自动计划直接消费 |
| 4 | 知识净值仪表盘 | 资产化 | 中 | 把已有资产健康度升级为总账叙事，差异化最强 |
| 5 | apkg 导入 | 资产化 | 中高 | 获客级入口，全本地 |
| 6 | 用户脚本插件系统 | 二次开发 | 高 | 平台化跃迁，建议在 1-5 稳定后启动 |
| 7 | 仓库结构重组 + README | 拓展 | 低 | 一切传播的前提，随时可做 |

**一条主线贯穿**：SxyBrick 的护城河不是任何一个功能，而是「全部数据本地 + 全链路可测 + Agent 可扩展」的**骨架**。以上所有方向都不需要推翻任何现有设计——这正是这轮 N1-N9 工程治理最大的红利。
