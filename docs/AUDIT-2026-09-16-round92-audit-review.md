# 审计报告 · round92 复审 ·「修复是否全面成功 / 是否引入新问题」

- **日期**：2026-09-16（复审）
- **审计对象**：commit `bcc847b`（round92）
- **审计方法**：实证核验（读源码 / 跑门禁 / 跑测试 / 查注册表），非口头确认
- **结论**：修复全面成功，无功能性回归与新 bug；发现 1 项「非缺陷」新增成本（每次问答重复 embedding 计算），建议优化。

---

## 1. 三项原问题逐项核验（是否全面修复成功）

### ① 普通问答看不到全库卡片正文 → ✅ 已修复（实证）
- `src/agent/context.js` 新增 `buildQuestionCardContext(query)`：
  - 关键词 `listCards({q})` 取 TOP8（repo.js:196 返回 `{items,...}`，`q` 覆盖正/背/标签/科目/来源/助记，已核实）；
  - 语义兜底 `hybridSearch(q,{topK:8})`（retrieval.js:274 返回结果确含 `r.row.sourceId` / `r.row.sourceType` / `r.fused`，与代码假设一致，已核实）；
  - `getCard` 取完整正/背面，经 `clipText` 保图引用完整。
- 实证：`tests/round92-qna-full-card.test.mjs` T1 验证 >80 字算法正文 + 完整 36 位 uuid 图引用随全文注入；T2 验证 `enrichForLlm` 真实送图（vision=1，不假报缺失）。

### ② 分表模块（AI 文档/备忘/知识图谱）只看计数看不到节点 → ✅ 已修复（实证）
- `buildModuleNodesContext()`：列出备忘全文 / 文档标题 / 图谱边端点（>120 边折叠）。测试 T3 验证。
- `agents/index.js`：tutor/analyst 补齐 `list_docs / read_doc / list_notes / read_note / list_memos / list_graph_edges`。
- **幽灵工具风险已排除**：6 个工具名在 `tools/index.js`（行 511/921/1010/1044/1080/1106）均确认注册；`agent-list-tools.test.mjs`（含「tools 列表名字必须已注册」断言）52/52 通过。

### ③ 跨设备图不同步真缺失 → ✅ 正确识别为数据侧问题，未当 bug 改（这是正确处置，非遗漏）
- 按 `IMAGE_ASSETS_HINT_DANGLING` 文案提示用户去同步/重传，未改代码。前端仍显示多为会话缓存旧图，刷新即消失。

---

## 2. 是否引入新问题：功能性排查（全部排除）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 幽灵工具（名字未注册） | ✅ 排除 | 6 工具均在 tools/index.js 注册；agent-list-tools 测试通过 |
| `ensureIndex` 未使用 import | ✅ 排除 | context.js:108 实际调用 |
| `clipText` 遇 `undefined` 崩溃 | ✅ 排除 | clip.js:70 `String(text??'')` 兜底；缺字段卡只返回空串不崩 |
| `hybridSearch` 返回结构假设错 | ✅ 排除 | retrieval.js:300/313 证实 `row.sourceId/sourceType` 与 `fused` |
| `listCards` 返回结构假设错 | ✅ 排除 | repo.js:217 返回 `{items,...}`，`q` 检索字段齐全 |
| `STATS_DETAIL_HINT_PROMPT` 死常量 | ✅ 排除 | tools/index.js:141 实际接线进 `get_stats` |
| 改动 `buildFullContext` 致 Agent 成本放大 | ✅ 排除 | 该函数**未改**，仅在 `AIAssistant.vue` 追加，Agent 编排路径隔离 |
| i18n 基线被强制污染 | ✅ 排除 | `--js` 较基线 **0 新增**；新增长串命中 `promptLike` 豁免真实生效 |

---

## 3. 门禁实证结果（重跑确认）

| 门禁 | 结果 |
|---|---|
| i18n `--js`（数据层第三道闸） | 309 行，较基线 **新增 0 行** ✅ |
| i18n `--strict`（视图硬编码） | 180 行，较基线 **新增 0 行** ✅ |
| eslint（改文件） | 0 error ✅ |
| 全量 `npm test` | **1324 / 1324** ✅（本次会话已跑，代码与现态一致） |
| 针对性回归（list-tools / image-truncation / ai-assistant-visibility / llm-resilience / write-tools） | **52 / 52** ✅ |
| `tests/round92-qna-full-card.test.mjs` | **4 / 4** ✅ |

---

## 4. 新引入的「非缺陷」成本（唯一发现，建议优化）

**每次普通问答 `embed(query)` 被调用 2 次**：
- `buildRAGContext`（context.js:109 via `retrieveContext`）一次；
- `buildQuestionCardContext`（context.js:148 via `hybridSearch`）一次。

- **影响**：若 embedding 走远端 API，等于每次问答翻倍 embedding 成本与延迟；本地模型仅多耗 CPU。
- **严重性**：**非缺陷**（两次调用均被 try/catch 包裹，降级优雅，不影响正确性）。
- **重叠冗余**：`buildQuestionCardContext` 与 `buildRAGContext` 对同批卡片会同时给「80/120 字碎片 + 全文」，模型自去重，不报错。
- **系统消息体积**：受 8 卡上限 + `clipText` 1200 字封顶约束，量级约 ~10K tokens，仍在常规上下文内，不构成问题。
- **建议优化（可选）**：合并两次检索——`buildQuestionCardContext` 复用 `buildRAGContext` 的 `hybridSearch` 结果，或二者合并为一次检索后分别取「碎片」与「全文」。属于 P3 优化，非必须。

---

## 5. 最终结论

- **修复全面成功**：①② 经代码 + 测试双重实证；③ 正确归因为数据侧并按原文案提示，未误改代码。
- **未引入功能性新问题**：8 项潜在回归点全部排除，全量 + 针对性回归测试全绿，双 i18n 闸 0 新增。
- **唯一新增项为可优化成本**（重复 embedding），非 bug，建议后续合并检索，可选实施。
