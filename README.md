# SxyBrick 记忆卡片

> 考研复习的**本地优先**记忆系统：FSRS 间隔重复 + 10 个 AI 智能体 + 知识图谱 + 知识资产化，数据全部存你浏览器里，零服务器、可离线、免费部署。

🔗 在线使用：https://hui-shang-qing.github.io/sxybrick/

---

## 它是什么

SxyBrick 是一套面向考研（计组 / 线代 / 系统概论 / 编译原理等）的记忆卡片系统，核心是**让复习这件事更科学、更可度量**：

- **FSRS-4.5 调度**：用记忆可提取性方程 `R = (1 + t/9S)^-1` 预测每张卡「你现在还记得多少」，据此安排下一次复习；支持权重训练、校准回测、到期洪峰预测。
- **本地优先 PWA**：所有卡片 / 复习记录 / AI 对话 / 知识图谱都存 IndexedDB，断网可用；AI 调用仅需你自备 API 密钥（存 localStorage），数据不出本机。
- **AI 智能体层**：10 个领域智能体（导师 / 分析师 / 制卡师 / 出题官 / 规划师 / 记忆管家 / 助记师 / 错题分析师 / 图谱构建 / 智能复习官），通过统一工具协议协同，开闭原则可扩展。
- **跨设备同步**：局域网中枢（hub）或 JSON 备份，双时间戳字段级合并 + 墓碑传播，保证内容编辑与 SRS 进度互不覆盖。

## 快速上手

```bash
npm install        # 安装依赖
npm run dev        # 本地开发（Vite）
npm test           # 运行全部单元测试（190+ 项）
npm run build      # 生产构建（产出 dist/）
npm run preview    # 本地预览生产构建
npm run hub        # 启动局域网同步中枢
```

> 首次使用：新建卡片 → 在「专注背诵」页按到期队列复习（空格翻面，1/2/3 自评）→ 到「复习数据」看校准曲线与到期预测。

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Vue 3.5 · Vite 6 · Pinia |
| 存储 | Dexie / IndexedDB（v16，16+ 张表） |
| 调度 | FSRS-4.5（19 权重、有限差分梯度训练、校准回测） |
| 可视化 | ECharts · 词云 · 热力图 · 雷达图 |
| 公式/排版 | KaTeX · marked · highlight.js |
| AI 智能体 | 运行时工具/Agent 注册（`registerTool` / `registerAgent`） |
| 测试 | node:test + fake-indexeddb（190+ 项，含三条黄金路径集成测试） |

## 目录结构

```
new_card/
├── src/
│   ├── agent/              # 智能体层：types/llm/context/memory/registry/
│   │   │                   #   orchestrator/agents/tools + analytics(统一数据访问)
│   │   ├── analytics.js    # 跨模块数据访问层（单卡画像/错题/校准/净值/预测）
│   │   └── tools/          # 工具注册（semantic_search/retrieve_context/calibration_report...）
│   ├── algorithms/         # 纯函数算法层（Node 可单测，无 IO）
│   │   ├── fsrs.js         #   FSRS-4.5 调度核心（19 权重）
│   │   ├── session.js      #   交错练习 + 检索分级
│   │   ├── calibration.js  #   校准回测（预测 R vs 实际正确率）
│   │   ├── calibration-feedback.js # 校准闭环（偏差反馈 desiredRetention）
│   │   ├── forecast.js     #   到期洪峰预测
│   │   ├── networth.js     #   知识净值（资产资产负债表）
│   │   ├── adaptive-retention.js  # 每科自适应目标保持率
│   │   ├── golden-hours.js #   黄金时段推荐
│   │   ├── prereq.js       #   前置依赖多层 BFS 回溯
│   │   └── ...
│   ├── repo.js             # 数据访问层（卡片/复习/统计，纯函数抽至 repo-core.js）
│   ├── sync.js             # 导出/导入/局域网同步
│   ├── sync-manifest.js    # 同步清单唯一事实来源（新增表只需改这里）
│   └── views/              # 视图：Review/Stats/Cards/Health/UserDashboard/AgentWorkbench...
├── tests/                  # 单测（*.test.mjs，glob 自动发现）
├── docs/                   # 设计文档 / 评审报告 / 路线图
└── .github/workflows/      # CI：npm test 门禁 + 构建发布 Pages
```

