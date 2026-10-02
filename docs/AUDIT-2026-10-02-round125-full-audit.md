# round125 全面审计（2026-10-02）

> 诉求：结合「每轮修复都会引出问题」的历史做全面审计，广度 + 深度，
> 看是否引入新问题 / bug / 业务问题 / 底层算法问题。
>
> 本轮审计方法换了：不再零散读代码，而是**先系统扫描全仓的「模块级缓存」，
> 再逐个核对它们的「失效机制」** —— 因为前几轮的问题几乎都出在
> 「数据变了、缓存没失效」这一类。扫描脚本对 172 个模块级变量做了分类。

---

## 零、一句话结论

抓到一个**严重的既有缺陷**（不是本轮引入，但影响面很大）：
**跨 tab 数据变更广播机制从未生效过**。原因是用错了 Dexie 的 API ——
`db.on('creating'|'updating'|'deleting')` 在 Dexie 里**直接抛错**，
而外面裹着的 `try/catch` 把错误**静默吞掉**：装配「看似成功」、运行时**一次都不触发**。

**已修复**（改用 Table 级 `table.hook`）并加了回归测试，负向对照确认测试有效。

---

## 一、🔴 P0：跨 tab 广播从未生效（`armDbNotify` 用错 API）

### 1.1 它是干什么的

`utils/dbEvents.js` 提供「任一 tab 写库后广播失效信号，其余 tab 刷新视图」的能力
（注释里标为「审计 C3」）。它把 Dexie 的写钩子接上，150ms trailing 节流后派发
`BroadcastChannel` + 本页 `window` 事件。

**全仓有 4 个订阅方，都只依赖这一个触发点**：

| 订阅方 | 作用 |
|---|---|
| `intelligence.js:41` | 卡片全表缓存失效（否则退化为 5s TTL 兜底） |
| `WordBook.vue:306` | 跨 tab 写库后重新加载词库 |
| `WordPhrases.vue:306` | 同上（词组） |
| `WordGroups.vue:148` | 同上（词群） |

### 1.2 问题

```js
// 原实现
for (const ev of ['creating', 'updating', 'deleting']) {
  try {
    dbInstance.on(ev, () => { schedule(); });   // ❌ Dexie 实例级 .on() 不支持这三个事件
  } catch { /* 静默降级 */ }
}
```

**实测（Dexie 4.0.8 + fake-indexeddb）**：

| 调用 | 结果 |
|---|---|
| `db.on('creating')` | ❌ **抛错**：`Cannot read properties of undefined (reading 'subscribe')` |
| `db.on('updating')` | ❌ 抛错 |
| `db.on('deleting')` | ❌ 抛错 |
| `db.on('populate' / 'ready' / 'versionchange')` | ✅ 未抛错（**这才是实例级 `db.on` 支持的事件**） |
| `db.cards.hook('creating')` ← 对照 | ✅ 写 1 次触发 1 次 |
| `db.cards.hook('updating')` ← 对照 | ✅ 改 1 次触发 1 次 |
| `db.cards.hook('deleting')` ← 对照 | ✅ 删 1 次触发 1 次 |

装配后写/改/删，`db.on('creating'|'updating'|'deleting')` **合计触发 0 次**。

**关键**：外面那个 `try/catch` 的注释写着「个别环境不支持 hooks 时静默降级，
绝不能影响 db 状态或主流程」—— 意图是好的，但它**把一个 100% 必现的 API 误用
包装成了"环境差异"**，于是这个缺陷活了很久（代码注释还写着"Dexie hooks 需在 open
完成后装配（open 前 db.on 会因表信息未就绪抛错）"，说明当时已经观察到异常，
但归因到了错误的方向）。

### 1.3 业务后果

- **跨 tab 场景**：Tab A 导入/同步/编辑后，Tab B **不会收到任何通知** ⇒ 显示陈旧数据；
  若用户在 B 继续编辑，还可能以旧数据为基覆盖 A 刚写入的内容
  （这正是该模块注释里声称要解决的问题）。
