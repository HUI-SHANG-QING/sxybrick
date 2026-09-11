# SxyBrick 深度代码审计报告 — Round 39

> **审计日期**：2026-09-15
> **代码基线**：git HEAD `e72d78b`（round38 提交：5 张本机表并入同步 + 图片收集加固）
> **测试状态**：970/970 全部通过，耗时 ~44.2s
> **上轮报告**：`docs/AUDIT-2026-09-11-round38-deep.md`（基线 `189c0e8`）
> **本轮变更范围**：自上轮审计起 1 次提交，sync-manifest.js +25/-15、sync.js +24/-6、repo.js +11/-3

---

## 一、上轮缺陷修复状态核验

| 上轮编号 | 问题 | 状态 | 说明 |
|---|---|---|---|
| BUG-01 | mergeByFieldTs 平局 `>=` 不收敛 | ❌ **未修复** | sync-manifest.js:447 仍为 `if (xt >= ct) out[k] = xr[k]`，注释称"与整行收敛一致"但实际整行是严格 `>`+字典序 |
| BUG-02 | imageRefs 死索引（只写不读） | ❌ **未修复** | 表仍存在，cleanupOrphanImages 仍走全表扫描；但 round38 新增 collectPackImageIds 加固了导出时的图片收集（扫 6 表而非仅卡片） |
| BUG-03 | dashboardSnapshot 缺显式 invalidate | ❌ **未修复** | repo.js:1104 仍无 invalidate 函数，仅靠时间戳缓存键自然失效 |
| BUG-04 | TOMB_KIND_TABLE 硬编码枚举 | ⚠️ **部分修复** | round38 补了 5 种新 kind（notification/error/aiUsage/wordExportHistory/wordStudyLog），但仍是硬编码，未从 SYNC_TABLES 自动派生 |
| BUG-05 | trainWeights 拟合惰性维度 w18 | ❌ **未修复** | fsrs.js:60 注释仍标注"训练仍会拟合它造成看似已调优的假象"，梯度循环未跳过 |

**结论**：上轮 5 个缺陷中 0 个完全修复、1 个部分修复、4 个未动。其中 BUG-01（合并不收敛）和 BUG-02（死索引）是 P2 级，建议优先处理。

---

## 二、本轮新发现的缺陷（round38 引入）

### NEW-01 [P1] wordStudyLog 同步语义错误：双设备同日时长被随机丢弃

- **位置**：`src/word-repo.js:646-660`（写入）、`src/sync-manifest.js:162`（合并策略）、`src/db.js:269-271`（注释）
- **问题描述**：
  - wordStudyLog 的 id 是 `t-${date}`（如 `t-2026-09-15`），**两台设备同一天的记录 id 完全相同**。
  - merge 策略是 `idOnly`（已存在则保留，不更新）。
  - 结果：A 设备今天学了 30 分钟，B 设备今天学了 20 分钟。同步时谁先到中枢谁的值保留，另一端的时长**被静默丢弃**。
  - db.js:270 注释称"不做求和，避免跨设备相加虚增"——但 idOnly 的结果不是"不做求和"，而是**随机保留一端**，这比求和更糟糕：用户在 A 设备学的时间在 B 设备上看不到，反之亦然，且无规律。
- **根因**：把"按天累计的时长流水"当成了"不可变追加记录"。wordStudyLog 的写入是 read-modify-write（`cur.ms + delta`），本质上是可变状态，不适合 idOnly。
- **影响范围**：所有使用多设备的用户，英语学习时长统计在设备间不一致。累计时长（wordStudyTimeTotal 全表求和）也会因设备不同而不同。
- **修复建议**（三选一）：
  - **方案 A（推荐）**：id 加设备分片，改为 `t-${date}-${deviceId}`，合并后展示时按 date 分组求和。每设备记录独立、不冲突，求和在展示层做。
  - **方案 B**：merge 策略改为 `updatedAt` LWW，至少保留较新的累计值（但仍会丢一端的增量）。
  - **方案 C**：回退到不同步（恢复 EXCLUDED_FROM_SYNC），时长本就是设备语境数据。

### NEW-02 [P1] notifications 已读状态不跨设备同步

- **位置**：`src/agent/proactive.js:71-79`（markRead/markAllRead）、`src/sync-manifest.js:159`（merge='idOnly'）
- **问题描述**：
  - `markRead(id)` 用 `db.notifications.update(id, { read: 1 })`，`markAllRead()` 用 `bulkPut(unread.map(u => ({...u, read: 1})))`。
  - 但 notifications 的 merge 策略是 **idOnly**——合并时"已存在则保留"，**不更新任何字段**。
  - 结果：A 设备把通知标记已读，同步到 B 设备时，B 设备上同 id 通知已存在（未读状态），idOnly 合并保留 B 的旧值——**已读状态不跨设备传播**。
  - 反过来，B 设备收到 A 同步来的"新通知"时，如果 B 本地已有同 id 通知（比如 proactive 推送去重 key 相同），也不会更新。
