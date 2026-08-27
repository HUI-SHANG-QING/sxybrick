# SxyBrick 优化改造提示词（直接复制给 AI 编辑器）

> 复制下面从【BEGIN】到【END】之间的全部内容，粘贴给你的 AI 编辑器（如 CodeBuddy / Cursor / WorkBuddy 等），让它按此执行修复与优化。所有路径相对于项目根目录 `new_card/`。本次任务**仅限前端/本地修复，不引入任何后端或 Python 服务**，且必须遵守文末"硬约束"。

---

【BEGIN】

你是一名资深前端架构师 + 算法工程师。下面是对 SxyBrick（Vue3 + Vite + Dexie/IndexedDB 本地优先 PWA 考研复习应用）的一份顶级交叉专家评审结论。请**严格按 R 编号逐条修复 Bug、落实优化**，每改一处必须保证 `npm run build` 通过且既有测试通过。不要重写已有架构，只做最小可用、可验证的改动。

## 一、项目背景与架构红线（不可破坏）
- 架构亮点：**`src/sync-manifest.js` 是同步的唯一事实源**，被前端 `src/sync.js` 与 Node 端 `sync-hub/hub.js` 共用——新增表只需在此登记。严禁在三处分别写合并逻辑。
- 五层单向依赖：表现层 → 业务域(repo/analytics) → 算法(srs/analytics) → AI(agent/) → 数据(Dexie+sync-manifest)。视图不得直接碰 `db`，只经 `repo/analytics` 取数。
- 本地优先、数据主权原则保留。本次不引入服务端。

## 二、必须修复的 Bug（按严重度）

### 🔴 P0-1｜R2：卡片短期巩固 `consolidation` 跨设备同步静默丢失
- **证据**：`src/repo.js:237` 的 `review()` 把 `consolidation`（值 null/1/2，短期巩固状态机核心字段）写回卡片，且正确地**不 bump `updatedAt`**（因它是 SRS 字段）。但 `src/sync-manifest.js:39` 的 `CARD_SRS_FIELDS = ['ease','level','intervalDays','dueAt','reviewedAt']` **漏掉了 `consolidation`**。于是 `mergeCardPair()`（sync-manifest.js:48-60）跨设备合并时只取 `CARD_SRS_FIELDS` 里的 SRS 字段，`consolidation` 被静默丢弃 → 换设备后巩固进度清零。
- **修复步骤**：
  1. 把 `sync-manifest.js:39` 改为 `export const CARD_SRS_FIELDS = ['ease', 'level', 'intervalDays', 'dueAt', 'reviewedAt', 'consolidation'];`
  2. 同步更新 `sync-manifest.js:9` 顶部注释，在 SRS 字段说明里补上 `consolidation`。
  3. 在 `tests/sync-manifest.test.mjs` 增加回归用例：设备A复习把 consolidation 推进 1→2（不 bump updatedAt），设备B编辑文字（bump updatedAt），调用 `mergeCardPair` 后合并结果 `consolidation` 必须等于 2。

### 🔴 P0-2｜R7：敏感人生数据 `privacyRecords` 明文进入同步/导出（PIPL 合规雷区）
- **证据**：`src/sync-manifest.js:30` 把 `privacyRecords` 列入 `SYNC_TABLES`（merge:'updatedAt'），会随局域网同步/全量导出包**明文流转**；`src/views/Export.vue:46,119-147` 直接把含 mood/energy/stress/painIndex/财务块/精神心流 等 PIPL 敏感个人信息导出为明文 JSON+CSV，无加密、无同意闸、无最小化。
- **修复步骤**：
  1. 将 `privacyRecords` 从 `SYNC_TABLES` **默认移除**（不再自动进入同步与全量导出包）。
  2. 新增显式开关：在同步/导出设置里加 `syncPrivacy`（默认 `false`，opt-in）；仅当用户开启时才把该表纳入同步/导出，并在 UI 用醒目文案提示"将随同步明文传输，请确认"。
  3. 本地加密：新建 `src/utils/crypto.js`，用 Web Crypto（`crypto.subtle`，AES-GCM + PBKDF2 由用户口令派生密钥）。`privacyRecords` 本地存储与导出均以加密形式落盘；明文 CSV 导出改为默认关闭并加二次确认警告。
  4. 合规：首次写入隐私数据时弹出"知情同意"对话框（说明收集项、用途、可删除），用户同意前不采集。
  5. 不要破坏 `userOps`（行为埋点，非敏感个人身份信息，可保留同步，但同样建议评估是否默认关闭）。

### 🟠 P1-1｜R3：`embeddings`（RAG 向量）未纳入同步 → 换设备 RAG 静默失效
- **证据**：`sync-manifest.js:12-30` 的 `SYNC_TABLES` 不含 `embeddings`（db v9 表）。
- **修复步骤**：在 `SYNC_TABLES` 增加 `{ table: 'embeddings', kind: 'embedding', merge: 'idOnly' }`（embeddings 由 cardId+content 确定性生成，idOnly 幂等即可）。或在导入完成后检测 embeddings 缺失并提示"一键重建索引"——**推荐前者（直接同步）更省心**。

