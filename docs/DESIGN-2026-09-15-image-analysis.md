# 设计：卡片图片全屏 + AI 图片分析（OCR 先行 + 视觉兜底）

日期：2026-09-15
需求：① 卡片图片点击全屏显示；② AI（对话/Agent/联动）分析数据时图片不再隐形；
③ 设置里提供「先 OCR / 先云端多模态」策略开关 + 每个选项详情与优缺点；
④ 根据系统数据（数字资产里图片数量）自动推荐策略；
⑤ 多模态接口复用「AI 设置」里现有的 AI API（不新增 key 字段）；全屏必须做。

## 0. 现状事实（代码实锤）

- 图片存储：Blob 存 `db.images`，正文用 `sxy-img://<id>` 占位符（src/images.js）。
- 卡片图片渲染**唯一汇聚点**：`src/components/MarkdownRenderer.vue` 第 71 行
  （Cards/WordBook/CardModal 等所有卡片视图都经此组件渲染 `sxy-img://`）。
- AI 链路现状（图片全隐形）：
  - `src/agent/retrieval.js:86` `chunkText(doc.content)` —— 只切文字；
  - `src/agent/llm.js` `chat(messages,cfg,opts)` —— OpenAI 兼容 /chat/completions，
    message.content 只传字符串，无 image_url 通道；
  - 卡片/笔记/资料 → RAG 索引 → retrieveContext → 喂给 chat，全程无图片。
- 可复用资产：
  - 云端 OCR 已是多模态格式：`src/utils/ocr.js:74 buildCloudOcrRequest`
    （content 数组 + image_url，默认 gpt-4o-mini），`docs-lib.js:334 defaultRecognize`
    已实现「云端优先 / 本地 Tesseract 兜底」；本地 `recognizeLocal` 离线免费。
  - 设置存储：`wordSettings` 单行（id='me'），`word-repo.js:721 saveWordSettings(patch)`。
  - AI 配置：`form.llmProvider/llmModel/llmApiKey/llmBase`（WordSettings.vue），
    agent 侧 cfg = { baseUrl, apiKey, model } 同一套来源。

## 1. 数据模型（新增字段，全部可缺省，旧数据零迁移）

`wordSettings.imageAnalysis`（新增对象，旧行没有时按 auto 缺省）：

```json
{
  "imageAnalysis": {
    "mode": "auto",        // auto | ocrFirst | visionFirst
    "autoChosen": "ocrFirst" // auto 模式下推荐器算出的选择（展示用，auto 实际执行 ocrFirst+兜底）
  }
}
```

三档语义：
- `auto`（默认）：含图内容走「OCR 先行」；OCR 不可用或质量差 → 自动切视觉（若视觉可用）→
  都不行则只分析文字并在结果里注明「N 张图片未纳入分析」。
- `ocrFirst`：只 OCR，视觉永不主动调用（省钱/纯离线场景）。
- `visionFirst`：含图内容直接发图给多模态模型，OCR 仅作视觉不可用时的兜底。

视觉模型 = 复用现有 AI 设置（llmProvider/Model/Key/Base），**不新增字段**。
（用户若想用专用视觉模型，把 AI 设置里的 model 填成视觉模型即可——说明里写清楚。）

## 2. 推荐算法（基于真实数据统计，纯前端可算）

统计口径（复用 `extractImageIds`）：
- 扫描 `cards.front/back`、`notes.content`、`memos.content`、`docFiles` 文本
  → 图片占位符总数 `imgRefs`，对应唯一图片 id 数 `imgCount`（db.images.count 校验孤儿）；
- 含图文档数 `imgDocs` / 总文档数 `docs`（cards+notes+memos+docFiles）。

推荐规则（保守、可解释，UI 展示命中原因）：
- `imgRefs == 0` → 推荐 `auto`（没有图，无差别）；
- `imgRefs > 0 且 本地 Tesseract 可用（已装语言包/可下载）` → 推荐 `ocrFirst`
  理由：「你的数据里有 N 张图，绝大多数是文字截图/扫描件，本地识别免费且离线」；
- `imgRefs > 0 且 本地 OCR 不可用 且 已配置 AI Key` → 推荐 `ocrFirst`（云端 OCR 通道）
  理由：「本地语言包不可用，将使用你已配置的 AI 接口做识别（少量费用）」；
- `imgRefs > 0 且 含图文档占比 > 50%（imgDocs/docs）` → 推荐 `visionFirst`
  理由：「过半文档核心是图，直接看原图分析更准（按张计费，注意费用）」；
- 兜底 `auto`。

展示：设置面板内一行「根据你当前的 N 张图片 / M 个文档，推荐：xxx（原因）」。
推荐只在用户切到该设置区时实时计算（一次扫描毫秒级，量级 ≤ 几万行），不后台轮询。

## 3. AI 链路改造（核心，3 个改动点）

