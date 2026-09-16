# round85 验收报告（round83/84 遗留收口 + 在途半成品结项 + 1 个新真缺陷）

- 日期：2026-09-16
- 起点 HEAD：`398c901`（structuredClone 兜底 + 补交 9 份审计 + round82 验证报告）
- 起点工作区：round83 的 4 条 P3 修复**在途未提交**（并行会话所写），其中
  `tests/quiz-recorded.test.mjs` 有 1 条失败断言 → `npm test` 红了，任务卡在半成品状态
- 本轮目标：**独立验收已提交修复 → 收口在途半成品 → 提交推送**，不留悬挂

---

## 一、已提交修复的独立验收（4/4 全过）

| 项 | 声称 | 独立核验 |
|---|---|---|
| buildFullContext 未导入（聊天页全坏） | `84002b3` | ✅ `AIAssistant.vue:6` import 已含 `buildFullContext`，调用点 `send()` 与 `ai.js` 导出三方对齐 |
| lint 进 CI 门禁 | `84002b3` | ✅ `package.json` 的 `test` 脚本首位即 `eslint .` —— 这条「改调用忘改 import」的错误本来谁都抓不到，现在能抓 |
| Safari 16+ API 兜底（AbortSignal 族） | `84002b3` | ✅ 全仓 `AbortSignal.timeout/any` **只出现在 `src/utils/abort.js` 内**；5 个消费方（llm.js / docs-lib.js / image-analysis.js / word-llm.js / sync.js，共 7 个调用点）全部走 `timeoutSignal()` / `anySignal()`；`tests/abort-util.test.mjs` 7 条（含**剥注释后的结构性闸门**） |
| `structuredClone` 兜底（round78 P2-2 / round83 P3-4） | `398c901` | ✅ 全仓零裸调；`plugins/registry.js:224/259` 已是 `deepClone()` |

**结论：四条都经得起核验，不是纸面修复。**

---

## 二、在途 P3 修复验收（round83 四条，质量良好）

1. **P3-1 未作答不得记账**：`AiQuizView.record()`

   ```js
   if (picked.value[i] == null) return;   // ← 用的是 `== null`，不是 `!`（0 是合法选择）
   ```
   防御位置正确（函数级一道闸 + 模板「已作答」块内），且**没有踩 falsy 陷阱**——选项下标
   `0` 是真值判断的反例，这里用 `== null` 放行 0，正确。

2. **P3-2 防重持久化**：新增 `src/utils/quiz-recorded.js`（localStorage，隐私模式/Node 退化内存 Map
   绝不抛错），`AiQuizView` 的 `recorded` 初值改从持久化读——修「切页/刷新后同一题重复
   `review(2)` 把 FSRS 稳定性注水」。

3. **P3-3 `scheduledHour` 0-23 钳制**：`repo.js` 收口出 `clampScheduledHour`，三条写路径
   （`createDailyPlan` / `addDailyTask` / `updateDailyTask`）统一走它。**原先漏的正是
   `createDailyPlan`（自动建计划路径自己造行）** —— 这条是本轮测试抓出来的。

4. 配套测试 +25 行 + `tests/quiz-recorded.test.mjs`。

---

## 三、在途缺陷：测试自伤断言 → 已修

`tests/quiz-recorded.test.mjs` 的用例 1 红了。round84 判为「样本选错」方向正确，但描述与实际不符，
本轮逐字节确认根因：

- 字面量①：`停止-等待␣协议[的窗]口` —— `的` 与 `窗` 之间**没有**空白
- 字面量③：`停止-等待␣␣␣协议[的␣␣窗]口` —— `的` 与 `窗` 之间**有两个**空白

折叠的语义是「连续空白的**数量**归一为 1 个空格」，它**不可能**把「无空白」变成「有空白」——
两串本就是**不同的题面**。断言拿这一对去测「同键」，是测试的错，不是实现的错（实现无缺陷）。

修法：把样本改成只差**空白数量**的一对（保正例），并补一条反向断言（空白**有无**不同 → 必须不同键），
把这个语义边界钉死。

---

## 四、本轮新发现：`scheduledHour` 的「null 被说成 0 点」（唯一真缺陷）

### 4.1 现象

`add_daily_task`（不给 `scheduledHour`）→ 工具回传 `data.scheduledHour === 0`，而库里存的是 `null`。

### 4.2 根因

AI 工具层有 **4 处**同一写法：

```js
scheduledHour: Number.isFinite(Number(v)) ? Number(v) : null
```

而 **`Number(null) === 0`** 且 **`Number.isFinite(0) === true`** → `null` 一路被判成 `0`。

