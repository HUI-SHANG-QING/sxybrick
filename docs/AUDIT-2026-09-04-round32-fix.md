# SxyBrick 深度审计修复报告（Round 32）

> **审计报告**：`docs/AUDIT-2026-09-04-round32-deep.md`（基线 facffb5，800/800）
> **修复日期**：2026-09-04
> **验证方法**：逐条读源码实证核验（非轻信报告）→ 修根因 → 补回归测试 → 全量门禁复跑

## 一、逐条核验结论

| 编号 | 严重度 | 判定 | 证据 |
| --- | --- | --- | --- |
| BUG-01 | P1 | ✅ 真实 | `embedding.js:147` `Math.min(a.length,b.length)` 静默截断；`retrieval.js` 无维度校验 |
| BUG-02 | P1 | ⚠️ 部分真实 | `graphAuto` 全表 `toArray()` + 主线程真实；「热门词偏置」是 `buildCandidates` 注释明示的**有意设计** |
| BUG-03 | P2 | ✅ 真实 | `base.js:32` 正则无 `g` 只匹配首个；`JSON.parse` 失败静默降级 `{}` |
| BUG-04 | P2 | ✅ 真实 | `sync.js:585` 硬编码引用字段枚举，注释自认「易漏」 |
| BUG-05 | P2 | ❌ 误报 | `sync-manifest.js:201-207` 已是「仅对 `undefined` 并集」语义，`null`/空串清空已生效 |
| BUG-06 | P2 | ⚠️ 部分真实 | 无 schema 校验真实；但 `runPipeline` 已有 `agentRegistry.get` 兜底（非「静默」） |
| BUG-07 | P2 | ✅ 真实 | `repo.js:358` 每次删卡 `allCards()` 全表扫描 |
| BUG-08 | P3 | ❌ 误报 | `fsrs.js` 已 `Math.max(0, elapsedDays)`，R 不会 >1 |
| BUG-09 | P3 | ✅ 真实 | `repo.js:712` 循环内串行 await |
| BUG-10 | P3 | ✅ 真实 | `retrieval-core.js:60-61` O(n×m) `find` |

**结论**：10 项中 **6 项真实**（含 2 项部分）、**2 项误报**（BUG-05/08，未改动以免破坏现有正确语义）、**2 项架构级**（BUG-02 性能债、OPT-01~03 按需展开）。

## 二、已落地修复

### BUG-01（P1）embedding 维度不一致静默截断
- `src/agent/embedding.js`：`cosine()` 入口改为 `la !== lb` 时直接返回 0（不再 `Math.min` 截断）。
- `src/agent/retrieval.js`：新增 `warnDimMismatch()`，`semanticSearch`/`hybridSearch` 加载行后告警一次，提示重建索引。

### BUG-03（P2）parseToolCall args 解析脆弱
- `src/agent/agents/base.js`：`parseToolCall` 导出；`JSON.parse` 失败或参数非对象时回填 `parseError`，不再静默 `{}`。
- `runReActAgent` 循环在 `parseError` 时回灌错误给 LLM 自我纠正，而非调用工具。

### BUG-04（P2）卡片引用字段枚举易漏
- `src/sync-dedup.js`：新增集中注册表 `CARD_REF_FIELDS`/`ARRAY_REF_FIELDS`/`JSON_REF_FIELDS`/`NESTED_REF_FIELDS` + 纯函数 `remapCardRefs(backup, idRemap)`。
- `src/sync.js`：`importBackup` 删掉内联枚举 + 重复重定向循环，改调 `remapCardRefs`（单一实现，测试与业务共用）。

### BUG-06（P2）decomposeTask 无 schema 校验
- `src/agent/pipeline-core.js`（新建，纯逻辑层）：`normalizeDecomposedSteps` + `parseDecomposedOutput`，过滤缺 agent/instruction/类型不符的步骤。
- `src/agent/pipeline.js`：`decomposeTask` 改用 `parseDecomposedOutput`。
- 纯逻辑抽到独立模块，规避 pipeline→offlineAI→genDeck→ai→index 的循环依赖（直接 import pipeline.js 会触发 `PRESET_PIPELINES` TDZ 错误）。

### BUG-09（P3）listDailyPlanSummary 串行 await
- `src/repo.js`：改为 `db.dailyTasks.where('planId').anyOf(planIds).toArray()` 一次查询后按 planId 分组（O(N)→O(1) 次查询）。

### BUG-10（P3）fuseResults O(n×m) 查找
- `src/agent/retrieval-core.js`：先建 `semBy`/`kwBy` 两个 Map 记最高分，替代逐 id `find`；顺带修正「乱序输入取首个而非最高分」的隐性正确性瑕疵。

## 三、回归测试（+18，840 → 858）

| 文件 | 覆盖缺陷 |
| --- | --- |
| `tests/embedding.test.mjs` | BUG-01：cosine 维度不一致/空向量/同维度 |
| `tests/retrieval-core.test.mjs` | BUG-10：fuseResults 乱序仍取最高分 |
| `tests/daily-plan.test.mjs` | BUG-09：多日期多任务 anyOf 分组 |
| `tests/agent-parse.test.mjs`（新建） | BUG-03：parseToolCall 非法 JSON/数组标量/空 args |
| `tests/pipeline-decompose.test.mjs`（新建） | BUG-06：normalizeDecomposedSteps + parseDecomposedOutput |
| `tests/sync-dedup.test.mjs` | BUG-04：remapCardRefs + 注册表防漂移 |

## 四、验证结果

- `npm test` 全量门禁：**858/858 通过**（i18n `.vue` 闸 + `.js` 数据层闸 + node --test）。
- i18n 数据层基线已重锚（插行位移致误报「新增」，经 `git diff` 核实仅 3 处合法 Agent 协议串，重锚 `scripts/i18n-js-hardcode-baseline.json` 后零新增）。

## 五、未处理项（评估后暂不落地）

- **BUG-02**（graphAuto 全表 + 主线程）：需 Web Worker 化，属性能债，影响面大、独立成项。
- **BUG-07**（cleanupOrphanImages 全表扫描）：需引入 `imageId→Set<cardId>` 反向索引表，涉及 schema 变更，风险较高、暂缓。
- **OPT-01~03 / OPT-05~08**：架构级（repo 拆分、materialized view、ANN 索引、配置中心、墓碑 GC 等），按阶段另行推进。
