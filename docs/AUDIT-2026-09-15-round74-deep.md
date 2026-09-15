# round74 深度修复：笔记 / 资料库 / 计划 / 每日任务 / 备忘 —— AI 看不到内容（工具侧收口）

> 承接 round73。上一轮修了「卡片域」与「Agent 每轮必 400」，本轮把同一类缺陷在
> **其余五个模块**补齐，并把「列表类工具四件套」固化成闸门。

---

## 一、用户视角的病灶：不是 AI 笨，是**工具根本没把内容给它**

round73 已确认卡片域的问题（`search_cards` 只回 `front`、`compact` 默认只留 8 条、列表无翻页）。
本轮逐个模块排查，发现的**真实**问题如下：

| 模块 | 现状（修复前） | 后果 |
| --- | --- | --- |
| **笔记** | `db.notes` 表（含标题/分类/标签/双向链接/Markdown 正文）**零工具暴露** | 用户问「我笔记里怎么写的」→ AI 完全无从下手 |
| **AI 文档** | `list_docs` 只回 `id/title/type/updatedAt`，**没有正文摘要**，也**没有读全文的工具** | AI 知道有《计网周报》，但永远读不到它写了什么 |
| **资料库** | `list_lib_docs` 描述写着「再用 **read_doc** 读具体内容」——但注册表里**根本没有 read_doc**（真实工具叫 `read_lib_doc`） | 模型照描述调用 → 撞「未知工具」→ 白费一步，并可能直接回答「我看不到资料内容」 |
| **学习计划** | `list_plans` 返回整个对象（含长正文），没有分页；**没有读全文的工具**；正文一长就被 compact 截到 300 字 | 「我的计划具体怎么安排的」拿不到完整安排 |
| **每日任务** | `db.dailyTasks` / `db.dailyPlans`（每天实际要做的事、四象限、预估时长、打卡状态）**零工具暴露** | 「我今天要做什么」「这周完成得怎么样」完全答不了 |
| **备忘** | `list_memos` 硬编码 `slice(0, 50)`，无翻页、无 `hasMore` | 超过 50 条就静默丢失后半 |

另外，**第十一条更隐蔽**：即使工具存在，**没挂到 Agent 的 `tools` 列表里也等于不存在**
（`buildSystemPrompt` 只渲染该 Agent 声明的工具）。例如「卡片生产工」的核心工作是
「把笔记/讲义拆成卡片」，却**读不到用户的笔记与 AI 文档**；「导师 Agent」手上只有卡片与资料库工具。

> 一句总结：**「AI 看不到内容」在本项目里几乎总是工具侧缺陷**——要么字段没给（只有 front）、
> 要么数量被截（slice(0,8)）、要么取不到全文（无详情工具）、要么根本没挂上（不在 tools 列表）、
> 要么工具名写错了（幽灵引用）。

---

## 二、修复

### 1) 统一分页助手（一处实现，六个模块共用）

```js
const LIST_DEFAULT_LIMIT = 20;   // 此前各工具自己 slice(0,30/50)
const LIST_MAX_LIMIT = 100;
function pageOf(rows, args) { … return { items, total, offset, limit, hasMore }; }
```

返回**必须**同时给 `total` 与 `hasMore`：只给 `items` 时模型无法判断「这是全部还是被截断」，
就会据此断言「只有这些」。

### 2) 新增 5 个工具（工具总数 50 → 55）

| 新工具 | 作用 | 要点 |
| --- | --- | --- |
| `list_notes` | 列笔记（q/category/tags 过滤 + 分页 + **正文摘要 100 字** + hasImage + 双向链接数） | 列表**不回传完整正文**（防上下文爆） |
| `read_note` | 读笔记全文 | id 或标题模糊；出参带 `contentChars`/`truncated` |
| `read_doc` | 读 AI 文档全文 | **兑现了 `list_lib_docs` 注释里预留的名字**（「把 read_doc 让给读 AI 文档的工具」） |
| `read_plan` | 读学习计划完整安排（阶段/每日任务/里程碑） | 默认 3000 字，可调 |
| `list_daily_tasks` | 每日规划：传 `date` 给当天口述原文 + 任务明细（类型/四象限/预估时长/开始时刻/状态/完成备注）；不传则给最近 N 天汇总 | 与 `list_plans`（长期计划）明确区分 |

命名族：**`read_*` 读全文（重内容）/ `get_*` 取结构化数据 / `list_*` 列表**，
`read_doc` / `read_note` / `read_lib_doc` / `read_plan` 成对，避免模型混用。

### 3) 重写 4 个列表工具

- `list_docs`：补正文摘要 / `contentChars` / `hasImage` / 分页 + 描述点名 `read_doc`；
- `list_plans`：补摘要（120 字）+ 正文原长 + 分页 + 描述点名 `read_plan`；
- `list_memos`：去掉硬编码 `slice(0,50)`，改分页（备忘是短句，列表直接给全文，无需详情工具）；
- `list_lib_docs`：**修幽灵引用 `read_doc` → `read_lib_doc`**、补分页、补**文字层摘要 60 字**，
  并明确写出「读资料库文件用 `read_lib_doc`，读 AI 文档用 `read_doc`，别混」。

