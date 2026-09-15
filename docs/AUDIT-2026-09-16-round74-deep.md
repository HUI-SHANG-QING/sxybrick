# round74 深度审计报告（数据模型全景 / 渲染 XSS 面 / localStorage 异常路径）

- 日期：2026-09-16
- HEAD：`64eaef3`（工作树：并行 AI 流式 WIP 未提交）
- 本轮零 P1/P2，1 个 P3（localStorage 裸写）

## 一、本轮打的两个新域

### 1. 数据模型全景（db.js，34 个版本）

- **34 个版本、0 个 `.upgrade()` 数据钩子**：round53 曾列为 P2"无迁移通道"——round51 已定性为**有意架构**：schema 变化交给 Dexie 引擎自动迁移；动数据行的场景（fieldTs 重盖、scheduledHour 净化、时间戳可逆规范化）全部走"运行时一次性修补"（可重试、幂等、差量写）。本轮复核：结构变化路径（version+stores）与数据变化路径（runtime patch）**边界清晰，无新增风险**
- 表/索引：27+ 张表，主查询路径（cards.dueAt、reviews.cardId、wordCards.familiar、dailyTasks.planId、imageRefs.imageId、embeddings 多索引）全部有索引覆盖；`pomoSessions.roundId` 幂等键、`cardLinks` 关联表、`wordSyllabusMeta` 词库元数据——模型设计合理，无字段冗余/缺失观察
- `plans`（老表）与 `dailyPlans`（新表）并存：**88 处引用，非死表**（番茄钟/计划老链路仍用），不是遗留

### 2. 渲染 XSS 面（sanitize.js + 全部 v-html 出口）

- **净化层完整**：协议白名单（http/https/mailto/tel/blob/data:image 均显式放行）、FORBID_TAGS/FORBID_ATTR、外链自动补 `rel=noopener noreferrer`、Node 环境兜底整体转义
- **所有 v-html 出口都过净化**：MarkdownRenderer（marked → 占位符还原 → **sanitizeHtml 最后执行**，覆盖 marked 产物与自建模板）、Cards.vue 列表高亮（hlKw 先转义再包 mark）、search-service 高亮（同款）——无一裸奔
- 结论：P0 安全修复完整，历轮无回退

## 二、P3（1 条）

| 编号 | 位置 | 大白话 | 优先级 |
|---|---|---|---|
| N1 | **~10 处 localStorage 裸 `setItem` 无 try/catch**：`crypto.js:63`（设备密钥，加密备份链路）、`theme.js:87/91/97`、`plan-reminder.js:42/135`、`appMode.js:43`、`interventions.js:52`、`pomoDedup.js:32`、`proactive.js:305` | 正常浏览器永远不触发；但 **Safari 隐私模式 / 配额满** 时 `setItem` 抛 QuotaExceededError——设备密钥那处在加密/解密备份的调用链上，异常会裸冒泡。其余写点是偏好类，抛了会让 UI 动作中断。项目一贯"显式暴露不静默"的纪律在这里是反例（多数写点有 try/catch，这 10 处漏了） | P3（影响面窄，但顺手补一层 try/catch 成本≈0） |

## 三、此前审计项修复完整性验证

| 项 | 来源 | 状态 |
|---|---|---|
| i18n 基线按内容登记（行号漂移免疫） | round71（我修） | ✅ 双闸仍绿；**并行会话也在改同一基线（438→341 行，清理了数据层存量），闸门 0 新增拦截正常** |
| SRS 调度全链路 / SW / 测试覆盖 | round72 | ✅ 无变化（本轮未触碰） |
| 回收站还原图片 / router.onError / 专注计时墙钟 | round54/53 | ✅ 上轮抽验在位，本轮 HEAD 未回退 |
| AI 流式 + 超时抢救（round73 并行） | 并行会话 | ⏳ 工作树 WIP（base.js/llm.js + 测试）未提交，不在本轮范围 |

## 四、结论（大白话）

1. **连续第五轮零必修**。数据模型（34 版演进架构自洽）、渲染安全（全出口净化）两个地基域干净。
2. **唯一 P3**：约 10 处 localStorage 裸写——真实影响窄（仅隐私模式/配额满），但和项目自己的"显式暴露"纪律不一致，攒批时用一行 try/catch 补上即可。
3. 并行会话在 AI 层（流式韧性）和 i18n 基线（存量清理）上动作中，闸门交叉验证正常，无冲突。

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round74 观察分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [0, 1, 0, 0] }
  ]
}
```