### 3.1 retrieval.js：索引/检索时的图片文字化（OCR 先行）
- 新增 `src/services/image-analysis.js`（新文件，聚合层）：
  - `analyzeImageSettings()` → 解析 mode（auto 时 = ocrFirst + 允许视觉兜底标志）；
  - `textifyContent(content)` → 检测 `sxy-img://` 占位：
    - 无图 → 原样返回（零开销）；
    - 有图 → 按 mode：
      - ocrFirst/auto：逐张 `defaultRecognize`（云端优先→本地 Tesseract），
        文本追加到 content 末尾 `[图片1 OCR] ...`，带 AbortSignal 可取消，
        单张超时 30s 失败跳过（不阻塞主流程）；
      - visionFirst：保留占位符并产出 `visionRefs: [imageId...]`，不 OCR；
    - 全部 OCR 失败且 mode 允许视觉 → 转 visionRefs 交给视觉兜底；
    - 都不行 → 追加 `[图片N 未能识别，未纳入分析]`。
  - `statImageAssets()` → 第 2 节的统计；
  - `recommendMode(stats)` → 第 2 节规则，返回 {mode, reason, stats}。
- `retrieval.js` `indexDoc(doc)` / `retrieveContext` 喂块前调 `textifyContent`：
  - **OCR 结果写回**：只进本次索引/上下文的副本，**不覆盖原文**（原文是用户的，
    OCR 文本只是分析用的增强层）；
  - 检索命中卡片时（tools/index.js:761 retrieveContext 路径）同样走 textifyContent。

### 3.2 llm.js：content 支持多模态（最小改动）
- `chat()` 请求体不变（OpenAI 兼容），仅允许 message.content 为数组
  （[{type:'text'},{type:'image_url',image_url:{url:'data:...base64'}}]）——
  现状已原样透传 messages，**只需确认不做字符串化处理**（现无，故 0 改动或仅注释）；
- `estimateTokens` 对数组 content 按 text 部分估算（vision token 估算粗算 1k/图，只影响记账）。

### 3.3 视觉兜底调用点（谁发图）
- `retrieveContext` 返回 `visionRefs` 时，由 agent 侧（context.js / tools/index.js
  拼装 messages 处）把前 3 张图（上限控费用）base64 化挂到最后一条 user message
  的 content 数组（复用 `blobToBase64`，压缩到 ≤1568px JPEG q0.8 控制体积）。
- 无 AI Key 或模型不支持 → 优雅降级：结果附「检测到 N 张图片，当前未配置可用视觉通道」。

### 3.4 记账
- 视觉调用照常走 `recordUsage(source:'vision')`；OCR 云端调用已有独立入口（docs-lib 自带
  endpoint/key 时可归 source:'ocr'）——不新增表，复用 aiUsage。

## 4. 卡片图片全屏（独立于 AI 链路）

- 改 `MarkdownRenderer.vue`：给 `.md-img` 加 `@click`（事件委托，v-html 出口内
  用容器级 click + closest('.md-img')，不逐节点绑定）→ 打开全屏灯箱；
- 灯箱实现：优先 `element.requestFullscreen()`（原生全屏，与 AI 助手/知识图谱同一心智），
  失败（CSP/iframe）→ CSS fixed 铺满兜底（项目已有同类模式可参照 AIAssistant）；
- 灯箱内：居中缩放（滚轮 0.5~4x、双击复位、拖拽平移）、ESC 退出、点空白退出、
  显示序号「i/N」（同文档多图可 ←/→ 切换）；
- 资源：`imgUrl(id)` 现成 objectURL，退出后不 revoke（LRU 缓存自己管）；
- 组件零新依赖，纯 Vue + 原生 API。

## 5. 设置 UI（WordSettings.vue）

- AI 区块下新增「图片分析」小节：
  - 三选一 radio：自动 / 先 OCR / 先多模态；
  - 每档一段说明（详情+优缺点，i18n 中英）；
  - 推荐条：`根据你当前的 N 张图 / M 个含图文档，推荐「xxx」——原因`，附「应用推荐」按钮；
  - 提示：视觉模式复用上方「AI 设置」的接口与模型（不新增 key）。
- 保存：`saveWordSettings({ imageAnalysis: {...} })`。

## 6. 边界与不变量

- 原文零污染：OCR 文本只进分析副本；
- 费用护栏：visionFirst 单次最多 3 张图；auto/ocrFirst 视觉兜底单次最多 1 张；
- 全部图片处理失败不影响主流程（降级纯文字 + 明确告知）；
- 不新增 npm 依赖、不动同步 schema（wordSettings 是自由对象，新字段对同步无感）；
- i18n 中英双份；测试：image-analysis 的推荐规则/textifyContent 走单测（mock OCR）。

## 7. 实施切分（文件不重叠，可并行）

- A：src/agent/retrieval.js + src/agent/context.js + src/agent/tools/index.js（OCR 接入 + visionRefs 透传）
- B：src/services/image-analysis.js（新）+ src/agent/llm.js（多模态注释/记账）
- C：src/components/MarkdownRenderer.vue（全屏灯箱）
- D：src/views/WordSettings.vue + src/i18n/views/wordSettings.js（设置 UI）
- E：tests/image-analysis.test.mjs（新）
主 agent 负责跨文件接线审查 + 全量验证 + 提交。
