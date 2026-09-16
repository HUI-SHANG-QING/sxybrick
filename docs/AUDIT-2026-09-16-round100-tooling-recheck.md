# round100 全面审计报告：AI 学习助手「工具化」复验 + round101 残留审查

日期：2026-09-16 ｜ 审计人：主审 Agent ｜ 范围：普通问答工具化（round100）全链路复验 + 并行会话遗留（round101）审查 + 回归面

---

## 一、结论摘要

1. **用户决策已落地且质量合格**：round100「AI 学习助手自己查数据」（c69240a）正是用户上轮明确采纳的方案（"让 AI 自己分析问题、根据项目数据回复"）。普通问答从「单次调用 + 关键词猜模块」升级为走 Agent 框架（assistant Agent，40 个工具，先取真实数据再回答，图片经 enrichForLlm 作为附图送出）。**意图词表边界问题（round99 R99-1/2/3）从根上退场**，round98 P2-2「无条件全量外发」同步消除。
2. **全量测试 1356 通过 / 0 失败**（脏工作树，含 round101 新增 4 条测试；round100 提交版基线为 1352 通过，与提交说明一致）。无回归。
3. **发现 1 项 P2 工作流事故**：并行会话完成的 round101 改动（考试/思维导图/周报/卡组/单词组/成就 6 模块工具 + 挂载 + 测试）**全部未提交**，残留在工作树；一旦 checkout/reset/stash 即丢失，用户"所有模块都能被 AI 调用"的诉求未入库。
4. **发现 2 项需用户知情的观察项**（P3/P4）：普通问答从「只读」变「可写」（5 个写工具仅提示词约束）；每轮问答的 LLM 调用次数上限从 1 次升至 9 次（成本知情）。

---

## 二、实证

### 2.1 提交链（HEAD = 0ce5842）

```
0ce5842 docs(audit): round99 修复复验报告入库留档          ← HEAD
c69240a feat(agent): AI 学习助手「工具化」（round100）      ← 用户方案落地
4cfd518 fix(security): 三处手写 CSV 导出补公式注入防护（round94 S1 收口）
0afdb22 docs(audit): round98 修复复验报告入库留档
980283a fix(agent): 修「第二道压缩坎」（round99）
3aeb185 fix(agent): 修长卡正文被砍 96% + 按意图下饭（round98）
```

### 2.2 工作树状态（round101 残留，3 处未提交）

```
 M src/agent/agents/index.js      ← 3 个通用 Agent（tutor/analyst/assistant）挂 6 个新模块工具
 M src/agent/tools/index.js       ← +125 行，注册 6 个新工具（list_exams/list_mindmaps/
                                      list_weekly_reports/list_card_groups/list_word_groups/
                                      list_achievements），统一 id/limit/offset + pageOf 分页
?? tests/round101-all-modules.test.mjs  ← 4 条新测试（未跟踪）
```

- 逐项核实：6 个新工具引用的 repo.js 导出全部存在（listMindmaps=1969 / getMindmap=1972 / listWeeklyReports=2011 / getWeeklyReport=2014 / listAchievements=2046 / listExams=2058 / getExam=2061）；工作树 `rg` 确认 agents 引用与 tools 注册一一对应。
- **提交错位确认**：`git show c69240a:src/agent/agents/index.js`（提交版）**不含** list_exams 等引用，`git show c69240a:src/agent/tools/index.js`（提交版）**不含**对应注册——即 round100 提交版自洽（40 工具全部已注册，测试通过）；round101 是**之后**新增、未提交的独立批次，两批次之间不存在"引用未注册"的运行时断链。

### 2.3 全量测试（脏工作树，含 round101）

```
# pass 1356  # fail 0  # cancelled 0  # skipped 0  # todo 0  duration 86.5s
```

1356 = round100 基线 1352 + round101 新测试 4，增量吻合。round101 的 4 条测试覆盖：6 工具已注册且可执行 / assistant+tutor+analyst 三 Agent 均挂载 / 考试列表含得分 + 传 id 给题目明细 / 导图·周报·卡组·单词组·成就均能取到具体内容（非仅计数）。

### 2.4 round100 核心链路复验（读码 + 测试双重确认）

- `src/views/AIAssistant.vue:144-170`：send() 改走 `runAgentTurn({ userInput, history, agentId: 'assistant' })`，本地 buildFullContext / buildQuestionCardContext / buildModuleNodesContext 预注入已删除（round100 测试第 4 条断言不再调用）。
- `src/ai.js:26`：runAgentTurn 运行时动态 import agentSystem.runTask，cfg 取 getAIConfig，不进静态初始化图（避免历史成环）。
- `src/agent/agents/index.js`：assistant Agent（round100 提交版 40 工具、maxSteps:8），systemPrompt 强制「先调工具取真实数据再回答」+「写入前先摘要确认」。
- `src/agent/agents/base.js`：MAX_STEPS=12 硬上限，assistant 实际 8 步封顶；工具观察用 user 角色承载（__toolObs 标记）规避 role:'tool' 400 限制；compactConvo 第二轮压缩（从旧到新、保最新长卡）与 round99 修复一致；预算耗尽走 buildLocalAnswer 本地直出兜底。
- 图片链路：get_card_detail / read_note / read_doc 返回内容经 enrichForLlm 送图，与 Agent 工作台共用同一条多模态富集管线——**普通问答与 Agent 在"看图"上已无能力差**（对应历史"只修一边"质疑的最终消除）。

