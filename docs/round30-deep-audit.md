# SxyBrick 深度审计（round30）—— 底层隐患 / 算法 / 业务 / 数据协同 / 数据建模

> 审计时间：2026-09-06
> 范围：全量只读审查（4 路并行 Explore + 主代理交叉核验 6 处高影响结论）
> 基线：`main` @ `35be2f2`（round29 字段级合并已落地）
> 方法：**每条结论均读源码核实并附 `file:line`**；区分「真实缺陷 / 设计权衡 / 误报」。

---

## 0. 总览

| 维度 | P0 | P1 | P2 | P3 | 误报澄清 |
|---|---|---|---|---|---|
| 数据协同 / 合并 / 同步 | 0 | 2 | 2 | 1 | 2 |
| 算法（图谱 / FSRS / 分析） | 0 | 1 | 2 | 2 | 4 |
| 数据对象建模 / IndexedDB / schema | 0 | 1 | 0 | 1 | 1 |
| 业务逻辑 / 异常 / 性能 | 0 | 1 | 3 | 1 | 2 |
| **合计** | **0** | **5** | **7** | **5** | **9** |

**好消息**：round29 修复的卡片侧字段级合并 P0 已闭环；历史坑（cosine 维度、forecast 洪峰、networth 假满分、graphAuto 边 id 漂移、parseToolCall 回灌、fuseResults Map、word 题干泄漏、plugins 环、tombstone 跨设备恢复）经复核**均确已修好**，本次不计为新缺陷。

**坏消息**：round29 的「字段级合并」铁律**未下沉到英语词卡模块**——多设备并发改不同字段时，英语模块的修改会静默丢失（与 round29 P0 同类，仅范围限于 `wordCards`）。这是本轮最该先修的一项。

---

## 1. P1 缺陷（高优先级，数据正确性 / 逻辑正确性）

### P1-1 ｜ 英语词卡 `wordCards` 字段级合并完全失效（round29 未下沉）
- **位置**：`src/word-repo.js:154-179`（`createWordCard`）、`src/word-repo.js:181-203`（`updateWordCard`）；合并侧 `src/sync-manifest.js:126,230,236`
- **缺陷**：`createWordCard` 不生成 `fieldTs`；`updateWordCard` 只 `next.updatedAt = now()`，对真正改动的字段不打 `fieldTs[f]`。合并侧 `mergeCardPair` 的字段集 `mergeFields = new Set([...CARD_CONTENT_FIELDS, ...fieldTs键])`（`sync-manifest.js:230`），而 `CARD_CONTENT_FIELDS`（`:162`）只有 `front/back/subject/source/...`，**不含** `word/meaning/note/example/phonetic/tags/source`。于是 wordCards 的主编辑字段既不在内容组、又无 fieldTs → 全部走 `it===null && lt===null → continue`（`sync-manifest.js:236`），**退化为整行 LWW**。
- **后果**：手机改「释义 meaning」、平板同时改「例句 example」→ 同步后只保留一端。round29 字段级合并对英语模块是**死代码**。
- **根因**：round29 只改了 `cards` 写入侧（`repo.js:198,229-233`），漏下沉到 `word-repo.js`。`word-repo.js` 内部 `setFamiliar`（`word-repo.js:259` 一带）已正确打 `fieldTs.familiar`，证明作者知道规范却没覆盖全文。
- **改进**：`createWordCard` 初始化 `fieldTs`（所有内容字段 = `createdAt`）；`updateWordCard` 对 `['word','phonetic','meaning','example','exampleTrans','note','source','subject','tags']` 逐字段 diff 打 `fieldTs[f]`，与 `repo.js:229-233` 同款。补回归测试（`tests/card-merge-fieldts.test.mjs` 已覆盖 cards，需加 wordCards 镜像用例）。

### P1-2 ｜ `setMarked` 与 `classify-lib` 归类写 `subject` 漏打 `fieldTs`（违反 round29 铁律）
- **位置**：`src/repo.js:683`（`setMarked`：`{ marked: !!marked, updatedAt: now() }`）；`src/classify-lib.js:126`（`db.cards.update(c.id, { subject: label })`，连 `updatedAt` 都不 bump）
- **缺陷**：`marked`/`subject` 都在 `CARD_CONTENT_FIELDS`（`:162`）里，但写入点不打 `fieldTs[marked]`/`fieldTs[subject]`。合并时这些字段走「双端都无 fieldTs → 沿用整行 content 赢家」分支（`sync-manifest.js:236`+`out={...content}`）。
  - `setMarked`：A 设备标星（updatedAt=T1）→ B 设备后改 front（updatedAt=T2>T1）→ content 赢家=B（未标星）→ **星标被丢**。
  - `classify-lib`：更糟——归类连 `updatedAt` 都不 bump，任何后续其它字段编辑（更新时间更大）都会让 content 赢家取走「旧 subject」，**自动归类结果跨设备被覆盖**。
