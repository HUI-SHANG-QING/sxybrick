# round86 深度审计报告（AI 对话上下文管理 × 新功能收口验证 × 隐私备忘）

- 日期：2026-09-16
- HEAD：`924845b`（round83 收口 + scheduledHour null→0 修复）
- 全量测试：**1272/1272 全绿**（较上轮 +10）
- 方向：本轮打向**以往未覆盖的「AI 对话上下文管理」**（普通对话路径 vs Agent 路径的对称性），并验证 round83/84/85 收口完整性。

---

## 一、问题清单

### P2-1（本轮核心新发现）：AI 助手**普通对话**路径无历史长度管理——长会话逐轮膨胀，慢、贵、最终"失忆"或 400

**位置**：`src/views/AIAssistant.vue:139` → `src/ai.js:65-75`（chatAI 直传）→ `src/agent/llm.js:166-188`（finalMessages 直传 body）

**证据链**：
1. `AIAssistant.vue:139`：`const history = [...currentChat.value.messages]`——**全量**会话历史快照（round76 只修了"空消息被当历史"，没做长度管理）；
2. `ai.js:65-75`：`chatAI(messages)` 原样透传，无截断/压缩；
3. `llm.js:166-188`：`messages: finalMessages` 直接进请求 body（图片富集还会把每张图展开成 OCR/多模态内容，放大体量）；
4. **不对称实锤**：Agent 路径 `orchestrator.js:129` 有 `history.slice(-12)` 滑动窗口，普通对话路径**没有任何等价物**。

**影响**（用户可感知，随对话轮数线性恶化）：
- 每轮请求重发全部历史 → 响应变慢、token 费用线性增长；
- 到达模型上下文窗口上限后：① 400「上下文超限」报错；② 更隐蔽——模型静默丢弃早期内容，**用户发现 AI "失忆"但说不出从哪一轮开始**；
- 多图会话（图片富集）叠加历史，问题放大更快。

**触发条件**：不新建会话、连续聊较久（30+ 轮）。**这是当前 AI 助手最可能自然触发的隐性故障**。

**根因**：对话路径与 Agent 路径各自维护上下文，Agent 侧（round34 意图分级/round46 截断）历轮加固过，普通对话侧只处理了截断续写（输出侧），**输入侧历史管理缺失**。

**修复方向**（约 1 小时）：
- 在 `chatAI` 入口做滑动窗口：按 token 估算保留最近 N 轮（如 16~20 轮）+ 早期内容用「记忆摘要」压缩（extractMemories 已有长期记忆基建可复用）；
- 或更轻：发送前 `messages.slice(-MAX_ROUNDS)`（阈值可配置），并保证"本次用户输入 + 系统提示"永远在窗口内。
- 建议补一条测试：构造 30 轮长历史，断言发送给 llmChat 的 messages 长度被封顶。

### P3-1（备忘→值得顺手修）：quiz-recorded.js 持久防重无容量上限——写满后静默退化，刷新即失效

**位置**：`src/utils/quiz-recorded.js`（KEY_PREFIX localStorage，每题一个 key，无清理/无上限）

**问题**：每次「记入复习」写一条 `sxy_quiz_rec:<cardId>|<题干60字符>`，**无 LRU/无上限/无清理**。localStorage 满（约 5MB）后 `setItem` 抛 QuotaExceededError → 被 catch 吞掉 → 防重退化到内存 Map——**同一会话内仍防重，刷新后失效**（回到 round83 P3-2 的原状）。重度用户（累计记入数千题）数月内即可触达。

**建议**：写入前 `getItem` 计数，超阈值（如 2000）清最旧；或按天归档。10 分钟，零风险。

### P3-2（备忘）：错误日志含学习内容/搜索词/内网地址，随同步与备份扩散

**位置**：`src/utils/errorLog.js:15`（ctx 序列化）+ 调用方 `KnowledgeGraph.vue:83`（`label=${q.slice(0,60)}`）、`Mindmap.vue:41`（`label=${q.slice(0,80)}`）、`Sync.vue:483`（`hub=${hub} details=${JSON.stringify(extras).slice(0,250)}`）

**问题**：`ctx.info` 会写入**用户学习内容片段（搜索词/节点名）与内网 hub 地址**；`errors` 表已在同步清单（round38 起入同步表、含墓碑），也会随导出备份扩散。自同步场景（用户自己的设备）无泄露；**仅当用户把备份分享给他人时**，这些内容片段会一起出去。

**建议**：errorLog 对 `ctx.info` 做默认脱敏（如剥离非字母数字外露片段？不现实）——更实际：导出备份时排除 errors 表，或 ctx.info 落库前对 `label=…/q=…` 这类已知内容字段做长度+内容清洗。低优先，记备忘。

---

## 二、历史修复完整性验证（用户点名要求，全过）

| 项 | 状态 | 证据 |
|---|---|---|
| round83 P3-1 未作答记 0 | ✅ | `AiQuizView.vue` `if (picked.value[i] == null) return;` 函数级守卫（注释标注 round83 P3-1） |
| round83 P3-2 防重仅组件内 | ✅ | `src/utils/quiz-recorded.js` 新建：localStorage + 内存退化 + 探测，`markQuizRecorded` 持久化（round82 标注） |
| round83 P3-3 scheduledHour null→0 | ✅ | `tools/index.js:602-603/639-640` round85 归一化入口 + 注释「不得写回 Number.isFinite(Number(v))…Number(null)===0」 |
| round83 P3-4 structuredClone | ✅ | `398c901` + `src/utils/clone.js`（structuredClone 优先 / JSON 往返兜底 / 边界注释），registry.js 两处已改 |
| round78 P2-1 AbortSignal 族 | ✅ | `84002b3` + `src/utils/abort.js`（AbortController+setTimeout，Node unref，97 行测试） |
| round78 P2-2 structuredClone | ✅ | 同上（clone.js） |
| 全量测试 | ✅ | **1272/1272**（含 i18n/lint/同步五道门禁 + round80 算法闸门） |

**结论：历史修复 6/6 健在，无回退、无半成品。**

---

## 三、根因分析（交叉思考）

1. **输入侧 vs 输出侧的加固不对称**（P2-1）：项目历轮把输出侧（截断自动续写 round49、max_tokens 学习 round73、流式空闲超时 round71）打磨得极细，但**输入侧历史管理只有 Agent 路径做了**。长对话是 AI 助手的主场景，"上下文越用越胀"是必然结局——这不是边界 bug，是**架构遗漏**，会在正常使用中自然触发。
2. **持久化防重的容量问题**（P3-1）：所有"防重/去重"持久化都必须带容量边界，否则退化路径（静默失效）本身就是 bug。
3. **日志即数据**（P3-2）：错误日志进入同步/备份通道后，已从"调试信息"变为"用户数据"，应受同一隐私纪律约束（此前遥测 A-B 分级做得好，errors 表没跟上）。

---

## 四、建议（按影响 ÷ 成本）

1. **P2-1 历史窗口截断**（1 小时）——修长对话慢/贵/失忆，用户直接可感知；
2. P3-1 容量上限（10 分钟）——顺手；
3. P3-2 导出排除 errors（10 分钟）——顺手，记备忘即可。

---

*round86 · 覆盖：AI 对话上下文管理 × 收口验证 × 隐私备忘 · 1 P2 + 2 P3（均备忘级修复成本）*
