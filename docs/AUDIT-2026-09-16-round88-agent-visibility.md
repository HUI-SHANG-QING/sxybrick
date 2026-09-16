# round88 修复报告：Agent 步数耗尽丢数据 + 单词模块零 AI 工具 + 图片缺失诊断

- 日期：2026-09-16
- 触发（用户实测原话）：
  > 「？？？为什么会这样，还是看不到图片和各个模块的具体内容，
  > 而且（已达到最大推理步数，Agent 提前结束）这是个什么鬼，进行修复」
- 基线：`597acd4`（工作区干净，无并行会话在途文件）
- 定性方式：**先复现、再定性**（fake-indexeddb 忠实复现 + 源码逐行核对），不靠猜。

---

## 一、结论速览

| # | 级别 | 问题 | 是 bug 还是配置/数据 | 处置 |
|---|---|---|---|---|
| 127 | **P1** | `runReActAgent` 步数耗尽时**丢弃已抓到的全部工具数据**，只回一句占位文案 | 真 bug（唯一一条不调 `buildLocalAnswer` 的失败出口） | 已修 + 8 条回归 |
| 128 | **P1** | 单词模块（`db.wordCards`，830 行 repo、API 齐全）**一个 AI 工具都没有** → AI 可见度为 0 | 真 bug（能力缺口） | 已修 + 10 条回归 |
| 129 | **P2** | 图片读不出来只有 `missing`/`unreadable` 两种原因，文案**合并成一句**误导性说明 | 读路径无缺陷（数据侧缺失），**诊断文案**有缺陷 | 已修 + 7 条复现/回归 |

三个问题合起来正好覆盖用户这句话的两半：
- 「（已达到最大推理步数，Agent 提前结束）这是个什么鬼」→ **#127**
- 「还是看不到图片和各个模块的具体内容」→ **#128**（单词模块）+ **#129**（图片）

---

## 二、#127（P1）Agent 步数耗尽丢数据

### 根因

`src/agent/agents/base.js` 的 `runReActAgent` 有四条失败出口：

| 出口 | 位置 | 旧行为 |
|---|---|---|
| ① 模型调用抛错 | `catch (e)` | ✅ `buildLocalAnswer({observations})` |
| ② 离线占位（有 `final`） | `isOfflineReply(final)` | ✅ `buildLocalAnswer` |
| ③ 既无 tool 也无 final | 尾部兜底 | ✅ `buildLocalAnswer` |
| ④ **for 循环跑完 maxSteps** | 旧 line 301 | ❌ **`return '（已达到最大推理步数，Agent 提前结束）'`——数据全丢** |

④ 是**唯一**不调 `buildLocalAnswer` 的一条，而它恰好是最容易命中的一条：
预算全给工具调用、**一步都不留给收尾**，模型多查两步就撞上上界。

### 修法（三层收口）

1. **在 `maxSteps` 之外多给一格，且该格只做收尾**
   `const totalSteps = maxSteps + 1; const finalStepIdx = maxSteps;`
   收尾格**不再执行工具调用**（模型若仍调工具 → 记轨迹 + `break` 落抢救出口）。
   → 不削减任何 agent 原有的工具预算（`maxSteps=3` 的插件依然能调满 3 次）；
   → 这格额外 LLM 调用**只在模型真把预算用满时才发生**，恰好只覆盖旧实现注定失败的那些轮次。
2. **收尾前预算提示**：剩余工具机会 ≤ 2 时，在工具观察后追加「本轮还可调用工具 N 次，之后必须输出 `<final>`」，促使主动收敛。
3. **真耗尽时抢救**：`buildLocalAnswer({ observations, reason: reasonStepLimit })`；真没数据才给 `stepLimitNoData`（含可执行指引，并首次把硬编码文案迁入 i18n 字典）。

### 验证

`tests/agent-step-budget.test.mjs`（新增 8 条）：

| 断言 | 内容 |
|---|---|
| A1 | 步数耗尽 → 输出含已抓到的工具数据 + 如实说明是「已达工具调用步数上限」 |
| A2 | 真一无所获（args 解析失败）→ 走 `stepLimitNoData` 且等于 i18n 字典值；工具调用次数 = 0 |
| B1 | `maxSteps=3` 仍能调满 **3** 次工具（收尾格是额外的），且第 4 轮能正常输出 `<final>` |
| B2 | 收尾格之前必须注入「不许再调工具 / 立即输出 `<final>`」的硬指令 |
| B3 | 收尾格仍调工具 → **不执行**（工具调用次数不增）+ 抢救已抓数据 + 留可诊断轨迹 |
| C1 | 剩余 ≤2 才提示（`3,2,1,0` 序列中只有 `2`/`1` 出现提示，不出现「还可调用 0 次」） |
| D1 | 反向闸门：base.js 不得再硬编码「已达到最大推理步数」 |
| D2 | 反向闸门：`buildLocalAnswer(` 调用点 ≥ 4（四条出口统一） |