- **根因**：这两个写入点把「标星 / 自动归类」当成管理动作，未纳入 round29 字段级时间戳纪律。
- **改进**：`setMarked` 改 `db.cards.update(id, { marked, updatedAt: t, fieldTs: { ...(cur.fieldTs||{}), marked: t } })`（事务内重读 `cur`，参照 `repo.js:399-401` linkedNoteIds 写法）；`classify-lib.js:126` 改 `db.cards.update(c.id, { subject: label, updatedAt: t, fieldTs: { ...(c.fieldTs||{}), subject: t } })`。

### P1-3 ｜ `resolveGraph` 产出的边丢失 `directed`，导图把无向「相关」当「前置」
- **位置**：`src/algorithms/graph-resolve.js:127-143`（edge 对象无 `directed` 字段）；消费者 `edgesToForest`（`graph-resolve.js:215`，`Mindmap.vue:326`）
- **缺陷**：`graphAuto.add`（`graphAuto.js:130`）区分 `prereq`（有向，A 是 B 的前置）与 `related`（无向）。但 `resolveGraph` 拼 edge 时只写 `type/label/labelKind/fromCardId/toCardId`，**不携带 `directed`**。下游 `edgesToForest` 遇 `.directed` 全空 → 一律按 `from→to` 建树。结果：无向「related」边也被画成「A 必须先于 B」的层级链。
- **后果**：思维导图 / 智能出题的「先补前置」逻辑会被无向关系污染——把本应平级的关联卡排成前置依赖，干扰复习路径规划。
- **根因**：`directed` 只在 `graphAuto.js` 内部 set，从未透传给统一入口 `resolveGraph`。
- **改进**：`resolveGraph` 的 edge 增加 `directed: !!e.directed`（默认 false）；`edgesToForest` 对 `!directed` 的边跳过或双向建（避免伪层级）。

### P1-4 ｜ 番茄钟 `pomoSessions.roundId` 非唯一 → 双标签页可重复入账
- **位置**：`src/repo.js:1558-1573`（`addPomoSession` 主键 `id: uid()`，`s.roundId` 仅作普通字段）；schema `db.js:293`（`pomoSessions: 'id, startedAt, roundId'`，`roundId` 是**非唯一**索引）
- **缺陷**：注释 `repo.js:1568` 声称「即便 localStorage 被清，同 roundId 拒绝二次入账」，但 `roundId` 无唯一约束，`put` 不会去重。幂等完全依赖 `pomoDedup.js` 的 localStorage 去重，而该去重是「load→filter→push→persist」**非原子读改写**（`pomoDedup.js:47-52`）。两个标签页各自读到 `isRoundRecorded=false` → 都 `markRoundRecorded` + `addPomoSession` → 各插一行 → **番茄数 / 成就虚高**。
- **根因**：注释承诺了 DB 层兜底，实现却只做了弱客户端去重。
- **改进**：以 `roundId` 作主键（或建唯一索引 `&roundId` 并 `put({roundId, ...})`），让 DB 真正兜底；`markRoundRecorded` 的标记应在入库成功后再做（当前先标记后写库，写库失败会丢该轮）。

---

## 2. P2 缺陷（中优先级）

### P2-1 ｜ `trainWeights` 依赖调用方已排序，自身无时间排序守卫
- **位置**：`src/fsrs.js:224-253`（`cardTrajectories` 按 `reviews` 插入序分组，`lossOf` 直接按序推进）；调用方 `src/agent/analytics.js:186`、`src/agent/analytics.worker.js:26`（均不排序）
- **缺陷**：docstring 写「`@param reviews ... 按时间升序`」，但无任何代码保证。若传入未按 `(cardId, reviewedAt)` 升序，某卡一次复习先于前一次处理 → `elapsed=Math.max(0,负)=0` → 用错误 S 推进 → loss 失真、**个性化权重静默失效**（用户只觉得「算法没变聪明」）。对比 `quickCheck.js:31` 在别处正确 `due.sort((a,b)=>a.reviewedAt-b.reviewedAt)`，说明项目知道要排序，此处是遗漏。
- **改进**：在构建 `cardTrajectories` 前对 `arr` 做 `arr.sort((a,b)=>a.reviewedAt-b.reviewedAt)`；或显式 `assert` 升序。