### 2.5 CSV 注入修复（4cfd518，round94 S1 收口）

三处手写 CSV 导出（word-syllabus.js / Export.vue / WordExport.vue）补 `=` 公式注入防护，新增 18 行测试。提交小、范围明确，与 round94 S1 结论一致，本轮未发现残留问题。

---

## 三、发现的问题

### P2-1  round101「6 模块工具」完成但未提交（工作流/交付风险）

- **位置**：工作树 `src/agent/agents/index.js` + `src/agent/tools/index.js` + `tests/round101-all-modules.test.mjs`
- **成因**：并行会话完成全部改动并通过测试（1356 全绿）后，在提交前结束会话；git 只保留了 c69240a（round100）等已提交内容，round101 以工作区未提交状态悬留。
- **影响**：任何 checkout / reset / stash / 重装都会丢失这批改动，用户「所有模块（考试/思维导图/周报/卡组/单词组/成就）AI 都能取到具体内容」的诉求将无法入库；此外若后续会话在未感知此残留的情况下继续开发，可能基于干净 HEAD 重复劳动或产生冲突。
- **建议（待用户拍板）**：审计确认后提交（沿用 force-add / force-commit 流程），或明确回退并说明不采纳该方向。已核实代码本身通过 4 条功能测试，无阻断缺陷。
- **后续更新（已解除）**：审计完成前，并行会话已将 round101 提交入库（`c07fcff`，3 文件 213+/3-，内容与本报告审查的残留一致），工作树已干净，P2-1 失效。

### P3-1  普通问答从「只读」变「可写」，写入无代码级确认护栏

- **位置**：`src/agent/agents/index.js` assistant tools 含 create_note / update_note / create_daily_plan / add_daily_task / checkin_daily_task（5 个写工具）；`src/agent/agents/base.js:90-114` executeTool 仅校验工具存在，无写工具白名单/强制确认；orchestrator.js:154 仅透传 writesData 标记。
- **成因**：round100 为覆盖用户"整理成笔记/排计划/打卡"等写入诉求，将写工具并入 assistant，确认动作只落在 systemPrompt 提示词（"先摘要给用户确认，得到同意后再调写入工具"），无代码层强制。
- **影响**：模型若漏遵守提示词（误解用户意图、或用户在对话中随口一句被当作授权），可直接写库（建笔记/排每日任务/打卡），无 UI 确认步骤。历史此类风险多发生在模型意图漂移时，属低-中概率、低-中损失。
- **建议**：① 在 runTask 层对 writesData 工具增加"执行前回执确认"拦截（前端弹确认框）；② 或初期把 5 个写工具从 assistant 剥离，写入需求引导到工作台 Agent；③ 至少在本轮向用户明示该能力变化。

### P4-1  普通问答成本上限变化（知情项，非缺陷）

- **位置**：assistant maxSteps: 8
- **说明**：普通问答每轮从「单次 LLM 调用」变为「最多 8 次工具步 + 1 次收尾 = 9 次调用」的 ReAct 循环，费用上限放大（实际多数寒暄/简单问题可能 1 次即答，工具步为 0）。这是用户所选方案（AI 自己分析）的固有成本，需用户知情。
- **缓解**：maxSteps 已有硬上限；systemPrompt 引导"需要数据才调工具"；预算耗尽本地直出兜底。

### P4-2  执行层无工具白名单（体系特征，非本轮引入）

- executeTool 不校验"工具是否在 agent.tools 声明内"，仅靠 prompt 层只展示声明工具来约束。模型理论上可猜名调用未声明工具。历轮沿用，非 round100 引入，记观察不记新账。

---

## 四、排除面（本轮复验确认无回归/已修复）

| 历史问题 | 状态 |
|---|---|
| round99 R99-1「测试」误伤复习意图 | 已退场（不再有意图词表） |
| round99 R99-2 思维导图/截图漏命中 | 已退场（AI 自己查数据，含导图工具） |
| round99 R99-3「总结一下我」误触全量 | 已退场（不再无条件外发） |
| round98 P2-2 无条件全量外发 | 已退场（工具化按需取数） |
| round98 长卡正文被砍 96% | 已修复（round98 工具级预算 + round99 第二道坎），本轮复验一致 |
| round91 裸 slice 切坏 sxy-img:// uuid | 全程 clipText/clipString，未复发 |
| round82 改了调用忘 import（AI 助手一条答不出） | eslint 门禁在，本轮视图 import 核对无缺失 |
| CSV 公式注入（round94 S1） | 4cfd518 已修，本轮未发现残留 |
| 全量回归 | 1356/0 通过 |

---

## 五、优先级与待拍板

1. **P2-1（round101 未提交）**：建议立即提交入库——代码已实测通过，纯工作流丢失风险，无开发成本。**等用户拍板**。
2. **P3-1（写权限护栏）**：建议下一轮加"写入前 UI 确认"或剥离写工具；本轮仅需知情。
3. **P4-1/P4-2**：知情项/观察项，无需立即动作。

## 六、声明

本轮审计**未修改任何代码**、未擅自提交/回退 round101 残留；round101 是否入库、P3-1 是否加固，均待用户决定。测试在含 round101 残留的工作树下执行，结果 1356/0。