- **卡片缓存**：`_cardsCache` 只剩 5s TTL 兜底（能自愈，影响较小）。
- **三个词库页面**：跨 tab 写库后**永不自动刷新**（用户需手动刷新页面）。

### 1.4 修法

改用 **Table 级 hook**（Dexie 文档写法的正确入口），并补两处防护：

```js
if (!dbInstance || !Array.isArray(dbInstance.tables) || dbInstance.__dbNotifyArmed) return;
dbInstance.__dbNotifyArmed = true;                 // 防 HMR / 重复调用导致 hook 累积成广播风暴
for (const table of dbInstance.tables) {
  for (const ev of ['creating', 'updating', 'deleting']) {
    try { table.hook(ev, () => { schedule(); }); }  // 回调只 setTimeout：不抛错、不改数据 ⇒ 不影响写事务
    catch { /* 个别表不支持：跳过该表，不影响其它表 */ }
  }
}
```

### 1.5 修复的验证（含负向对照）

新增 `tests/db-events-arm.test.mjs`（5 个用例）：
在 jsdom 下**动态导入** `db.js`（保证顶层装配发生在 `window` 就绪之后），
监听本页 `sxy:dbchanged` 事件，实测：

1. 写入 → **确实派发**（修复前为 0 次）；
2. 更新、删除 → 同样派发；
3. 50 次连续写 → 被 150ms trailing 节流为**个位数**广播（不产生风暴）；
4. 重复装配 → 单次写不产生多次广播（`__dbNotifyArmed` 守卫生效）；
5. **结构闸门**：源码不得再出现 `db.on('creating'|…)`（剥注释后匹配）。

**负向对照**：把装配改回 `dbInstance.on(ev, …)` → 该测试 **3 个用例立刻变红**；
恢复 `table.hook` → **5/5 通过**。

### 1.6 顺带验证（确认我的修复没有放大别的问题）

修复让广播**真的会触发**了，因此必须确认订阅侧是安全的 —— 逐个核对：

| 检查 | 结论 |
|---|---|
| 3 个词库页面是否在卸载时取消订阅 | ✅ 都有 `onUnmounted(() => unsubDb?.())`（WordBook:309 / WordGroups:149 / WordPhrases:123），不会因重挂载累积监听器 |
| 订阅回调是否会写库（形成「写→广播→刷新→写」循环） | ✅ 全是纯读：`load()` / `reload()` / 纯内存 `invalidateCardsCache()`，三个页面文件内**没有任何 `db.*.write` 调用** |
| 广播风暴 | ✅ 150ms trailing 节流（第 3 个用例实测） |
| 是否影响写事务 | ✅ hook 回调只 `setTimeout`，不抛错、不返回修改 |
| `armDbNotify` 的重复装配 | ✅ 加了 `__dbNotifyArmed` 守卫 |

---

## 二、✅ 系统扫描中「实现正确」的缓存（避免过度报警）

同一次扫描覆盖了 172 个模块级变量，其中**真正依赖数据库内容的缓存**逐个核对如下：

| 缓存 | 位置 | 失效机制 | 结论 |
|---|---|---|---|
| `_dashSnap` | `repo.js:1279` | 缓存 key（count + 最大时间戳 + DB 模式）+ 显式 `invalidateDashboardCache()` | ✅ 正确（round122 已补齐漏调的写路径） |
| `_failCountCache` | `repo.js:1329` | key（行数 + 最新 reviewedAt + id）+ `invalidateFailCountCache()` | ✅ 正确 |
| `_schedCache` | `repo.js:109` | **DB 模式校验** + 60s TTL + `refreshSchedConfig()`（调用点：`App.vue:310`、`repo.js:141`） | ✅ 正确 |
| `_cardsCache` | `intelligence.js:29` | 5s TTL **+ 订阅 `subscribeDbChanged` 写失效** + 返回值浅拷贝防污染 | ✅ 实现正确（但此前因 1.2 的缺陷，订阅那条路是死的；**本轮修好后它才真正生效**） |
| `images.js` 的 `cache` | `images.js:15` | `MAX_CACHE=300` LRU 淘汰 + 显式 revoke | ✅ 有上限 |
| `plugins/loader.js` 的 `cache` | — | key 含 `updatedAt#hash` ⇒ **内容寻址**，内容变则天然 miss | ✅ 天然失效 |
| `Feynman.vue` 的 `ctxCache` | `:150` | 配 `ctxKey` 一起判定 | ✅ 正确 |
| `repo.js` 的 `_dashLoading` | `:1280` | Promise 去重，`finally` 中置空 | ✅ 正确 |