### P2-2 ｜ `local-analyzer.js` 标签/科目 ×3 强信号加权是死代码
- **位置**：`src/analysis/local-analyzer.js:14-20`（`cardProfile` 把 tags/subject 词频 ×3）；`:25-31`（`jaccard` 仅用 `b.has(w)` 集合成员判定，完全忽略频率）
- **缺陷**：`jaccard` 不读频率值，×3 膨胀的 `freq` 在相似度计算里零作用。两张共享标签的卡**并未**比共享一个普通内容词的卡相似度更高；`relationGraph`/`topoSort`/`learningPath`/`criticalPath` 的「强信号」名不副实。
- **改进**：实现真正的加权 Jaccard（`min(f_a,f_b)` 求和 / 并集频率求和），或如实删除 ×3 并改注释，避免误导图谱/拓扑结果。

### P2-3 ｜ 导入合并无时钟偏移补偿（快时钟对端静默覆盖本地更晚编辑）
- **位置**：`src/sync-manifest.js:199-215,388-415`（`mergeCardPair`/`mergeRows` 直接用裸时间戳比较）
- **缺陷**：LWW 固有局限。若对端设备时钟比本机快（哪怕 <5min 也在 `SYNC_STATUS_SKEW_MS=5min` 容忍外对**合并**生效），其导出的旧包会因 `updatedAt` 数值更大覆盖本机「物理上更晚」的本地编辑 → 静默丢改。`SYNC_STATUS_SKEW_MS` 仅用于状态面板显示（正确），不进合并。
- **改进**：导入时对本机行做时钟偏移估计（取 Hub 返回时间与本机 now 差）补偿；或对同 id 冲突给出 `conflicts` 提示（cards 已有 `collectCardConflict`，`updatedAt` 表无）。

### P2-4 ｜ `telemetry` 关页瞬间异步 flush 不等待 → 末批埋点静默丢失
- **位置**：`src/utils/telemetry.js:255`（`beforeunload` 同步调用 `async _flush(true)`，未 await 且 `beforeunload` 本无法等微任务）
- **缺陷**：最后一批 `userOps` 可能不落盘。
- **改进**：用 `navigator.sendBeacon`，或缩短 `FLUSH_INTERVAL` 让主路径定时落盘，降低丢失量。

### P2-5 ｜ `proactive.pushNotification` 每次全表 `toArray()` 截取
- **位置**：`src/agent/proactive.js:52`（`db.notifications?.orderBy('createdAt').reverse().toArray()`）
- **缺陷**：通知量大时每次推送都拉全表；同文件 `:68` 的 `unreadCount` 已正确用 `.where('read').equals(0).count()`，此处不一致。
- **改进**：用 `where('createdAt').below(...)` 或 `count()` 超限再清理。

### P2-6 ｜ `wordCards` 无跨设备去重（仅 `cards` 有），幽灵词卡链接
- **位置**：`src/sync-dedup.js:14-43`（`dedupeIncomingCards` 仅对 `cards`）
- **缺陷**：两设备各自建的相同词卡会有不同 id；`cardWordLinks`（id=`${cardId}:${wordCardId}`）按 wordCardId 引用时无法统一 → 跨设备残留指向「幽灵词卡」的悬空链接或重复词卡。当前未崩（id 重算仅 remap cardId），属潜在数据冗余。
- **改进**：对 `wordCards` 加同款去重 + remap（需把 wordCardId 纳入重映射）。

### P2-7 ｜ 每日规划 `estimatedMinutes` 未 clamp → 时间轴超界 24h 栅格
- **位置**：`src/plan-parser.js:121/129`（`scheduledHour` 已 clamp 0–23，但 `estimatedMinutes` 未 clamp）；`src/views/DailyPlanView.vue:639`（`:style="{top,height}"`）
- **缺陷**：LLM 返回超大 `estimatedMinutes`（如 600）时 `start+est` 超出 24:00 → 视觉超界。
- **改进**：渲染层对结束时刻 `min(start+est, 24:00)` 截断。

### P2-8 ｜ 错题同现只认 `rating===0`，漏掉 `rating===1`（模糊答对）
- **位置**：`src/algorithms/graphAuto.js:184-185`（`if (r.rating !== 0) continue;`）
- **缺陷**：「经常模糊答对」的卡同样是薄弱点，被排除在 coMistake 薄弱簇外。
- **改进**：`r.rating <= 1` 计入 coMistake（权重可略低）。