- **根因**：notifications 不是不可变记录——`read` 字段会被更新。idOnly 策略只适合 append-only 表（如 reviews、pomoSessions），不适合有状态变更的表。
- **影响范围**：多设备用户的通知已读状态永远各自为政，A 读完了 B 还显示红点。
- **修复建议**：merge 策略改为 `updatedAt`，且 markRead/markAllRead 时必须 bump `updatedAt`（当前 update 只改 read 字段，不更新 updatedAt）。或者把 `read` 字段从同步行里剥离，改为设备本地存储（localStorage 按 notificationId 存已读状态），通知内容同步、已读状态本地。

### NEW-03 [P2] notifications 删除/清空/超量清理均不写墓碑

- **位置**：`src/agent/proactive.js:55-56`（超量清理）、`:82`（clearAllNotifications）、`:86`（deleteNotification）
- **问题描述**：
  - `pushNotification` 超量清理：`db.notifications.bulkDelete(excessIds)` — 不写墓碑。
  - `clearAllNotifications`：`db.notifications.clear()` — 不写墓碑。
  - `deleteNotification(id)`：`db.notifications.delete(id)` — 不写墓碑。
  - notifications 已入同步表（idOnly），**absence ≠ deletion**——本地删了但对端/中枢仍有副本，下次拉取时被删除的通知会**复活**。
  - 对比：errors 表的超量清理和清空都已正确写墓碑（errorLog.js:25-29, 43-49），aiUsage 的 prune 和清空也写了墓碑（repo.js:795-800, ai-usage.js:96-102）。notifications 是唯一遗漏的同步表。
- **根因**：round38 把 notifications 从 EXCLUDED_FROM_SYNC 移到 SYNC_TABLES，但只改了清单，没有同步修改 proactive.js 的删除路径——这些路径是按"本地表"语义写的，删除即消失，不需要墓碑。
- **影响范围**：用户在 A 设备清掉通知，B 设备下次同步后通知又回来了。超量清理（超过 maxNotifications 自动删旧通知）也会在对端复活，导致通知数量在设备间不一致。
- **修复建议**：三处删除路径统一包事务 + 写墓碑（kind='notification'），与 errors/aiUsage 同型。可抽一个 `deleteNotificationsWithTombstone(ids)` 工具函数复用。

### NEW-04 [P2] notifications 同步的设计语义矛盾：已读是设备本地状态

- **位置**：`src/agent/proactive.js:48`（read 字段）、`src/sync-manifest.js:159`
- **问题描述**：
  - 通知的"已读/未读"本质上是**设备本地状态**——A 设备用户看了通知，不代表 B 设备用户也看了。
  - 当前设计把整条通知（含 read 字段）同步，意图是"多设备统一通知中心"，但这与用户直觉矛盾：我在手机上划掉了通知，平板上不应该也自动划掉（反之亦然）。
  - 即使修复 NEW-02（让已读状态同步），也会造成"A 读了 B 也变已读"的反直觉行为。
  - 这是一个**设计层面**的问题，不是单纯的 bug。
- **修复建议**：明确产品语义——
  - 如果要"多设备统一通知中心"：同步通知内容，已读状态也同步（修复 NEW-02 + NEW-03），用户接受"一端已读全端已读"。
  - 如果要"各设备独立已读"：同步通知内容但不同步 read 字段（strip 掉），每设备本地维护已读状态。
  - 当前是最坏的中间态：内容同步了但已读状态因 idOnly 不同步，删除也不写墓碑，四不像。

---

## 三、仍存在的上轮未修复缺陷（重申）

### BUG-01 [P2] mergeByFieldTs 平局取 incoming，双端可不收敛

- **位置**：`src/sync-manifest.js:447`
- 上轮已详述。notes/memos/plans/mindmaps 四表的字段级合并用 `>=`，与项目其它合并点的严格 `>`+字典序收敛纪律不一致。round38 未动此代码。

### BUG-02 [P2] imageRefs 反向索引表"只写不读"

- **位置**：`src/db.js:325-331`、`src/repo.js:644-667`
- 上轮已详述。round38 的 collectPackImageIds 加固了**导出时**的图片收集（从只扫卡片改为扫 6 表），但 imageRefs 表本身仍无读路径。两个问题是独立的：导出收集加固是对的，但 imageRefs 死索引的问题仍在。

### BUG-03 [P3] dashboardSnapshot 缺显式失效函数

- **位置**：`src/repo.js:1104-1126`
- 上轮已详述。仍无 invalidateDashboardSnapshot 导出。

### BUG-05 [P3] trainWeights 拟合惰性维度 w18

- **位置**：`src/fsrs.js:315-328`
- 上轮已详述。梯度循环仍遍历全部 19 维，w18 不被公式引用但仍参与训练。

---

## 四、可优化点

### OPT-01 [P2] notifications 表的写路径需全面适配同步语义

- 与 NEW-02/NEW-03/NEW-04 联动。一旦决定了同步语义，需要统一修改：pushNotification（超量清理写墓碑）、markRead（bump updatedAt 或 strip）、markAllRead、clearAllNotifications、deleteNotification。当前 5 个写路径没有一个考虑了同步语义。

### OPT-02 [P2] wordStudyLog 如需同步，必须改 id 设计