### 4) Agent 接线（这一条同样关键）

| Agent | 新增工具 | 为什么 |
| --- | --- | --- |
| 学习答疑导师 | `list_notes` `read_note` `list_docs` `read_doc` `list_plans` `read_plan` `list_daily_tasks` `list_memos` | 它是默认路由，此前只能看到卡片与资料库 |
| 卡片生产工 | `list_notes` `read_note` `list_docs` `read_doc` | 核心工作是「把笔记/讲义拆成卡片」，却读不到笔记 |
| 复习计划编排师 | `read_plan` `list_daily_tasks` `list_notes` | 编排前要看得见现状，否则排出与现状脱节的计划 |
| 智能复习教练 | `read_plan` `list_daily_tasks` `list_notes` `read_note` | 它的职责描述里就写着「综合…计划与费曼反馈」 |
| 学习数据分析师 | `list_plans` `read_plan` `list_daily_tasks` | 周报要能引用计划进度与每日完成情况 |

### 5) 两条新闸门 + 一条闸门规则

- **`tests/agent-list-tools.test.mjs`（10 条）**
  1. **工具描述/参数里引用的工具名必须已注册** —— 直接抓 `read_doc` 那类幽灵引用；
  2. **Agent 的 `tools` 列表里每个名字必须已注册** —— 防拼错导致工具静默不可用；
  3. **列表类工具必须有 `limit`/`offset`**；
  4. **列表工具描述必须点名它的详情工具**，且该详情工具真实存在；
  5. **「读全文」类工具必须支持 id 与标题两种定位**；
  6. ~10. 真实数据端到端：笔记 25 条翻页无重无漏、`read_note` 按 id/标题均可、AI 文档摘要与 `hasImage`、
     计划摘要与全文、每日任务按天/按区间/按状态、非法日期**显式报错**（而不是静默返回空让模型误报「那天没计划」）、
     备忘分页、资料库空库不抛错。
- **`get_weak_cards` 补分页**：闸门第 3 条当场抓到它「是列表类却没有 `offset`」（上一轮只给 `search_cards` 补了）。
  其 `total` 是**已知下界**（`weakCards` 无 count-all 接口），故取满即判 `hasMore` ——
  宁可让模型多翻一页拿到空列表，也不谎报「只有这些」。
- **i18n 第三道闸新增豁免**：`const *_PARAMS = {…}` 共用参数说明表与 register 内的 `parameters`
  属**同一类文本**（发给模型的参数契约、永不翻译），只是声明位置在 register 窗口之外。
  不豁免就会出现「同一段参数说明，写在 register 里放行、抽成常量复用就报错」的荒谬局面，
  反而逼人把说明复制 6 份。配对必须**引号感知**——模板字面量里的 `${…}` 花括号会让朴素正则提前截断，
  实测把 `offset` 那行漏了出来（已改为与 `maskCallArgs` 同款的括号配对）。
- **3 条工具文案迁入字典**（`agent.toolMsg.*`）：闸门判定「短中文字符串 = 疑似 UI 文案」，
  它们确实会经由 `buildLocalAnswer` 显示给用户（「工具 X 执行失败」+ 原因），故按闸门要求走 `t()`，
  而不是 `--force-baseline` 认领。

---

## 三、验证

```
npm test            → 1219 passed / 0 failed   （基线 1209 + 本轮新增 10）
npm run build       → BUILD_EXIT=0
npm run check:build → ✓ 52 个词库分片全部就位
dep:check           → 272 个源文件，0 循环依赖
i18n 三闸           → 通过（数据层 341 行、较基线新增 0；字典 zh/en 键位与占位符对齐）
幽灵工具名扫描       → 0（修复前 1：read_doc）
列表类工具 offset    → search_cards / get_weak_cards / list_notes / list_docs / list_plans / list_memos / list_lib_docs 全为 true
```

## 四、用户可感知的变化

- 问「我笔记里是怎么记的」→ AI 能列出笔记并**读出正文**（此前完全看不到笔记模块）。
- 问「那篇 AI 周报写了什么」→ AI 调 `read_doc` 拿到全文与图片引用（此前只能看到标题）。
- 问「我上传的那份讲义讲了什么」→ 不会再因为模型去调不存在的 `read_doc` 而卡住。
- 问「我的计划具体怎么安排的」→ 拿到完整阶段/每日任务（此前只有被截断的摘要）。
- 问「我今天要做什么 / 这周完成得怎么样」→ 能按天给出任务明细与完成状态（此前该表零工具暴露）。
- 任何列表超过一页时，AI 会**自己翻页**取全，而不是回答「我只看到 20 条」。

## 五、仍未做（按价值排序）

1. 笔记/资料库的**写入**工具（`create_note`/`update_note`）：目前只能读；用户说「帮我把这段整理成笔记」时 Agent 只能落到 AI 文档（`create_doc`）。
2. 资料库文件的**按页读图**目前靠 `read_lib_doc` 的 `pages` 参数，尚无「先给目录再按需翻页」的形态。
3. 打字机效果（`onToken` 已全链路打通，UI 未消费）。
4. `max_tokens` 与模型上下文窗口的自适应（当前只处理「服务端拒绝 max_tokens」这一类 400）。