### 4.3 影响链（不是代码事实，是用户可见后果）

| 出口 | 后果 |
|---|---|
| `add_daily_task` 回传 | 模型被告知「0 点」→ 回答用户「已安排在 00:00」 |
| `list_daily_tasks` 回传 | 模型「看到」一堆 0 点任务 → 复述给用户，凭空捏出一个时间轴 |
| `create_daily_plan` 回传 | 同上 |
| `add_daily_task` **入参** | 模型显式传 `scheduledHour: null`（=「没定时间」）→ 被写成 `0` → **真的入库成 0 点** |

最后一条最重：用户说「这件事今天做，时间没定」，AI 传 `null` 表达「未定」，结果**落库成 00:00**
（`PlanReminderLayer` 会在 0 点提醒、四象限时间轴出现 00:00 格）。

### 4.4 这是哪一类陷阱

铁律里已有 `Number(x) || 默认值` **吞掉显式 0**；本缺陷是它的**孪生兄弟**：
`Number.isFinite(Number(x))` **把 null 变成 0**。两者同源——**用了强制转换做存在性判断**。
通则：**域判断（含 null 判断）不得靠 `Number()` 中转**，先判类型/空值再转数值。

### 4.5 修法：收口成一份

数据层已有一份 `clampScheduledHour`（round82 收口），本轮把它 **导出并加固**，工具层 4 处全部改走它：

```js
export function clampScheduledHour(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null; // 挡住 Number([])===0 / 布尔
  const raw = typeof v === 'string' ? v.trim() : v;
  if (raw === '') return null;                                     // 挡住 Number('')===0
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(23, Math.floor(n)));
}
```

- 两个必须显式挡的坑：`Number('') === 0`（空串是「没填」不是「0 点」）、`Number([]) === 0`（只收 number/string）
- 允许数字串 `'9' → 9`：与 `sync-manifest` 的 `dailyTasks` 域校验对齐（该域只认 **number 或 null**，
  留着 `'9'` 反而会被导入侧拦下）
- 全仓现在只剩**一个** scheduledHour 规则：数据层 3 条写路径 + 工具层 4 处读/写映射

### 4.6 闸门

新增 `tests/agent-write-tools.test.mjs` 用例：**三个出口口径一致**（未排时段 → `null`，不得是 0），
并钉住反向——**显式 0 点必须保住 0**（凌晨排程是合法值），以及 `'9' → 9` / `25 → 23`。

---

## 五、验证现场

| 项 | 结果 |
|---|---|
| `npm test`（eslint . + i18n 三闸 + dep-check + sync-coverage + node --test） | ✅ **1272/1272 passed，exit 0**（较上轮 1267 → +4 在途 +1 本轮） |
| `eslint .` | ✅ 0 error 0 warning |
| i18n 三闸（--strict / --js / 字典对齐） | ✅ 绿（本轮新增中文**全在注释**里，不产生字面量） |
| `npm run build` | ✅ vite 生产构建通过 |
| 行尾一致性 | ✅ 改动 4 文件全部纯 CRLF（无假 diff：改动 122 行 ≙ 真实改动量） |
| 依赖环 | ✅ `dep:check` 无环（工具层新增的 `clampScheduledHour` 走的是工具层**已有**的 `repo.js` 导入，未新增边） |

---

## 六、结论与遗留

1. round83 的 4 条 P3 + round78 的 1 条漏修（structuredClone）**全部结项**，无悬挂。
2. 本轮从「测试失败」里挖出的是**测试写错 + 一个更深的真缺陷**（`null → 0 点`），
   而不是 round84 描述的「只是样本失误」。**教训：断言红了先怀疑断言，但也别停在断言——
   把「这个断言想测什么」顺着实现追一遍，往往能挖到下一层。**
3. 遗留（非本轮范围，登记不修）：
   - `tools/index.js:836` 的 `estimatedMinutes: Number(task.estimatedMinutes) || 0`——同族写法，
     但影响链验证后**无用户可见后果**（缺失与 0 都渲染成 0），故不修，仅登记避免下次重复评估。
   - `quiz-recorded.js` 的 localStorage 键无上限/无清理入口。窗口极窄（每题一键、值 1 字节），
     但按「缓存三件套 = 上限 + 失效 + 清理」的通则应补；需先定淘汰策略，留待后续轮次。
   - 工作区根目录堆积 **46 个 `dist_bak_*`** 目录（沙箱构建规避 safe-delete 的副产物，已被 gitignore）。
     不影响仓库，但建议择机清理磁盘。
