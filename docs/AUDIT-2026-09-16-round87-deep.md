# round87 深度审计报告（round85/86 验收 + AI 上下文/防重修复深审）

- 日期：2026-09-16
- HEAD：`1c83394`（对话滑动窗口 + 防重容量上限）
- 工作区：干净（round84 的在途半成品已全部提交）

## 一、round84 在途半成品验收（全过）

| 遗留项 | 现状 |
|---|---|
| quiz-recorded.test.mjs 自伤断言（两串题干字符不同） | ✅ 924845b 已修正：:16 改用"仅空白有无不同"的两串（`停止-等待 协议的…` vs `停止-等待 协议的 窗口…` 同键 / 异键语义自洽），相关测试全过 |
| 在途改动（quiz 持久防重 / 未作答不记账 / clampScheduledHour） | ✅ 已提交（924845b），工作区干净 |
| 全量验证 | ✅ 本轮复跑：lint 0 error、node --test 全绿 |

## 二、新修复深审（924845b + 1c83394，零新 P1/P2）

1. **clampScheduledHour 二次收口（round85）**：round82 收口数据层后，round85 发现工具层另有 4 处 `Number.isFinite(Number(v)) ? … : null`——**`Number(null)===0` 且 isFinite(0)===true** → 库里是 null（没排时段）却上报成 0 点，模型对用户说"已安排 0 点"。现在归一为**全仓唯一一份**（repo.js 导出），数据层 3 条写路径 + 工具层 4 处读写映射共 7 个调用点全部收敛；语义与 sync-manifest 域校验对齐（number 或 null）；两个显式挡住的坑（`Number('')===0`、`Number([])===0`）注释在案。
2. **trimChatHistory 滑动窗口（round86 P2-1）**：普通对话此前全量塞历史——长对话请求逐轮膨胀直至 400"上下文超限"。修法：头部 system 消息保留、按"轮"截断（user 为锚，最近 16 轮，轮对不切半截）、本轮输入永远在；maxTurns=0/负/NaN 防御（至少 1 轮）；与 Agent 路径（orchestrator slice(-12)）对齐。
3. **防重存储容量上限（round86 P3-1）**：防重键无上限 → localStorage 写满 → setItem 抛错被吞 → 防重静默失效。超 3000 键一次性清空（防重只是优化，清空降级可接受——注释明确"不是正确性"）。

## 三、验证（本轮实测）

- `npm run lint`：exit 0
- `node --test --test-concurrency=1 "tests/*.test.mjs"`：exit 0，全绿
- 工作区干净，无未提交源码改动

## 四、结论（维度限定）

1. 已覆盖维度内（round84 遗留 + 两个新提交）：零未收口项、零新 P1/P2/P3。
2. 亮点观察：clampScheduledHour 的"二次收口"体现了 `Number(x)` 孪生陷阱（吞显式 0 / null 变 0）的完整认知——同一类坑在 fsrs.js H-1、calibration-feedback A9、本次工具层三处复发，每次都以"全仓唯一实现 + 全调用点收敛"方式终结，而非打补丁。
3. 节奏维持：审计按事件触发（大重构/新子系统/事故），当前无可审计增量。