---

## 3. P3 / 设计权衡（低优先级，建议后续迭代）

| 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|
| P3 | `src/sync.js:607` | DataCloneError 防护仅单点（importBackup 入口 JSON-clone）；未来新增「不经 importBackup 直调 mergeRows 并传 reactive」的调用方仍会触发 | 在 `mergeRows` 出口统一深拷兜底 |
| P3 | `src/sync-manifest.js:137` | `strip`（敏感字段剔除）仅在表条目内声明，B1 三查未强制「敏感字段→strip」登记；未来新增含凭证表易漏 | strip 登记纳入 B1 checklist |
| P3 | `src/analysis/local-analyzer.js:92-121,148` | `topoSort`/`criticalPath` 命名误导（实为相似度降序 / 度中心性 topK），无环检测 / 关键路径松弛 | 重命名 `rankByBaseness` / `topDegree` |
| P3 | `src/analysis/local-analyzer.js:148,133` | `relationGraph`/`learningPath` 缺 `matrix` 与 `cards` 同源守卫（已有 `topoSort`/`criticalPath` 守卫），matrix 不同源时 TypeError | 补齐一致护栏 |
| P3 | `src/utils/notify.js:18` + `Pomodoro.vue:162` | 番茄完成系统通知默认静音（从未主动 `requestPermission`），「提醒弹窗」默认不可见 | 首次完成番茄时提示授权 |
| 信息 | schema 实测 v32 | brief 旧口径「46 表」已变为 **47 表**（新增 `imageRefs` 本地派生表，已正确排除同步）；覆盖一致无遗漏 | 更新项目笔记口径 |

---

## 4. 误报澄清（复核后确认已修好 / 不成立，避免重复劳动）

1. **tombstone 跨设备恢复不可行** — 不成立。`restoreFromTrash`（`repo.js:331`）把行 `updatedAt:Date.now()` 重写，其活跃时间 > 墓碑 `deletedAt`，下次同步 `applyTombstones` 判 stale 清墓碑，跨设备复活生效。
2. **cosine 维度校验缺失** — 已修（`embedding.js:147-153` 维度不等直接 `return 0`）。
3. **forecast rating=0 洪峰 / 死循环** — 已修（`forecast.js` 三重护栏，模拟正常铺满 30 天）。
4. **networth 零复习假满分 / NaN** — 已修（`isReviewed` 双路径、`cardNetValue` 未复习=0、分母守卫）。
5. **graphAuto 边 id 漂移** — 已修（`id:auto-${[aId,bId].sort().join('-')}` 方向无关）。
6. **plugins registry 静态环** — 已修（`getCtxModules` 动态 import 避开 `registry→analytics→repo→registry`）。
7. **word 题干 q-word 泄漏答案词** — 已修（`WordReview.vue:448` 列表已剔除 cloze/sentenceCloze，测试 `word-review-leak.test.mjs` 覆盖）。
8. **DataCloneError 经 mergeRows 进 bulkPut** — 当前 `sync.js:607` 单点 JSON-clone 已闭环，未现新触发点。
9. **索引误用触发全表扫描** — 逐条核对 `.where()` 与 `db.js` 声明，全部命中索引（含 v28 graphEdges、v29 embeddings 修复），无遗漏。

---

## 5. 交叉分析矩阵（按用户要求的多视角）

| 用户关注视角 | 发现 | 对应问题 |
|---|---|---|
| **算法设计** | FSRS 训练乱序输入静默失真；图谱无向边被当前置；相似度加权死代码 | P2-1 / P1-3 / P2-2 |
| **业务逻辑** | 番茄幂等仅客户端；规划超界；归类/标星非字段级 | P1-4 / P2-7 / P1-2 |
| **数据协同** | wordCards 合并退化为 LWW；导入时钟无补偿；wordCards 去重缺失 | P1-1 / P2-3 / P2-6 |
| **数据对象建模** | fieldTs 纪律未下沉英语模块；Proxy 防护单点 | P1-1 / P3 |
| **边界条件** | roundId 非唯一、estimatedMinutes 未 clamp、LIVENESS 已补（正面） | P1-4 / P2-7 |
| **异常处理** | beforeunload 异步丢失、telemetry/push 失败分支 | P2-4 / P2-5 |
| **性能表现** | pushNotification 全表扫描、jaccard O(n²) 截断已做（正面） | P2-5 |

---

## 6. 最该优先修的 5 件事（建议修复顺序）