> `server/`（旧 Express+SQLite 架构）与 `web/`（旧前端）已被 `src/` 取代，仅作历史参考，不在本仓库构建链内。

## 核心机制速览

- **卡片字段级同步**：内容按 `updatedAt`、SRS 按 `reviewedAt`、错因按 `wrongReasonAt`、反思按 `selfExplainAt` 各自取新，复习动作不覆盖文字编辑。
- **墓碑传播**：删除写 `tombstones`（带 kind），跨设备级联删除卡片 + 复习记录 + 孤儿图片。
- **校准闭环**：复习落盘预测 R → 分桶对比实际正确率 → 偏差自动反馈到目标保持率，调度器自我校正。
- **知识资产化**：每张卡有价值（内容权重 × 记忆保持度），净值 = 资产原值 − 遗忘折旧，Health 页看「知识资产负债表」。

## 插件系统（Phase 4：平台化）

插件是「把 Agent 能力交还给用户」的扩展机制——用户粘贴一段 ES Module 代码即可给应用添加**工具**（Agent 可调用的能力）、**Agent**（自定义角色）与**事件钩子**（响应卡片保存/删除、复习评分等动作）：

- 工具定义与 **MCP 协议** 兼容（`name/description/inputSchema`），未来可桥接真正的 MCP server。
- 安装后插件工具自动注册进全局 Agent 注册表，在「Agent 工作台」与 AI 助手中模型可直接调用；导出 `agents` 可注册自定义 Agent。
- 工具/钩子函数可接收第二个参数 **运行时上下文 ctx**（只读）：`ctx.analytics`（统一数据层：错题/到期预测/净值/科目诊断等）+ `ctx.data`（备忘录/番茄/计划只读查询）+ `ctx.notify()`（系统通知）——插件可读应用数据但无写权限，安全隔离。
- 插件包（`.json` 单文件，含 manifest + 源码）可导出/导入，用于备份与分享。
- 插件存本地 IndexedDB（`db.plugins`，不同步），仅安装你信任的来源——插件代码在本应用上下文中执行。

**官方示例库**（插件页一键安装，源码在 `src/plugins/examples/`，可作开发模板）：

| 插件 | 能力 | 演示点 |
|---|---|---|
| `word-count`（基础） | 字数统计 + 卡片摘要 | manifest/工具/钩子最小形态 |
| `weekly-review`（错题周报） | 近 7 天错题/正确率/科目分布 + 周报 Agent | ctx.analytics 只读数据 + Agent 注册 |
| `pomo-stats`（番茄统计） | 今日/本周专注时长、按标签拆解 + Agent | ctx.data 只读查询 |
| `due-alert`（到期提醒） | 到期洪峰分布 + 复习后超阈值浏览器通知 | ctx.analytics + ctx.notify + onReviewRated 钩子 |

事件钩子（`SUPPORTED_HOOKS`）：`onCardSaved` / `onCardDeleted` / `onReviewRated` / `onMemoSaved` / `onExamFinished` / `onSyncCompleted`，由 repo.js 与 sync.js 在业务动作后 fire-and-forget 分发，插件异常不影响主流程。

示例（`src/plugins/example-plugin.js`，插件页一键安装）：

```js
export const manifest = {
  name: 'word-count',
  version: '1.0.0',
  description: '统计卡片正反面字数',
  tools: [{
    name: 'count',
    description: '统计给定文本的字符数（中文按 1 字、英文按单词）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }],
  hooks: { onCardSaved: 'onCardSaved' },   // 卡片保存时被调用
};

export async function count(args) {
  const text = String(args?.text || '');
  return { chars: text.length };
}

// 可选：自定义 Agent，安装后出现在 Agent 工作台
export const agents = [{
  id: 'word-count-assistant',
  name: '字数助手',
  description: '统计卡片正反面字数，输出简洁报告',
  systemPrompt: '你是简洁的统计助手。用户要求统计字数时调用 count 工具。',
  tools: ['count'],
}];
```

