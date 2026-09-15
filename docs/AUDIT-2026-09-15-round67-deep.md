# round67 深度审计报告（round65/66 并行修复验收 + 去重/插件/模式切换扫描）

- 日期：2026-09-15
- HEAD：`6d972e2`（round66 课程表护栏）+ `6b5f85b`（round65 导入行级校验）
- 工作树：`docs-suite/` + 并行报告 round53/55/56/60/61 未跟踪

## 一、验收并行会话 round65 + round66（两个提交，全过）

### round66 `6d972e2`：课程表脏值护栏——把我上轮 P2-1 修得比建议更完整

我上轮发现"脏 scheduledHour 在展示侧裸奔"（`sh < 6 || sh > 23` 对 NaN 恒 false → top:NaN → 课程表错乱）。并行会话的修法**超出我的建议**：

| 修复点 | 大白话 |
|---|---|
| `Number.isFinite(sh)` 显式校验 | 脏值（'9:00'/NaN/25/9.5）一律归"未排程"，不再画 NaN 坐标 |
| **`safeDur()` 统一时长兜底** | 我没想到的坑：`'abc' \|\| 60` 在 JS 里返回 `'abc'`（非空字符串是真值）而不是 60——裸 `\|\|` 兜底对字符串脏值**短路失效**。它把这条也修了 |
| label 用归一化后的 hour/durMin | 不再回头读 task 上的原始脏值，避免字符串偏移拼出 NaN 时刻 |
| scheduleOption（死代码）+ checkinTimeline（图外消失） | 一并修了（Number.isInteger 0-23 / Number.isFinite 0-23） |

### round65 `6b5f85b`：导入侧行级域校验——"出口设防"升级为"入口根治"

这是我 round61 之后反复强调的架构问题：`computeStats` 只在**读取侧**（出口）加护栏——脏行照样入库、随同步传播到每台设备，每个出口都得各自设防。round65 把它修到**入口**：

- **`sync-manifest.js` 新增行级净化**：导入 / 中枢合并入口统一清洗（hub.js 复用，两端行为一致）
- **三条设计原则**（缺一出事）：
  ① 只清洗字段值，**绝不丢行**（丢行 = 复习记录凭空消失）
  ② 只动"明确非法"的值，合法值（含 null/undefined）原样放行（兼容老包）
  ③ 时间戳做**可逆规范化**：数字字符串转数字，转不动的置 null——置 null 让该行 LWW 永远输给对端（安全降级）；留着字符串则 `'2026-09-15' > 1757894400000` 恒 false → **永不更新的僵尸行**，比置 null 糟
- **FIELD_DOMAINS 表专属域**：rating（与 computeStats 同口径）、type、scheduledHour（0-23）、estimatedMinutes——注释明确引用了我的 round64 报告（"展示侧守卫对 NaN 恒为 false，入口这一层是必需的"）
- **Agent 结构化结果可读化**：裸 JSON 甩给渲染器 → 按形状渲染成 `- key: value` 可读列表（数组/标准包装/错误对象各归其位；形状无法识别回退 JSON——**信息优先于美观，绝不返回空**）
- **提醒去重键清理**：REMINDED_PREFIX 键随计划删除清理

**评价**：round65 是最近几轮**架构价值最高**的提交——把"防脏数据"从每个出口的散兵游勇整合成入口的统一防线，且"置 null 让 LWW 安全降级"的设计深思熟虑。**建议写进毕设论文"数据完整性"章节。**

验证：全量 **1158/1158**（+31 回归）、lint 0、i18n 闸绿。

## 二、本轮新扫描（3 模块）

### sync-dedup.js（同步内容去重）——2 个 P3 观察

整体干净：内容键用 `\x01` 不可打印分隔符（round13 教训：`||` 会被卡面文本污染误判重复）、同 id 必走 mergeRows 绝不被去重丢弃、idRemap 重定向关联、引用字段注册表收敛（BUG-04）。

| 编号 | 观察 | 大白话 | 位置 |
|---|---|---|---|
| N1 | **空卡面判重**：键 = norm(front)\x01norm(back)\x01subject——front/back 都空的卡（如"占位卡"）只要 subject 相同就被判重复丢一张 | 空卡少，且合并后关联会重定向，实际影响低 | sync-dedup.js:37/48 |
| N2 | **词卡键含可选字段**：键 = word\x01meaning\x01subject——如果一台设备建的词卡 meaning 为空（从大纲捞词还没补全就同步），与另一台"同 word 有 meaning"的词卡**键不同不判重** → 同词双卡并存 | 只在"跨设备同步时一台没补全"的窗口发生；词卡补全链路（word-enrich）最终会合并吗？不会——去重已过，两张卡各自独立 | sync-dedup.js:72/80 |

N2 是更值得记的一条：去重键含"可能缺席"的字段会导致漏判。修法（如需要）：词卡键降级为 word\x01subject，meaning 参与合并而非键。**P3 观察，暂不动。**

### plugins/loader.js（插件加载）——干净

Blob URL + 动态 import（@vite-ignore）、FNV-1a 内容哈希缓存键、旧 Blob URL 释放防泄漏、编译失败显式抛错由 registry 标记 lastError、preview 即时释放。安全说明诚实（"Blob URL + 动态 import 本质上等同于 eval，无法真正沙箱化"，靠用户主动安装 + 结构化克隆 + 高危二次确认兜住）。

### stores/appMode.js（M3 演示模式）——干净

real/test **物理隔离**（两个 Dexie 实例）、切换 = localStorage + setDbInstance + 整页 reload（保证全视图重查）、测试库空→seed、非空→时间滚动（round33）、clearTestData 用 `db.tables` 动态枚举（round17 教训：手写 35 表清单落后 schema）。

## 三、此前审计项修复完整性验证

| 项 | 状态 |
|---|---|
| round64 P2-1（课程表脏值） | ✅ round66 已修且超出建议（safeDur） |
| round64 P3-1/3-2（死导出/图外消失） | ✅ round66 一并修 |
| round63（计划解析 6 缺陷） | ✅ 上轮验收，复跑全绿 |
| round61（统计层 4 P2） | ✅ 在码（computeStats 两级过滤 + dirtyReviews） |
| round54 P1（回收站还原图） | ✅ 在码（repo.js _images 快照 + 还原写回） |
| 历轮累计修复 | ✅ 抽查健在，零回退 |

## 四、结论（大白话）

1. **并行会话连续两轮高质量**：round65 把防脏数据从"每个出口设防"升级为"入口统一根治"（架构级），round66 把我上轮 P2-1 修得比我建议的更细（连 `'abc' || 60` 短路失效都堵了）。1158/1158 全绿。
2. **本轮新发现 0 个 P1/P2**，2 个 P3 观察（词卡去重键含可选字段 → 跨设备漏判；空卡面判重），均备忘级。
3. **工程格局已成型**：入口净化（round65）+ 读取侧两级过滤（round61）+ 展示侧护栏（round66）——**三层防线各司其职**，"脏数据必须显式暴露、不能静默吞掉"的纪律贯穿全链路。

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round67 新发现分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [0, 0, 0, 0] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [0, 1, 1, 0] }
  ]
}
```
