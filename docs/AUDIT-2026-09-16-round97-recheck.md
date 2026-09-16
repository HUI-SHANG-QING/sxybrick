# 全面审计报告 · 2026-09-16 · round96 修复复验 + 数据协同/性能补审（round97）

- **审计背景**：并行会话已结束并提交（HEAD 由 `3d1c34d` 推进到 `e4ed4fc`）。本轮对 round96 报告的问题逐项复验是否被修复，并继续向数据协同、查询性能、删除一致性等「表面看不见」的方向补审。
- **基线 HEAD**：`e4ed4fc`（feat: 普通问答也能看到全模块明细 + 文档/笔记图片，round96）；工作树干净（仅本报告与 round96 报告为未跟踪文档）。
- **审计方法**：`git show` 核对提交面 + 读源码 + 真实模块实跑复验 + 全量测试。
- **总结论**：并行会话**只把「全模块明细」功能连同 3 条回归测试提交了，round96 报告点名的 2 项 P2 均未修复、原样在主线**（P2-1 已重新实证）。本轮**无新增 P1/P2**，新发现 3 项 P3（查询性能、资料状态过滤、备忘长度）；删除级联/孤儿边/软删除绕过/关键词注入等数据协同高危面经复核**均健壮**。全量测试 **1335 pass / 0 fail**。

---

## 一、并行会话到底改了什么（`e4ed4fc`）

仅 2 个文件、+121 行，改动面干净、无夹带：

| 文件 | 内容 |
|---|---|
| `src/agent/context.js`（+46/-10） | `buildModuleNodesContext()` 从「节点目录」升级为「全模块明细快照」（即 round96 报告中那份**已被实测 10 项 PASS 的未提交改动**，内容一致） |
| `tests/round96-qna-all-modules.test.mjs`（+75，新增） | 3 条回归测试：① 全模块明细可见（备忘/文档/笔记/计划/每日/番茄/单词/资料库/图谱）；② 图片引用为完整 36 位 uuid；③ 上下文经 `enrichForLlm` 真把文档/笔记图送出（`vision>=1`，端到端） |

**评价**：功能正确、测试到位（第三条还覆盖了「注入→富集→送图」整条链），可放心保留。但它**没有**处理 round96 报告里该功能伴生的成本/预算问题（P2-2），也没有碰 P2-1。

---

## 二、round96 问题复验（是否已修复）

| 编号 | 问题 | 状态 | 复验依据 |
|---|---|---|---|
| **P2-1** | Agent `get_card_detail` 取长卡时，正文被通用压缩砍到每字段约 300 字（图在、文字丢 96%） | **❌ 未修复（仍在主线）** | `compact.js` / `agents/base.js:293` 不在本次提交内。重新实跑：10179 字符的长卡 → 压缩后 866，含「已截断」，图片引用仍完整。触发阈值 front+back 合计约 5500+ 汉字。 |
| **P2-2** | 普通问答 system「无条件全量注入」全模块明细，输入侧无总字符预算（成本/隐私/小窗口超限） | **❌ 未修复，且随 `e4ed4fc` 正式固化进主线** | `views/AIAssistant.vue:135,144` 未改，仍每轮 `Promise.all` 全量拼进 system；`ai.js chatAI` 只按 16 轮裁历史、不裁 system；`llm.js` 只夹输出 `max_tokens`。本轮 N1 又补一处性能侧证据。 |
| P3-1 | `visionFirst` 仅送前 3 张、按注入顺序而非相关度 | 未修复（默认 ocrFirst 不受影响，低优） | `image-analysis.js:464-477` 未改 |
| P3-2 | 明细文案英文枚举原样输出（类型 note / 状态 active） | 未修复 | `context.js:204,212` 未改，实跑输出仍为「类型为note」「状态为active」 |
| P3-3 | `listGraphEdges()` 全表 `toArray()`，仅 ≤120 条列文本 | 未修复（当前 58 条无碍） | `context.js:197` |
| P3-4 | 全量测试偶发计数波动（曾见 1334/1） | 本轮未复现（1335/0） | 仍建议 CI 连跑抓 `not ok` 用例名 |

> 结论：**上轮报告的两个「较重」问题都还在**，其中 P2-1 直接影响「Agent 看长卡/思维导图卡正文」，是用户「Agent 也看不全」体感的真实来源，建议优先修。

---

## 三、round97 新发现（均为 P3）

### N1（P3 · 性能/成本）普通问答每轮把多张表「连正文一起整表拉进内存」，再截取前 N 条

**位置**：`src/agent/context.js:188-197 buildModuleNodesContext()` 调用的
- `listDocs()`（`repo.js:1834`）= `db.docs.orderBy('updatedAt').reverse().toArray()`
- `listNotes()`（`repo.js:1615`）= 全表 `toArray()` 后内存过滤
- `listPlans()`（`repo.js:1741`）、`listMemos()`（`repo.js:1288`）同为全表 `toArray()`
- `listGraphEdges()`、`db.docFiles.toArray()` 全表

**成因**：这些公共 list 函数返回**整行（含 `content` 正文大字段）**；而 `buildModuleNodesContext` 实际只用前 10 篇文档/10 篇笔记/6 份计划，每篇正文也只取 `clipText(...,500/300)`。等于「为取前 10 篇摘要，把全部文档/笔记的完整正文反序列化进内存」，且**每次普通问答、无论问什么都执行一遍**（与 P2-2 同根因：无条件全量）。

