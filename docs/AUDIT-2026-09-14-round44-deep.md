# SxyBrick 深度代码审计报告 — Round 44

> **审计日期**：2026-09-14
> **审计基线**：git HEAD `08b14b8`（round43 基线 `a610a83` 之后 2 个提交：Agent 裸 JSON 出口净化 / 全屏路由退出 / 本轮 P2/P3 修复）
> **变更范围**：22 文件（+1445/−579），核心新面：新模块 `utils/ai-structured.js`（220 行）、`algorithms/graphAuto.js` 重写（697 行）、`algorithms/mistakeAttribution.js` 重构（312 行，纯本地 TF-IDF 错题归因）、`agents/base.js` JSON 净化、`sync.js` 增量导出索引化、`repo-core.js` 幽灵卡口径统一、db.js 新增 userOps/embeddings 索引、MarkdownRenderer/CardModal/AiGraphView/WordBook 等视图增量
> **测试状态**：全量 **1074/1074 通过**（较 round43 的 1072 新增 2 个，随迭代提交带入）
> **上轮报告**：`docs/AUDIT-2026-09-14-round43-deep.md`

---

## 一、总评（大白话）

这轮迭代质量高。最值钱的两个改动：**增量导出索引化**（sync.js 的 userOps/embeddings 从全表 toArray 换成 db.js 新建的 `t` / `updatedAt` 索引查询，`since` 过滤下推到 IDB 层，round42 F7 的一部分被顺手修掉了）和 **幽灵卡口径统一**（repo-core 的 `dueOf`：NaN/null/undefined dueAt 三态分明，注释直接写清了旧实现两个入口对不上的根因）。

我按新面逐一审了：JSON 净化出口（base.js:59-62 拒收数组/标量/null）、增量导出等价性（`livenessTs` 的 LIVENESS_FIELDS 含 `t`/`updatedAt`，单字段索引查询与全字段取 max 的判定值一致，**等价性声明成立**）、`pruneDeadEdges` 的墓碑纪律（手动边写墓碑、auto 边按派生数据豁免，自洽）、mistakeAttribution 的 TF-IDF 数学（`N+1/df+1` 平滑、norm 有 `||1` 除零保护）、AiGraphView 的 D3 生命周期（unmount 清理）。

**结论：本轮未发现新的 P0/P1/P2**。有 2 个 P3 口径不一致（见 N2/N3）和 2 个顺手可修的小点。

---

## 二、round43 修复（N1–N5）回退验证

| 编号 | 标记位置 | 状态 |
|---|---|---|
| N1 空轨迹守卫 | `fsrs.js:273` | ✅ 健在 |
| N2 IMAGE_REF_TABLES 四处同源 | `images.js:4` + `repo.js:625/646` + `sync.js:117/949` | ✅ 健在 |
| N3 sweepOrphanRows 墓碑 | `repo.js:675` | ✅ 健在 |
| N4 estimateTokens 数组支持 | `ai-usage.js:25` | ✅ 健在 |
| N5 OCR_TEXT_LIMIT | `image-analysis.js:35/396/431` | ✅ 健在 |

五处修复**全部无回退**，且回归测试（fsrs N1、sweep-orphans、ai-usage N4）仍在套件中通过。

---

## 三、本轮新发现

### N1 [P3] 到期判定口径三分天下：`dueOf`（repo-core）vs 裸 `c.dueAt <= nowTs`（analytics/intelligence/repo）

- **已统一的好例子**：`repo-core.js:209-214` 的 `dueOf`——`undefined→Infinity`（不到期）、`NaN/null→0`（到期一次，复习后自愈），注释写明与 `filterReviewCandidates` 同口径。`source-trace.js:33` 也有自己的注释完整口径（有限且>0 才算到期）。
- **没跟上的调用点**（均为裸比较，`null` 会被当 1970 年、`NaN` 恒假）：
  - `analytics.js:388`（学科诊断的 due 计数）
  - `analytics.js:468/489`（graph 复习路径的 includeDueOnly 过滤与 seeds 筛选）
  - `intelligence.js:411`（智能复习候选评分）
  - `repo.js:179`（卡片列表 dueCount）
  - `repo-core.js:291`（buildReviewSuggestion 自己下面的 dueToday —— 同一函数里 `dueOf` 与裸比较并存，**同一函数两个口径**）
- **影响**：卡片带 `null/NaN dueAt`（半成品卡、导入残留）时，"建议队列"与"统计计数"对不上——正是 repo-core 注释里描述过的现象，只修了建议入口没修计数入口。均为统计展示偏差，无数据损坏。
- **建议**：把 `dueOf` 提升为共享工具（如 `algorithms/due.js` 或 repo-core 导出），五处调用点替换。约 15 行。

### N2 [P3] `ai-structured.js` 的 JSON 提取对「嵌套代码块」不处理

