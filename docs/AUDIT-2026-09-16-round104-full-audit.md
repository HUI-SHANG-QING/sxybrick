# round104 审计报告：全量复审计（确认门无绕过 + 4 个 P3 观察项）

- 日期：2026-09-16
- HEAD：`ebb596a`（round103 两个 commit 已入库推送，工作树干净、远端一致）
- 范围：底层代码 / 核心算法 / 业务逻辑全量复核，重点排查「不易察觉的隐患」

## 一、结论

| 项 | 结论 |
|---|---|
| 严重问题（P1/P2） | ✅ **零**——未发现新的高危缺陷 |
| round103 写入确认保险 | ✅ 无绕过路径（详见第二节） |
| 工具层一致性 | ✅ 46 个工具引用全部已注册，零悬挂 |
| 回归 | ✅ 全量 `npm test`：**1365 pass / 0 fail / 1 todo**（todo=构建产物分片加载器，历史既定、CI 兜底；eslint + i18n 双闸门 + dep-check + sync-coverage-audit 全绿） |
| 观察项 | 4 个 P3（低风险，未授权不修，见第三节） |

## 二、重点排查面（已确认安全）

1. **写入确认门无绕过路径**：
   - `assistant`（普通问答）工具清单仅 5 个写工具（create_note/update_note/create_daily_plan/add_daily_task/checkin_daily_task），全部 `writesData:true` → 全部被确认门覆盖；
   - `delegate_to_agent` / `write_blackboard` **不在** assistant 清单（仅工作台 tutor 等挂，且工作台不开启 confirmWrites）→ 不存在"委托子 Agent 绕过确认"的路径；
   - pipeline 分支：`if (!agentId && shouldUsePipeline(...))`——assistant 显式传 `agentId:'assistant'` 不进 pipeline，确认门不会被绕过。
2. **"名字像写"的工具全部确认只读/只生成**：`generate_cards`（只返回候选）、`quiz_me`（只出题）、`suggest_mnemonic`（实为取近期错题）、`smart_review_plan` / `auto_generate_plan`（只算不存，由模型再调 create_plan 落库）、`generate_variant_card`——落库统一走有 writesData 标记的工具，设计与确认门一致。
3. **附图链路有护栏**：`image-analysis.js` 有 24MB 字节预算 + 张数上限夹取 [1,1000]；费曼完整正文（clipText 400/600 保图片引用）不会造成一次请求附图爆炸。
4. **辅助函数齐全**：`clip.js` 的 clipText/hasImageRef/stripImageRefs 实现完善（保 56 字符图片引用完整）；`ai-structured.js` 的 esc 定义存在；timeline 渲染补丁与协议一致。
5. **WordBook 批量删除**：卡片全量加载 → 全选覆盖全部；单条失败不中断整批；删除走回收站可恢复。

## 三、P3 观察项（低风险，未授权不修）

| # | 位置 | 问题 | 成因 | 影响 |
|---|---|---|---|---|
| P3-1 | `src/analysis/ai-analyzer.js`（round103 并行修复处） | 裸 JSON 仍有漏网：LLM 返回**合法 JSON 但忘包 type/data 键**（如 `{"steps":[...]}`）时，`hasEnvelope` 判 false → 走文本降级 → 用户仍看到裸 JSON | 降级判断只查"像不像信封"（`"type":`/`"data":` 正则），不先试 `JSON.parse` | 极低概率（模型忘包 envelope）；显示裸 JSON 而非数据丢失。建议：降级前先 tryParse，能解析则按结构提取或明确提示 |
| P3-2 | `src/views/WordBook.vue:450` + `src/repo.js:324` | 批量删除 `await deleteWordCard(id); done += 1` 无条件计数，未检查返回值 | repo 层注释已确认：deleteWordCard 等删除操作调用方普遍不查返回值 | 配额写满/磁盘异常时 toast「已删除 N 个」可能虚高 |
| P3-3 | `src/agent/agents/base.js` executeTool | 确认门一次性放行：模型同一轮**连续调同一写工具两次**时，第二次被拦截→再弹框→重跑→实际写入 2 次 | 一次性放行是刻意取舍（防批准 A 后自动写 B/C），代价是同工具连续调用需二次确认 | 罕见（模型同轮重复调同工具）；每次都有弹框，无静默写；guard 3 兜底 |
| P3-4 | `src/sync.js:214-215`（round89 遗留） | 增量包把全部变更图片 base64 全量驻留内存（每张 200-600KB） | 既有架构（图片单独打包），与 x-client-time 等同步项同为历史遗留 | 图片量大时同步打包内存压力/卡顿；非新引入 |

## 四、验证（实测）

- `npm test`：**1365 pass / 0 fail / 1 todo**；eslint、check-view-i18n（--strict/--js，反向扫描 179 行无新增）、dep-check、sync-coverage-audit 全过
- 工具引用完整性脚本：assistant 46 工具 + 全部内置 Agent 工具，**零未注册引用**
- 提交链：`ebb596a`（round103 写入确认 + 并行修复）已推送，本地/远端一致

## 五、结论（维护度限定）

round103 的写入确认保险与并行修复经本轮全量复核**无回归、无绕过**；仅余 4 个 P3 观察项（均低风险、非新引入），建议按需处理：P3-1 可在下次触碰 AI 输出管线时顺手补一次 tryParse 兜底；P3-2/P3-3 为 UX 级；P3-4 为历史 sync 遗留，需单独授权。
