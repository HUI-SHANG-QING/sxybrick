# round68 深度审计报告（并行 WIP 收编验收 + i18n 闸门行号敏感缺陷）

- 日期：2026-09-15
- HEAD：`f128cd8`（收编并行会话 WIP：图片感知截断 + hasImage 提示）
- 工作树：`docs-suite/` + 并行报告 round53/55/56/60/61 未跟踪

## 一、收编并行会话 WIP（验收 + 修复闸门误报）

工作区遗留并行会话未提交 WIP（`src/agent/tools/index.js` + 新建 `src/utils/clip.js`）：

**WIP 内容**（设计自洽，验收通过）：
1. **clipText 图片感知截断**：卡片/笔记正文里的图片标记 `![alt](sxy-img://<36位uuid>)` 单条 56 字符——朴素 `slice(0, N)` 会拦腰切坏 id → 富集时 `db.images.get(残缺id)` 查不到 → 图静默丢。clipText 统一出口：正文照常截断、**图片引用完整保留追加末尾**；同时覆盖 `sxy-doc://` 页码后缀（截断会静默改变送图页码）。
2. **hasImage 提示**：列表类工具（get_weak_cards/list_cards）摘要只给前 60 字不保留引用（避免几十张卡的引用吃光送图额度），但附 `hasImage` 字段让模型知道"这张卡有图，去调 get_card_detail"。
3. 实现细节到位：hasImageRef 无 g 标志（无 lastIndex 状态）、clipText 每次新建 RegExp（防 lastIndex 残留）。

**验收中发现的真问题**：跑全量测试 **红**——i18n 数据层闸门报 tools/index.js "新增 140 处硬编码中文"。

## 二、真发现（P3）：i18n 闸门基线按行号登记——插行即全文件雪崩误报

**现象**：WIP 在 tools/index.js **文件头加了 4 行 import** → i18n 数据层闸门报"新增 140 处硬编码中文"。

**真相**：净增其实 **只有 1 行**（get_weak_cards 的 description 补了 hasImage 说明）。其余 139 处是**存量中文**——基线 `scripts/i18n-js-hardcode-baseline.json` 对每个文件按**行号**登记 reasons（`src/agent/tools/index.js` 原登记 32/36 两行），文件头插行 4 行后全部行号漂移 → 全文件中文"失配" → 逐一误报。

**根因**：基线 key 是"文件 + 行号"，对插入/删除行**零鲁棒性**。任何开发者在 src/.js 头部加 import/注释都会触发同一文件全量假红。

**影响**：不是运行缺陷，是**门禁体系可信度风险**——假红频发会培养"反正要 force 重认领"的习惯（警报疲劳），真违规混在其中时反而可能被忽略。闸门脚本自己预见了"插行位移"场景（`--force-baseline` 需人工确认），但识别责任完全落在人身上。

**处置**：确认位移场景后 `--js-update-baseline --force-baseline` 重认领（437→438，净增 1 行正是 WIP 合法新增），闸门复绿。

**建议**（P3，备忘）：基线改"文件 + 归一化字符串内容"匹配（或内容哈希）与行号解耦——插行不失效，假红归零。改动集中在 check-view-i18n.mjs + 基线格式迁移，收益是门禁可信度。

## 三、语音模块扫描（speak.js / tts.js）——干净

- speak.js（英文词卡朗读）：浏览器原生 SpeechSynthesis、**Safari 30s 超时兜底**（F-29，onend/onerror 可能永不触发）、先 cancel 防排队叠加、try/catch 全包、非浏览器环境静默降级
- tts.js（笔记朗读）：独立的轻量封装（mdToSpeech + zh-CN），与 speak.js 功能重叠但各司其职
- 无后端、离线可用、无 API key 泄漏面

## 四、验证与完整性

- 全量 **1169/1169**（WIP 收编后，五道门禁全绿）
- lint 0 · i18n 双闸绿（438 行基线，0 新增）
- 历轮修复抽查：round65 入口净化 / round66 课程表护栏 / round63 计划解析 / round61 统计层 —— 全部健在

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round68 发现分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
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
