# 全面审计报告 · 2026-09-16 · 底层代码 / 算法 / 业务逻辑（round93）

- **审计范围**：看不见的地方——数据/同步层、算法层、业务逻辑层（非 UI 样式）
- **审计方法**：三路并行深读源码 + 主审逐条**实证核验**（读源码 / 跑脚本 / 查调用点），非口头确认
- **基线 HEAD**：`bcc847b`（round92），工作区无未提交改动
- **结论**：发现 **1 项 P2**（可实证、影响检索正确性）+ **6 项 P3**（边界/一致性/体验）。**无 P1**。经典陷阱（FSRS 调度、融合权重、墓碑复活、打卡幂等、掌握度过滤）经复核**均已正确**。

---

## 一、P2 · 严重（建议尽快修）

### P2-1　编辑卡片后 embedding 索引不更新 + 增量重建实质失效（双因叠加）

> **✅ 已修复（round93 修复轮，commit 见下）**：`getStaleCards` / `getStaleDocs` 改为按 `updatedAt` 降序扫描
> （`src/agent/retrieval.js`），最近编辑的卡片/文档优先进增量重建窗口；新增回归测试
> `tests/round93-reindex-order.test.mjs`（3 条，含「编辑过的卡必进窗口且排最前」）。
> 说明：写入侧不直接挂钩 `indexCard`——`createCard` 在 Anki 导入等路径是**批量循环**，逐卡触发会给
> embedding API 造成洪峰且易让测试抖动；根因是扫描截断，修扫描口径即可，且 `buildRAGContext` 每次
> AI 检索前都会 `ensureIndex`，故下一次交互即拿到新向量。

**位置**：
- `src/repo.js` `createCard` / `updateCard` / `createDoc` / `updateDoc` —— **均无 reindex 调用**（脚本实证：4 个函数体内 `indexCard|ensureIndex|reindex` 命中数 = 0）。
- `src/agent/retrieval.js:121` `getStaleCards`：`db.cards.limit(limit * 2)` —— **无 `orderBy`、无 offset**。
- `src/agent/retrieval.js:59` `indexCard` —— 仅被 `repo.js:559`（回收站恢复）与 `ensureIndex` 调用。

**缺陷**：两个独立缺陷叠加，导致「卡片内容更新后，语义检索长期返回旧向量」：

1. **写入侧不重建**：`createCard`/`updateCard` 写完卡片后不调 `indexCard`。用户改了一张卡的正面/背面，`db.embeddings` 里仍是旧内容的向量。而 Agent 的 `semantic_search` / `hybrid_search` 工具直接 import 检索函数、**自身不触发 reindex**，因此会持续返回与卡面不符的旧文本。
2. **增量重建路径在规模下失效**：唯一能后台补索引的是 `ensureIndex(20,3)`（`context.js:108`，仅 RAG 会话触发）。它经 `getStaleCards(20)` → `db.cards.limit(40)`。Dexie 的 `.limit()` 在**无 `orderBy`** 时按**主键顺序**取前 N；而卡片主键是 `uid()` = `crypto.randomUUID()`（`db.js:429`）——**纯随机十六进制**，与创建/更新时间无关。于是每次只扫描「uuid 排序最靠前的 40 张」这个**固定集合**。一旦这 40 张索引齐全，**其余卡片（uuid 靠后的绝大多数）永远不会被增量 reindex 命中**，即使它们被编辑过。

**用户可见影响**：库中任意非平凡规模（>40 张）下，编辑过的卡片用语义/关键词检索会命中**旧内容**；新卡（未进前 40）语义检索**完全搜不到**。只有手动全量 `rebuildIndex`（`read 前 19998`）才覆盖，且下次编辑又回到陈旧态。用户的直观感受是「AI 说找不到我明明改过的卡 / 搜出来的内容是旧的」。

**验证方式（可复现）**：
```
建 100 张卡（uuid 随机）→ 编辑第 60 张卡正面 →
调 hybridSearch(新正面关键词) → 命中的 text 仍是旧正面
调 getStaleCards(20) → 不包含第 60 张（不在 uuid 前 40）
```

**修复建议（分两步，均零风险）**：
1. **写入侧**：`updateCard` / `updateDoc` 在事务提交后 fire-and-forget 调 `indexCard(card)`（与 `repo.js:559` 回收集成同型；注意放在事务**外**，避免异步跨事务）。
2. **增量侧**：`getStaleCards` 增加 `orderBy('updatedAt').reverse()`（先扫最近更新的）或引入 offset 游标，确保全库可达；`getStaleDocs` 同理。
3. 补回归测试：编辑后 `hybridSearch` 命中新内容；>40 张库中「uuid 靠后」的卡也能被判 stale。

---

## 二、P3 · 轻微（边界 / 一致性 / 体验，可按需批量修）

