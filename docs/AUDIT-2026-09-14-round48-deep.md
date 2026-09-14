# SxyBrick 深度底层审查报告（round48 · 2026-09-14）

> 审查范围：269 个源文件 / 6.6 万行；4 个并行子代理分域深挖（同步层 / 算法层 / 业务逻辑与数据建模 / AI 与异常性能），
> 主审对每条发现**逐行读源码复现核验**，否决误报 3 条。
> 每条均给：现象（大白话）→ 位置 → 根因 → 修复建议。

---

## 一句话总览

系统整体已经很结实（前 47 轮把"测试全绿但线上崩"这类大坑基本填平），但**这一轮挖到 2 个 P1、6 个 P2**，
集中在三类隐蔽形态：**① 错误被"降级"掩盖真因；② 缓存/截断静默失效；③ 同一概念多套口径**。
其中 P1-1 正是你最近遇到的"AI 密钥网络都正常却报网络失败"的**根因**。

---

## 🔴 P1 严重

### P1-1　AI 的 401/429/密钥失效，全被说成"网络连接失败"

- **现象（大白话）**：你的密钥明明是对的、网也是通的，AI 却告诉你"网络连接失败或 AI 服务不可达"。
- **位置**：`src/utils/offlineAI.js:220-223`（`isNetworkError`）＋ `src/agent/orchestrator.js:20-28`、`src/ai.js:52-59`
- **根因**：降级判定用一句**正则**去猜"是不是网络问题"，而正则里包含了 `AI 请求失败`：
  ```js
  return /fetch|network|Failed to fetch|网络|请求失败|AI 请求失败|timeout|aborted/i.test(m);
  ```
  可 `src/agent/llm.js:93` 抛的错误消息偏偏就是 `AI 请求失败(401：API 密钥无效或已过期)：…` —— 于是
  **密钥失效 / 无权限 / 模型不存在 / 限流(429) / 服务端 5xx，全部被正则命中**，被当成断网 → 返回
  `offlineChat()` 的"网络连接失败或 AI 服务不可达"。真实原因被彻底掩盖。
- **修复**：按**结构化字段**分类而不是猜字符串——`err.status`（401/403/404/429/5xx）与 `err.name === 'AbortError'`
  一律**不降级**（照实抛出）；只有真正的网络异常（`fetch` 抛的 `TypeError: Failed to fetch` / 无 status）才走离线兜底。
- **影响面**：`chatAI`（AI 问答/费曼/周报 AI）与 `chatWithFallback`（全部 Agent）两条链路。

### P1-2　单词本"关联通用卡"候选：TTL 是死代码 + 硬截断 500 张

- **现象（大白话）**：卡片多的用户（你有上万张），在单词详情里想"关联一张通用卡"，候选列表里**永远找不到第 501 张之后的卡**；
  而且这次打开页面后新建的卡，也**永远不会出现**在候选里。
- **位置**：`src/views/WordBook.vue:483-501`
- **根因**：两处
  1. `let linkedCardCacheTs = 0;` 与 `const LINKED_CACHE_TTL = 30000;` **声明了但全文件从不读也不写**——
     注释写着"改为 30s TTL 自动失效"，实际**永不失效**（缓存只在为空时才重建）：
     ```js
     if (!linkedCardCache.length) { linkedCardCache = (await db.cards.toArray()).slice(0, 500); }
     ```
  2. `.slice(0, 500)` 硬截断：只取前 500 张。
- **修复**：真正实现 TTL（比较 `Date.now() - linkedCardCacheTs > LINKED_CACHE_TTL` 时重建）；
  去掉 500 截断，改为**服务端式搜索查询**（按关键词走索引/过滤，而不是全量物化后切片）。

---

## 🟠 P2 中等

### P2-1　删掉的图片会在对端"复活"（墓碑在导入路径不生效）

- **现象（大白话）**：删一张卡/一条笔记后，它引用的图片本应一并清掉；但对端设备那图**永远删不掉**，
  还会随同步被灌回来，导致**数据包越来越大**、孤儿图越堆越多。
- **位置**：`src/sync.js:821-822`（主循环 `if (t.table === 'images') continue;`）＋ `src/sync.js:1076-1089`（只 `bulkPut` 新图）
- **根因**：删除侧确实写了墓碑（`repo.js:605`、`repo.js:1617`、`word-repo.js:293` 都写 `kind:'image'`），
  但**导入侧把 images 从主循环里 `continue` 掉了**，既不调 `applyTombstones(..., 'image')`，也不按墓碑删图 → 墓碑形同废纸。
- **修复**：导入侧补一段「按 `kind:'image'` 墓碑 bulkDelete」，与卡片级联删孤儿图同口径。

### P2-2　卡片列表"到期"过滤与"到期数"两套口径（NaN 数据会错位）