- 与 NEW-01 联动。当前 `t-${date}` 的 id 设计在单机模式下合理（一天一行累计），但一旦入同步就必须改。建议加设备分片或改 merge 策略。

### OPT-03 [P3] round38 新增 5 表的"三查 checklist"未完全覆盖

- sync-manifest.js 的"三查 checklist"（L53-75）要求新增表时检查：引用字段登记、图片 GC 覆盖、级联删除、不变量测试、敏感字段 strip。
- 新增的 notifications/errors/aiUsage/wordExportHistory/wordStudyLog 中：
  - errors 含 stack/ctx（可能含敏感路径信息），未加 strip
  - aiUsage 含 model/source（非敏感），OK
  - notifications 含 body（可能含用户数据），但通知本身就是用户数据，OK
  - 5 张表均无引用卡片 id 的字段，无需登记 CARD_REF_FIELDS
  - **不变量测试**：tests/sync-manifest.test.mjs 的表数量断言应已更新（+5 表），需确认

---

## 五、扩展点

### EXT-01 [P2] 设备标识（deviceId）基础设施

- wordStudyLog 的设备分片、notifications 的已读状态本地化、未来的"哪台设备最后编辑"审计，都需要一个稳定的 deviceId。当前项目没有 deviceId 概念（同步靠 hub URL + token，不标识设备）。可在首次启动时生成 UUID 存 localStorage，作为跨模块基础设施。

### EXT-02 [P2] 同步表"可变 vs 不可变"自动校验

- 当前 merge 策略靠人工指定（idOnly/updatedAt/card/chat），但表的实际写路径是否真的不可变没有校验。可加一个 lint/测试：扫描所有 `db[table].update` / `db[table].put`（非 create）调用，若某 idOnly 表存在更新路径则告警。这能系统性捕获 NEW-02 这类问题。

---

## 六、优先级汇总

| 编号 | 类型 | 优先级 | 位置 | 一句话摘要 |
|---|---|---|---|---|
| NEW-01 | 新缺陷 | **P1** | word-repo.js:646, sync-manifest.js:162 | wordStudyLog 同日 id 冲突，idOnly 随机丢一端时长 |
| NEW-02 | 新缺陷 | **P1** | proactive.js:71-79, sync-manifest.js:159 | notifications 已读状态用 update 但 idOnly 不更新 |
| NEW-03 | 新缺陷 | **P2** | proactive.js:55,82,86 | notifications 删除/清空/超量清理不写墓碑，对端复活 |
| NEW-04 | 新缺陷 | **P2** | proactive.js:48, sync-manifest.js:159 | notifications 已读是设备本地状态，整行同步语义矛盾 |
| BUG-01 | 遗留 | P2 | sync-manifest.js:447 | mergeByFieldTs 平局不收敛 |
| BUG-02 | 遗留 | P2 | db.js:325, repo.js:644 | imageRefs 死索引 |
| BUG-03 | 遗留 | P3 | repo.js:1104 | dashboardSnapshot 缺 invalidate |
| BUG-04 | 遗留 | P3 | repo.js:751 | TOMB_KIND_TABLE 硬编码（已补5种但未根治） |
| BUG-05 | 遗留 | P3 | fsrs.js:315 | trainWeights 拟合 w18 惰性维度 |
| OPT-01 | 优化 | P2 | proactive.js 全文件 | notifications 写路径全面适配同步语义 |
| OPT-02 | 优化 | P2 | word-repo.js:646 | wordStudyLog id 加设备分片 |
| OPT-03 | 优化 | P3 | sync-manifest checklist | 新增5表的敏感字段/不变量测试覆盖确认 |
| EXT-01 | 扩展 | P2 | 基础设施 | deviceId 稳定标识 |
| EXT-02 | 扩展 | P2 | 测试/lint | idOnly 表更新路径自动校验 |

---

## 七、审计结论

round38 把 5 张"本机表"并入同步是一次**有意义的功能扩展**，但引入了 **4 个新缺陷**，其中 2 个 P1 级（wordStudyLog 时长丢失、notifications 已读不同步），核心原因是**只改了同步清单，没有同步修改这些表的写路径来适配同步语义**（墓碑、updatedAt、id 设计）。

这与上轮审计指出的"枚举漂移"系统性风险（X-1）是同一类问题：新增/变更同步表时，衍生的写路径、删除路径、合并策略需要联动修改，靠人工 checklist 容易遗漏。

**建议修复顺序**：
1. **NEW-01**（wordStudyLog）——决定同步语义后改 id 或回退，10 行改动
2. **NEW-02 + NEW-03 + NEW-04**（notifications）——先决定产品语义（统一已读 vs 各端独立），然后统一改 5 个写路径
3. **BUG-01**（mergeByFieldTs 收敛）——10 行改动，与上轮一致
4. **BUG-02**（imageRefs）——架构决策：用起来还是删掉

上轮 4 个未修复缺陷中，BUG-01/BUG-02 已连续两轮未动，建议本轮优先处理。

---

*审计完成时间：2026-09-15 | 审计基线：e72d78b | 测试：970/970 pass*
