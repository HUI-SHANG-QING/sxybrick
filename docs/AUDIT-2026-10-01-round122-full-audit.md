# round122 全面审计报告（2026-10-01）

> 诉求复述：鉴于历史上每轮修复/更新都会引入新问题，本轮要求**广度 + 深度**审计，
> 找出「表面跑得通、底层有隐患」的问题，并区分**已验证**与**推断**。
> 本轮**只报告，不改代码**。
>
> 结论标注规范：
> · **【已复现】** = 用 Node + fake-indexeddb 忠实跑出数据流，结论可复算；
> · **【已核实】** = 逐行代码追踪到确定事实（含调用链两端）；
> · **【推断】** = 静态判断，未做运行时验证。

---

## 一、总览

| # | 严重度 | 位置 | 缺陷 | 证据强度 |
|---|---|---|---|---|
| A | **严重** | `views/WrongBook.vue:141`、`views/Cards.vue:731/741` | 改排期后首页统计快照不失效 → 数字不更新、已救的卡仍在预警列表 | 【已复现】 |
| B | **严重**（限 FSRS 用户） | `utils/quickCheck.js:56` | 快速校验的到期日预筛把 FSRS 下 level=1 的卡全部静默排除 → 功能失效 | 【已复现】 |
| C | **一般** | `tests/round57-perf.test.mjs:200` | 「写路径必须失效快照」门禁只扫 `src/repo.js`，`.vue`/`utils/` 完全在雷达外 | 【已核实】（A 的结构性根因） |
| D | 一般 | `sync.js:1004` | 删批注不写墓碑，与 `repo.js:655` 口径不一致，全靠 `sweepOrphanRows` 兜底 | 【已核实】 |
| E | 建议 | `db.js:363` | schema 注释自相矛盾且过时（359 行说写墓碑，363 行说不写；说不做图片扫描但实际已做） | 【已核实】 |
| F | 建议 | `annot-repo.js:94/104/115` | `level` 是死字段：写入但全仓无任何读取方 | 【已核实】 |
| G | 建议 | `db.js:28` | 墓碑表主键为单列 `id`，却靠 `kind` 区分语义 → 同 id 不同 kind 会互相覆盖 | 【推断】 |

---

## 二、详细结论

### A（严重）首页统计快照不失效 —— 「今日待复习」不涨、已救的卡仍列在预警里

**【已复现】**

`dashboardSnapshot()`（`repo.js:1238`）是首页三个聚合（统计 / 错题集 / 复习建议）
共用的共享快照，缓存键为
`DB模式 | cards行数 | reviews行数 | 最大card.updatedAt | 最大review.reviewedAt`。

`WrongBook.vue:141` 与 `Cards.vue:731/741` 只写 `dueAt` + `reviewedAt`：

```js
// WrongBook.vue:141
await runAction(() => db.cards.update(card.id, { dueAt: Date.now(), reviewedAt: Date.now() }), ...)
// Cards.vue:731
await db.cards.put({ ...card, dueAt: Date.now(), reviewedAt: Date.now() });
```

不 bump `updatedAt` 是**有意为之**（注释写明：推高 updatedAt 会让本机这份旧内容成为
跨设备合并的 winner，把其他设备的卡面文字编辑整段覆盖掉）——这个取舍本身是对的。
但**没有配套调用 `invalidateDashboardCache()`**，于是缓存键四项全不变 → 命中陈旧快照。

复现输出（`E:/tmp/audit7-out.txt`，fake-indexeddb）：

```
[1] 初次 getStats().dueToday = 0 (期望 0)
[2] DB 真实行 A.dueAt = 1790865959899 | <=now ? true
[3] 快照里 A.dueAt = 1791125160899 => 陈旧！快照比 DB 落后
[4] 改完后 getStats().dueToday = 0 => 未反映（陈旧缓存命中）
[5] 显式失效后 getStats().dueToday = 1 => 正确反映
```

用户可见后果：
1. 错题本点「加入今日复习」、卡片页点「提前巩固」→ 回首页「今日待复习」数字不涨；
2. 所有读同一份快照的消费方都拿到旧行：`getStats`（统计）、`getReviewSuggestion`（复习建议）、
   `analytics.getForgetRisk`（遗忘预警）、`getNetWorth`（知识净值）、`getDueForecast`（到期预测）、
   `getSourceOverview`（来源血缘）。

