# 审计报告：round91 —— 图片「明明在本机却被报缺失」根因修复

- **日期**：2026-09-16
- **基线**：`c513247`（round90 已落地，远端一致）
- **触发**：用户反馈「agent 功能模块又能看到图片，但是一些明明在的图片它却说缺失了」+ 复验「AI 学习助手（普通问答）还是看不到图片」。
- **结论**：不是读路径 bug（round88 已证伪），是**摘要工具用裸 `.slice()` 把 `sxy-img://<uuid>` 拦腰截断**，产出半截 id 进上下文 → `enrichForLlm` 拿半截 id 查库查不到 → 对库里确实存在（完整 id 行存在）的图报「本机图库里没有这张图」。

## 1. 问题定性（先复现，再修）

### 1.1 机制
`src/agent/tools/index.js` 的 `search_cards` / `get_weak_cards` / `smart_review_plan` 路径卡 / 列表摘要，对卡片正文用**裸 `String(c.front).slice(0, 60)`** 截断。
`sxy-img://<36位uuid>` 单标记 52 字符，正文前面只要写几个字（真实卡片几乎都是「文字+图」），`slice` 就会从 uuid 中段切断，产出半截 id（如 `sxy-img://550e8400-e29b-41d4-a716-446655`）。

这半截 id 随工具结果 JSON 串进 ReAct 上下文（`base.js` 的 `toolObservation` / `compactToolPayload`），`enrichForLlm` 用 `extractImageIds` 扫到它 → `db.images.get(半截id)` 返回 undefined → 标注 `missing` → 文案「本机图库里没有这张图」。

**真相**：图就在库里（完整 id 对应的 `db.images` 行存在），是摘要把 id 切坏了。这就是用户说的「明明在的图片它却说缺失了」。

### 1.2 为什么 agent「又能看到」、普通问答「看不到」
两条链路共用同一个 `chat()`（`src/agent/llm.js:169` → `enrichForLlm`），是**所有 AI 链路（对话/Agent/卡片联动/子任务）唯一的图片富集入口**。
不对称来源：Agent 会调 `get_card_detail` 取**完整正文**（含完整引用 id）→ 这些图能正常解析；而摘要类工具（含 RAG 检索片段、`get_stats` 的薄弱卡上下文）泄漏半截 id → 这些图被假报缺失。普通问答若不调取详情工具、只靠上下文里的摘要，假缺失暴露得更彻底。本质是同一条 bug，只是 Agent 有更多全文字段掩盖。

### 1.3 复现测试（先红后绿）
`tests/agent-image-truncation.test.mjs`：
- 种一张「正面第 19 字符起就带图」的卡片 + 完整 image 行；
- 断言 `search_cards` / `get_weak_cards` 的 `front` 预览**不含** `sxy-img://` 片段（修复前红：裸 slice 泄漏半截 id）；
- 把摘要结果当工具观察喂 `enrichForLlm`，断言**不对库里存在的图**报「本机没有这张图」（修复前红：半截 id 触发 `missing`）；
- 对照组：完整引用 → 必须送出 1 张图（证明改的是摘要，读路径无缺陷）。

## 2. 修复

### 2.1 摘要工具去引用再切片（主修复）
`src/agent/tools/index.js`：所有 `String(c.front).slice(0,N)` / `String(c.back||'').slice(0,N)` 改为 `stripImageRefs(c.front).slice(0,N)`。
- 摘要意图本就不含图（命中几十张卡时保留引用会把送图额度吃光，注释 round71 已说明）；`hasImage` 标志保留，继续引导模型调 `get_card_detail` 取全文看图。
- 涉及：`search_cards`(front/back 80)、`get_weak_cards`(front 50)、`smart_review_plan` 路径卡/前驱卡(front 60)、列表摘要 map（`[img]` 标记行）。
- `stripImageRefs` 加入 import。