| # | 位置 | 缺陷 | 影响 | 实证 |
|---|---|---|---|---|
| P3-1 | `src/repo-core.js:186` | `rankWeakCards` 排序键 `(b.failCount - a.failCount) \|\| (b.updatedAt - a.updatedAt)`：某卡 `updatedAt` 缺失时后者得 `NaN`，`Array.sort` 收到 `NaN` 返回值 → 排序未定义 | 薄弱卡顺序在多次运行/跨设备间**不一致**（`marked` 卡 failCount 恒 0，最易触发） | 已读源码确认；`||` 短路后 NaN 参与比较 |
| P3-2 | `src/utils/planSynergy.js:93` vs `:120/:135/:142/:161/:180/:191` | `aggregateReviews` 用 `between(dayStart,dayEnd,true,false)`（左闭右开），其余 6 处聚合用 `(true,true)`（**含上界**） | 恰在本地**零点整**发生的事件被相邻两天**重复计数**；单日视图无碍，历史趋势/相邻日对比口径不自洽 | 已读源码确认 6 处 `(true,true)` |
| P3-3 | `src/views/KnowledgeGraph.vue:271` | 同心圆布局中心层：`if (li===0){ arr[0].x=cx; arr[0].y=cy; return; }` 只定位第一个节点，其余**不设 x/y** | 多个并列最高度的枢纽节点全部塌缩到 `(0,0)` 重叠、看不见（真实库中多枢纽很常见） | 已读源码确认 |
| P3-4 | `src/views/KnowledgeGraph.vue:211` | 树布局 `build(k, new Set(visited))` 每分支拷贝 visited，兄弟分支不共享 | 被两条路径共同指向的节点（DAG 共享子孙）在树视图**重复渲染多次**；`graph-resolve.js` 的 `edgesToForest` 已用全局 `placed` 修过同类问题 | 已读源码确认 |
| P3-5 | `src/plugins/examples/due-alert.js:62-72` | `onReviewRated` 每次评分都 `ctx.notify`，无节流/去重 | 连续评 30 张卡 → 连续弹 30 条相同通知（受授权门控，危害有限） | 已读源码确认 |
| P3-6 | `src/algorithms/calibration.js:129` vs `calibration-feedback.js:14` | Stats 页在 `n>=20` 就给「应上调/下调目标保持率」的 verdict，但反馈闭环 `calibrateFromStats` 实际要 `n>=50` 才生效 | 20–49 样本时显示一条**调度器不会执行**的处方（提示与行为不一致） | 已读源码确认门槛常量不同 |

---

## 三、复核为「正确」的高危区（避免误报，明确排除）

| 区域 | 结论 |
|---|---|
| FSRS / SM-2 调度（`fsrs.js` / `srs.js`） | 间隔单位、`MAX_STABILITY=365` 封顶、`clamp` 护栏、hard/easy 方向、`w[17]=0` 消噪确定性、NaN/Infinity 多重兜底——**均正确** |
| 融合权重（`retrieval-core.js:46 fuseResults`） | 默认 `semW+kwW=1`，`fused∈[0,1]`，两路均经 `>=minScore` 预过滤，负余弦不入融合——**无越界/NaN** |
| 图谱建边去重（`graphAuto.js:112` / `repo.js:2718 linkCards`） | 排序对键合并、prereq 方向升级保 label、双向查重、禁自环——**无重复边/幽灵节点** |
| 墓碑与复活（`sync-manifest.js:739 livenessTs` / `applyTombstones`） | 活跃时间戳覆盖全部时间语义字段，级联清主行——**删除传播与防复活正确** |
| 冲突解决（`sync-manifest.js mergeCardPair`） | 逐字段 `fieldTs` LWW、平局序列化字典序收敛、错因清除语义胜出——**正确且幂等** |
| 打卡幂等（`repo.js:1551 checkinDailyTask`） | 事务化、`completedAt` 随 `done` 才置、status 白名单——**不会双计/漏落库** |
| 统计聚合（`repo-core.js:286 computeStats`） | `real`/`rated` 两级过滤、`coverage` 用 `cardMap` 求交封顶 ≤100%、加权掌握度无除零——**正确** |
| 双源 localStorage（`sxy_card_search` vs `filters.q`） | 已统一为单一权威源 `filters.q`，`sxy_card_search` 仅 `removeItem`——**无残留** |
| `failCount` 读取路径 | `attachFailCounts` / `rankWeakCards` 统一注入——**历史缺口已闭环** |
| 维京号不一致（embedding 维度） | `modelSig` 变更触发全量重建，维度不符返 0 并告警——**正确** |

---

## 四、优先级建议

1. **P2-1（写入侧 + 增量侧）** —— 影响检索正确性，用户可感知，建议单独一轮修复并补回归测试。
2. **P3-1 / P3-2 / P3-3 / P3-4** —— 可一轮批量收口（都是小改 + 明确断言）。
3. **P3-5 / P3-6** —— 体验/一致性，可选。

## 五、本次未改动任何文件
本报告为只读审计结果。若需修复，建议按上面优先级另开提交。
