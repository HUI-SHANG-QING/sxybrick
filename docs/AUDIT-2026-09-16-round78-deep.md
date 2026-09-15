# round78：浏览器兼容性——构建目标声明与运行时 API 的裂缝

> 基线：`d0fdb14`（并行：全面审计回归三处）
> 并行占 round77（AI/agent + PWA/worker/计时器），本报告另起 round78。
> 方向：**从未碰过的「启动路径 + 遥测 + 浏览器兼容性」空白域**。

---

## 一、本轮方向与覆盖

历轮未审域：`main.js` 启动路径、`pwa.js`（SW 注册/配额）、`telemetry.js`（遥测隐私/批量）、**浏览器运行时 API 兼容性**。

**验证结果**：main.js（错误守卫/启动任务/fire-and-forget 兜底）、pwa.js（SW 失败降级/quota 检查/持久化请求）、telemetry.js（节流/去重/隐私 A-B 分级/批次回填）——三个模块全部成熟，零新问题。

**实锤发现集中在「浏览器兼容性」**：项目声明构建目标 es2020（main.js 注释「chrome87/safari14」），但代码里用了 **3 个 Safari 14 之后才有的运行时 API**，且大部分无兜底——**语法支持≠API 可用**，声明与实际运行环境存在裂缝。

---

## 二、问题清单

### P2-1：AbortSignal.timeout × 9 处无兜底——Safari 15 及以下核心功能直接失效

**现象**：iPhone/iPad 用 Safari 15（2021-2022 年的 iOS 15）打开应用，同步、AI 对话、图片分析、文档解析**直接抛错**，且报错误导排查。

**证据链**：
1. `AbortSignal.timeout()` 是 **Safari 16+（2022-09）** 才有的 API，不存在时调用即抛 `TypeError: AbortSignal.timeout is not a function`；
2. 全仓 **9 处**直接调用，无一兜底：
   - `sync.js:635`（hub 同步超时）
   - `services/word-llm.js:210/211/226/345`（英语 AI 生成/翻译）
   - `services/image-analysis.js:151/493`（图片分析）
   - `docs-lib.js:341/342`（资料解析）
3. 项目声明构建目标 es2020（main.js 注释）、vite.config 未设 target（默认 'modules'≈es2020）——**vite 只转译语法，不 polyfill 运行时 API**；
4. **最坏的误导**：`sync.js:635-648` 的 catch 链——`AbortSignal.timeout` 抛的 TypeError 会落入 `e instanceof TypeError` 分支，报「连不上电脑端中枢。请确认①中枢已启动②地址是当前内网 IP…」——用户按错误提示排查半天，实际是**浏览器 API 太老**。

**影响**：Safari 15 及以下（或老安卓 WebView）：同步、AI、图片分析、资料解析全挂；现代浏览器无影响。

**修复方向**：建一个共享 helper：
```js
export function safeTimeout(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms) };
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal };
}
```
9 处调用点统一替换（同步误报分支自然消失）。约半小时工作量。

### P2-2：plugins/registry.js structuredClone × 2 处无兜底

**现象**：Safari 15.3 及以下装插件后，插件工具调用/事件钩子分发直接抛 `ReferenceError: structuredClone is not defined`（该 API Safari 15.4+ 才有）。

**证据**：`registry.js:223`（工具调用 `fn(structuredClone(args), ctx)`）、`:258`（triggerHook `fn(...structuredClone(args), ctx)`）——无任何 typeof 检查。

**影响**：仅影响**插件功能**（可选功能，不装插件无感），但一旦装插件即挂。修复同款一行兜底（`typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x))`）。

### P3-1（备忘）：locale-date.js:155 `.at(-1)` 依赖降级路径

**状态**：`REL_STEPS.at(-1).ms`（Safari 15.4+）——**有 try/catch 兜底**（失败降级为 `fmtLocaleDateTime`），功能不挂，只是老浏览器相对时间显示降级为绝对时间。**无需修**，备忘记录。

---

## 三、根因分析（交叉思考）

1. **「语法转译」与「API polyfill」是两个层次**：esbuild 的 target 只处理语法（箭头函数/可选链/?? 等），**运行时的内置对象方法（AbortSignal.timeout/structuredClone/Array.prototype.at）从不会被转译**。项目在历轮审计中已对 crypto.randomUUID（round23 P3-6）、CompressionStream（shareCode）、requestIdleCallback（telemetry）做过兜底——**说明兜底纪律存在，但 AbortSignal.timeout/structuredClone 是漏网的两族**。
2. **为什么一直没炸**：开发者用现代浏览器（Chrome/Edge），Safari 15 及以下不常见；且 GitHub Pages 场景下大部分用户用现代手机浏览器。**但项目自己声明的支持下限是 Safari 14**——声明与实际实现冲突，属「看不见的底层裂缝」。
3. **误报放大问题**：兼容性错误与网络错误混在同一个 catch 链里，报错文案把用户引向网络排查——**兼容性缺陷 + 误导性提示**双重成本。

---

## 四、历轮修复完整性验证（本轮顺带实证）

| 项 | 结果 | 证据 |
|---|---|---|
| npm test 全量 | ✅ **1230/1230** | 五道门禁全绿 |
| uid 兜底（round23 P3-6） | ✅ | db.js:430 randomUUID 可选链 + 兜底 |
| 遥测批次回填（round34 P2-8） | ✅ | telemetry.js:87-97 逐批 try + 回填 |
| 遥测定时器测试挂起（round11b） | ✅ | telemetry.js:114 `typeof window` 守卫 |
| 回收站/专注计时/router.onError/i18n 护栏 | ✅ | 上轮（验证型审计）已逐项源码实证 |

---

## 五、本轮建议（按影响 ÷ 成本）

1. **P2-1 safeTimeout helper 替换 9 处**（半小时）——修 Safari 15 核心功能 + 消除误导性报错；
2. **P2-2 structuredClone 两处兜底**（5 分钟）；
3. P3-1 无需动。

---

*round78 · 覆盖：启动路径/遥测/浏览器运行时 API 兼容性 · 零必修（2 P2 + 1 P3 备忘）*
