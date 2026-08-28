# SxyBrick 开发路线图（v1）

> 本文是七领域专家拓展思考（见《SxyBrick-多领域专家拓展思考-v1.md》）落地后的**整体规划与进度跟踪**。
> 唯一主线：**全部数据本地 + 全链路可测 + Agent 可扩展**。所有方向都不需要推翻现有设计。
> 数据安全拓展（隐私合规 / 加密 / 多租户隔离）**按用户要求暂缓**，留待后续单独规划。

---

## 一、已落地（截至 2026-08-27，均可查 git 提交）

### 工程治理（N1–N9）
| 编号 | 内容 | 关键文件 |
|---|---|---|
| N1 | 检索双全表扫 → 单次加载 + subject/sourceType 索引裁剪 | `src/agent/retrieval.js` `retrieval-core.js` |
| N2 | 过期记忆分级纯函数（stale/near/extinct） | `src/agent/stale.js` |
| N3 | 黑板归因纯函数 | `src/agent/attribution.js` |
| N4 | 前置依赖多层 BFS 回溯（防环/穿透） | `src/algorithms/prereq.js` |
| N5 | 工具链 subject 参数透传 | `src/agent/tools/index.js` |
| N6 | （P0）同步导入去重不吞纯复习卡 | `src/sync.js` `sync-dedup.js` |
| N7 | 交错练习 + 检索分级 + 测试间隔效应 | `src/algorithms/session.js` |
| N8 | 复核配置源分裂——判定非缺陷，暂不动 | — |
| N9 | FSRS / repo.js 纯函数层抽取 + 单测 | `src/fsrs.js` `src/repo-core.js` |

### 七方向第一批（按质量杠杆排序执行）
| 方向 | 交付 | 关键文件 | 单测 |
|---|---|---|---|
| 学习×SRS | **校准回测**：预测 R vs 实际正确率分桶，落盘 predR | `src/algorithms/calibration.js` | 10 |
| 生产 | **E2E 集成测试**：fake-indexeddb 三条黄金路径 | `tests/integration.test.mjs` | 3 |
| SRS | **到期洪峰预测**：未来 30 天每日到期量模拟 | `src/algorithms/forecast.js` | 8 |
| 资产化 | **知识净值仪表盘**：内容权重 × R(t) 的「知识资产负债表」 | `src/algorithms/networth.js` | 5 |
| 学习科学 | **每科自适应目标保持率** + **黄金时段推荐** | `src/algorithms/adaptive-retention.js` `golden-hours.js` | 10 |

**测试总量：89 → 181 项（全绿）**，`vite build` 每次通过（约 2500+ 模块）。
**Phase 4 插件系统后：181 → 223 项（全绿）**，构建通过。
**Phase 4 生态打磨后：223 → 233 项（全绿）**，构建通过。

---

## 二、分阶段路线图

### Phase 1 —— 科学性与可信度（✅ 已完成）
- 校准回测、E2E 集成测试、Due Forecast、知识净值、每科自适应保持率、黄金时段。
- 验收：`npm test` 全绿 + 三条黄金路径有集成守护 + 调度器有硬指标。

### Phase 2 —— 学习科学深化（部分完成，剩余高杠杆项）
- ✅ 每科自适应 desiredRetention（弱科多复习、强科省时）。
- ✅ 黄金时段推荐（从 24h 分布找最集中时段）。
- ✅ **延迟反馈**：错题延迟揭示答案（Bjork 间隔揭示效应），Review.vue 独立开关。
- ✅ **自我解释钩子**：错题后（rating=0）弹反思卡写一句话自我解释，落盘 `reviews.selfExplanation`（按 selfExplainAt 跨设备同步）。
- ✅ **校准闭环**：用校准偏差（ECE/Brier）自动微调每科 desiredRetention。

