# SxyBrick 深度代码审计报告 — Round 57（新维度专项）

> **审计日期**：2026-09-15
> **审计基线**：git HEAD `5ad4ccf`
> **本轮性质**：**换新攻击面**的深审——前几轮（53/55/56）连续"零新发现"，判断是**老维度挖干了**，
> 故不再重复"对称性配对"等既有维度，改用 8 个从未系统扫过的新维度。
> **上轮报告**：`docs/AUDIT-2026-09-14-round56-deep.md`（并行会话产出）
> **测试状态**：全量 **1101/1101 通过**（含新增回归 5 条）；i18n 三道闸 0 新增 · dep:check 0 环

---

## 一、总评（大白话）

**认领口径先说清**：round54 那 12 项（含 P1 回收站还原丢图）经核验**已全部落地且正确**——
并行会话的 round55 已逐项复核 12/12，我另行确认改动文件确在 `0214759` 里（`src/repo.js` /
`src/router.js` / `src/views/Review.vue` / `src/main.js` / `vite.config.js` 等 16 个文件）。

**本轮的价值不在"又扫了一遍"，而在换维度后真的挖出了东西**：新维度 8 个，
**确认 2 个真实缺陷（1 P2 + 1 P3），全部已修 + 带回归测试**；
同时**否证了 4 条听起来很吓人但实际不成立的假设**（这部分同样有价值——避免瞎改）。

---

## 二、新维度清单与结论

| # | 维度 | 结论 |
|---|---|---|
| D1 | 异步竞态与重入 | 抽查未见缺陷（批量 AI 任务用 AbortController + 序号校验） |
| D2 | 存储配额 / 部分失败 / 事务一致性 | **发现 P2（已修）** |
| D3 | 时间、时区与日期边界 | 零发现（UTC/本地口径统一、无固定毫秒加日期） |
| D4 | 多标签页并发 / SW 更新 | 零发现（Dexie blocked/versionchange 横幅 + BroadcastChannel + SW prompt） |
| D5 | 安全边界（XSS/公式注入/凭证泄漏） | 零发现（公式注入已防、4 处凭证均无同步出口） |
| D6 | 数据规模与性能悬崖 | 见下（未完成系统扫描，见"未完成项"） |
| D7 | 备份/还原版本兼容与完整性 | **发现 P3（已修）**；tombstones 缺失、meta 同步均安全 |
| D8 | 资源生命周期与配对 | 零发现（配对统计：revoke 22≥create 20、clear 22≥set 18） |

---

## 三、P2：配额写满时"主数据已入库、图片全缺"，且 UI 只弹原始 QuotaExceededError

### 3.1 实证（不是推测）

用 `fake-indexeddb` 忠实复现导入数据流，把 `db.images.bulkPut` 换成抛 `QuotaExceededError`：

```
importBackup 抛出: QuotaExceededError: The quota has been exceeded
落库结果: cards = 1 , images = 0 , snapshots = 1
```

卡片**确实入库了**，它引用的 `sxy-img://img1` **不存在** → 库里留下一张断图卡。

### 3.2 根因

图片写库**刻意**放在主事务之外（`src/sync.js:1063-1071` 注释写明：round11 N1 拆出以①避免大
base64 阻塞事务 ②单张坏图不回滚整 31 表导入——这是**正确的设计取舍**）。

但该注释辩护的理由只覆盖了"**单张坏图**"（逐张 try/catch → `stats.skippedImages`，已由 round54
P2-4 补上提示）。**配额写满是另一条路**：它是 `bulkPut` 整体硬抛，异常一路冒出 `importBackup`
→ `Sync.vue confirmImport` 的 catch → `toast(err.message)`，即弹出
`QuotaExceededError: The quota has been exceeded` 这种对用户零信息量的原文；
且 `loadCounts()` / `saveReport()` 都在 await 之后，**根本不会执行** →
用户以为"什么都没导入"，实际卡片已落库、图片全缺、侧栏计数还是旧值。

### 3.3 修复（`src/sync.js` + `src/views/Sync.vue` + i18n）

1. `db.images.bulkPut` 包 try/catch → **就地降级不再抛出**，缺图数进 `stats.imageWriteFailed`，
   `stats.images` 保持 0（不虚报成功数）。
2. 图片墓碑 `bulkDelete` 同样加 try/catch（同因：已在事务外，抛出会毁掉整个导入的判定）。
3. `fmtStats` 显式汇报 `imageWriteFailed`，文案给出**可执行动作**（清理空间后重新导入补齐）。
4. 主事务路径的配额失败（真会回滚）给专属文案 `quotaExceeded`：**"导入已回滚（未写入任何数据）"**
   ——这句是能兑现的承诺，已由回归测试 #3 证明。

**关键设计区分**（回归 #2 守）：`skippedImages`（单张坏图，可重新导入补齐）与
`imageWriteFailed`（整批写不进去，多为空间不足）**语义必须分离**，否则用户拿不到正确动作。

---

## 四、P3：损坏备份包抛裸 `TypeError`，用户无从判断"其实是文件坏了"

### 4.1 实证

```
backup.cards = {}   →   TypeError: (backup.cards || []).filter is not a function
                       落库结果: cards = 0   （事务已回滚，不脏数据）
```

不脏数据（这点是好的），但**报错信息是给开发看的**。用户手工编辑/传输截断备份包后导入，
只看到一句 JS 报错，完全不知道该怎么办。

