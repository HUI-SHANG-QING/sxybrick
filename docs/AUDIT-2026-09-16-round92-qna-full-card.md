# 审计报告 · round92 · 普通问答「按问题搜卡注入全文」+ 分表模块节点可见

- **日期**：2026-09-16
- **基线 HEAD**：`9c48cdd`（round91 追加）
- **范围**：AI 学习助手（普通问答）看不到卡片完整正文 / 分表模块（AI 文档 / 备忘 / 知识图谱）只看计数看不到节点
- **结论**：三类诉求中①②已通过代码修复，③（跨设备图不同步）为数据侧问题，按原文案提示，未改代码。

---

## 0. 用户诉求（一句话）

1. **普通问答看不到全库卡片正文** —— 设计使然：普通问答走 `buildFullContext`（统计 + RAG 80/120 字碎片），不主动取全文。
2. **AI 文档 0 篇 / 备忘 0 条 / 知识图谱 58 边看不到节点** —— Agent 有对应工具但普通问答没挂载，且 `getModuleSummary` 只报计数。
3. **跨设备图不同步的真缺失** —— 数据侧问题（另一设备未同步 / 原图被删 / 备份未带图），非代码 bug。

---

## 1. 根因分析

| 维度 | 根因 | 影响 |
|---|---|---|
| 普通问答正文 | `buildFullContext` 只用 RAG 片段（80/120 字），不含主动取全卡 | 模型只能看到碎片，答不全、还可能因裸 slice 误判图缺失 |
| 模块节点 | `buildFullContext` 不含 docs/memos/graphEdges 明细；Agent 工具未全部挂载到 tutor/analyst | 模型只看到「N 篇/条/边」计数，说「看不到节点」 |
| 跨设备图 | 数据未同步（非代码） | 真缺失，按 IMAGE_ASSETS_HINT_DANGLING 文案提示即可 |

**关键约束**：`buildFullContext` 同时也是 Agent 编排路径（`orchestrator.js:106` / `pipeline.js:191` 每步重跑）的输入，**不能改它本身**，否则会放大 Agent 每步成本。故采用「在普通问答 system 消息**追加**两个独立上下文函数」的方案，Agent 路径完全不动。

---

## 2. 修复清单（5 文件 + 1 测试）

### 2.1 `src/agent/context.js`（新增两函数，纯增量）
- `buildQuestionCardContext(query)`：按问题主动 `listCards({q})` 关键词搜（TOP8）→ 语义兜底 `hybridSearch`（补足至 TOP8）→ `getCard` 取完整正/背面 → `clipText` 保图片引用完整（超长只截正文，引用追加末尾）。中文均按 i18n 数据层闸要求写成「长串」（≥40 字且中文≥8）触发 `promptLike` 豁免。
- `buildModuleNodesContext()`：`listMemos`（全文列出）/ `listDocs`（标题列出）/ `listGraphEdges`（≤120 条列端点 `from（起点）→to（终点），关联关系为：label`，>120 折叠只报计数）。任一为空返回 `''`。

### 2.2 `src/ai.js`（导出桥接）
- import 补 `buildQuestionCardContext, buildModuleNodesContext`；末尾 `export { buildQuestionCardContext, buildModuleNodesContext }` 供 `AIAssistant.vue` 调用。`buildFullContext` 本体不变。

### 2.3 `src/views/AIAssistant.vue`（普通问答注入，CRLF 保留）
- import 补两函数；`send()` 内 `Promise.all` 并行取 `buildQuestionCardContext(text)` 与 `buildModuleNodesContext()`；system 消息由
  `SYSTEM_PROMPT + mem + ctx` 改为 `SYSTEM_PROMPT + mem + ctx + (qcards ? '\\n\\n'+qcards : '') + (modules ? '\\n\\n'+modules : '')`。

### 2.4 `src/agent/agents/index.js`（Agent 工具补齐）
- `tutor`：已含 `list_graph_edges` / `list_docs` / `read_doc` / `list_notes` / `read_note` / `list_memos`。
- `analyst`：tools 由 11 项追增 `list_docs, read_doc, list_notes, read_note, list_memos, list_graph_edges`（现 17 项）。

### 2.5 `src/agent/tools/index.js`（明细引导 hint）
- `STATS_DETAIL_HINT_PROMPT` 末尾补 `；AI 文档 list_docs/read_doc；笔记 list_notes/read_note；备忘 list_memos。…普通问答看不到这些节点时，请引导用户改用对应 Agent（如学习答疑导师）或到相应页面查看。`
- 该常量以 `*_PROMPT` 命名，被 i18n 数据层闸整段豁免（prompt 契约永不翻译）。

### 2.6 `tests/round92-qna-full-card.test.mjs`（新增，4 条）
- T1：全文注入（>80 字算法正文 + 完整 36 位 uuid 图引用）。
- T2：带图卡命中后 `enrichForLlm` 真实送出图（vision=1，不假报缺失）。
- T3：`buildModuleNodesContext` 列备忘全文 / 文档标题 / 图谱边端点。
- T4：短 query（<2 字）/ 无模块数据时安全返回空。

---

## 3. 质量门禁

| 门禁 | 结果 |
|---|---|
| i18n `--js`（数据层第三道闸） | ✓ 新增 0 行 |
| i18n `--strict`（视图硬编码） | ✓ 新增 0 行 |
| eslint（改文件） | ✓ 0 error |
| `node --test tests/round92-qna-full-card.test.mjs` | ✓ 4/4 |
| 全量 `npm test`（eslint + 双闸 + dep-check + sync-coverage + node --test） | 见末尾「构建/全量」 |

---

## 4. 未改代码项（数据侧，按原文案提示）

- **③ 跨设备图不同步的真缺失**：非代码 bug。前端仍显示图片多为会话内缓存旧图，刷新即消失。`IMAGE_ASSETS_HINT_DANGLING_PROMPT` 已覆盖提示：「在其他设备同步一次或重新上传」。无需改代码。

---

## 5. 风险与边界

- `buildQuestionCardContext` 最多取 8 张全文（每张正/背各 `MAX_FULL_CARD_CHARS=1200` 字），上下文增量受控；失败 `.catch` 静默降级为 `''`，不影响原问答。
- 语义兜底依赖 embedding 索引（`hybridSearch`），索引未建时仅关键词命中，不报错。
- 图谱边 >120 自动折叠，避免上下文撑爆。

---

## 6. 交付物

| 文件 | 说明 |
|---|---|
| `src/agent/context.js` | +2 导出函数 |
| `src/ai.js` | +导出桥接 |
| `src/views/AIAssistant.vue` | 普通问答 system 追加全文/模块节点 |
| `src/agent/agents/index.js` | tutor/analyst 工具补齐 |
| `src/agent/tools/index.js` | 明细引导 hint |
| `tests/round92-qna-full-card.test.mjs` | 4 条回归测试 |