### Phase 3 —— 资产化增强（✅ 全部完成）
- ✅ 知识净值仪表盘（Health.vue 顶部）。
- ✅ **Anki .apkg 真解析导入**：jszip 解压 + sql.js 解析 SQLite，本地零服务端。
- ✅ **源→卡→数据全血缘**：`source-trace.js` 来源归一 + 每来源聚合 + 单卡变式链/同源追溯，Health.vue「来源资产」面板。

### Phase 4 —— 平台化跃迁（主体完成，云端市场留待后续）
- ✅ **用户脚本插件系统**：ES Module 字符串存 `db.plugins`，Blob URL 动态 import；`install/toggle/uninstall/invokeTool/triggerHook/warmup` 全生命周期。
  - ✅ **插件 → Agent 编排器桥接**（平台化关键一跳）：`src/plugins/agent-bridge.js` 纯函数层（MCP inputSchema→参数说明、工具描述、Agent 定义归一、钩子映射、冲突检测）+ `plugins/registry.js` 激活/反激活——安装插件后其工具自动注册进 `toolRegistry`、导出 `agents` 自动注册进 `agentRegistry`，Agent 工作台/多 Agent 流水线直接可用；注册表支持 `unregister` 与 `plugin` 来源标记。
  - ✅ **业务钩子触发点**：repo.js 在 createCard/updateCard（onCardSaved）、deleteCard（onCardDeleted）、review（onReviewRated）、addMemo（onMemoSaved）、saveExam（onExamFinished）后 fire-and-forget 分发；sync.js 在 syncWithHub 成功后分发 onSyncCompleted——`SUPPORTED_HOOKS` 声明与触发点全对齐。
  - ✅ **插件运行时上下文（ctx 只读注入）**：`createPluginCtx` 惰性动态 import 统一数据层（避免 registry→analytics→repo→registry 静态循环）——工具/钩子函数第二参数 `ctx` 含 `ctx.analytics`（错题/到期预测/净值/科目诊断等）、`ctx.data`（备忘录/番茄/计划只读）、`ctx.notify()`（系统通知）；只读无写权限，安全隔离，旧插件单参数完全兼容。
  - ✅ **插件包分发**：`src/plugins/package.js` 序列化/解析 + 导出/导入 .json 单文件（工具市场最小落地形态）。
  - ✅ **官方示例库 ×3**（`src/plugins/examples/`，插件页一键安装，可作开发模板）：`weekly-review`（错题周报：ctx.analytics 聚合 + 周报 Agent）、`pomo-stats`（番茄统计：ctx.data + Agent）、`due-alert`（到期提醒：onReviewRated 钩子 + ctx.notify 超阈值浏览器通知）。
  - ⏳ **云端工具市场**：插件/卡组/主题的远程目录与一键安装，需托管服务 + 来源校验，留待后续。

### Phase 5 —— 项目拓展与传播
- ✅ **仓库结构重组 + README**：确认 git 仓库根即主项目，README 重写（价值主张 + 快速上手 + 架构 + 测试）。
- ✅ **可复现的评测基准**：`fsrs-benchmark.js` + `scripts/benchmark.mjs`，校准质量/训练改善回归门槛纳入 CI。