> **【诚实性修订 · 2026-10-01 晚】初版报告在这里写重了，订正如下。**
> 初版第 2 条写的是「刚点过提前巩固的卡继续列在遗忘预警里」——**这个说法不准确**。
> 逐行核实 `getForgetRisk`（`analytics.js:397-424`）后确认：它的评分是
> `risk = 临近度×0.6 + 历史错误率×0.4`，而**逾期卡的临近度直接拉满**（`dueIn < 0 → proximity = 1`）。
> 所以卡被拉到「现在到期」之后 risk 反而更高，**即使快照是新鲜的，它也照样留在预警列表里**。
> 陈旧快照造成的真实差异是：**risk 百分比与 dueAt 不刷新**（快照里仍是旧的未来到期日），
> 而不是「列表不移除」。
> 修复本身不受影响，但结论必须按实际代码订正——定级/描述偏高会误导后续的处理方向。

### B（严重，限 FSRS 用户）快速校验在 FSRS 下对 level=1 卡静默失效

**【已复现】**

`getQuickCheckDue()`（`quickCheck.js:52`）为省一次全表扫，先用到期日做预筛：

```js
const near = await db.cards.where('dueAt').belowOrEqual(now + DAY).toArray();  // :56
```

隐含假设：「level ≤ 1（刚学/学习中）的卡，到期日必然在 1 天内」。
这条假设在 **SM-2（默认调度器）下成立**，在 **FSRS 下不成立**：

- `fsrs.js:216`：`level = S < 1 ? 0 : S < 3 ? 1 : ...` → level=1 表示稳定度 S ∈ [1, 3)；
- `fsrs.js:150`：`nextInterval(S, 0.9) = 9 * S * (1/0.9 - 1) ≈ S` 天 → 间隔 **1.1 ~ 3.4 天**。

于是 `dueAt = 复习时刻 + 1.1~3.4天`，而预筛上界是 `轮询时刻 + 1天`，**必然落在外面**。
注意 `isQuickDue()`（`quickCheck.js:38`，真正的窗口判定）对这些卡返回的是 **true** ——
即"该弹"，但预筛这一关先把它筛掉了。

复现输出（`E:/tmp/audit7b-out.txt`，FSRS 分支，fuzz 会带来 ±抖动但结论稳定）：

```
FSRS S=1   level=1 interval=1.14d | isQuickDue=true | 预筛通过=false  <<< 该弹但捞不到
FSRS S=1.5 level=1 interval=1.21d | isQuickDue=true | 预筛通过=false  <<< 该弹但捞不到
FSRS S=2   level=1 interval=2.40d | isQuickDue=true | 预筛通过=false  <<< 该弹但捞不到
FSRS S=2.9 level=1 interval=3.28d | isQuickDue=true | 预筛通过=false  <<< 该弹但捞不到

SM-2 起始level=0 -> level=0 interval=1.000d | 预筛通过=true
SM-2 起始level=1 -> level=0 interval=1.000d | 预筛通过=true
```

影响面：FSRS 由 `App.vue:608` 的开关主动开启（默认 `sm2`，见 `App.vue:278`）。
开了 FSRS 的用户，快速校验对 level=1 的卡**永久不弹**，且无报错、无日志——纯静默失效。

### C（一般）门禁覆盖面不足 —— 这是 A 能长期存活的结构性原因

**【已核实】**

`tests/round57-perf.test.mjs:197` 已经有一条正确的契约：
「repo 的 cards/reviews 写路径必须显式失效快照（或属 key 已覆盖的增删类）」。
但它的扫描范围写死为单个文件：

```js
const src = readFileSync(new URL('../src/repo.js', import.meta.url), 'utf8');  // :200
```

`.vue` 组件与 `utils/` 里的写路径**完全不在雷达内**。同在闸外的还有
`classify-lib.js:137`（`db.cards.update`）、`utils/quickCheck.js:103/111/139/147`
（这两处因为 bump 了 `updatedAt` 而侥幸安全）。

这正是「每轮修完还有问题」的一个可解释来源：**防护网只守住了 1/3 的写入面，
门禁却显示绿**。建议把闸门扩到 `src/**/*.{js,vue}`（或至少扫全仓 `db.cards.`/`db.reviews.`
写入点），并把「改字段但不 bump updatedAt」显式列为违规形态。

