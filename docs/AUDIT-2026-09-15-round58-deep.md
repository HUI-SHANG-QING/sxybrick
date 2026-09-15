# round58 深度审计报告（生成器 / 计划解析 / 草稿链路）

- 日期：2026-09-15
- HEAD：`cc4c995`（本轮修复已推送）｜ 前一提交：`6f54d71`（并行会话，备份导入失败路径）
- 工作树：仅 `docs-suite/` 与 round53/55/56 三份并行报告未跟踪（按用户要求保留）

## 一、前序修复完整性验证（用户点名必答项）

| 前序提交 | 修复内容 | 核验结果 |
|---|---|---|
| `6f54d71`（并行） | 备份导入配额写满降级 + 损坏包可读错误 | ✅ 修复扎实：图片 bulkPut/墓碑 bulkDelete 失败就地降级进 `stats.imageWriteFailed`，不虚报 `stats.images`；主事务配额失败走 `quotaExceeded` 专属文案；损坏包给可读错误。5 条回归在位 |
| `09a050e`（上轮） | 农历范围守卫 | ✅ 本次全量回归仍绿（守卫测试 8/8 健在） |

全量测试：**1101/1101** 绿（较上轮持平，本轮新增断言在既有 test 块内）。

## 二、本轮审计域（前几轮未碰的外围生成/解析层）

`offlineAI.js`（离线 AI 降级）→ `genScoring.js`（卡片评分/题型决策）→ `card-drafts.js`（资料→草稿）→ `plan-parser.js`（口述→计划解析）。

## 三、问题清单

### P2 · 已修复：`splitTasks` 英文句号不切分（注释与实现不符）

- **位置**：`src/utils/plan-parser.js:189-195`
- **现象**：注释写明「分句：换行 / 分号 / 中文句号 / **英文句号** / 顿号切分」，但正则 `[\n\r;；。、]+` 里**没有英文句点**。实测 `'Do A. Do B.'` 整段粘连成 1 个任务——离线解析路径（不调 LLM 时）英文口述任务全粘一起，任务数少算、标题超长。
- **根因**：注释声明的契约与实现不一致；历史上没加 `.` 大概率是防小数（`1.5 小时`）误切，但实现连"英文句号后跟空格"的区分都没做。
- **修复**：`split(/[\n\r;；。、]+|[.](?!\d)(?=\s|$)/)` —— 英文句号仅在**后跟空白或行尾**时切；`(?!\d)` 保护小数（`'复习 1.5 小时'` 实测保持单段）。
- **已知权衡**：`i.e.` 等英文缩写会被切（`'i.e'` + 后半段）。口述计划场景缩写极罕见，接受并已写入注释。
- **验证**：plan-parser 套件 11/11（新增 3 条断言：英文句号切 / 小数不切 / 行尾切）、全量 1101/1101、lint 0、i18n 闸绿。

### P3 · 观察（启发式通病，建议暂不修）

| 编号 | 问题 | 大白话 | 位置 |
|---|---|---|---|
| N1 | `detectIntent` 意图误判 | 普通聊天说「帮我拆解一下这个问题」会命中 `/拆解/` 误入卡组生成分支（离线兜底行为不同，影响小） | `offlineAI.js:12-19` |
| N2 | `(?<=)` lookbehind 正则 | 旧 Safari（<16.4，2023 前）不支持 lookbehind，`offlineGenDeck` 会抛 SyntaxError。现代手机基本不受影响 | `offlineAI.js:78` |
| N3 | `decideType` 选项误判 | 背面正文某行恰好以 `A.` 开头（如「注意：A. 表示正确」）会被判成选择题 | `genScoring.js:60` |
| N4 | `splitQA` 小节号误判 | 讲义「1.1 背景」被题号正则拆成题号 1 + 题干「1 背景」 | `card-drafts.js:20` |
| N5 | 否定词误判 | 「不着急，明天再说」含「急」→ 判紧急；「不重要」含「重要」→ 判重要。关键词启发式没处理否定前缀 | `plan-parser.js:42-48` |
| N6 | 「晚」字误判 | 「最晚 8 点出门」的「晚」被当晚上时段前缀 → 8+12=20 点 | `plan-parser.js:127/135/144` |

N5/N6 属于"关键词启发式"的固有上限（要根治得上否定前缀表 + 语义分析，收益不成比例）；N1-N4 触发条件都偏罕见，标为备忘，下次大版本迭代时统一评估。

## 四、根因分析

本轮唯一的硬缺陷（N 已修）是**注释契约与实现脱节**：文档承诺了英文句号切分，代码没兑现，且直接补 `.` 会引入小数误切——这类"注释比实现先进"的漂移比"没注释"更隐蔽，因为测试只覆盖了注释承诺的中文场景（`tests/plan-parser.test.mjs:12-15` 的用例里根本没英文句号）。

## 五、改进建议（影响 ÷ 成本）

1. **（已做）** splitTasks 补英文句号 + 小数保护 —— 2 行 + 3 断言，离线解析正确性直接提升。
2. N5 否定词：若后续计划功能被吐槽「我明明说不急还标紧急」，可在 Q2/Q3 词表前加 `不|别|无需|不用` 前缀否定——约半小时，纯启发式增强。
3. N1-N4/N6：维持观察，随大版本迭代统一评估。

## 六、历史修复完整性

- 历轮修复标记抽查：round48 词库优先级 / round49 截断续写 / round50 输出长度 / round54 十二项 / round57 导入配额 —— 全部健在，无回退。
- 本轮无新增待办（N1-N6 为观察级，不入待办）。

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round58 问题分布（四维 × 优先级）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 1, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [2, 3, 0, 1] }
  ]
}
```