**影响**：个人量级（几十~几百行、本地 IndexedDB）通常几十毫秒，无正确性问题；但随文档/笔记增多（AI 周报、长总结，单篇可达数千字），这是随库增长的固定开销，也白耗内存。`docFiles` 因元数据/大字段分表（`db.js:142-152`）**不含此问题**。

**修复建议**：为「摘要/目录」场景新增轻量查询（Dexie `.limit(n)` + 只取标题/必要字段，或先取 id 再批量取前 N 的 content）；或随 P2-2 一起做意图分级——没问到文档/笔记时不发起这些查询。

### N2（P3 · 一致性）资料库文件清单/视觉统计不过滤 `status`，处理中/失败的文件也被当作「你有这份资料」

**位置**：
- `src/agent/context.js` 资料库文件名注入处（`files.slice(0,20).map(...)`，无 status 过滤）；
- `src/agent/context.js:64-77 buildStudyContext` 的「共 N 份资料，其中 M 份 PDF/图片」同样无过滤。

**成因**：`docFiles.status` 取值为 `parsing / ready / failed`（`docs-lib.js:140/152/166`）。两处都直接统计/列名，把 `parsing`（还在解析）、`failed`（解析失败/损坏）的文件也算进去。

**影响**：AI 会告诉用户「你有《X.pdf》」并引导其提问，但 `read_lib_doc`/视觉链路对 failed 文件给不出内容，造成「说有却读不出」的二次落差（虽 then 会返回明确失败原因）。建议两处都只统计/列出 `status==='ready'`（或对 failed 显式标注「解析失败」）。

### N3（P3 · 边界）单条备忘无长度上限，全文注入

**位置**：`context.js` 备忘注入 `memos.map(m=>m.text).slice(0,30)`（限 30 条，但**每条全文不截断**）；`addMemo`（`repo.js:1291` 附近）写入侧 `text` 仅 `trim()`、不限长。

**影响**：备忘语义是短句，但写入不强制；若出现超长备忘，整条进 system（与 P2-2 叠加放大输入）。建议注入侧对单条 `clipText(text, 200)`。

---

## 四、本轮复核为「健壮 / 已正确」的高危面（明确排除，避免误报与重复修）

| 区域 | 结论 |
|---|---|
| 删卡后的图谱孤儿边 | `deleteCard`（`repo.js:618-651`）按 `fromCardId/toCardId` 双向收集边并物理删 + 写墓碑；`pruneDeadEdges`（`graphAuto.js:349-376`）三分类严谨——带 cardId 的引用必须存在、纯文本知识点边**永不误判死**、资料边（doc-card/docId）豁免、仅「裸 UUID 文本脏边」清理。**无孤儿边/误删文本边问题**。 |
| 单词删除绕过回收站 | `wordCards` 删除为**物理删 + 墓碑**（`word-repo.js:288,275`），普通问答直接 `db.wordCards` 查询**不会带出回收站词**；`word/meaning` 字段名与注入一致，无空释义。 |
| 笔记/文档/备忘删除 | 均走「主表物理删 + 墓碑」同体系（`repo.js:323` 注释列明 deleteMemo/deleteNote/deleteDoc），list 全表查询不泄漏已删行。 |
| 关键词检索注入 | `listNotes` 的 `q` 用 `String.includes`（非正则、非 Dexie 原始语法）拼接，**无正则/查询注入风险**。 |
| round96 功能正确性 | `e4ed4fc` 的 context.js 与 round96 实测版本一致；新测试 `round96-qna-all-modules.test.mjs` 覆盖「明细可见 + uuid 完整 + vision≥1 端到端」，质量到位。 |
| 资料库大字段建模 | `docFiles` 元数据 / `docTexts` 全文 / blob 三分离，全文与 blob 不进同步（`db.js:219` 注释明确曾修过「Blob 塞进同步表」问题），无全表读 base64 风险。 |
| 全量测试 | **1335 pass / 0 fail**（76.7s），无回归。 |

---

## 五、优先级建议

1. **P2-1（仍未修，最该先修）**：`get_card_detail` 走工具级宽预算（推荐 `compactToolPayload` 支持 `payloadBudget: {maxChars:12000, maxStringLen:4000}`，`base.js:293` 透传），或工具内 `clipText(front/back,2500)`；补「长卡正文保留度 + 图片引用完整」回归测试。这是「Agent 看长卡正文残缺」的直接修复。
2. **P2-2 + N1（同一根因，建议合并修）**：给普通问答 system 注入加**总字符预算 + 按问题意图分级**（借鉴 Agent 的 `needsFullContext`），文档/笔记/计划改为轻量 limit/摘要查询；没问到的模块不查、不注入。同时解决 token 费用、隐私外发、小窗口超限、整表性能四件事。
3. **P3 批量**：N2 资料库只统计 ready；N3 备忘单条 clipText；P3-2 枚举中文化；P3-1 visionFirst 额度内按相关度重排；P3-3 graphEdges 查询加 limit；P3-4 CI 连跑抓 flaky。

> 本轮为只读复验 + 实跑，**未修改/提交任何代码**；round96 报告与本报告均为未跟踪文档，可一并提交留档。是否动手修 P2-1 / P2-2 待确认。