### D（一般）`sync.js:1004` 删批注不写墓碑，与 `repo.js:655` 口径不一致

**【已核实】**

- `repo.js:655-657`：删卡时先 `bulkPut` 墓碑（`kind:'cardAnnot'`），再 `:663` 物理删行；
- `sync.js:1004`（收到对端卡片墓碑时的级联）：**只** `db.cardAnnots.where('cardId').anyOf(removed).delete()`，**不写墓碑**。

两条删卡路径口径不一致。当前不炸，是因为 `sweepOrphanRows`（`repo.js:765`）会兜底，
但它是 fire-and-forget、失败仅 `warn`（`sync.js:1214` 处的调用注释自述）。
建议与 `repo.js:655` 对齐：删行前补写墓碑。

### E（建议）`db.js:363` schema 注释自相矛盾且已过时

**【已核实】** 同一段注释里：

- 第 359 行：「删除与项目其余表同口径：**物理删行 + 写墓碑（kind='cardAnnot'）**」✅ 与代码一致
- 第 363 行：「**不参与图片引用扫描，不写 tombstones**」❌ 两半都错：
  - `images.js:11` 的 `IMAGE_REF_TABLES` 已含 `'cardAnnots'`（round119 B 修复补的）；
  - `annot-repo.js:153` 明确写墓碑。

这是典型的「修复改了行为、没同步注释」，下一轮维护者照注释改就会把 B 修复退掉。

### F（建议）`annot.level` 是死字段

**【已核实】** `annot-repo.js:94/104/115` 写入 `level`，全仓检索无任何读取方
（`reviewCount` 有读，见 `CardAnnotation.vue:43`）。`db.js:357` 还为它写了设计说明。
属于「写了没人用的建模负担 + 会误导后来者」，建议删除或明确标注为预留。

### G（建议）墓碑表主键建模隐患

**【推断】** `db.js:28`：`tombstones: 'id, deletedAt'` —— 主键是单列 `id`，
但语义上靠 `kind` 区分（`'card'` / `'cardAnnot'` / `'review'` …）。
`db.tombstones.put({id, kind})` 是整行覆盖，`restoreFromTrash` 里的
`db.tombstones.bulkDelete(annots.map(a => a.id))`（`repo.js:480`）也**不按 kind 过滤**。
若两个不同 kind 的墓碑 id 相同（`uid()` 碰撞），会互相覆盖 / 误删。
概率极低，属建模层面隐患，非活跃 bug。

---

## 三、本轮核实「没问题」的部分（避免过度报警）

| 项 | 结论 |
|---|---|
| `sync.js:333 / 966` 导入合并路径 | **确实**调用了 `invalidateDashboardCache()`，**不是**漏网点 【已核实】 |
| `repo.js` 内 7 处失效点 + `createCard/deleteCard/restoreFromTrash` | 全部合规（后三者改行数 → 键天然换）【已核实】 |
| `quickCheck` 窗口逻辑自洽性 | `review()` 会重置 `quickAnchorAt = nowTs`（`repo.js:1118`），不会因「跳过」写下的旧锚点永久压制后续轮次；`skipDecision` 的 defer→abandon 二段上限成立 【已核实】 |
| `recordQuickCheck` 单事务改造 | 无回归；`failCountMap` 经 `realReviews` 过滤，quick 答错不会误标红 【已核实】 |
| 缓存键依赖的索引 | `cards.updatedAt`、`reviews.reviewedAt` **都有索引**（`db.js:25/26`），键能算出，不会退化成每次重建 【已核实】 |

---

## 五、修复记录（用户「接着修」后落地）

### A 的修法：写路径收口到 repo，而不是在 .vue 里补一行失效

新增 `repo.rescheduleCardToNow(cardId)`（`repo.js`，位置在 `setMarked` 之后）：

- 差量写：只 `db.cards.update(cardId, { dueAt: t, reviewedAt: t })`，**不 bump updatedAt**（保留原有
  跨设备合并语义），**不回写整行**（顺带消除 Cards.vue 原先 `get 整行 → put 整对象` 的覆盖风险）；
- 写后立即 `invalidateDashboardCache()`；
- `WrongBook.vue:141`、`Cards.vue:731/741` 改为调用它，并删除 WrongBook 里已不再使用的 `db` 导入。

为什么不在 .vue 里各补一行 `invalidateDashboardCache()`：那样只是把洞补上，写路径仍散在视图层，
下一次新增入口还会再漏。收口后写路径回到 repo，**自动落进门禁视野**（见 C）。