### 4.2 修复

在版本校验之后加**顶层结构校验**（`src/sync.js`）：
- 字段名从 `sync-manifest.js` 的 `SYNC_TABLES` **派生**——新增表自动纳入，**不手工枚举**（枚举必漏）；
- **只拦"存在但类型错"**，缺失字段仍走 `|| []` 兜底以兼容老版本包（回归 #5 守）；
- 错误信息点名是哪个字段坏了（回归 #4 断言必须含 `cards` 且不得是 `TypeError`）。

> 合规性说明：项目 i18n 第三道闸（数据层中文）在 `check-view-i18n.mjs:267` **明确跳过
> `throw new Error(...)` 所在行**（"错误码不是 UI 文案"），且同文件已有版本校验的同款中文抛错
> 先例——故此处按既有先例实现，未破坏 i18n 纪律（三道闸 0 新增已验证）。

---

## 五、被否证的 4 条假设（避免误报的价值）

审计的一半价值在于**不说假话**。以下 4 条都是"读代码时很像 bug"的，实测/深读后**证伪**：

| # | 假设 | 否证依据 |
|---|---|---|
| 1 | `intelligence.js:304` 日期键不补零（`2026-9-5`），会与其他键（`2026-09-05`）静默失配 | 该键只在**同一函数内的局部 Map** 中做分桶计数，从不与外部键比较 → 无失配路径 |
| 2 | `csvEscape` 未做公式注入防护（TSV 有、CSV 无，疑似漏了一处） | `exporters.js:109` 实测**第一行就是 `sheetCellGuard(v)`** → CSV 也已防 `= + - @` |
| 3 | `getLunar(1899/2101/无效日期)` 未守卫，会按越界索引算出"看似合理"的农历 | **属并行会话在修的缺陷，且已由对方修好**（我复跑 `tests/lunar.test.mjs` 8/8 通过）；非我所改文件，未越界修改 |
| 4 | `docs-lib.js` 的 `cloud.apiKey`（OCR 云密钥）可能随同步外泄 | 实测存 `localStorage['sxybrick_ocr_settings']`，注释即写明"本机偏好，不进同步" |

**凭证泄漏专项（D5 最高价值项）结论：干净。** 四处凭证各有归属且**均无同步出口**：

| 凭证 | 存储 | 是否同步 |
|---|---|---|
| `ai.js` / `agent/embedding.js` 的 `apiKey` | `localStorage`（`CFG_KEY`） | ✗ |
| `wordSettings.llmApiKey` / `llmBase` | db 表，但 `sync-manifest.js:149` 有 `strip` | ✗（导出/合并/中枢三处统一剔除） |
| OCR `cloud.apiKey` | `localStorage` | ✗ |
| 同步中枢 token / 密码 | `localStorage`（`sxy_hub*`） | ✗ |

---

## 六、并行会话冲突记录（重要）

本轮审计期间有并行会话在同时工作，**两次撞车**，如实记录以免后人误判：

1. **轮次撞名**：并行会话先产出了 `AUDIT-2026-09-14-round56-deep.md`（例行轮），故本轮改名为 **round57（新维度专项）**。
2. **测试撞车**：我第二次全量跑测试时出现 `not ok 529 - 范围守卫…`，初判像真实缺陷。核对 `git status`
   发现 `src/utils/lunar.js` + `tests/lunar.test.mjs` **处于对方未提交的修改中**（他们正在加范围守卫）。
   再次复跑该文件已 **8/8 通过**——属**并行半成品**，不是主干缺陷。
   **教训**：`git status` 必须先看，别把并行会话的在途改动当成自己引入的回归。

> 我的改动严格限定在自己的 5 个文件，**未触碰** lunar 相关文件。

---

## 七、未完成项（诚实交代）

- **D6（数据规模/性能悬崖）未做系统扫描**：本轮的 4 个并行子代理中，负责 D3+D6 与 D1+D4、D5+D8
  的三个未在本次会话内返回结果（仅 D2+D7 一路回传，已产出上文实证）。D3/D1/D4/D5/D8 是我**亲自
  接手**扫完的（结论见第二节），**D6 仍空缺**，留待下轮或专门触发（需构造万卡/十万 review 级数据集）。
- **D1 覆盖有限**：只抽查了批量 AI 任务的 AbortController 与序号校验，未逐视图穷举"双击提交/乱序响应"。

---

## 八、交付物

| 文件 | 变更 |
|---|---|
| `src/sync.js` | 图片写库失败降级（`imageWriteFailed`）+ 顶层结构校验 |
| `src/views/Sync.vue` | 汇报 `imageWriteFailed` + 配额专属错误文案 |
| `src/i18n/views/sync.js` | 新增 `stats.imageWriteFailed` / `quotaExceeded`（zh+en） |
| `scripts/i18n-hardcode-baseline.json` | 重锚（**纯行号位移**：新增 7/消除 7，HEAD 逐条核对零净增后重锚） |
| `tests/round57-fixes.test.mjs` | **新增回归 5 条**（配额降级 / 语义分离 / 主事务回滚 / 结构校验 / 向后兼容） |

---

*审计完成时间：2026-09-15 | 基线：5ad4ccf | 测试：1101/1101 pass | 本轮新维度 8 个 | 确认缺陷 2（1 P2 + 1 P3，均已修+回归） | 否证假设 4 | 未完成：D6*
