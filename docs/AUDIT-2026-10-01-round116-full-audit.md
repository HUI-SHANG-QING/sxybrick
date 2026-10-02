# 全面审计报告 round116（2026-10-01）

> 审计范围：广度（9 大模块）+ 深度（底层算法/数据一致性/跨模块交互）
> 审计起点：HEAD=`5c78b19`，本地=远端，工作区干净
> 结论：**可用**。发现 2 处问题（1 遗留 + 1 微残留），均已修复并验证。

---

## 一、审计矩阵与结果

| # | 模块 | 深挖点 | 结论 |
|---|------|--------|------|
| 1 | SRS/FSRS 调度（srs.js / fsrs.js / trainWeights） | 间隔封顶 365 天、NaN/Infinity 兜底、level 归一化防卡消失、难度钳制 [1,10]、hard≤good 结构护栏、训练器消噪（w17 置零）/排序/过滤/空轨迹丢弃/首测不计分 | ✅ 无问题 |
| 2 | 同步合并（sync-manifest / sync-dedup / hub） | 双时间戳字段级合并（内容=updatedAt / SRS=reviewedAt 独立哨兵）、时钟偏移换算、strip 凭证保护、平局字典序收敛、墓碑严格 `>`、去重"同 id 必放行"、引用重映射（含复合 id / embeddings id / wikilink）、hub HMAC 挑战-响应 | ✅ 无问题 |
| 3 | 知识图谱（graphAuto / graph-resolve / AiGraphView） | 同对卡单边收敛（related/prereq 升级方向）、错题本地日界、单日崩盘保护、确定性边 id、先删后建、渲染空态/超限截断 | ✅ 无问题 |
| 4 | RAG/嵌入（embedding / retrieval / intelligence） | 降级签名触发自动重建、余弦维度不一致判 0、幽灵向量逐条墓碑 + keepIds 防误删、智能推荐性能防 O(n²) | ✅ 无问题 |
| 5 | 批注 + 搜索（annot-repo / CardAnnotation / search-service） | 级联删批注双路径同口径（并行 AI 已补）、requestId 防竞态、草稿清空时机、bulkGet 只取引用卡 | ✅ 无问题 |
| 6 | 出题/生成（genQuiz / knowledge-budget / genDeck / genVariants / genScoring） | fitKnowledge 水填式二分、50000 上限全路径截断一致、LLM 输出解析、评分 clamp | ✅ 无问题 |
| 7 | 业务视图层（Docs/Memo/Plans/Review/FlipCard/GenQuiz） | 路由 ?id= 定位（load 先于 return）、批注切卡收起、翻转状态重置 | ⚠️ 发现 1 处微残留（已修） |
| 8 | 图片生命周期 | IMAGE_REF_TABLES 单一来源 + 全表存活集 GC + 导入导出同源 | ✅ 无问题 |
| 9 | 服务端 hub | 认证签名/限流/密钥 strip 透传 | ✅ 无问题 |

---

## 二、发现的问题（均已修复）

### P2-遗留（用户上轮点名未修）：单词 AI 模式输出下限 1600 写死

**位置**：`src/views/WordAIModes.vue:37` → `maxTokens: resolveMaxTokens(1600)`

**成因**：`resolveMaxTokens(floor)` 语义 = `Math.max(floor, 用户配置)`——功能上"尊重用户设置"已成立（用户配置 >1600 时生效），但 **floor=1600 的下限**使「用户配置 <1600（如 1024）」时每请求被强行抬高到 1600 token，而单词 AI 输出（例句/翻译/解析）本来就短，买多 ~1K token 不产出更多内容。这是上轮已点名、本轮确认仍未落地的遗留。

**修复**：floor 1600 → 512（只兜底极端小配置，用户配置更大时仍按用户配置走）。

### P3-微残留：FlipCard 切卡时 3D 渲染上下文未回收

**位置**：`src/components/FlipCard.vue` 的 `watch(card.id)` 与 `watch(flipped)`（flip3d 600ms 定时器）

**成因**：翻转过渡开启 `flip3d=true` 并挂 600ms 定时器；若在过渡期间切卡，`watch(card.id)` 重置了 flipped 却没清 flip3d 定时器 → 新卡最多 600ms 停留在 preserve-3d 渲染路径上（功能无感、性能小浪费，属修复 flip3d 时的遗漏）。

**修复**：切卡时同步 `flip3d=false` + 清定时器。

---

## 三、验证结果

| 闸门 | 结果 |
|------|------|
| `npm test`（eslint + i18n 双闸 + dep-check + sync-coverage + 1542 用例） | ✅ 1542 tests / 1541 pass / 0 fail（todo 1 为 build 前 dist 缺失的正常标记，build 后重跑 todo 0 全绿） |
| `npm run build` | ✅ 成功（2 个 >600KB 非首屏产物按策略移出预缓存，非报错） |
| 修复项语法/引用 | ✅ build 通过 = 语法与引用有效 |

**测试覆盖说明**：两处修复均为小改动且无既有单测直接覆盖（单词模式与 FlipCard 无组件级测试），依赖 build + 全量回归兜底；建议后续为 WordAIModes token 配置补一条静态断言（参照 knowledge-budget 的结构闸门模式）。

---

## 四、结论

- **整体可用**：9 大模块深度审计未发现数据丢失、调度错误、同步不一致或安全缺陷；既有修复链（批注/图谱/搜索/RAG）经交叉验证无回归。
- **本次审计价值**：仍然引出了 2 处真实问题（1 处用户上轮点名的遗留未落地、1 处上一轮 flip3d 修复的遗漏），印证"每轮修复都可能留下小尾巴"的判断——本轮已收口。
- 待推送：2 个修复 + 本报告。
