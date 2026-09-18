# 全面代码审计报告 · round111（知识图谱专项 + 并行 AI 最新提交）

- 日期：2026-09-18
- 范围：并行 AI 新增 3 个提交（f419586 / 1e1efcb / b7c14d5）+ 知识图谱未提交改动（KnowledgeGraph.vue / knowledgeGraph.js）
- 方法：逐文件读 diff/源码 → 数据落库与同步链路核对 → 全量 `npm test` → 生产 `npm run build`
- 结论（先说）：**可用**。知识图谱"AI/Agent 生成结果"的保存链路已查清并补全：**AI 自动生成此前确实不落库（刷新即丢，你踩到的就是这个）**，并行 AI 已补"生成成功自动存成思维导图"（未提交，已验证可过门禁）；并行 AI 上轮的向量重复堆积 P1 已修复。**全量 1437 测试通过、构建成功。**

---

## 一、你问的知识图谱四个问题（逐条实锤）

### 1. AI 生成结果和 Agent 生成结果分别保存在哪里？

| 生成方式 | 保存位置 | 落库时机 | 是否随数据包同步 |
|---|---|---|---|
| **AI 生成**（🔗 AI 生成按钮） | 旧版：**只写内存 ref，不落库** → 刷新即丢 | 用户手动点「💾 保存这些关联」才逐边存 `graphEdges`；**并行 AI 新改动：生成成功即自动落一张思维导图到 `db.mindmaps`**（带时间戳标题，多次生成不覆盖） | ✅ 是（`mindmaps` 在 sync-manifest.js:102，`merge:'updatedAt'`） |
| **Agent 智能构建**（🤖 智能构建按钮） | `graph-builder` agent 调 `link_cards` 工具，**直接逐边写 `db.graphEdges`**（知识图谱边表） | 构建过程中实时落库 | ✅ 是（`graphEdges` 在 sync-manifest.js:99，`merge:'updatedAt'`，同步时排除 `auto` 类型脏边） |
| **智能推荐**（🔗 智能推荐） | 本地相似度算法（tokenize+词频+集合相似度，**不调任何 AI 接口，免 Key 免流量属实**）产出候选，用户点保存才写 `graphEdges` | 用户确认时 | ✅ 同上 |
| 手动「存为思维导图」 | 并行 AI 新加的按钮 → `db.mindmaps` | 点击时 | ✅ 同上 |

### 2. 「知识库」具体指什么？

界面上的"知识库"其实是两个真实落库位置（都在 IndexedDB、都在同步清单里）：
- **「💾 保存这些关联到知识库」→ `graphEdges` 表**（知识图谱关联库：节点对 + 关系标签 + 科目）
- **「🗂️ 存为思维导图（随数据包同步）」→ `mindmaps` 表**（思维导图库：标题 + 树形节点）

两处都随数据包同步到其他设备/导出包。**不存在"第三个虚拟知识库"**——就是这两张表。

### 3. 是不是根本没有保存成功？

分情况，**你说的场景属实**：
- **AI 自动生成后不点任何保存 → 确实没保存**（已提交版本 generate() 只写内存 ref，KnowledgeGraph.vue:377 仅 `generatedNodes.value = ...`，无落库）→ **刷新就丢**。这是根因，实锤。
- 手动「保存这些关联」「存为思维导图」→ 一直有效（createGraphEdge / createMindmap 均真实写库，已验证）。
- Agent 智能构建 → 一直有效（link_cards 直接写 graphEdges）。
- **并行 AI 未提交的改动**：generate() 成功后**自动**调 `saveGeneratedToMindmap({silent:true})` 落 mindmaps，从此刷新不丢、换设备可见。

### 4. 图片历史记录为什么刷新就丢？应存哪、怎么保留？