- **现象（大白话）**：左边显示"今日到期 12 张"，点进去列表只有 11 张——数字和内容对不上。
- **位置**：`src/repo.js:171` vs `src/repo.js:180`
- **根因**：同一函数里两套判定：
  ```js
  if (mode === 'due') cards = cards.filter(c => c.dueAt <= now());   // 裸比较
  for (const c of all) if (dueOf(c) <= nowTs) dueCount++;            // 走 dueOf
  ```
  `dueOf`（`repo-core.js:213-217`）把 `undefined→∞`、`null/NaN→0`；而 `NaN <= now` 恒为 `false`。
  → **`dueAt=NaN` 的坏数据卡：不进列表，却被计入到期数**。
- **修复**：列表过滤也走 `dueOf(c) <= nowTs`。

### P2-3　单词本"待背"数与真实复习队列对不上（NaN 缺口）

- **现象（大白话）**：单词本写"待背 300"，点开始复习只给你 298 个。
- **位置**：`src/word-repo.js:592` vs `:540` vs `:551`
- **根因**：三处口径不齐——
  - 统计：`if ((r.dueAt || 0) <= t) due++;`（`NaN || 0` = 0 → **算作到期**）
  - 队列：`db.wordCards.where('dueAt').belowOrEqual(t)`（索引查询，**NaN 不在索引里 → 不入队**）
  - 一次性修复：`db.wordCards.filter(r => r.dueAt == null)`（**只补 null/undefined，漏了 NaN**）
    注释自称修的是"老版本遗留/损坏数据"，但 NaN 恰好漏网。
- **修复**：修复条件改 `!(Number.isFinite(r.dueAt))`；统计口径与队列统一。

### P2-4　导出页一搜索就整页崩（front 为 null 的卡）

- **现象（大白话）**：在"导出"页搜索框里打字，页面直接白屏/报错。
- **位置**：`src/views/Export.vue:212`
- **根因**：`cards.filter(c => c.front.includes(k) || c.back.includes(k))` —— 同文件 218 行对 tags 做了 `|| []` 兜底，
  这里却**对 front/back 裸调字符串方法**。导入或数据损坏产生的 `front=null` 卡一出现，`c.front.includes` 抛 TypeError，
  computed 崩 → 整页崩。
- **修复**：`String(c.front || '').includes(k) || String(c.back || '').includes(k)`。

### P2-5　"今日动作数"永远少算"掌握"这一类

- **现象（大白话）**：每日规划顶部的"今日动作"数字偏低，明明掌握了新卡却不增加。
- **位置**：`src/utils/planSynergy.js:129`（`mastered: 0` 从不赋值）vs `:70`（`actions: … + cards.mastered`）
- **根因**：`aggregateCards` 里 `mastered` 初始化后**全程没有赋值**，而 `totals.actions` 把它加进去了 → 恒 +0。
- **修复**：在 `aggregateCards` 里按 `isMastered(card) && reviewedAt∈今日` 实际统计。

### P2-6　图谱推荐"是否已存在"用卡片正文比对，而非稳定 id

- **现象（大白话）**：① 两张不同卡只要**开头 30 个字一样**，就会被当成同一对，合法的关联推荐被悄悄吞掉；
  ② 改了卡片正文后，系统认不出"这条关联已经有了"，于是重复推荐。
- **位置**：`src/intelligence.js:154-158`（`existPair` 建自 `e.from/e.to`）与 `:352-359`（候选去重用 `c.from/c.to`）；
  但候选本身带 `fromId/toId`，且同文件 `:320` 已经用 `pairKeyOf(c.fromId, c.toId)` —— **同一文件两套键**。
- **根因**：`from/to` 是"卡片正文截断 30 字"（展示用），`fromCardId/toCardId` 才是稳定键；去重/存在判定却用了前者。
- **修复**：统一改用 `fromCardId`/`toCardId`。

---

## 🟡 P3 轻微（建议顺手清）