### Phase 6 —— 资料中心（学习资料中枢，6.1-6.5 主体完成 ⏳ 余 OCR/图谱）
> 详细设计见 `docs/SxyBrick-资料中心规划-v1.md`。从「记忆卡片系统」升级为「学习资料中枢」：上传（PDF/Excel/图片/Word/TXT）→ 全量解析（几百 MB 扫描 PDF 不切片丢内容）→ 原样预览 → 文件问答 → 模块联动（知识图谱第一优先）。
> 已确认决策：**OPFS 存原文件 + IndexedDB 元数据/解析文本**、**本地 OCR 优先可切云端**、**本地检索默认 + 语义 key 开关**、**原文件不跨设备同步（元数据/文本/索引同步）**。
> 关键复用：RAG 全链路（`retrieval.js` chunkText/indexDoc/hybridSearch 现成）、`embeddings` 表（`sourceType:'doc'` 概念已预留）、graph-builder/cardsmith/source-trace 联动地基。
> 阶段进度：
> - ✅ **6.1 存储与上传**：db v17 建 `docFiles`（同步元数据）/`docTexts`（本地全文）两表；`src/utils/opfs.js`（分块写、进度、持久化申请、≤10MB 降级 IndexedDB）；`src/docs-lib.js` 上传编排；`LibraryFiles.vue`（路由 `/materials`，导航「资料库」）+ 存储用量展示。
> - ✅ **6.2 解析管线**：`parsers.js` 纯函数路由 + `parsers-pdf.js`（pdfjs-dist 逐页流式）/`parsers-sheet.js`（SheetJS 全表文本化）/`parsers-docx.js`（mammoth）/txt 直读；串行解析队列 + 进度 + 失败重试；**全量解析不切片**（分块仅是问答检索标签）。
> - ✅ **6.3 索引与预览**：解析完成自动 `indexDoc`（subject=文件名，`retrieveContext` 天然兼容）；预览面板：PDF canvas 翻页（懒加载）/ Excel 表格 / Word 近似 HTML（标注）/ 图片 / 全文文本。
> - ✅ **6.4 文件问答**：`docs-qa.js` 纯函数（prompt 拼装/引用格式化）+ `askDoc`（`hybridSearch` 新增 `sourceId` 限定单文件）+ chatAI 离线兜底；问答面板带引用片段。
> - ✅ **6.5 自动建卡（用户选择制）**：`card-drafts.js` 纯函数（真题 QA 分卡 + 段落要点分卡）；**默认绝不自动建卡**——用户点「生成卡片」→ 预览弹窗 → 逐卡编辑/删除 → 必须「确认导入」才入库（source 记 docFiles.id 血缘可反查原文）。
> - ⏳ **6.5b OCR**：扫描版 PDF 图片提取（本地 Tesseract 优先 + 云端开关）。
> - ⏳ **6.6 联动**：知识图谱抽概念（graph-builder 接解析文本）→ 错题溯源（卡片血缘反查原文段落）→ 复习上下文增强。

---

## 三、暂缓（数据安全，用户明确要求暂不处理）
- 隐私合规（PIPL）、本地数据加密、多租户隔离、导出脱敏。
- 现状已具备：`EXCLUDED_FROM_SYNC`（本地诊断表不同步）+ `PRIVACY_SYNC_TABLES`（敏感表默认 opt-in）骨架，后续可在此之上扩展，无需返工。

---

## 四、开发纪律（延续既有模式）
1. **抽纯函数 + 单测 + 编排层做 IO**：任何新算法先落到 `src/algorithms/*.js`（无浏览器依赖），配 `tests/*.test.mjs`，再在 analytics.js / repo.js / 视图层做 IO 编排。
2. **测试接入即 CI 真实**：新测试文件放 `tests/*.test.mjs`，`npm test` 用 glob + `--test-force-exit` 自动发现并防 Dexie 连接挂起。
3. **分批提交**：每个方向一个 conventional commit，测试与实现同批，保证任意提交点可构建。
4. **新数据先落 db 再进 sync**：Agent/工具产出的数据先写 IndexedDB 再入同步链路，保证本地优先 + 跨设备一致。
5. **新表只在 `src/sync-manifest.js` 登记一次**：导出/导入/中枢合并自动覆盖。

---

## 五、下一步（按质量杠杆）
1. **资料中心 Phase 6 余项**：6.5b OCR（扫描版 PDF 图片提取，本地 Tesseract 优先 + 云端开关）→ 6.6 联动（知识图谱抽概念 → 错题溯源 → 复习上下文增强）。主线（上传→解析→预览→问答→建卡）已闭环。
2. **云端 Agent 工具市场**（Phase 4 余项）：插件/卡组/主题的远程目录与一键安装——需要托管服务 + 来源校验/签名，成本较高，等插件生态有实际需求后再动。
3. **数据安全拓展**（用户明确暂缓，可随时重启）：PIPL 合规、本地加密、导出脱敏。