1. **P1-1 wordCards 字段级合并**（数据正确性，与 round29 P0 同类）—— 命中「多设备并发改不同字段丢修改」的核心风险，且当前完全失效。
2. **P1-2 setMarked / classify-lib 补 fieldTs**（2 行级修复，立竿见影防标星/归类跨设备丢失）。
3. **P1-4 pomoSessions roundId 唯一约束**（防成就/番茄数虚高，双标签页竞态）。
4. **P1-3 resolveGraph 透传 directed**（修正导图/智能出题的伪前置层级）。
5. **P2-1 trainWeights 内部排序**（防个性化权重静默失真，无报错难察觉）。

> 注：P1-1 / P1-2 属于同一根因（fieldTs 写入纪律未全面贯彻），建议合并为一个 commit 一次性补齐 `word-repo.js` + `repo.js:683` + `classify-lib.js:126`，并补 `wordCards` 字段级合并回归测试。

---

## 7. 修复状态（round30-fix，2026-09-08）

全部 P1/P2/P3 项已在本轮修复并回归（P0=0；P3-5 番茄通知默认静音为**有意保留**——
用户显式偏好「提醒默认静音、声音需显式开启」，与审计「首次完成提示授权」冲突，不改）。

| 编号 | 修复内容 | 位置 |
|---|---|---|
| P1-1 | wordCards 字段级合并：createWordCard 全字段 fieldTs 初始化；updateWordCard/setWordNote 逐字段 bump | src/word-repo.js |
| P1-2 | setMarked / classifyAllCards 补 fieldTs（事务内重读 cur 合并 fieldTs，防并发内容编辑被旧快照覆盖） | src/repo.js / src/classify-lib.js |
| P1-3 | resolveGraph 透传 `directed`（`e.directed !== false` 即视为有向——老边缺省不回归）；edgesToForest 仅显式 `directed===false` 跳过层级；**graphAuto 落库补写 directed**（prereq=true / related=false，此前只存内存不落库，根因在此） | src/algorithms/graph-resolve.js / graphAuto.js |
| P1-4 | pomoSessions roundId 作主键（提供时）→ DB 层真正幂等，双标签页各插一行根治 | src/repo.js |
| P2-1 | trainWeights 按 reviewedAt 升序内部排序后再构轨迹 | src/fsrs.js |
| P2-2 | jaccard 改加权实现（min/max 按词频，标签/科目 ×3 强信号真正生效） | src/analysis/local-analyzer.js |
| P2-3 | 跨设备时钟偏移补偿：客户端用中枢 HTTP `Date` 头、中枢用 `x-client-time` 请求头估算 skew，mergeRows/mergeTombstones 入口把 incoming 时间戳换算到本机帧（含 fieldTs/dueAt 等 12 个时间字段）；文件导入无时间源→skew=0，靠 stats.conflicts 可视化提示 | src/sync-manifest.js / src/sync.js / sync-hub/hub.js |
| P2-4 | telemetry 补 pagehide + visibilitychange(hidden) 兜底 flush | src/utils/telemetry.js |
| P2-5 | pushNotification 修剪改 `orderBy().reverse().offset().primaryKeys()`（O(大表) 全表扫描 → O(需删数)） | src/agent/proactive.js |
| P2-6 | wordCards 跨设备内容去重（word+meaning+subject 键）+ `WORD_CARD_REF_FIELDS` 注册 + wordReviews/cardWordLinks 引用重定向（复合键 id 重算） | src/sync-dedup.js / src/sync.js |
| P2-7 | estimatedMinutes 解析/存储双 clamp（0~1440，parser + addDailyTask/updateDailyTask 兜底）；渲染高度本就有 maxBottom 截断，「跨午夜」标签为既有意图特性保留 | src/utils/plan-parser.js / src/repo.js |
| P2-8 | coMistake 薄弱判定 rating<=1（模糊答对也算薄弱信号，原仅 rating===0） | src/algorithms/graphAuto.js |
| P3-1 | mergeRows/mergeTombstones 入口 JSON 深拷兜底（未来直调传 reactive 也不 DataCloneError） | src/sync-manifest.js |
| P3-2 | B1 checklist 增 [6]「敏感字段→strip 登记」 | src/sync-manifest.js |
| P3-3/4 | 函数重命名 rankByBaseness/topDegreeBridges + matrix 同源护栏 | src/analysis/local-analyzer.js |

验证：i18n 双闸 ✓（--js 基线重锚 407 行）· dep-check 0 环 ✓ · **node --test 961/961** ✓ · vite build ✓ · sync-coverage-audit ✓。
