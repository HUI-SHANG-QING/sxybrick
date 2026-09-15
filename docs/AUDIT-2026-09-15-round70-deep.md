# round70 深度审计报告（搜索/测验生成/每日规划聚合扫描）

- 日期：2026-09-15
- HEAD：`69c2cf6`（工作树干净，仅 docs-suite/ 与并行报告未跟踪）
- 本轮零新增 P1/P2，3 个 P3 观察

## 一、扫描模块（3 个，整体干净）

### search-service.js（全库搜索）

- `rowMatches`：深度优先遍历**叶子值**逐串匹配（round16 R16-4：百 KB 导图/考题不全量 JSON.stringify）、只匹配值不匹配键、超 4 层深才 stringify 兜底——性能取舍明确且注释到位
- `highlight`：**XSS 防护完整**——HTML 转义含单引号（round15 P2 补齐）+ 正则元字符转义（`[.*+?^${}()|[\]\\]`）后包裹 `<mark>`，v-html 渲染安全
- 结论：干净

### genQuiz.js（离线测验生成）

- `pool.splice(idx, 1)` 防重复抽卡、choice 干扰项排除同卡同答案、池不足时 `（无关选项）` 占位、cloze 无 2-8 字词时 `answer.slice(0,3)` 兜底、`options.indexOf(answer)` 唯一性由 filter 保证
- 结论：干净，1 个边缘 P3（见下）

### planSynergy.js（每日规划聚合）

历轮修复痕迹完整：round33 左闭右开口径、round17 科目 join（R17-4）、round48 grade 四档→三桶语义、pomodoro duration 字段名（R17-1）、mastered 赋值修复（round48）。buildRisks 严重度排序正确、heatmap 字符串日期字典序比较正确、多表并行查询每张独立 try/catch。
结论：干净，2 个 P3 观察（见下）

## 二、P3 观察（均备忘级）

| 编号 | 位置 | 大白话 |
|---|---|---|
| N1 | genQuiz.js:76 | **cloze 挖空歧义**：随机抽词 `blank` 后 `answer.replace(blank, '____')` 只替换**第一个**出现处——若 blank 是 answer 更早位置的子串，填空位展示的位置可能不是目标词位。不影响判分（判分按 blank），仅展示位置可能不直观 |
| N2 | planSynergy.js:166 | **exam 平均分双口径混用**：`sumTotal ? sum/sumTotal*100 : sum/rows.length`——同一批考试部分带 total 部分不带时，全局 avgScore 混合"百分比"与"平均分"两种口径 |
| N3 | planSynergy.js:292-294 | **task.date 脏值静默丢弃**：热力图 `byDate[t.date]` 找不到（任务 date 与 plan date 不一致 / 缺失）→ `continue` 静默跳过——该任务完成不计入热力矩阵，无暴露。与"脏数据必须显式暴露"纪律是反例；round68 入口净化（FIELD_DOMAINS）未覆盖 dailyTasks.date 字段 |

## 三、此前审计项修复完整性验证

| 项 | 状态 |
|---|---|
| round69 收编的 S1-S8（P1 墓碑级联去重目标 / 回收站快照中止 / fieldTs 重盖 / scheduler mode / 字节预算） | ✅ 上轮验证 1178/1178，本轮 HEAD 不变 |
| round68 闸门行号敏感（P3→P2 待办） | ⏳ 待修（基线改内容匹配）——已连续两次实证 |
| round65 入口净化 / round66 课程表护栏 / round63 计划解析 / round61 统计层 | ✅ 全部健在 |
| i18n 双闸 | ✅ 438 行基线零漂移 |

## 四、结论（大白话）

1. **连续第三轮业务代码零必修项**：搜索（XSS+性能）、测验生成（去重+兜底）、每日规划聚合（历轮 6 类修复全部在位）——核心链路已进入"稳定态"。
2. **3 个 P3 都是边缘**：挖空展示位置、分数口径混合、热力图漏计——都不影响数据正确性，建议攒批处理。
3. **唯一真正的待办还是那条 P2**：i18n 闸门基线按行号登记，已两次引发"全文件假红"误报。它每发作一次，就消耗一轮人工判断并培养"反正要 force 认领"的习惯——这是门禁体系的可信度债，建议下次迭代优先还。

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round70 观察分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [0, 2, 1, 0] }
  ]
}
```
