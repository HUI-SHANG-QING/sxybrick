# 全面代码审计报告 · round110（并行 AI 交付后全新一轮）

- 日期：2026-09-18
- 范围：并行 AI 最新 3 个提交 + 工作区一批未提交收尾改动
- 方法：逐文件读 diff/源码 → 静态逻辑推演 → 全量 `npm test` → 生产 `npm run build` → 同步语义核对
- 结论（先说）：**核心可投入使用**。已提交代码质量高；未提交的两个新功能经我补齐门禁合规后，全量 1422 测试通过、构建成功。**唯一重要遗留是「多设备向量重复堆积」（P1，单设备不触发，并行 AI 已记录方案但未实施）**。

---

## 一、本轮审查对象

### 已提交（3 个，新→旧）
| commit | 内容 | 审查结论 |
|---|---|---|
| `7e41698` | 长期记忆按「相关度+重要度+新鲜度+巩固度」召回；流水线 LLM 失败兜底单 Agent；孤儿索引工具挂载；i18n | ✅ 通过 |
| `3fdf522` | chatAI 入参归一（修 PrivacyData 传字符串必崩）；架构评审报告 | ✅ 通过 |
| `4c4e017` | 真机修复：Dashboard「近14天复习趋势」从不渲染；演示模式首启空库竞态 | ✅ 通过 |

### 工作区未提交（并行 AI 收尾时留下，完成度高但未跑门禁）
- `src/agent/embedding.js`、`src/ai.js`：**embedding 独立供应商配置** + 连通性探针 `probeEmbedding()`
- `src/agent/memory.js`：**记忆批量清空** `clearMemories()`（按类型或全清，事务内写墓碑）
- `src/views/AIAssistant.vue` + `src/i18n/views/aiAssistant.js`：记忆库筛选/导出(JSON/MD)/清空 UI、向量供应商设置与「测试」按钮
- `tests/embedding-provider.test.mjs`、`tests/memory-clear.test.mjs`：两个新功能的测试

---

## 二、关键逻辑核查（已提交部分）

### 1. 记忆召回排序 `scoreMemories`（memory.js）——正确
- 综合分 = 相关度×3 + 重要度/5×1 + 新鲜度×0.6 + 巩固度×0.4，权重为常量。
- **相关度复用 `retrieval-core.scoreKeyword`，是 CJK bigram 字面命中（0~1），不是 embedding 语义向量**。即本轮做的是「关键词相关度召回」轻量版：零成本、离线可用、短记忆场景够用；但用户用同义改写提问仍可能召不回。这是有意识的取舍，非缺陷。
- 新鲜度按 45 天双曲衰减；巩固度 `log2(1+useCount)/log2(8)`，约 7 次到顶。
- 类别配额（core12/preference12/fact20）与 1800 字上界保持不变；无 query 时退化为重要度+新鲜度+巩固排序。
- 两个调用点（`orchestrator.js` 传 userInput、`pipeline.js` 传 query）均已正确传参。

### 2. 巩固机制 `consolidateUsage`——正确，且有一处很专业的判断
- 被注入记忆写 `useCount/lastUsedAt`，6 小时节流、失败静默、不阻塞回答。
- **刻意不更新 `updatedAt`**：因 `aiMemories` 同步合并策略是 `merge:'updatedAt'`（sync-manifest.js:81，整行「谁新听谁」）。若巩固时 bump updatedAt，本机多读几次就会让该记忆变成「最新内容赢家」，跨端覆盖对端真正编辑过的内容。此判断符合同步语义，正确。

### 3. 淘汰 `pruneMemories`——正确
- 从「删 updatedAt 最旧」改为「删综合分最低」，core 类保留 `CORE_PRUNE_PROTECT=2` 条。
- 扫描上限 200→300（=表硬上限 MEM_MAX_ROWS），修掉「第 201 行之后的老记忆永远进不了淘汰候选」的隐患。

### 4. 流水线兜底（orchestrator.js）——正确
- `runPipeline` 整体 try/catch；分解阶段 LLM 抛错（401/429/超时/网络）时记降级日志并退回单 Agent，不再整体失败。

### 5. 索引工具挂载——已核实真实有效
- `get_index_status/ensure_index/rebuild_index` 在 `tools/index.js:1573/1587/1598` 真实注册，挂载名一致，无「挂了不存在的工具」。

### 6. chatAI 入参归一（ai.js/llm.js）——正确
- 字符串→`[{role:'user',content}]`；非数组且非字符串→抛可读错误（i18n `agent.llm.badMessages`）。修掉 PrivacyData 增强报告把字符串当 messages 传、必然 `messages.reduce is not a function` 的崩溃。

### 7. 两个真机 bug 修复——正确
- Dashboard 趋势图：渲染移到 `finally` 后 `await nextTick()`，DOM 就绪再画；失败路径 `renderTrend` 自带元素判空，安全。
- 演示模式空库竞态：播种后用 `sessionStorage` 一次性守卫触发 `location.reload()`；隐私模式 setItem 抛错仍只 reload 一次，有防死循环保护。

