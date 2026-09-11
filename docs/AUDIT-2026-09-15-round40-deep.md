# SxyBrick 深度代码审计报告 — Round 40

> **审计日期**：2026-09-15
> **代码基线**：git HEAD `a5cb4a2`（自 round39 基线 `e72d78b` 起 2 次提交）
> **测试状态**：973/973 全部通过（新增 3 个回归测试），耗时 ~39.8s
> **上轮报告**：`docs/AUDIT-2026-09-15-round39-deep.md`

---

## 一、上轮缺陷修复状态核验

### 1.1 round38 平行审计 5 项——全部修复 ✅

| 上轮编号 | 问题 | 修复方式 | 验证 |
|---|---|---|---|
| BUG-01 | mergeByFieldTs 平局 `>=` 不收敛 | 改为严格 `>` + 平局按 JSON 字典序取小者；新增对端独有字段直接采纳 | sync-manifest.js:460-465 ✅ |
| BUG-02 | imageRefs 死索引只写不读 | db v33 删除表（`imageRefs: null`），repo.js 删除 rebuildImageRefs 和所有 db.imageRefs 调用 | db.js:335-337, repo.js:636-638 ✅ |
| BUG-03 | dashboardSnapshot 缺显式失效 | 新增 `invalidateDashboardCache()` 导出，review/attachSelfExplanation/sweepOrphanRows 均调用 | repo.js:1095-1097, 972, 993, 656 ✅ |
| BUG-04 | TOMB_KIND_TABLE 硬编码枚举 | 新增 `tombKindTable()` 从 SYNC_TABLES+PRIVACY_SYNC_TABLES 自动派生 | sync-manifest.js:181-187, repo.js:720 ✅ |
| BUG-05 | trainWeights 拟合惰性维度 w18 | 新增 `TRAINABLE_WEIGHT_COUNT=17`，梯度循环只跑 0..16，非训练维原样保留 | fsrs.js:64-65, 318-337 ✅ |

**额外改进**：docs 和 exams 表也加了 fieldTs（createDoc/updateDoc/saveExam/updateExam），mergeRows 的 updatedAt 分支自动检测 fieldTs 并走字段级合并——这正是上轮 OPT-02 建议的。

### 1.2 round39 新发现 4 项——均未修复 ❌

| 上轮编号 | 问题 | 当前状态 |
|---|---|---|
| NEW-01 | wordStudyLog id=`t-${date}`，双设备同日 id 冲突，idOnly 随机丢一端 | ❌ word-repo.js 无变更，db.js 注释仍称"按 id 幂等不做求和" |
| NEW-02 | notifications 已读状态用 update 但 merge 是 idOnly，不跨设备同步 | ❌ proactive.js 无变更，markRead 仍 `update(id, {read:1})` |
| NEW-03 | notifications 删除/清空/超量清理不写墓碑 | ❌ proactive.js:56,82,86 仍直接 bulkDelete/clear/delete |
| NEW-04 | notifications 已读是设备本地状态，整行同步语义矛盾 | ❌ 未决策 |

---

## 二、本轮新发现

### NEW-05 [P3] mergeByFieldTs 对长文本字段做 JSON.stringify 字典序比较，平局时性能开销

- **位置**：`src/sync-manifest.js:465`
- **问题描述**：BUG-01 修复后，平局处理用 `JSON.stringify(xr[k]) < JSON.stringify(cur[k])` 做字典序收敛。对于 notes/docs 的 content 字段（可能数千至数万字），如果两端同毫秒修改了正文，每次合并都要 `JSON.stringify` 两份完整正文做字符串比较。
- **影响评估**：平局需要两端 fieldTs 完全相同（同毫秒），概率极低。且 JSON.stringify 长文本是 O(n) 但同步本身就是 IO 密集型，CPU 开销可忽略。仅在极端场景（万级文档 + 频繁并发编辑）下有感知。
- **建议**：无需立即处理。如果未来性能成问题，可改为先比较 `fieldTs` 字符串长度或哈希，哈希相同再做完整比较。

### NEW-06 [P3] tombKindTable() 未防御"kind 字段缺失"的新表

- **位置**：`src/sync-manifest.js:185`
- **问题描述**：`map[t.kind || t.table] = t.table`——如果未来新增表时漏写 `kind` 字段，会静默用 table 名作为 kind。此时如果写墓碑的地方用了不同的 kind 字符串（手写），又会回到 kind 漂移。
- **影响评估**：当前所有 38 张表都有 kind 字段，无实际问题。这是防御性编程的薄弱点，不是 bug。
- **建议**：加一个启动时断言——遍历 SYNC_TABLES 检查每张表都有 kind 且 kind 唯一，缺了就 console.warn。与 sync-manifest 已有的"三查 checklist"理念一致。

