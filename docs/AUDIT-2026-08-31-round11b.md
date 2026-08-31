# SxyBrick 第十一轮审计 · 复核与残留专项（round11b，2026-08-31）

> 定位：上一份 `AUDIT-2026-08-31-round11.md`（算法层 5 缺陷，已随 `0ae5b00` 提交）是"审计+修复"一体；本份是对**第十轮遗留问题修复质量的复核** + **本轮新变更的独立深审** + **残留问题与体系性风险**。两者互补，不重复。

## 0. 本轮变更面

自第十轮基线（`aed1cb6`）以来共 2 个提交，工作区当前干净（0 改动）：

| 提交 | 内容 | 规模 |
|---|---|---|
| `764801f` | 第十轮未提交批次收口：UserDashboard i18n 外置、pomo 时钟注入、demo-mode 竞态修复、locale-date 新函数、闸门 strict 模式、24 处回退分叉修复 | 16 文件 +1780/−168 |
| `0ae5b00` | 算法层 5 缺陷修复（graphAuto/forecast/repo-core/networth/analytics）+ 画像 i18n 跨层修复 + 3 份新回归测试 | 12 文件，665 测试 |

## 1. 第十轮遗留问题复核（全部闭环 ✓）

| 上轮问题 | 修复方式 | 复核结论 |
|---|---|---|
| **P0-1** pomo 测试周一必红 | 三级修复：① `createPluginCtx` 提供 `now: () => Date.now()` 时钟注入点（registry.js:53）；② 测试固定 `REF = 2026-08-26 周三 14:00`，断言与真实运行日期彻底解耦；③ 顺手修了两个隐藏算法缺陷——`avgDailyMinutes` 分母从恒 7 改为「本周已过天数」（周一打满也不再被稀释成假预警）、byTag 排序加标签名次键保证输出稳定（Agent 引用不漂移） | ✅ 根因正确且修在源头（插件约定"绝不直接 Date.now()"已注释固化）。HEAD 复跑 665 全绿 |
| **P1-1** demo-mode 套件级红 | `stopHub()` 等 `exit` 事件 + 3s SIGKILL 兜底 + 显式 destroy stdio 流；`before()` 排空子进程输出（防缓冲区写满卡死 hub）+ 探测轮 `await r.arrayBuffer()` 消费响应体（修 keep-alive socket 泄漏） | ✅ 对 `UV_HANDLE_CLOSING` 断言的两条来源（未关的 handle、泄漏的 socket）都处理了，根因分析准确 |
| **P1-2** UserDashboard/Workspace 未迁移 | UserDashboard 全量迁移（新字典 userDashboard.js，zh/en 各 89 键，0 缺失 0 占位符失配）；**动态键盲区**（本地 `T()` 包装器拼 key，静态闸门抓不到）专门补 `tests/userdashboard-i18n.test.mjs` 三道护栏（含"正则失效防空跑"自检）；Workspace 相对时间改 `fmtLocaleRelative`（Intl.RelativeTimeFormat），`/30 模块` 硬编码改 `MODULE_GROUPS` 实算 | ✅ 迁移真实（残留 12 行中文全为注释/CSS 注释）；盲区测试设计比常规迁移质量高 |
| **P2-1** 24 处回退字面量分叉 | Health 16 处 + CardGroups 4 处 `t('key', '', …)` → `t('key', undefined, …)`，口径统一 | ✅ diff 逐条核实，全量修复 |
| **P2-2** dbg.mjs / dbg2.mjs 残留 | 已删除 | ✅ |

**附加验证**：新增 `fmtLocaleRelative/weekdayNames/monthNames` 均有真实消费方（UserDashboard 周/月轴、Workspace 同步时间），非死代码；partner.* 字典 9 code × 3 子键 zh/en 齐全（首轮探测误报系脚本路径错误，复测确认 0 缺失）。

## 2. 本轮新发现（独立深审，非 round11 报告已覆盖项）

### N-1（P2）· graphAuto 边标签硬编码中文且**持久化到 DB**

`graphAuto.js:260`：`label: e.label || (e.kind === 'prereq' ? '前置' : '相关')`。

- 与 round11 已修的 `bestWorstPartners`、`analytics.getLearningProfile` 是**第三例同类跨层缺陷**，但落在最难发现的位置——不是 API 返回值，而是**写入 db.graphEdges 的持久化行**：切英文后图谱仍显示中文「前置/相关」，且**已落库的旧边换语言也不会变**（要等下次重建）。
- i18n 闸门只扫 .vue 的 `t()` 调用，对 .js 数据层的字符串字面量完全不可见——这三例全部漏网就是证明。
- 建议：仿 partner.* 模式改 `labelKind`（prereq/related）+ 视图层 `t()` 组装；重建时 `bulkDelete` 已有（graphAuto.js:243-244，升级路径安全已确认），旧中文标签随下次重建自然替换，无需迁移脚本。

### N-2（P2）· `ability.noData` 标记无 UI 消费——修复意图未闭环

round11 P0-3 把零复习的假满分 100% 改为 0，并注释"另给 noData 标记**供 UI 显示「暂无数据」**"。但全库 grep：`noData` 仅出现在 repo-core.js（定义）、adaptive-retention.js（另一个 noData 语义）、测试里。**Stats.vue 雷达图（:195）直接画 `[mastery, correct, stable, coverage]`，没有 noData 分支**——新用户看到的仍是 0/0/0/0 全零雷达，而非"暂无数据"空态。标记是死代码。

- 建议（小改动）：Stats.vue 画像区 `v-if="stats.ability.noData"` 显示 EmptyState compact（组件已有），一行级改动，把 round11 修复的意图真正落地。

