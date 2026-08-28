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
- 插件包（`.json` 单文件，含 manifest + 源码）可导出/导入，用于备份与分享。
- 插件存本地 IndexedDB（`db.plugins`，不同步），仅安装你信任的来源——插件代码在本应用上下文中执行。

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

## 测试

```bash
npm test
```

覆盖 FSRS 调度、同步合并语义、校准、预测、净值、apkg 解析、自我解释同步、插件系统（manifest 校验 / Agent 桥接 / 钩子映射 / 插件包）等 220+ 项断言，含 fake-indexeddb 的三条黄金路径集成测试（建卡→复习→到期闭环 / 备份冲突合并 / 删除→墓碑跨设备级联）。CI 中 `npm test` 作为发布门禁，失败则不构建不发布。

## 部署

`.github/workflows/deploy.yml`：push 到 `main` 后自动 `npm ci → npm test → npm run build` 并发布 GitHub Pages（base `/sxybrick/`）。AI 调用需用户自备 API 密钥，站点托管/HTTPS/构建全免费。

## 许可证

MIT