### 🟠 P1-2｜R1（部分修复后的残余）：`wrongReason` 跨设备仍可能丢失
- **证据**：`wrongReason` 已在 `CARD_CONTENT_FIELDS`（sync-manifest.js:38），但 `repo.js:237` 在复习时写 `wrongReason` 却**不 bump `updatedAt`**。若设备A复习写入错因、设备B随后编辑文字（bump updatedAt），`mergeCardPair` 按 updatedAt 取 B 的内容，A 写的错因被丢弃。
- **修复步骤**：给错因增加独立时间戳 `wrongReasonAt`。`repo.js:237` 写错因时一并写 `wrongReasonAt = now()`；在 `mergeCardPair` 中对 `wrongReason`/`wrongReasonAt` 采用"按自身时间戳取新者"的合并（仿照 SRS 与内容分离的思路：错因不跟随 updatedAt，而跟随 wrongReasonAt）。在测试中验证：复习写错因 vs 另一设备编辑文字，合并后错因保留。

### 🟠 P1-3｜R4：无离设备加密备份
- **证据**：全量语料仅存单设备 IndexedDB，导出包明文。
- **修复步骤**：基于上面新建的 `src/utils/crypto.js`，在导出/同步页增加"加密备份/恢复"入口——导出时用口令派生密钥 AES-GCM 加密整个数据包为 `.sxybrick` 加密文件；导入时输入口令解密。保证离设备备份不泄露。

### 🟠 P1-4｜R5：测试广度严重不足（仅 2 份）
- **证据**：`tests/` 仅 `srs.test.mjs` 与 `sync-manifest.test.mjs`；24 视图、`analytics.js`、`agent/` 全套、同步导出零测试。
- **修复步骤**：引入 Vitest（或沿用 node --test）。至少补充：
  - `tests/analytics.test.mjs`：弱卡/易混对/六维画像核心函数单测。
  - `tests/retrieval.test.mjs`：embedding/retrieval 关键路径单测。
  - `tests/sync-export.test.mjs`：导出→导入往返一致性（必须覆盖 R2/R3/R1 三个字段）。
  - 既有 2 份测试保持通过。

### 🟡 P2-1｜R6：算法层主线程 O(n²)
- **证据**：`src/agent/analytics.js` 弱卡/易混对全表配对扫描，千卡级卡顿。
- **修复步骤**：全表配对改为分页/索引查询，并在 Web Worker 中计算；相关列表渲染引入虚拟滚动（如 vue-virtual-scroller）。目标：千卡级不卡顿。

### 🟡 P2-2｜R9：`notifications`/`errors` 未入同步且未文档化
- **证据**：`SYNC_TABLES` 不含 `notifications`(v10)、`errors`(v11)。
- **修复步骤**：在 `sync-manifest.js` 顶部新增 `EXCLUDED_FROM_SYNC = ['notifications','errors']` 并注释"设备本地日志/通知，非跨设备数据，故意不同步"；在 `src/views/Sync.vue` 文案里说明这一点。

### 🟡 P2-3｜算法健壮性：`wrongPenalty` 用中文子串嗅探
- **证据**：`src/srs.js:24-30` 的 `wrongPenalty()` 用 `includes('概念'/'混淆'/'记忆'/'粗心'...)` 模糊匹配，措辞偏差即静默失效（惩罚=1.0）。
- **修复步骤**：改为受控枚举。定义错因码（如 `CONCEPT_MIS`/`MEMORY_WEAK`/`CARELESS`/`NONE`）映射固定惩罚系数；UI 选择错因时回写枚举码（保留原中文作展示标签）。`computeNext` 内部按枚举取惩罚。

### 🟡 P2-4｜R8：逐步引入 TypeScript
- **修复步骤**：优先为关键模块（`sync-manifest.js`、`srs.js`、`repo.js`）加类型声明或改 `.ts`，配置 `vue-tsc` + Vite TS 支持，再逐步覆盖视图。不要一次性全量改造，避免大范围回归。

## 三、硬约束（必须遵守）
1. 不重写 sync-manifest 单一事实源、不破坏五层解耦、不引入后端/Python。
2. 每处改动后必须 `rm -rf dist && npm run build` 通过，且 `tests/` 全部通过。
3. 涉及隐私(PIPL)的修改默认保守：最小收集、本地加密、opt-in、知情同意。
4. 优先补测试与最小修复，不做无关重构；改动小而可验证。
5. 改动后给出"影响范围说明"（哪些表/字段/视图受影响）。

## 四、验收标准（完成后自检）
- [ ] R2：consolidation 已入 `CARD_SRS_FIELDS`，回归测试证明跨设备合并保留。
- [ ] R7：privacyRecords 默认不入同步/导出，已加密 + opt-in + 知情同意；原有功能不崩。
- [ ] R3：embeddings 已入 `SYNC_TABLES` 或导入后提示重建。
- [ ] R1：错因独立时间戳，跨设备合并保留。
- [ ] R4：加密备份/恢复可用。
- [ ] R5：新增 ≥3 份测试且全部通过。
- [ ] R6/R9/wrongPenalty/TS：至少 R9 与 wrongPenalty 完成，R6 与 TS 给出可落地方案或最小实现。
- [ ] `npm run build` 绿，既有 2 份测试绿。

【END】

---

> 使用说明：将【BEGIN】~【END】整段复制粘贴到你的 AI 编辑器对话框即可。建议**按 P0→P1→P2 顺序分批执行**，每批跑通构建与测试再进下一批，避免一次性大改引入回归。