## 资料中心（Phase 6：学习资料中枢）

把复习系统升级为「学习资料中枢」——上传真题/讲义/笔记（PDF / Excel / Word / TXT / 图片），**全量解析入库**（几百 MB 大文件逐页流式，绝不切片丢内容）→ 原样预览 → 对文件提问 → 一键生成记忆卡片：

- **存储**：原文件存浏览器 **OPFS 专属大仓库**（4MB 分块写入，内存受控）；元数据同步、原文全文本地。≤10MB 小文件在 OPFS 不可用时自动降级 IndexedDB。原文件**不跨设备同步**（跨设备可见清单，可重新导入）。
- **解析管线**（`src/utils/parsers*.js`，懒加载分包不进首屏 bundle）：
  - PDF：pdfjs-dist 逐页流式提取，保留换行结构；扫描版图片 PDF 检出后提示走 OCR。
  - Excel：SheetJS 全表文本化（`【工作表：name】` 前缀分表）。
  - Word：mammoth 提取纯文本 + 近似 HTML 预览。
  - TXT / 图片：直读 / 预览。
  - 解析队列**串行执行**，防多个大文件并发挤爆内存；状态机 `uploading → parsing → ready / failed`，失败可重试。
- **OCR（扫描版识别）**：本地 **Tesseract** 优先（`src/utils/ocr.js` 纯函数 + `docs-lib.ocrDoc` 编排，worker/核心 wasm 本地化 `public/ocr/`，数据不出浏览器、离线可用）；扫描版 PDF 用 pdfjs 逐页渲染（2x 缩放）→ 逐页识别，图片直接识别（长边压 2000px 防爆内存）；可切**云端 OCR**（OpenAI 兼容视觉端点，需自备 API Key）；语言可选简中/英文/繁中，语言包首次自动下载并缓存。
- **预览**：PDF 画布翻页、Excel 表格、Word 近似 HTML、图片、TXT 全文——全部原样在线预览。
- **文件问答**（RAG）：全量文本切块 → 本地检索（预留语义 embedding 开关）→ 仅依据命中片段作答 + 引用标注；无检索结果时离线兜底，不崩溃。
- **生成卡片（用户选择制）**：**默认不建卡**——用户点「生成卡片」→ 弹出草稿预览弹窗（每张可编辑/删除）→ 点「确认导入」才入库（记 `docFiles` 血缘，卡片可反查原文）；可整体取消。
- 数据表：`docFiles`（同步元数据）+ `docTexts`（本地全文），避开旧 `docs` 表；复用 `embeddings`（`sourceType:'doc'`）做检索。

## 测试

```bash
npm test
```

覆盖 FSRS 调度、同步合并语义、校准、预测、净值、apkg 解析、自我解释同步、插件系统（manifest 校验 / Agent 桥接 / 钩子映射 / 插件包 / 官方示例）、资料中心（OPFS 路由 / 解析器 / 建卡草稿 / 文件问答 / OCR 纯函数与黄金路径）等 265+ 项断言，含 fake-indexeddb 的五条黄金路径集成测试（建卡→复习→到期闭环 / 备份冲突合并 / 删除→墓碑跨设备级联 / 资料上传→解析→索引→检索→确认建卡→删除 / 图片上传→OCR→全文入库→检索）。CI 中 `npm test` 作为发布门禁，失败则不构建不发布。

## 部署

`.github/workflows/deploy.yml`：push 到 `main` 后自动 `npm ci → npm test → npm run build` 并发布 GitHub Pages（base `/sxybrick/`）。AI 调用需用户自备 API 密钥，站点托管/HTTPS/构建全免费。

## 许可证

MIT