### 测试替身踩到的坑（值得记住）

`compactConvo` 在「未超预算且无内部标记」时**原样返回同一个 convo 数组引用**（零拷贝快路径），
而 `runReActAgent` 之后还会继续 `convo.push(...)`。测试替身若直接存引用，
第 0 轮的记录会被后续轮次污染 → 出现「第 0 轮就带着收尾指令」这种**假故障**，
足以骗过整条断言链。**必须在测试替身里对 messages 做快照**。

---

## 三、#128（P1）单词模块零 AI 工具

### 根因（实证）

- `src/word-repo.js`：830 行，API 齐全（`listWordCards`/`wordStats`/`wordGroupStats`/`dueWordCards`/`wordReviewHistory`/`getParkedWordCardIds` …）。
- `src/agent/tools/index.js`：61 个内置工具，**`/word/` 命中数 = 0**。
- 英语词库独立在 `db.wordCards`（与卡片域 `db.cards` **分表**），所以「卡片域工具齐全」完全覆盖不到它。

→ 用户问「我背了哪些单词 / 这个词什么意思」时，学习答疑导师手上没有任何工具可调，
只能回答「我看不到」——**与卡片域修复前是同一类缺陷**（工具不可见 = AI 看不到）。

### 修复

**数据层**（`src/word-repo.js`）：新增 `getWordCard(id)`。
单词模块此前**只有列表 API**，「给个 id 取全文」这条路在数据层就不存在；
回填复用既有的 `backfillCards`，不另写一份以保证口径一致。

**工具层**（`src/agent/tools/index.js`）：三个新工具，按「列表四件套」分工：

| 工具 | 职责 | 关键设计 |
|---|---|---|
| `list_words` | 列表 + 关键词检索 + 分页 | `q`/`kind`/`familiar`/`groupId` + `limit`/`offset`；返回**摘要**（`meaning` 截 160）、id、`hasMore`、`hint` 指向详情工具 |
| `get_word_detail` | 单张词卡**全文** | 双定位：`id`（最可靠）/ `word`（精确 → 退化包含）；返回释义/例句/例句翻译/笔记/标签/掌握度/到期 |
| `get_word_stats` | 统计概览 | 总/可复习/到期/**实际复习队列长度**/已掌握/熟词/模板/今日新增 + 今日与累计已背次数 + 各组掌握率（带组名） |

**挂载**（`src/agent/agents/index.js`）：`tutor` / `analyst` / `smart-reviewer` 挂三个；`quizmaster` 挂两个（英语也能出题）。

**踩到的坑（已固化为断言）**：
`familiar` 过滤绝不能写成 `Number(args.familiar) || undefined` ——
显式传 `0`（只看未标熟词，**最常用的取值**）会被 `|| undefined` 吞成「不过滤」。
这正是项目通则「可归零字段禁 `!v` / 禁 `Number() || 默认值`」在**新参数**上的又一次复现。
`list_words` 里用显式空串判定收口，并由「`familiar=0` 必须只返回未标熟词」这条断言锁住。

### 验证

`tests/agent-word-tools.test.mjs`（新增 10 条）：工具存在 + 四件套齐全、四类 Agent 挂载、
反向闸门（单词工具数 ≥3）、摘要不泄漏全文、分页覆盖无遗漏无重复、`familiar=0` 不被吞、
空词库给可执行指引、`get_word_detail` 两条定位路径 + 找不到时显式报错、
`get_word_stats` 带组名且不泄漏具体单词。

`tests/agent-list-tools.test.mjs`：把 `list_words: 'get_word_detail'` 纳入既有的
**列表四件套闸门**（摘要 + id + 分页 + 详情引导）——新增列表工具自动被同一道门兜住。

---

## 四、#129（P2）图片读不出来：两种原因必须分开说

### 先复现，再定性

`tests/agent-image-missing.test.mjs` 的前 3 条是**复现**，结果：

| 复现 | 结果 |
|---|---|
| 行存在 + 合法 PNG → `imageIdsToVisionContentMapped` | ✅ 正常产出 data URL，`onSkip` 一次都没被调 |
| 行不存在 | ✅ `onSkip(id, 'missing')` |
| 行在但 blob 损坏 | ✅ `onSkip(id, 'unreadable')` |

**结论：读路径本身没有缺陷**，`missing` 与 `unreadable` 在 `onSkip` 层已经分得很清。
用户「看不到图片」属**数据侧缺失**（跨设备未同步 / 从备份导入时漏带图库 / 原图已删），
代码层面的缺陷在**文案**：把两种原因合并成一句，指向了错误的排查方向。

### 缺陷点