---

## 三、🟡 既有问题（非本轮引入，未修，报告待决）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| **A** | `Cards.vue:581 _objUrlCache` | 视图层自己维护了一套 `imgId → objectURL` 缓存，**没有上限/LRU**；而 `images.js` 里已有一套带 `MAX_CACHE=300` 的 LRU 缓存。两套并存 ⇒ 同一张图可能被创建**两个 objectURL**（双份内存） | 在卡片页浏览大量带图卡片时，objectURL 只增不减（直到组件卸载才批量 revoke）。属**内存占用**类问题，不是正确性问题 |
| **B** | `_schedCache` 未订阅 `subscribeDbChanged` | 跨 tab 改调度器/权重后，本 tab 最长 60s 用旧配置 | 影响轻微（60s TTL 兜底）。**本轮修好广播后**，给它加订阅是一行的事，但属扩大改动面，故未动 |

> 上一轮报告的 3 处导出页性能问题（`plain()` 逐项跑正则 / `hideAnswer` 全量重建 / 缩略图重复解码）仍未处理，**等你决定是否一并收掉**。

---

## 四、门禁（实测数据）

| 检查项 | 结果 |
|---|---|
| `eslint .` | **通过**（0 错误） |
| i18n `--strict` | **通过**，反向扫描较基线**新增 0 行** |
| i18n `--js`（数据层中文闸） | **通过**，命中 308 行、**新增 0 行** |
| `dep-check`（循环依赖） | **通过，0 个环** |
| 全量 `node --test` | **1582 测试 / 1582 通过 / 0 失败 / 0 todo** |

对比基线（round124 收尾时 `1577 / 1576 通过 / 1 todo`）：
- `+5` 测试 = 本轮新增的 `db-events-arm.test.mjs` 5 个用例 ✅
- **`todo 1 → 0` 的说明（不是本轮改动引起的）**：那 1 个 todo 来自
  `tests/vite-glob-guard.test.mjs:58` —— 它是**条件性**的：
  `dist` 不存在时 `t.todo('本机未校验产物…')`。现在 `todo` 消失说明**仓库里出现了 `dist/` 构建产物**
  （非本次改动所为，推测是并行会话跑过 `vite build`），该用例于是走了「校验产物」分支并通过。

> 顺带提示：`dist/` 常驻在仓库里会占磁盘，而本机 **C 盘已接近写满**。
> 按项目惯例，构建残留应移出仓库（`mv dist /e/tmp/…`）而不是留在原地。

---

## 五、诚实边界

1. **未在真实浏览器里做「双 tab」端到端验证**。本轮验证到的是
   「Table hook 确实触发 → 本页确实派发 `sxy:dbchanged` 事件」，
   而 `BroadcastChannel` 跨 tab 投递这一段**没有实测**（沙箱里开两个真实 tab 不可靠）。
   不过 BroadcastChannel 那段代码本轮**未改动**，改动只在触发源头。
2. 扫描脚本按「顶格声明的变量名 + 是否含 set/clear/赋值」做启发式分类，
   会漏掉用其它形态实现的缓存（例如完全靠闭包封装的），
   因此第二节的"已核实正确"是**针对扫描命中的这 172 个**，不代表全仓穷尽。