### NEW-07 [P3] docs/exams 的 fieldTs 初始化字段列表与 update 字段列表硬编码两处

- **位置**：`src/repo.js:1717`（createDoc 的 fieldTs 初始化）、`:1729`（updateDoc 的 diff 列表）、`:1941`（saveExam 的 fieldTs 初始化）、`:1958`（updateExam 的 diff 列表）
- **问题描述**：docs 的字段列表 `['title','content','type','tags','source']` 在 createDoc 和 updateDoc 各写了一份；exams 的 `['title','subject','questions','score','total']` 也写了两份。如果未来给 docs 加字段，需要同时改 create 和 update 两处，漏改一处会导致新字段不走字段级合并（回退整行 LWW）。
- **影响评估**：低。当前字段稳定，但属于可维护性债务。
- **建议**：把字段列表提为模块常量（`const DOC_FIELD_TS_KEYS = [...]`），create 和 update 共用。

---

## 三、仍存在的遗留问题（重申）

### NEW-01 [P1] wordStudyLog 同步语义错误——双设备同日时长被随机丢弃

- **位置**：`src/word-repo.js:646-660`、`src/sync-manifest.js:162`
- 上轮已详述。id=`t-${date}` 导致双设备同日 id 冲突，idOnly 合并随机保留一端。**连续两轮未修复。**

### NEW-02 [P1] notifications 已读状态不跨设备同步

- **位置**：`src/agent/proactive.js:71-79`、`src/sync-manifest.js:159`
- 上轮已详述。markRead/markAllRead 用 update/bulkPut，但 idOnly 合并不更新已读状态。**连续两轮未修复。**

### NEW-03 [P2] notifications 删除/清空/超量清理不写墓碑

- **位置**：`src/agent/proactive.js:56,82,86`
- 上轮已详述。**连续两轮未修复。**

### NEW-04 [P2] notifications 同步设计语义矛盾

- **位置**：`src/agent/proactive.js:48`、`src/sync-manifest.js:159`
- 上轮已详述。需先决定产品语义。**连续两轮未修复。**

---

## 四、优先级汇总

| 编号 | 类型 | 优先级 | 位置 | 一句话摘要 |
|---|---|---|---|---|
| NEW-01 | 遗留缺陷 | **P1** | word-repo.js:646 | wordStudyLog 同日 id 冲突，时长随机丢一端 |
| NEW-02 | 遗留缺陷 | **P1** | proactive.js:71 | notifications 已读状态不跨设备同步 |
| NEW-03 | 遗留缺陷 | P2 | proactive.js:56,82,86 | notifications 删除不写墓碑，对端复活 |
| NEW-04 | 遗留缺陷 | P2 | proactive.js:48 | notifications 已读是本地状态，整行同步矛盾 |
| NEW-05 | 新观察 | P3 | sync-manifest.js:465 | 长文本平局时 JSON.stringify 开销（极低概率） |
| NEW-06 | 新观察 | P3 | sync-manifest.js:185 | tombKindTable 未防御 kind 缺失 |
| NEW-07 | 新观察 | P3 | repo.js:1717,1729 | docs/exams fieldTs 字段列表硬编码两处 |

---

## 五、审计结论

**本轮迭代质量很高。** round38 平行审计的 5 项修复全部落地，且附带了 docs/exams 的 fieldTs 推广（超出了上轮建议范围），测试从 970 增至 973。mergeByFieldTs 的平局收敛修复正确——严格 `>` + 字典序，与项目其它合并点同口径。tombKindTable() 自动派生彻底解决了枚举漂移。imageRefs 死表的处理也很干净（直接删除而非将就）。

**但上轮新发现的 4 个问题连续两轮未动。** 其中 NEW-01（wordStudyLog）和 NEW-02（notifications 已读）是 P1 级，直接影响多设备用户的数据正确性。这两个问题都不复杂（各约 10-20 行改动），但需要先做产品决策：
- wordStudyLog：是要"各设备独立记录"还是"跨设备求和"？
- notifications：是要"一端已读全端已读"还是"各设备独立已读"？

**建议本轮优先处理这 4 项**，它们是当前代码库中唯一影响用户实际数据的正确性问题。新发现的 NEW-05~07 都是 P3 级可维护性改进，可排期处理。

---

*审计完成时间：2026-09-15 | 审计基线：a5cb4a2 | 测试：973/973 pass*
