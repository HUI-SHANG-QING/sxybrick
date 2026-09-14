# SxyBrick 深度代码审计报告 — Round 46

> **审计日期**：2026-09-14
> **审计基线**：git HEAD `122c41d`（并行会话新提交：死边误删 P1 + embedding 降级签名 P2 修复）+ 工作区未提交的 round45 N1 修复（mergeChatPair 确定性收敛）
> **审查角度**（按 round45 报告预留建议，换运行时视角）：多 tab 并发、worker 生命周期与定时器、存储配额与降级——静态功能审查盖不到的暗角
> **测试状态**：全量 **1079/1079 通过**
> **上轮报告**：`docs/AUDIT-2026-09-14-round45-deep.md`

---

## 一、总评（大白话）

round45 建议这轮查"运行时行为"，照做了。三个暗角逐一翻过：

- **多 tab 并发**：跨 tab 通信是干净的一次性通道（发完即关，不泄漏句柄）；写库广播有 150ms trailing 节流（批量导入不会广播风暴，且广播落在"最后一次写完安静 150ms"后，别的 tab 不会刷新到中间态）；番茄跨 tab 幂等不靠脆弱的时间窗，靠 roundId 稳定判重（容量 500 条覆盖数月）。**两个 tab 同时点同步**没有 Web Locks 互斥，但靠 hub 侧 `SYNC_IN_FLIGHT` 互斥 + 客户端优雅捕获兜住——单 hub 架构下这是合理的集中式锁。
- **worker 与定时器**：analytics worker 失败时清空句柄、reject 所有 pending、后续调用自动降级回主线程——三层善后齐全。全库 12 处 setInterval 逐一核对：组件级的全部有清理配对，模块级的（性能监控、配额检查）是有意常驻的应用级心跳。工作区里并行会话给 proactive.js 加的 tick 互斥（防定时/唤醒并发双推送）也核实为正确的正交修复。
- **存储配额**：5 分钟周期检查 + 30 分钟警告节流 + <10% 预警；持久化存储（`navigator.storage.persist`）双入口申请，防浏览器静默回收数据；SW 更新失败有完整降级链（activate → SKIP_WAITING → 强制 reload）；非安全上下文（局域网 http）配额 API 不可用时返回结构化的 `{unsupported}` 而不是崩。

**结论：无 P0/P1/P2。** 只有 1 个 P3 备忘（业务写路径无 QuotaExceededError 专项捕获，靠配额预警前置兜底——可接受，记录在案）。

---

## 二、round45 修复健在复验

| 项 | 位置 | 状态 |
|---|---|---|
| N1 mergeChatPair 确定性收敛 | `sync-manifest.js:404-424`（工作区，`round45 N1` 标记 1 处） | ✅ 健在（含回归测试） |
| N2 rtfCache 备忘 | 不适用（决定不修） | — |

round43/44 的 7 项修复随 round45 复验结论继续有效（本轮基线代码面未触碰这些文件的核心逻辑）。

---

## 三、本轮详细发现（大白话）

### 已核验为「做得对」的关键机制（交叉取证）

| 机制 | 证据 | 为什么重要 |
|---|---|---|
| 广播通道用完即关 | `dbEvents.js:26` postMessage 后 `setTimeout(ch.close(), 0)` | 每次通知新建 Channel 不会积累句柄泄漏 |
| 写库广播 trailing 节流 | `dbEvents.js:73-77` 审计 P2-3 注释：每次写重置计时器 | 别的 tab 永远刷新到"写完之后"的状态，不会读到半截数据 |
| 番茄跨 tab 幂等 | `pomoDedup.js` roundId 派生 + localStorage 判重 + 容量 500 | 同一轮专注不管开几个 tab 只入账一次，成就/长休不会翻倍 |
| 跨 tab 同步互斥 | hub 侧 `SYNC_IN_FLIGHT` 错误码 + `Sync.vue:584` 优雅捕获 | 两 tab 同时同步不会把 hub 的合并队列搞乱 |
| worker 三层善后 | `analytics.js:33-38` onerror 清句柄 + reject pending + 后续降级 | worker 崩了应用照常跑（慢一点），不会卡死也不会漏 resolve |
| worker 测试退出纪律 | `analytics.js:50-59` shutdownAnalyticsWorker + 注释解释 force-exit 的坑 | 测试进程能干净退出，不吞真实断言失败 |
| proactive tick 互斥 | 工作区 `proactive.js` `_lightRunning` in-flight 标志（round47 P2 注释） | 定时 tick 与 visibilitychange 唤醒并发时同一建议不再推两次 |
| 定时器全配对 | App/NotificationBell/DailyPlanView/LibraryFiles/plan-reminder 均 clearInterval 配对（LibraryFiles 1:4 是多分支清理） | 组件卸载不留僵尸定时器 |
| 配额预警 + 持久化 | `pwa.js` 5min 周期 + 30min 节流；`opfs.js:178`/`pwa.js:223` persist 双入口 | 写满盘前用户会先收到预警；浏览器不会静默回收数据 |
| SW 更新降级链 | `pwa.js:150-175` activate → SKIP_WAITING → 1.5s 兜底 reload | "点了更新还是旧版本"的老问题已被三层兜底覆盖 |

### 备忘（不修）

- **M1 [P3·备忘] 业务写路径无 QuotaExceededError 专项捕获**：`db.bulkPut/put` 满盘时浏览器静默拒写（promise reject），代码里没有针对这个错误码的专属兜底（如"清理缓存图片后重试"）。当前靠配额 <10% 预警前置提醒，实际写满的概率被压得很低。若未来要做，最佳切入点是 db 层统一包裹一次 retry-with-cleanup。记录在案，不动手。

---

## 四、优先级汇总

| 编号 | 优先级 | 位置 | 说明 | 建议成本 |
|---|---|---|---|---|
| M1 | P3·备忘 | db 写路径 | QuotaExceededError 无专项兜底（靠配额预警前置，可接受） | 未来可选 |

**无 P0/P1/P2，本轮零必修项。**

---

## 五、审计结论（大白话）

1. **运行时暗角全数通过**：广播、worker、定时器、配额四条生命线都有护栏，且注释里能看到历次审计修复的痕迹（P2-3、round19 R19-1、round33 E-3、round47 P2）——这个库的"防御工事"是长期按审计逐条砌起来的，不是偶然。
2. **基线推进说明**：并行会话在 round45 之后提交了 `122c41d`（死边误删 P1 + embedding 降级签名 P2），属于 AI 层深审的正交修复；工作区另有 round45 N1 修复 + 报告待提交。本轮全部纳入验证，1079/1079 通过。
3. **审计节奏建议**：连续六轮（43→46）未出现 P0/P1（除并行会话修掉的两项），代码库进入稳态。建议下一轮审计的触发条件改为"功能性大版本迭代后"而非固定周期，把审计预算留给真正的新代码面；运行时性能画像（万级卡 + 十万级复习记录）可在有真实大数据的用户环境时再做。

---

*审计完成时间：2026-09-14 | 基线：122c41d + 工作区 round45 N1 | 测试：1079/1079 pass | 本轮零必修项*
