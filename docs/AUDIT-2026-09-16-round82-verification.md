# round82：承接 round76~81 的独立验证 —— 1 个 P0（**无人报**）+ 2 条未完成修复 + 2 处报告失真

- 日期：2026-09-16
- 基线：`bef64f9`（我的 P3 批）+ 工作区新增的 round77~81 报告（未提交）
- 方法：与 round80 验证一致——**不采信结论表**，逐条读代码 + 可执行复现。
- 触发：用户问「继续分析审计，还有没有未完成的修复和假的修复」

---

## 一、结论速览

| 类型 | 条目 | 状态 |
| --- | --- | --- |
| **P0 真问题（无人报）** | `AIAssistant.vue` 调用 `buildFullContext` 却没有 import → **聊天页每次发送抛 ReferenceError，AI 助手一条回答都给不出来** | ✅ 已修 + 门禁强化 |
| **未完成修复** | round78 P2-1：`AbortSignal.timeout/any` **7 处裸调**（Safari 16+ API vs 声明 es2020） | ✅ 已修（助手 + 9 处收口 + 闸门） |
| **未完成修复** | round78 P2-2：`structuredClone` **2 处裸调**（Safari 15.4+）→ 插件功能老 Safari 直接挂 | ✅ 已修（同上） |
| **仍开着（设计级）** | round76 P2-1：同步**拉取全量** vs 推送增量不对称 | ⏸️ 未修（见 §四） |
| **报告失真** | round81 称 round80 A5「顺带补了 back/tags/wrongReason」 | ❌ 误记（见 §五） |
| **报告失真** | round78 证据链称 9 处裸调 | ⚠️ 实测裸调 7 处（2 处本有 `?.` 兜底） |
| **仓库卫生** | 9 份审计文档从未提交；用户侧 3 项交付物未跟踪 | 📋 见 §六 |

---

## 二、P0：聊天页全坏（**没有任何一份审计报告发现它**）

### 证据链

```
src/views/AIAssistant.vue:6   import { chatAI, buildContext, getAIConfig, … } from '../ai.js';   ← 没有 buildFullContext
src/views/AIAssistant.vue:131 const [ctx, mem] = await Promise.all([buildFullContext(text), …]); ← 调用它
src/ai.js:98                  export function buildFullContext(query) { … }                      ← 函数确实存在，只是没导入
```

`npm run lint`（= `eslint .`）报：`131:43 error 'buildFullContext' is not defined  no-undef`。

### 引入者与时间线

`git log -S "buildFullContext(text)" -- src/views/AIAssistant.vue` → **`9d2d764`**
（2026-09-15 21:33「修『AI 时好时坏』的真因——流式空闲超时 + 超时抢救…」）。

该提交把 `buildContext()` 改成 `buildFullContext(text)`（改得有道理：buildContext 只给统计面板，
模型看不到正文）——**但没补 import**。于是：

- 聊天页每次发送 → `Promise.all` 处抛 `ReferenceError` → 被 catch 吞成一句报错 toast；
- **用户永远拿不到回答**，且报错文案与真实原因无关；
- 同一晚 22:10 用户投诉「为什么 AI 对话功能还存在高频失败现象」——**时间线吻合**；
- 而 Agent 工作台走 `runAgentTurn` 自己的 context 路径 → 仍可用 → 正好解释用户说的「有时能、有时不能」。

### 为什么门禁没抓到（这才是最该记的一条）

1. `npm test` 的链里**没有 lint**（只有 i18n/dep/sync-coverage + node --test）；
2. 没有任何组件级冒烟测试（`.vue` 的 `send()` 从不被执行）；
3. **我自己的验证也有盲区**：我一直用 `npx eslint src tests`，而项目脚本是 `eslint .` ——
   前者不含 `.vue`，所以我此前多轮报「lint 0 error」都是**不完整的**。

**修法**：补 import；并把 **`eslint .` 插进 `package.json` 的 `test` 链**——`no-undef` 从此由 `npm test` 兜住。

---

## 三、未完成修复：round78 的两条（跨浏览器运行时 API）

round78 判定正确、结论在码，但**修复从未落地**（工作区与 HEAD 都没有对应改动）。

| API | 要求 | 项目声明 | 裸调点（修复前） | 旧 Safari 上的后果 |
| --- | --- | --- | --- | --- |
| `AbortSignal.timeout` / `AbortSignal.any` | Safari 16+ | es2020（≈safari14） | `sync.js:635`、`word-llm.js:210/211/345`、`docs-lib.js:341/342`（7 处） | 同步、AI 对话、图片分析、云端 OCR **整条失效** |
| `structuredClone` | Safari 15.4+ | 同上 | `plugins/registry.js:223/258`（2 处） | 装插件后工具调用/事件钩子抛 `ReferenceError` |