### 2.2 工具结果压缩改用图片感知截断（防御纵深）
`src/agent/tools/compact.js`：`clipString` 的 `s.slice(0,maxLen)` 改为 `clipText(s,maxLen)`。
- 这样 `>300` 字的**全文字段**（如 `get_card_detail` 返回的超长正文）被压缩时，图片引用完整保留、不切坏。
- `clipText` 无引用时回退码点安全截断（比裸 `slice` 还能避免劈坏 emoji/组合字符）。

### 2.3 系统上下文薄弱卡、僵尸卡摘要
- `src/agent/context.js`：注入 Agent 系统提示的薄弱卡 `front` → `stripImageRefs(...)`（最危险：进 system 消息，照样被 `enrichForLlm` 扫到）。
- `src/agent/analytics.js`：僵尸卡 `front` → `stripImageRefs(...)`。

### 2.4 已有保护（未改，确认有效）
- `src/agent/retrieval.js` 的 `retrieveContext`（RAG 片段，图片进上下文主入口）早已用 `clipText`（round67）；
- `src/utils/clip.js` 的 `clipText`/`stripImageRefs` 是统一出口，本轮只是把摘要工具从「裸 slice」迁到它。

## 3. 门禁
- `eslint` ✅ · `i18n --strict` ✅ · `i18n --js` ✅ · `dep-check` ✅ · `sync-coverage` ✅
- `node --test` **1318/1318**（上轮 1303，本轮 +6 回归 + round88/90 部分补登 = 全绿）
- `vite build` ✅

## 4. 新增/改动文件
- 改：`src/agent/tools/index.js` / `src/agent/tools/compact.js` / `src/agent/context.js` / `src/agent/analytics.js`
- 新增测试：`tests/agent-image-truncation.test.mjs`（6 条：复现+回归+对照+单元）

## 5. 仍未处置 / 后续
1. **「AI 学习助手看不到全库卡片正文」是设计使然**（只返回检索命中的片段，防撑爆上下文），非 bug；要看某张卡需贴正文或调工具——属产品预期，不在本轮范围。
2. **「AI 文档 0 篇 / 备忘 0 条 / 知识图谱 58 边看不到节点」**：这些模块确实无 AI 工具（docs/notes/mindmaps/graph 缺详情工具），与 round88 单词模块同类——属「分表模块未挂工具」的存量问题，可单列一轮补齐（候选 `get_doc_detail` / `get_memo_detail` / `list_graph_edges` 详情化）。
3. 跨设备图不同步的**真缺失**仍按原文案提示去同步——那是数据侧问题，不是本 bug。

## 6. 追加验证：AI 学习助手（普通问答）同样已修复

用户纠正「AI 学习助手是真的不看到图片」。实证两链路共用同一 `chat()`（`llm.js:169`→`enrichForLlm`）：
`AIAssistant.vue:135` 调 `buildFullContext(text)` 注入 system 消息 → `chatAI` → `enrichForLlm`。
`buildFullContext = buildStudyContext(薄弱卡, 本轮 stripImageRefs) + buildRAGContext(retrieveContext, 早已 clipText)`。
_round91 修的正是这两条上下文里的 id 切坏_，故假缺失对普通问答同样消除。

新增复验 `tests/ai-assistant-image-visibility.test.mjs`：
- 种一张「正文前带图」的卡 + 完整 image 行 + 2 条 rating=0 复习记录（使其同时是薄弱卡、能被 RAG 命中）；
- 调 `buildFullContext('停止等待协议超时重传')` 取上下文，喂 `enrichForLlm` → **vision=1**，且不对库里存在的图假报缺失；
- 上下文里所有 `sxy-img://` 引用必须是**完整 36 位 uuid**（不得半截）。

**仍存的真实边界（非 bug，本轮未扩）**：普通问答靠 RAG 被动检索，若用户问题文本与该卡正文语义不匹配，
RAG 取不到 → 图不进上下文 → 看不到。Agent 因能调 `get_card_detail` 主动取全文，故「总能看到」。
要使普通问答与 Agent 对齐，需给普通问答加「按问题搜卡并注入全文」的能力（候选后续轮）。