- 根因：AI 生成的知识图谱（你看到的"图"）是 ECharts 运行时画的，数据只存在于页面内存变量（generatedNodes/generatedEdges），**没有任何持久化**。刷新页面 → JS 状态清空 → 图消失。
- 正确存放位置：`db.mindmaps`（思维导图表，随数据包同步）。
- 并行 AI 的修复：生成成功即自动存一张「AI 知识图谱快照 · 时间戳」进 mindmaps，标题带时间戳互不覆盖，可在「思维导图」页回看；另提供手动「存为思维导图」按钮。

---

## 二、并行 AI 最新 3 个提交审查

| commit | 内容 | 审查结论 |
|---|---|---|
| `f419586` | **向量行改确定性 id**（根治 round110 P1 多设备向量重复堆积）+ 记忆护栏计数对齐（P3） | ✅ 通过。`id = hash(sourceType\|sourceId\|chunkIdx\|modelSig)` 取代 `uid()`，idOnly 合并天然幂等、跨端收敛；新增测试覆盖。round110 报告的 P1 正式关闭 |
| `1e1efcb` | analytics offload 挂死超时护栏（round94 P3-1 收口） | ✅ 通过。给卸载任务加超时，防后台挂死 |
| `b7c14d5` | 记忆向量独立供应商 + 记忆库管理界面（导出/筛选/清空） | ✅ 通过。即 round110 那批未提交半成品，并行 AI 已补测试并提交（round110 我改的探针 ASCII 词也在其中） |

## 三、本轮知识图谱未提交改动的审查 + 我修的一处 P3

- **自动落库逻辑正确**：generate() 成功后 `saveGeneratedToMindmap({silent:true})`，静默不打扰；手动按钮走非静默带 toast；标题带时间戳防覆盖；`createMindmap` 写 `db.mindmaps` 带 fieldTs（round34 字段级合并，跨端不互相覆盖）；i18n 键 zh/en 已补齐。
- **我修的一处 P3**：KnowledgeGraph.vue:420 原调用 `T.track('kg_save_generated', ...)`，但 `telemetry.js` 的 `T` 对象只有具名方法（reviewRate/graphSave/mindmapSave…），**没有通用 track 方法** → 运行到此处抛 TypeError 被 try/catch 静默吞掉（落库不受影响，仅埋点失效）。已改为项目既有的 `T.mindmapSave(nodes)`（语义一致且真实存在）。
- 小瑕疵（P3 不阻断）：generate() 与 saveGeneratedToMindmap() 都设 `loading`，嵌套调用时内层 finally 先置 false、外层 finally 再置 false，无冲突，仅轻微冗余。

## 四、验证结果（实跑）

| 项 | 结果 |
|---|---|
| `npm test` | ✅ **# tests 1437 / # pass 1437 / # fail 0 / # todo 0**（比上轮多 15 条：向量确定性 id、超时护栏、记忆管理等） |
| i18n 三道闸 | ✅ 46 视图可解析 · 45 字典 zh/en 对齐 · 数据层 308 行无新增 |
| `npm run build` | ✅ 构建成功（首次卡死在 rendering chunks 约 6 分钟、CPU 停滞，清理残留构建进程后重试即成功；E 盘剩 11.7GB。判定为瞬时资源/残留进程问题，非源码问题） |
| 知识图谱落库链路 | ✅ createMindmap / createGraphEdge / link_cards 三路均真实写库且表在同步清单 |

## 五、遗留问题（按优先级）

1. **P3（环境提示）**：本次构建首次卡死，与残留 node 进程有关；本地内存/磁盘偏紧（E 盘 11.7GB 可用）。若复现，先清 node 进程再构建；CI 不受影响。
2. **P4（可选）**：AI 自动生成的 mindmap 快照标题为「AI 知识图谱快照 · 时间」，生成多了会占列表；后续可考虑自动合并/上限清理（非必需）。
3. 关闭项：round110 P1（向量重复堆积）已由 f419586 修复；round110 P3（护栏计数）已修；探针 i18n 违规已随 b7c14d5 以 ASCII 词入库。

## 六、处置建议

本轮知识图谱未提交改动（自动落库 + 手动存导图 + i18n）质量达标、测试全绿，可提交。提交前已确认无遗留临时文件、无硬编码中文、埋点已修正。