### B 的修法：去掉预筛，改走共享快照

`getQuickCheckDue()` 不再用 `db.cards.where('dueAt').belowOrEqual(now + 1天)`，改为
`const { cards } = await dashboardSnapshot()` 后 `cards.filter(isQuickDue)`。

- 语义上不再依赖任何「排期字段 ↔ 短期窗口」的假设；
- 性能上**零额外全表读**——复习页/首页已物化过同一份快照，比原索引查询更省；
- 遵守共享数组的只读契约：`filter` 产新数组后再 `sort`，不污染其他消费者。
- 顺带给 `skipQuickCheck` / `recordQuickCheck` 补了显式失效：它们只 bump `updatedAt`
  （行数不变），**同一毫秒内连续跳过两张卡时「最大 updatedAt」撞成同值 → key 不变 → 陈旧**。

### C 的修法：门禁扩到全仓

`tests/round57-perf.test.mjs` 契约⑥ 的扫描范围从 `src/repo.js` 单文件改为
`src/**/*.{js,vue}` 全仓，并新增对 `const name = async () => {}` 形态的函数识别。
扩面后**当场抓出 1 处此前完全在雷达外的违规**：`classify-lib.js → classifyAllCards`
（批量改 subject，同一毫秒内多次写会把「最大 updatedAt」撞成同值），已补显式失效。

白名单保留 5 项（均为「行数必然变化 → key 天然换」）：
`createCard` / `deleteCard` / `restoreFromTrash` / `seedTestDatabase` / `refreshDemoSchedule`。

### 回归测试 + 负向对照（证明测试不是摆设）

新增 6 个测试：
- `tests/dashboard-invalidate.test.mjs`（4 个）：拉进今日复习后 `getStats().dueToday` 必须立刻 +1；
  共享快照必须立即反映新 dueAt；卡不存在返回 null；**结构闸门**：两个 .vue 不得再直接写 `db.cards`。
- `tests/quick-check-record.test.mjs`（+2 个）：FSRS level=1（间隔 2.4 天）的卡必须能被
  `getQuickCheckDue()` 捞到；**结构闸门**：`quickCheck.js` 里不得再出现 `where('dueAt')`。

**负向对照已做**：把两处修复临时退回后重跑，上述 4 个断言**确实变红**（`not ok 1/2/8/9`），
恢复后重新全绿。所以这些测试不是在给已有代码背书。

> 踩坑记录：结构闸门第一次误报——我在注释里写了 `where('dueAt')` 这个字面量，被正则当成代码。
> 与契约⑤ 曾踩过的坑同款，已按同样办法在断言前剥注释。

### 门禁结果

- `eslint .` 通过；i18n `--strict` / `--js` 双闸通过（新增 0 行）；`dep-check` **0 循环依赖**；
  `sync-coverage-audit` 通过。
- 全量 `node --test`：**1566 测试 / 1565 通过 / 0 失败 / 1 todo**（基线 1560，净 +6 即新增用例）。

---

## 六、遗留事项

1. `39c7f07`（round120 修复）+ `6f1f5a0`（round121 性能修复）**本地已提交、尚未推送**，等你发话。
2. 搜索跳转 `goId`：provider 侧有断言（`search-service.test.mjs:135/155`），
   但**消费方 `Search.vue:68` 的 `item.goId ?? item.id` 仍是零测试保护**（round119 老问题，未修）。
3. 工作区有 3 个未跟踪文件（并行会话产物）：`docs/AUDIT-2026-10-01-round116/117-full-audit.md`、
   `tests/quick-check.test.mjs`。

---

## 五、给「为什么每轮修完还会出问题」的一条观察

本轮两个严重缺陷都不是"改错了代码"，而是：

- **A**：修法本身正确（不 bump updatedAt 是对的），但**漏掉了配套动作**；
- **B**：为了性能加的预筛，隐含假设只在一个分支（SM-2）下成立，换分支（FSRS）就静默失效；
- **C**：已有门禁，但**覆盖面只有 1/3**，于是「测试绿」给了一个虚假的安全感。

三者的共同形状是：**局部正确、边界未闭合**。建议在修 A/B 的同时把 C 的闸门范围扩开，
否则同类问题下一轮还会再从别的 `.vue` 里冒出来。