vite **只转译语法、不 polyfill 运行时 API**（`vite.config` 亦未设 target），故这是真实缺口。

**最误导的一处**：`sync.js` 的 catch 把 `AbortSignal.timeout` 抛的 TypeError 归到「连不上电脑端中枢。
请确认①中枢已启动②地址是当前内网 IP③防火墙放行」——用户会按提示排查半天，真实原因只是浏览器太老。

**修法**：
- 新增 `src/utils/abort.js`（`timeoutSignal` / `anySignal`，用 `AbortController + setTimeout` 兜底，
  超时 reason 仍为 `TimeoutError` 以兼容 `sync.js` 等既有判据）；
- 新增 `src/utils/clone.js`（`deepClone`，`structuredClone` 缺失时退 JSON 往返）；
- **9 个调用点全部收口**（含 `llm.js` / `image-analysis.js` 里原本"正确但不统一"的写法）；
- **闸门**：`tests/abort-util.test.mjs` 含「删掉原生 API 模拟 Safari 15」的行为测试 +
  **全仓禁止裸调**这两个 API 的结构闸门（兼容 API 清单化，新增一条只需加一行，**扫描前剥注释**）。

> 顺带说明一处**语义漂移**：`image-analysis.js` 原本用 `AbortSignal.timeout?.(30000)`，
> 在新浏览器超时生效、在旧浏览器**静默退化为「无超时」**——同一个功能两种行为。
> 收口后两端一致（超时真的会生效）。

---

## 四、仍开着：round76 P2-1（同步拉取全量）

**现状核对**：推送侧确实是增量的（`buildIncrementalBackup` 只带 `updatedAt > since` 的行 + 被引用图片），
而拉取侧是整体下载 hub 上该 scope 的**整个数据文件**（含全部图片 base64）→ 图片越多、每次同步越慢越费流量。

**为什么本轮不修**：这不是漏改一行，而是**协议不对称**——需要 hub 侧支持按 `since` 生成增量，
客户端再本地合并（还要处理「本地已删/远端已删」的墓碑语义）。属独立一轮的设计+实现，
且必须同时改 `sync-hub/` 与 `sync.js`，并补「增量拉取后状态与全量拉取等价」的等价性测试。

**建议切入点**（给下一轮）：hub 端按 `?since=<ts>&scope=<x>` 返回增量包 → 客户端复用既有的
`mergeFromBackup` 路径（该路径已处理字段级时间戳与墓碑）→ 用「先全量再增量」的等价性测试兜住。

---

## 五、报告准确性（两处修正）

1. **round81 的误记**：其验收表写「A3/A4/A5 ✅ …（顺带补了 back/tags/wrongReason）」。
   实测 `git log -S "c.back || ''" -- src/algorithms/mistakeAttribution.js` → 唯一命中 `ba71762`
   （**旧提交**，原作者时期），与 round80 的 A5 修复无关。
   → 代码没问题，但**结论表把"本来就有的守卫"记成了本次修复的功劳**；下轮复核时别把它当已验证事实。
2. **round78 的计数**：称 `AbortSignal.timeout/any` 「全仓 9 处无一兜底」。
   实测裸调 **7 处**；`image-analysis.js:151/493` 原本就是 `AbortSignal.timeout?.(30000)` + 手工 `any` 判断
   （不崩，但语义随浏览器漂移）。→ 结论方向正确，证据链计数偏大。

---

## 六、仓库卫生（未提交/未跟踪）

- **9 份审计文档从未提交**：round53/55/56/60/61/77/79/80/81 → 本轮一并补交（审计轨迹应入库，
  否则我的 round80-verification 引用的 round80-deep 在仓库里根本不存在）。
- **用户侧交付物未跟踪**（建议**不要**随手 `git add -A`）：
  - `SxyBrick-毕业设计任务书.docx`（39KB，含个人信息）
  - `_taskbook_work/`（gen_taskbook.py + outline.md + attachment_purpose.md）
  - `docs-suite/`（00-总索引 / 01-项目总览 / 02-技术文档 / 03-使用文档 / 04-甲方交付）
  这三项属毕设交付物，仓库是公开的 GitHub Pages 源。**是否入库需用户拍板**（本轮只报告，未改动 `.gitignore`）。

---

## 七、验证

```
npm test            → 1266 passed / 0 failed   （1262 + 新增 5：超时语义/删原生 API/原因透传/deepClone/兼容 API 闸门）
                      且 test 链现在先跑 eslint .
build + check:build → 通过（52 分词库分片）
eslint .            → 0 error / 0 warning（修前：1 error + 1 warning）
```

**本轮最重要的一条教训**：验证要跑**项目自己的脚本**，而不是自己顺手敲的相似命令。
`npx eslint src tests` 与 `eslint .` 差一个 `.vue`，就足够让一个「聊天页全坏」的 P0 连续通过我多轮"全绿"检查。