### N-3（P2）· 闸门覆盖盲区是体系性风险——同类缺陷已 2 次坐实

本轮两次遇到"数据层产出 localized 内容、.vue 闸门扫不到"（bestWorstPartners → 已修；profile → 已修；边标签 → 新发现 N-1）。单靠逐例修复不收敛，因为**任何新增领域函数都可能再犯**。

- 建议：给 `check-view-i18n.mjs` 加第三道闸——扫描 `src/repo*.js`、`src/agent/*.js`、`src/algorithms/*.js` 中的中文字符串字面量（白名单：注释、log 前缀、`throw new Error`），基线文件沿用 `i18n-hardcode-baseline.json` 机制（本轮已为 .vue 建立 207 行基线，机制可直接复用）。`tests/analytics-profile.test.mjs` 的"数据层不得返回中文"断言是单测侧模板，两者叠加可把这类缺陷挡在提交前。

### N-4（P2）· 时钟注入模式已被证明有效，但只在 2 处贯彻

pomo-stats（ctx.now）与 fmtLocaleRelative（nowMs 参数）建立了"时间判断必须可注入"的模式，round11 报告也证实这是周一必红的根治方案。但其余按时间构造数据的测试仍是裸 `Date.now()`：`trash-lifecycle`（9 处，30 天 TTL 语义）、`integration`（6 处）、`session`/`reset`/`ocr` 等——trash TTL 与"跨月/跨周一"边界的碰撞只是时间问题。

- 建议：repo 层时间相关函数（trash TTL 判定等）逐步接受 `now` 参数（缺省 Date.now()，与 locale-date 同口径），测试统一注入 REF 常量。不需要一次改完，先给 trash-lifecycle 这一个最高危文件做，模式已现成。

### N-5（观察项，round11 已记，沿用）· analytics 大表全表扫

10+ 处 `reviews.toArray()` 后内存过滤。个人单机规模无感，卡片 5k+ 后应下推 `where('reviewedAt').above()`。无新增风险，不重复展开。

## 3. 多角度交叉分析

**（a）数据协同视角——本轮最有价值的"看不见"修复在同步正确性上**
graphAuto 边 id 改 `[aId,bId].sort()` 表面是算法 bug，实质是**跨设备数据协同的正确性问题**：旧 id 随难度序漂移 → 两端设备各自算出不同 id → 同步合并后同对卡双边堆积（且各自吃 maxEdgesPerCard 名额，还会级联挤掉真实边）。修复后两端收敛到同一 id，bulkPut 幂等覆盖。这类"id 必须与本地计算顺序无关"的约束应成为后续所有派生数据的铁律（目前 auto 边、aiUsage 本地表、trash 本地表都已满足）。

**（b）i18n 架构视角——三例同类缺陷指向同一收口方案**
数据层三处中文散文/标签（bestWorstPartners→code+params、profile→levelCode、边标签→N-1 未修）说明"领域层只回 code + params，视图层 t() 组装"必须从惯例升级为**机制**：N-3 的 .js 闸门 + analytics-profile 式单测模板。闸门本轮已升级（正向解析 + zh/en 键/占位符对齐 + --strict 反向硬编码基线），.vue 侧已收口，.js 侧是最后一块。

**（c）测试体系视角——修复质量明显高于平均水准**
本轮 7 个新增/修正测试文件里，3 个值得作为仓库范例：userdashboard-i18n（动态键盲区 + 防空跑自检）、graphAuto（同序/反序双路径 + 库行数=返回数的落库一致性）、plugins-examples（REF 固定时刻 + 注释说明为何选周三）。测试不再是"防回归"，开始承担"记录根因"的职责——这是前几轮反复要求的，本轮做到了。

**（d）扩展功能视角——两个低成本收口项**
1. N-2 的 noData 空态（一行级，完成 round11 意图）；
2. 上轮 UX 报告第一批（音效开关 / demo 横幅收纳 / 1080px 宽屏档 / 默认核心导航组）与本轮 i18n 收口无冲突，可并行——其中"默认核心导航组"落地后，导航 36 项平铺的新用户过载问题解决，比任何单视图美化收益都大。

## 4. 验证记录

| 项 | 命令 | 结果 |
|---|---|---|
| 测试基线（HEAD 复验） | `npm test` | **665 passed / 0 failed** |
| i18n 正向 + 对齐闸门 | `node scripts/check-view-i18n.mjs` | ✅ 36 视图 t() 可解析 · 35 字典 zh/en 键位与占位符对齐 |
| i18n 反向 strict 闸门 | `… --strict` | ✅ 207 行基线，新增 0 / 消除 0 |
| 构建 | `npm run build` | ✅ 119 预缓存条目 |
| 工作区 | `git status` | ✅ 干净（0 改动） |
| 数据层中文残留抽查 | grep 数据层/算法层 | ⚠️ 见 N-1（graphAuto 边标签） |

## 5. 建议处理顺序

1. **N-2**（noData 空态，一行级）+ **N-1**（边标签 labelKind 化，随下次图谱重建自然替换旧标签）——同属"上轮修复意图收尾"，合并一个小批次；
2. **N-3**（.js 数据层闸门 + 基线）——机制性收口，挡住第三、四例；
3. **N-4**（trash-lifecycle 时钟注入，模式已现成）；
4. UX 第一批四件套（音效开关 / 横幅 / 宽屏档 / 默认导航组）与上述并行。

> 审计人备注：本轮未修改任何源码；N-1/N-2 均可独立复现（grep 定位 + 切英文界面观察图谱标签）。round11 报告已覆盖的 5 算法缺陷不重复审计，仅复核其回归测试与修复代码的自洽性（通过）。
