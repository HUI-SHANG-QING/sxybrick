# 全面代码审计报告 · round115（2026-10-01 绝对严格审计）

- 日期：2026-10-01
- 范围：并行 AI 新交付 8 个提交（round128-132 + 批注功能 3 连）＋工作区 2 个未提交改动
- 方法：逐提交读 diff/源码 → 墓碑/级联/收敛/预算/UI 逻辑逐条验证 → 残留硬编码全库扫描 → 全量 `npm test` → 生产 `npm run build`
- 结论（先说）：**项目可用，无重大缺陷**。批注新功能完整（表结构/同步/级联/搜索/UI 全部到位）。**但发现 1 个 P1 级收尾问题：2 个工作区改动未提交、未测试**——批注功能的跨设备闭环依赖它们，当前 HEAD 缺这段。

---

## 一、本轮审查的 8 个提交

| commit | 内容 | 审查结论 |
|---|---|---|
| `09751d6` | round128：FlipCard 潜伏镜像规则清理 + 闸门白名单漏洞 | ✅ |
| `e5bb5ed` | round129：卡片上限 8000→50000，散落 8 处硬编码收敛为单一来源 | ✅ |
| `a40e1dc` | round130：AI 文档刷新/跨模块进入看不到历史 | ✅ |
| `4681d0f` | round131：同页 ?id= 变化不重新定位 | ✅ |
| `b8d5b65` | round132：出题按卡片实际长度喂 AI（knowledge-budget） | ✅ |
| `a9ef253` | 批注功能：独立表 + 右侧面板 + 全屏 + 软删除 | ✅ |
| `2531cbf` | 批注审计修正：草稿丢失 / Esc 连关两层 / 删除跨设备失效 | ✅ |
| `ec401b6` | 批注补齐：删卡级联 / 跨设备残留兜底 / 图片保护 / 全局搜索 | ✅ |

## 二、独立验证过的关键逻辑（非仅信提交说明）

1. **墓碑机制闭环**：`applyTombstones` 是通用实现（按 `kindOf` 过滤 + `livenessTs` 判活 + 30 天时钟容忍窗口防误删）；`kind:'cardAnnot'` 已登记 sync-manifest（`{table:'cardAnnots', kind:'cardAnnot', merge:'updatedAt'}`，BACKUP_VERSION 10→11）。✅
2. **删除语义修正正确**：初版行内 `deletedAt` 软删除有两处硬伤（与墓碑表字段同名不同义 + updatedAt LWW 下删除会被对端编辑覆盖→批注复活），`2531cbf` 已改为**物理删行 + 写墓碑**，与项目其余表同口径；`deleteAnnot` 事务原子（删行+墓碑同事务）。✅
3. **删卡级联完整**：`deleteCard` 回收站快照带 `_annotations` + 物理删 + 逐条写墓碑；`restoreFromTrash` 还原批注 + 清墓碑 + **bump updatedAt**（防对端墓碑回灌"恢复即消失"）；`sweepOrphanRows` 扩到批注（旧版对端删卡不带批注墓碑的唯一兜底）。✅
4. **图片保护**：`IMAGE_REF_TABLES` 加 cardAnnots——批注正文里的图不会被孤儿清理物理误删。✅
5. **上限收敛干净**：全库扫描确认 8 处卡片长度硬编码全部改为 import `card-limits.js`（CARD_MAX_CHARS=50000，CARD_WARN_CHARS 由上限派生防漂移）；残留的 8000 均为超时/位运算/token 预算等**无关用途**。`repo-core.js` 写入校验同步收敛。✅
6. **出题预算算法**：`fitKnowledge` 总量≤预算零拷贝返回；超预算二分求统一阈值 cap，**短卡全文保留、仅超长卡等比例收窄**（刻意避开"每张摊薄=旧的 120 字"同一种错）；cap 压到 0 的极端情况保底留 1 字；`KNOWLEDGE_CHAR_BUDGET=200000` 有 token 窗口推导依据。✅
7. **Docs 历史根因**：`applyRouteId` 里 `await load()` 被无 `?id=` 的提前 return 跳过 → 刷新/从侧栏进入 docs 恒为 []；已改为 load 最前，且同族排查（Memo/Plans 无此问题）。✅
8. **路由定位**：三页补 `watch(() => route.fullPath)`（同路由 query 变化复用组件实例时 onMounted 不触发）；无 immediate，挂载仍只由 onMounted 负责，不双重加载。✅
9. **组件层防御**：批注面板 requestId 防竞态（A 卡批注不串到 B 卡）、Esc 让位（`.content-fs-overlay` 全屏 + Element Plus 模态框双层避让，不"一键关两层"）、草稿清空时机修正、切卡清状态、`@click.stop` 防冒泡触发翻转/评分、v35 表索引齐全（id/cardId/createdAt/updatedAt）。✅

## 三、验证结果（实跑）

| 项 | 结果 |
|---|---|
| `npm test` | ✅ **tests 1541 / pass 1540 / fail 0 / todo 1**（todo 为既有"dist 不存在跳过产物校验"标记） |
| `npm run build` | ✅ 构建成功（26.3s） |
| 硬编码残留扫描 | ✅ 无卡片长度 8000 残留 |
| 工作区改动测试覆盖 | ❌ **无直接回归测试**（见下） |

## 四、发现的问题

### 🔴 P1：批注功能收尾 2 个改动未提交、未测试（当前 HEAD 缺闭环）

工作区有两个**逻辑正确但未入库**的改动，且**没有任何测试覆盖**（全库 tests 搜索确认）：

| 文件 | 改动 | 为什么重要 |
|---|---|---|
| `src/search/search-service.js` | annots 搜索从 `db.cards.toArray()` 全表读改为 `bulkGet` 只取引用卡 | **HEAD 版本在 5 万卡上限下，每次批注搜索都全表读 cards（含 `_embeddings` 大字段）**——真实性能隐患；工作区版本已修复 |
| `src/sync.js` | importBackup 补 `db.cardAnnots.where('cardId').anyOf(removed).delete()` | 对端经卡片墓碑删卡时本端批注残留——**HEAD 版本缺这段**，只能靠 `sweepOrphanRows` fire-and-forget 兜底（失败仅 warn） |

两个改动注释到位、逻辑正确，但：**未提交（HEAD 仍是 ec401b6）＋ 未测试（1541 全绿测的是 HEAD，不含这两段）**。即"删除跨设备失效"修复在已提交代码里只完成了一半，另一半在未提交状态。**建议：提交 + 补回归测试后再推送。**

### 🟡 P2：批注自身删除无恢复入口（设计取舍，非 bug）
`deleteAnnot` 物理删 + 墓碑后不可恢复（`restoreFromTrash` 只覆盖删卡级联场景的快照还原）。UI 有二次确认兜底，数据层保留 `updateAnnot` 供将来补编辑入口。当前可接受，但用户误删批注会永久丢失——值得将来加回收站或撤销。

### 🟢 环境状态
- 本地 = 远端（HEAD `ec401b6`），8 个提交已在远端。
- 工作区 2 个未提交改动（上述 P1）。
- 线上网页 = 最新（含批注功能）。

## 五、结论

**可直接使用。** 批注功能（表结构、同步合并、墓碑、级联、搜索、UI、i18n）全链路验证通过，无新增逻辑缺陷；卡片上限收敛与出题预算重构质量高（单一来源 + 零依赖叶子 + 负向对照）。**唯一的动作项是 P1：把 2 个未提交改动提交并补测试**（尤其 sync.js 的跨设备批注残留，当前线上版本仍靠兜底路径），完成后推送即为完整闭环。