---

## 三、未提交新功能核查 + 我做的收尾

### 功能本身：实现规范，测试齐全
- **embedding 独立供应商**：新增 `embeddingBaseUrl/embeddingApiKey/embeddingModel`，留空逐项回退聊天配置（老用户零迁移，测试明确断言签名逐字一致）。这修掉一个**隐性大问题**：此前聊天用 DeepSeek（无 `/embeddings` 端点）时，向量检索永久降级为本地 256 维 bigram，语义召回名存实亡；现在可单独配一家支持 embeddings 的供应商。探针真实发一条向量，能暴露端点错误/模型名错/key 无效。
- **记忆批量清空**：事务内 `bulkDelete` + 逐条 `bulkPut` 墓碑（kind:'memory'），正确遵守「idOnly/updatedAt 合并下 absence≠deletion，不写墓碑对端会把数据推回来」的不变量。
- UI 全部走 i18n、清空有 `confirmDialog` 二次确认、动作用 `runAction` 统一错误反馈；新依赖 `downloadText/runAction/probeEmbedding` 导出均真实存在。

### 我发现并修复的两处阻断/卫生问题
1. **门禁红灯（阻断）**：`src/agent/embedding.js:147` 探针里硬编码中文测试词 `'向量检索测试'`，被 i18n 数据层第三道闸（check-view-i18n `--js`）判定为新增硬编码中文，导致 `npm test` exit 1。该词是发给 embedding 端点的一次性探测文本、非界面文案，已改为 ASCII `'embedding probe test'`（不影响探针目的；测试不断言该字面量）。
2. **临时文件漏删**：根目录 `_uiprobe.mjs` 是验证新界面的临时 CDP 真机脚本（0 引用、硬编码本机 Chrome 路径/端口），按项目「临时探针用完即删」的既定规矩已删除。

---

## 四、验证结果（实跑）

| 项 | 结果 |
|---|---|
| `npm test`（修复前） | ❌ exit 1，i18n 数据层闸门报 embedding.js:147 |
| `npm test`（修复+重建后） | ✅ **# tests 1422 / # pass 1422 / # fail 0 / # todo 0，exit 0** |
| i18n 三道闸 | ✅ 46 视图 t() 可解析 · 45 字典 zh/en 对齐 · 数据层 308 行回到基线 |
| `npm run build` | ✅ 36s 构建成功，PWA 202 预缓存条目；仅大 chunk 常规警告（已配置移出预缓存） |
| vite-glob-guard 产物校验 | 初次失败系 **dist 为旧产物**（非源码问题），重新 build 后通过 |

---

## 五、遗留问题（按优先级）

### P1｜多设备向量重复堆积（已知、未修、有方案）
- 位置：`retrieval.js:68/102/179` embedding 行 id 用随机 `uid()`；`sync-manifest.js:99` embeddings 合并为 `merge:'idOnly'`；`sync-dedup.js` 只对 cards/wordCards 去重，**不按 sourceId 去重向量**。
- 后果：同一张卡在 A/B 两端各建索引产生不同 id，idOnly 合并后两端都保留 → 向量随设备数倍增；`hybridSearch` 同一卡片占多个 topK 位、挤掉别的结果；更快撞 `FULLSCAN_ROW_LIMIT=3000` 全表上限；`rebuildIndex` 只清本端，idOnly 下无墓碑、absence≠deletion，对端旧行会被推回，跨端无法收敛。
- 影响面：**单设备完全不触发**；多设备同步才出现（用户有跨设备场景，会踩到）。
- 方案（并行 AI 架构报告 P1-2 已给，未实施）：确定性 id `hash(sourceType|sourceId|chunkIdx|modelSig)` 取代 `uid()`；去掉 `embeddings.text` 原文副本；加 `contentHash` 与 prune；删源时级联删向量并写墓碑。

### P3｜字符护栏截掉的记忆仍被记一次巩固（极轻微）
- 位置：`buildMemoryText` 中 `picked` 在类别配额阶段就 push，而 1800 字总量护栏用 `lines.pop()` 截断，未同步从 `picked` 移除。
- 后果：个别因超字数实际没进 prompt 的 fact 仍被 `consolidateUsage` 记一次 useCount；仅影响排序微调，且有 6h 节流，无功能损害。
- 建议：把 picked 的最终确定移到字符护栏之后（顺手可修，非必须）。

---

## 六、处置建议

1. 本轮未提交的两个新功能已达可交付标准（测试/构建/门禁全绿），可提交；提交前不要再带入任何根目录临时脚本。
2. P1 向量重构建议作为下一独立任务（涉及一次性索引重建与旧行清理，需单独验证跨端收敛）。
3. P3 可在下次触碰 memory.js 时顺手修。