| # | 问题 | 位置 | 说明 / 修复 |
|---|---|---|---|
| P3-1 | **AI 记忆无去重 + 无限增长 + 每轮全表扫** | `agent/memory.js:10/27/94`；`ai-usage.js:67` | `addMemory` 无唯一约束 → 同事实反复插入；`buildMemoryText` 每轮 `toArray()` 全表读却只用 ~44 条。修：按 content+category 去重、游标 limit、定期 prune。 |
| P3-2 | **喂 LLM 的消息无总量封顶** | `agent/agents/base.js:123/157/165` | system+history+多步 ReAct 每步重发全量，分项有上限但缺最终总闸 → 长历史 + 大工具回包会 413/静默截断。修：发送前估总 token 并按优先级裁剪。 |
| P3-3 | **图片 OCR 不可中断** | `agent/llm.js:47`；`services/image-analysis.js:414-417` | `enrichForLlm` 未接 `opts.signal`，OCR 循环只用内部 30s 超时且不查 `aborted` → 用户取消后最多 8 图×30s=240s 仍在跑。修：透传 signal + `AbortSignal.any` + 循环内检查。 |
| P3-4 | **`list_lib_docs` N+1 查询** | `agent/tools/index.js:994-1003` | 为显示 hasTextLayer，对前 50 个资料**串行** `await getDocText(id)`。修：批量或懒加载。 |
| P3-5 | **墓碑/时间戳缺时钟上界** | `sync-manifest.js:668`（`applyTombstones`） | 判定用 `rTs <= (t.deletedAt ?? 0)`，无"未来时间"上界；`mergeTombstones` 只按 hub 单点 skew 校正。若某设备时钟被拨到未来（虚拟机/双系统常见）且未被校正，其墓碑会**删掉本地匹配行**（数据丢失）；反之删除永久失效。修：超阈值截断/拒绝。 |
| P3-6 | **字符串时间戳未净化** | `sync-manifest.js:240` | `incoming.updatedAt ?? 0` 遇字符串 → `Math.max('2026…',100)=NaN`；`livenessTs` 又忽略非有限值 → 该行增量导出 `> since` 恒假 → **永不重传**；墓碑 `deletedAt` 为字符串时比较恒 false → **删除永不生效**。修：合并入口强制 `Number()`。 |
| P3-7 | **`byGrade`/`GRADE_NUM` 是死代码且语义可疑** | `planSynergy.js:89/103/109` | `GRADE_NUM` 把"勉强(hard)"映成 0（"没记住"），且 `byGrade` **全项目无人消费**。无用户影响，但应删或修（`session.js` 里 hard=0.5）。 |
| P3-8 | **vision 重试漏记账** | `agent/llm.js:91` | 400/422 首失败请求未 `reportUsage`，用量账本少记一次。 |
| P3-9 | **"已掌握" 4 套口径 + "薄弱" 2 套窗口** | `repo-core.js:91` / `graphAuto.js:327` / `networth.js:104` / `source-trace.js:46`；`intelligence.js:400` vs `repo-core.js:177` | 同一概念多处不同算法 → 跨模块数字对不上（`networth` 甚至用瞬时 `R>=0.9`，"刚复习完"全算掌握 → 虚高）。建议全部收敛到 `repo-core` 单点。 |
| P3-10 | **错题归因簇 score 失真** | `mistakeAttribution.js:100-103` | 合并簇取"块内均值最大值"而非合并后均值；同名高频 token 的不同概念被并簇。 |

---

## ✅ 此前审计项修复完整性核验（抽样实证）

| 旧审计项 | 核验方式 | 结论 |
|---|---|---|
| round46 P0｜MarkdownRenderer 空白（watch 漏调 update） | 读 `MarkdownRenderer.vue:311-316` | ✅ 完整：`watch(..., {immediate:true})` 且内部 `await update()` |
| round46 P0｜`typeof import.meta.glob` 假绿 | `grep -rn "typeof import.meta.glob" src/` | ✅ 无残留 |
| round45｜工具注册表同名覆盖 | 源码 `register(name:…)` 唯名统计 | ✅ 无重复名 |
| round47｜proactive 并发互斥 | `grep SYNC_IN_FLIGHT src/sync.js` | ✅ 在位（:588） |
| 2026-09-14｜`chat()` 空响应真因透出 | 读 `llm.js` 非流式分支 | ✅ 已抛可读原因（但上游仍被 P1-1 的宽正则二次掩盖，需一并修） |
| 2026-09-14｜卡片放大/灯箱居中缩放 | 读 `FlipCard.vue` / `MarkdownRenderer.vue` | ✅ 公式已按舞台中心修正 |
| 2026-09-14｜周报全 0 | 读 `WeeklyReport.vue` | ✅ 已回落最近有数据的周 + 单一事实源 |

## ❌ 经实证核验后**否决**的子代理误报（避免误导）

1. **"P1 `GRADE_NUM` hard→0 评分分布错映"** → **`byGrade` 在 `src` 全项目无消费者**，属死代码，无用户影响（降为 P3-7）。
2. **"P2 mergeCardPair fieldTs 回退丢字段"** → 读 `sync-manifest.js:257`：`out` 先取**行级 LWW 赢家**，字段级循环只是"覆盖"，两者都无 fieldTs 时 `continue` **不会丢**；同毫秒平局走确定性 `tiebreak`，是**有意权衡**（降为 P3）。
3. **"FSRS `Math.random` 抖动是缺陷"** → 训练已 `w[17]=0` 消噪，且只影响排期日期、不影响 S/D 学习，属设计。

---

## 建议修复顺序（按"影响面 ÷ 成本"）

1. **P1-1**（AI 错误分类）—— 一行判定逻辑，直接解决你当前最困惑的问题，收益最大。
2. **P1-2**（关联候选 500 截断 + TTL 死代码）—— 重度用户必然命中，改动小。
3. **P2-4 / P2-2 / P2-3**（三处"口径不一致/崩溃"）—— 都是几行的统一改动。
4. **P2-1 / P2-5 / P2-6** —— 逻辑补全，需配回归测试。
5. **P3 批量清理**（尤其 P3-5 / P3-6 的时钟与时间戳净化，属数据安全纵深）。