| 分支 | 旧文案 | 问题 |
|---|---|---|
| `visionFirst` 兜底 | 「读取失败（图片可能已被删除或无法解析），请确认该图仍在卡片中」 | `skipReason` 已经收齐了 `missing`/`budget`，却只用了 `budget`，`missing` 与 `unreadable` 一起掉进 else |
| OCR 分支 | 「未能识别文字，未纳入分析」 | 行缺失时也这么说 → 用户会去折腾 **OCR 设置**，而真相是这张图在本机根本不存在 |

### 修复

- `visionFirst`：按 `skipReason` 拆成两句 ——
  · `missing` → 「本机图库里没有这张图（多因尚未同步到本设备，或原图已被删除）；请在其他设备上同步一次，或重新上传该图」
  · 其它 → 「图片存在但无法解析（数据可能已损坏），建议重新上传该图」
- OCR 分支：新增 `missingOcr` 集合，行缺失时单独说明，与「图在但没认出来」分开。
- 顺带对齐资料页（`sxy-doc://`）分支已有的做法：那个分支早就按 `ocrFirst` / 原始文件不在本机 / 额度用完分别措辞了——本轮是把卡片图片侧补齐到同一水准。

### 断言更新（2 处，均为「钉住旧文案」而非实现错）

| 文件 | 旧断言 | 新断言 | 为什么改 |
|---|---|---|---|
| `tests/image-analysis.test.mjs`（文案区分） | `/读取失败/` | `/本机图库里没有这张图/` | 该用例的图确实**不存在**；旧断言认下笼统措辞等于放过了原因混淆 |
| `tests/ocr-cache.test.mjs`（删除后不复用） | `/未能识别/` | `/本机图库里没有这张图/` | 用例意图（删除后不得复用缓存）不变，只是钉住更精确的措辞 |
| `tests/image-analysis.test.mjs`（体积超限） | `/读取失败|体积上限/` | **收紧为** `/体积上限/` + 反向断言 `/本机图库里没有这张图/` 不出现 | 二选一放过了张冠李戴；该用例的图确实存在，只是体积到顶 |

### 验证

`tests/agent-image-missing.test.mjs` 7/7；受影响的 6 个图片相关测试文件 76/76。

---

## 五、门禁与交付

| 项 | 结果 |
|---|---|
| `eslint .` | 通过 |
| `check-view-i18n --strict` | 通过（46 视图 / 45 字典模块，反向扫描 180 行**新增 0**） |
| `check-view-i18n --js`（数据层第三道闸） | 通过（**新增 0**） |
| `dep-check` | 通过 |
| `sync-coverage-audit` | 通过 |
| `node --test` 全量 | **1303 用例 / 1301 通过**（修 #129 前） → 见提交信息中的最终数字 |
| `vite build` | 见提交信息 |

### i18n 纪律（本轮新增文案的去向）

- `agent.localAnswer.*`（新增 5 个键）：`reasonStepLimit` / `stepLimitNoData` / `finalizeInstruction` / `budgetHint` / `toolCallAfterBudget`
- `agent.toolMsg.*`（新增 4 个键）：`noWords` / `wordNotFound` / `wordsHint` / `wordStatsHint`
- 依据：数据层第三道闸按「短中文字符串 = 疑似 UI 文案」判定，而
  **llm 不可达时 `buildLocalAnswer` 会把工具返回值和这些提示原样渲染到用户屏幕上** ——
  它们确实属于需要可本地化的文案。首次跑闸时精准命中 1 行（`list_words` 的 `hint`），
  已迁入字典而非写进基线。

---

## 六、未处置 / 待跟进

1. **`MAX_STEPS=12` 未上调**。收尾格已保证「不会空手而归」，但**广问题**（「我各模块都有什么内容」）
   仍会消耗大量步数。真正的解法不是加预算，而是给一个**一次调用就能回答模块概览**的工具
   （见下条）。加预算的直接代价是每轮多一次带全量上下文的 LLM 调用。
2. **建议新增 `get_content_overview` 工具**（候选 round89）：一次返回「各模块：条数 + 样例 id + 详情工具名」，
   把「能看到具体内容的是哪些模块」从 10+ 步压到 1 步。这是本轮暴露出的**结构性**改进点，未在本轮动。
3. **`enrichForLlm` 的 OCR 失败仍只有一句「未能识别文字」**：OCR 抛出的具体原因在
   `catch { text = '' }` 被吞掉，用户无法区分「图太糊」/「语言不匹配」/「OCR 资源加载失败」/「模式是 ocrFirst 而本机没有云端 OCR」。
   与 #129 同一类诊断缺陷，本轮未动（改动面涉及 OCR 设置引导，值得单独一轮）。
4. C 盘仍 98% 满；回收站 964MB 需用户自行清空（本轮未处理）。
