# round103 审计报告：写入前确认保险 + 并行修复验收

- 日期：2026-09-16
- HEAD：`8c3450c`（本轮分两个 commit：并行修复 `8c3450c`，写入确认见下）
- 需求：用户拍板「加一道"写入前先问你一句"的保险」；并行 AI 会话已结束，其修复一并验收入库

## 一、结论

| 项 | 结论 |
|---|---|
| 写入前确认保险 | ✅ 已落地：普通问答（AI 学习助手）的**写工具**（建笔记/排任务/打卡/编辑卡片）执行前必须先弹确认框，用户批准才真正写入；工作台 Agent 不开启，行为不变 |
| 并行 AI 修复验收 | ✅ 4 处全部通过：AI 输出截断修复、timeline 渲染、费曼完整正文、单词批量删除（详见第五节） |
| 回归 | ✅ 全量 `npm test`：**1361 pass / 0 fail / 0 todo**（eslint + i18n 双闸门 + dep-check + sync-coverage-audit 全绿） |

## 二、写入确认保险：问题与根因（P3-1 闭环）

- **位置**：`src/agent/agents/base.js`（executeTool / runReActAgent）、`src/agent/orchestrator.js`（runTask ctx）、`src/views/AIAssistant.vue`（send 确认流程）、`src/i18n/views/aiAssistant.js`（zh/en 文案）。
- **根因**：round100 工具化后，assistant Agent 挂了 5 个写工具（create_note/update_note/create_daily_plan/add_daily_task/checkin_daily_task），此前只有提示词约束「先确认再写」，**无代码级护栏**——模型偶发跳步会直接改用户数据且无痕。
- **影响**：AI 学习助手（充钱用户日常使用）可能未经确认写入笔记/计划/打卡，用户难以察觉和回滚。

## 三、实现（用户拍板后落地）

1. **确认门（base.js）**：`executeTool` 在 `tool.writesData === true && ctx.confirmWrites === true` 时，若无匹配的 `approvedWrite` 则返回 `{ ok:false, needsConfirm:true, name, args }` 并**不执行**；批准后 `delete ctx.approvedWrite` 一次性放行。
2. **中断循环（base.js）**：`runReActAgent` 新增 `onPendingWrite`，收到 needsConfirm 立即中断 ReAct 循环并交回调用方，不再继续推理。
3. **开关透传（orchestrator.js）**：ctx 注入 `confirmWrites: opt.confirmWrites === true` 与 `approvedWrite`；返回值附 `pendingWrite`。仅 assistant 路径开启，工作台 Agent（tutor/planner 等）不传 → 行为不变。
4. **前端确认（AIAssistant.vue）**：`runAgentTurn(..., confirmWrites:true)` 收到 `pendingWrite` 弹 `confirmDialog`（标题「AI 想写入数据」+ 写工具中文名 + 参数摘要，均走 i18n）；批准后用同一轮历史带 `approvedWrite` 重跑；取消则回复「已取消写入，未做任何修改」。连续写入逐次确认（guard 上限 3 防死循环）。
5. **安全复核**：批准后模型若再冒新写入 B，B 仍被确认门拦截（approvedWrite 已一次性清除），不会未确认写入——**无安全缺口**；第二轮会再次弹框（循环确认）。

## 四、验证（实测）

- `node --test tests/round103-write-confirm.test.mjs`：**5 pass / 0 fail**
  - 未批准 → 拦截且探针计数为 0（绝不执行）
  - 批准匹配 → 放行执行一次，且 approvedWrite 被清除（一次性）
  - 批准不匹配（不同工具名）→ 仍拦截
  - 未开启 confirmWrites（工作台路径）→ 直接执行，不回归
  - 读工具不受影响
- 全量 `npm test`：**1361 pass / 0 fail / 0 todo**（含 eslint、check-view-i18n --strict/--js、dep-check、sync-coverage-audit 门禁）

## 五、并行 AI 修复验收（用户反馈三件事 + 输出健壮性）

| 用户反馈 | 修复（并行 AI） | 审查意见 | 实测 |
|---|---|---|---|
| 联动分析输出「JSON 原文」没渲染 | ① `llm-json.js` 新增 `repairTruncated`：从首个 `{`/`[` 起按字符串内/外扫描，补未闭合引号/括号，救回被 max_tokens/超时截断的结构化输出；② `ai-analyzer.js`：解析失败但**看起来像 JSON 信封**时抛错降级本地模式，绝不把裸 JSON 甩给用户 | ① 只修「尾巴」不重建中间内容，调用方按 id 过滤，局限明确；② 正则仅匹配代码块/`{`/`[` + type/data 信封，误伤自由文本风险低 | ✅ 全量测试含 4 条新断言 |
| 费曼能否读到详细数据 | `Feynman.vue`：正文从 `.slice(0,100/140)` 改为 `clipText(400/600)`——正文变长但**图片引用（56 字符 sxy-img://）完整保留**，随 enrichForLlm 作为附图送出 | clipText 截断不切引用，符合 round101 大字段截断范式；上下文体积有界（每卡 ≤1KB 左右） | ✅ 含断言（不再 slice 切坏引用） |
| 单词本要能批量删除 | `WordBook.vue` + `wordBook.js` i18n：多选模式 + 全选/取消/删除选中，逐条删除、单条失败不中断整批，zh/en 文案齐全 | 删除走既有 deleteWordCard → 回收站可恢复；批量条仅在 batchMode 显示，不破坏原有交互 | ✅ 含断言（i18n 键位对齐） |
| （附带）timeline 类型无渲染 | `ai-structured.js`：新增 `timeline` 类型 → 有序步骤列表渲染（此前落 genericToMd 接近裸 JSON） | 与 Agent 提示协议、渲染分支口径一致 | ✅ 含断言 |

## 六、遗留（P3，均未授权修复，非本轮范围）

- round89 备忘：sync-hub x-client-time、过期挑战惩罚语义、OCR 语言包 CDN、备份含 errorLog、依赖卫生等（仍开放）
- round94 P3-1：analytics offload 无超时（worker 挂起时 promise 悬挂窗口仍在；onerror 回退不受影响）

## 七、变更清单（两个 commit）

1. `8c3450c feat(ai): round103 修 AI 输出截断/裸JSON/timeline渲染 + 费曼完整正文 + 单词批量删除`（并行 AI 成果：ai-analyzer / llm-json / ai-structured / wordBook.js / Feynman.vue / WordBook.vue + 测试 + round102-deep 报告）
2. 本轮 commit：base.js / orchestrator.js / AIAssistant.vue / aiAssistant.js i18n / round103-write-confirm 测试 / 本报告

> 说明：本报告所涉代码改动均经用户明确授权（「好，加一道写入前先问你一句的保险」）。