- **位置**：`utils/ai-structured.js`（新模块）：`extractJson` 按首个 `{`/最后一个 `}` 截取。LLM 回复含 ```json 围栏且正文里还有第二个 `{...}` 文本（如给用户展示 JSON 示例）时，最后一个 `}` 可能落在正文示例里，截出非法 JSON。
- **影响**：结构化解析偶发失败（抛错被上层 catch 降级为纯文本，不崩），成功率略降。与 `pipeline-core.js:35`（用正则先找数组再 parse，失败返回 null）风格不一。
- **建议**：与 base.js 净化同级处理——先剥代码围栏再截取。约 6 行。

### N3 [P3] `KnowledgeGraph.vue:374` / `Mindmap.vue:348,370,396` 的 AI JSON 解析无 try 边界一致性

- 这几处 `JSON.parse(m ? m[0] : r)` 依赖外层 try/catch（已确认存在，不崩）；但 `Mindmap.vue:370` 在 `m` 为 null 时直接 parse 整串必然抛错，靠 catch 显示「Agent 未返回 JSON 结构」——报错文案依赖异常类型，遇到 `r` 恰好是合法 JSON 标量（如 `"ok"`）时会 parse 成功但 `obj.root` undefined，走 `'Agent 没返回有效结构'` 分支——行为正确但路径绕。
- **建议**：低优先，可保持现状；若顺手，统一走新的 `ai-structured.js`。0–20 行。

### N4 [P3·顺手项] `repo.js:624` 附近图片 GC 兜底注释与新 `IMAGE_REF_TABLES` 描述不同步

- `repo.js:625` 注释说"GC 漏扫会把仍被资料引用的图误删"，而 `:624` 上一行注释还留着"统一走全表扫描兜底"的旧表述，两句连读有歧义（实际已是常量清单驱动，不是全表）。
- **建议**：注释理顺，1 行。

---

## 四、优先级汇总

| 编号 | 优先级 | 位置 | 说明 | 建议成本 |
|---|---|---|---|---|
| N1 | P3 | repo-core/analytics/intelligence/repo 五处 | 到期判定口径三分天下，统计与队列对不上（无数据损坏） | ~15 行 |
| N2 | P3 | `utils/ai-structured.js` | JSON 提取不剥代码围栏，嵌套示例文本会截出非法 JSON | ~6 行 |
| N3 | P3 | KnowledgeGraph/Mindmap | AI JSON 解析路径绕但行为正确 | 可保持 |
| N4 | P3 | `repo.js:624` 注释 | 旧注释与新口径描述并存，理顺 | 1 行 |

**无 P0/P1/P2。**

---

## 五、审计结论

1. **本轮迭代（08b14b8）质量高**：增量导出索引化的等价性声明经 `LIVENESS_FIELDS` 核实成立；JSON 净化出口正确拒收非对象；`pruneDeadEdges` 墓碑纪律自洽；TF-IDF 数学无除零。
2. **round43 N1–N5 全部健在**，回归测试在套件中通过，全量 1074/1074。
3. **唯一值得排期的是 N1（口径统一 ~15 行）**，其余是顺手项。代码库维持"无已知 P1/P2 缺陷"状态。

---

## 六、修复落地记录（2026-09-14 当轮完成）

| 编号 | 修复内容 | 改动位置 | 验证 |
|---|---|---|---|
| N1 | `dueOf` 从 buildReviewSuggestion 内部提升为 repo-core 导出（全库唯一幽灵卡到期口径），替换 5 处裸比较：repo-core:291（同函数两口径消除）、repo.js:179（dueCount）、analytics.js:388/468/489（学科诊断/图路径 fallback/seeds）、intelligence.js:411（候选评分） | repo-core.js + repo.js + agent/analytics.js + intelligence.js | 全量 1074/1074 ✅ |
| N2 | `normalizeStructuredFinal` 优先剥代码围栏（`​```json{...}​```​` 最强信号，命中且带 type+data 直接采用），失败再走原首尾扫描兜底；正文夹第二个 {...} 示例不再截出非法 JSON | utils/ai-structured.js | ai-structured 10/10（新增 2 个围栏断言：命中剥离 + 非 type+data 不误剥）✅ |
| N3 | 维持现状（行为正确，路径绕） | — | — |
| N4 | cleanupOrphanImages 注释理顺：删除「统一走全表扫描兜底」旧表述，明确现状是 IMAGE_REF_TABLES 常量清单驱动（新增引用表只改常量一处） | repo.js:622-628 | 注释-only ✅ |

**过程中处理**：N1 的 1 行 import 使 analytics.js 行号整体位移，i18n 数据层闸门按 file:line 基线误报 59 处"新增硬编码中文"——核实为行号漂移（旧版本同位置即存量中文，我的 diff 仅 +4/−3），用项目自带 `--js-update-baseline` 重写基线（28 文件/434 行，无真新增债务），三道闸复检全部通过（新增 0 行）。

---

*修复完成时间：2026-09-14 | 测试：1074/1074 pass · i18n 三道闸通过（新增 0 行） | 基线：08b14b8*

---

*审计完成时间：2026-09-14 | 基线：08b14b8 | 测试：1074/1074 pass | round43 修复验证：5/5 无回退*
