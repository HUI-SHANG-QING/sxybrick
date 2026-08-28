# SxyBrick 资料中心（Phase 6）规划 v1

> 定位：从「记忆卡片系统」升级为「学习资料中枢」——资料上传 → 全量解析 → 原样预览 → 文件问答 → 模块联动，让资料成为整个复习系统的知识源头。
> 状态：规划已确认（2026-08-28，用户四项决策落定），待开发。

---

## 一、用户需求与已确认决策

| 需求 | 内容 | 决策 |
|---|---|---|
| 上传格式 | PDF / Excel / 图片 / Word / TXT 等主流格式 | 全支持 |
| 大文件 | 几百 MB 扫描版 PDF，解析必须**全量**（不切片丢内容） | **OPFS 存原文件** + IndexedDB 存元数据/解析文本 |
| 扫描件 | 图片型 PDF 需 OCR 提取 | **本地 Tesseract.js 优先 + 可选云端 OCR**（设置切换） |
| 预览 | 原格式原样预览 | PDF.js / SheetJS / 原生渲染；Word 用 mammoth 近似预览（接受降级） |
| 问答 | 对资料提问，交互式问答 | **本地降级 embedding 默认 + 语义 key 开关预留**（分层架构） |
| 联动 | 与卡片/复习/图谱协同 | **知识图谱第一优先**，随后自动建卡 / 错题溯源 / 复习上下文 |

**关键认知（已与用户对齐）**：
1. 「全量解析」与「问答分块」是两回事——解析入库**全文完整**（逐页流式 append，字符不丢）；问答时才按 500 字切块建索引（只是「抽屉标签」），全文始终完整保留。
2. 几百 MB 文件**不跨设备同步**——只同步元数据 + 解析文本 + 向量索引；原文件留本机（OPFS），跨设备不可见但可问答/可联动。

---

## 二、架构总览

```
┌─────────────┐   ┌──────────────┐   ┌────────────────┐
│  上传存储     │ → │  格式解析      │ → │  全文 + 向量入库  │
│ OPFS+docs表 │   │ pdf/ocr/xlsx │   │ indexDoc(现成)  │
└─────────────┘   │ /docx/txt    │   └───────┬────────┘
                  └──────────────┘           │
        ┌───────────────────────────┬────────┴──────────┐
        ▼                           ▼                   ▼
┌──────────────┐           ┌──────────────┐    ┌────────────────┐
│ 在线预览      │           │ 文件问答      │    │ 模块联动         │
│ PDF/表/图/文 │           │ hybridSearch │    │ 图谱/建卡/溯源   │
└──────────────┘           └──────────────┘    └────────────────┘
```

### 各层职责与复用

| 层 | 新建 / 复用 | 说明 |
|---|---|---|
| 存储层 | 新建 | OPFS 存原文件 Blob；`docs` 表（IndexedDB）存元数据 + 解析全文；`embeddings` 表复用（已有 `sourceType: 'doc'` 概念） |
| 解析层 | 新建 | `src/utils/parsers/`：pdf-text（pdf.js 逐页流式）、sheet（SheetJS）、docx（mammoth）、ocr（Tesseract.js 本地 / 云端开关）、txt/md 直读 |
| 索引层 | **复用** | `src/agent/retrieval.js` 的 `chunkText / indexDoc / hybridSearch / retrieveContext` 全链路现成 |
| 服务层 | 新建 | `src/docs.js`：上传（分块写 OPFS + 进度）、解析状态机（uploading→parsing→ready/failed）、预览取流、问答编排 |
| 视图层 | 新建 | `Library.vue`（资料库列表/上传/进度）+ 预览面板 + 问答面板；路由 `/library` |
| 联动层 | 部分复用 | graph-builder（现成 Agent）接解析文本抽概念建边；cardsmith（现成）接文本生成卡片；source-trace 血缘扩展 sourceType 到 doc |

### 依赖链（防循环）
- `docs.js` 依赖 db / parsers / retrieval / ai —— 单向
- 插件 ctx 扩展 `ctx.docs`（只读查询）—— 沿用惰性动态 import 模式，不进静态链

---

## 三、数据模型（docs 表，v17）

```
docs: 'id, name, ext, size, mime, subject, status, storage, createdAt, updatedAt'
  id          string  主键 uid()
  name        string  原始文件名（含扩展名）
  ext         string  小写扩展名 pdf/xlsx/docx/txt/md/png/jpg...
  size        number  字节数
  mime        string  MIME 类型
  subject     string  所属科目（可选，联动按科目过滤）
  storage     string  'opfs' | 'idb'（小文件降级 idb）
  opfsPath    string  OPFS 内相对路径（storage=opfs 时）
  status      string  uploading | parsing | ready | failed
  text        string  解析全文（ready 后写入；大文本用单独 text 字段直存）
  textLen     number  全文长度（进度/完整性指标）
  pageCount   number  PDF 页数（可选）
  ocrUsed     boolean 是否走了 OCR
  ocrEngine   string  'local' | 'cloud'
  error       string  失败原因
  createdAt / updatedAt  number
```

同步策略：docs 表登记进 `sync-manifest.js`，但**大字段（text/原文件）标记 EXCLUDED**——只同步元数据与状态（跨设备可见文件清单，点击可看「本机无原文件」提示）。新增 `DOCS_TEXT_LOCAL` 约定，导出时可选携带解析文本。

---

## 四、开发阶段（按依赖顺序）

### 6.1 存储与上传（地基）
- OPFS 封装 `src/utils/opfs.js`：`saveFile/readFile/deleteFile/stat` + 容量估算 + 持久化申请（`navigator.storage.persist()`）
- `docs` 表建表（db v17）+ sync-manifest 登记（元数据同步）
- `src/docs.js`：`uploadFile`（File → 分块写 OPFS → docs 行）、`listDocs/deleteDoc`
- `Library.vue`：资料库列表 + 上传（多选、进度条、大文件分块提示）+ 删除
- 纯函数：docs 状态机、文件名归一、扩展名→解析器路由表

### 6.2 解析管线（文字类优先）
- `src/utils/parsers/`：
  - `pdf-text.js`：pdf.js **逐页流式提取**（getTextContent 逐页 append，进度回调，可取消；内存受控，几百 MB 不炸）
  - `sheet.js`：SheetJS 全表读取 → 文本化（每 sheet 每行拼接，保留表头）
  - `docx.js`：mammoth 转纯文本 + 近似 HTML（预览用）
  - `txt-md.js`：直读
- 解析状态机接线：uploadFile 成功后自动入队解析（串行队列 + 进度），失败可重试
- **完整性保障**：解析完成后 textLen 与预估比对，OCR 版打印「已提取 N 页」；大 PDF 用「逐页进度」而非整体切片

### 6.3 索引与预览
- 解析完成 → 调 `indexDoc({ id, content: text, subject })` 建向量索引（现成）
- 预览：
  - PDF：pdf.js canvas 渲染（原样翻页、缩放）
  - Excel：SheetJS 渲染表格（只读样式化）
  - Word：mammoth 近似 HTML（标注「近似预览」）
  - 图片 / TXT / MD：原生
- Library.vue 内嵌预览面板（大文件懒加载：仅预览当前页/当前 sheet）

### 6.4 文件问答
- `src/docs-qa.js`：`askDoc(docId, question)` —— 复用 `retrieveContext`（限定 sourceId 过滤）→ 拼 prompt（资料摘要 + top-k 段落 + 问题）→ `runAgentTurn` / `chatAI`
- 问答面板：选择资料 → 提问 → 流式回答 + 引用段落展示（点段落跳预览定位）
- **embedding 分层**：`embedding.js` 已有「远程优先、本地降级」逻辑 → 加配置开关：默认 local；配了支持 /embeddings 的 key 自动切语义（现有 `modelSig` 机制已处理模型变更重建）

### 6.5 OCR（重活）
- 本地：Tesseract.js Worker（中文 chi_sim），逐页、进度、可取消；设置页放「扫描 PDF 处理方式：本地/云端」
- 云端：预留 provider 抽象（百度/腾讯/通义 OCR 接口 + key 配置），本地慢或质量差时一键切换
- 纯函数：OCR 结果后处理（去噪、段落合并、页码标记）

### 6.6 联动（知识图谱优先）
- **知识图谱**：解析文本（如计组教材章节）→ graph-builder Agent 抽概念 → `graphEdges` 建节点边 → 图谱页展示「资料章节级网络」
- 自动建卡：文本 → cardsmith Agent → 卡片（source 记 doc id，血缘可反查）
- 错题溯源：卡片血缘扩展支持 doc 源 → 错题详情展示原文段落
- 复习上下文：到期复习附资料片段（hybridSearch 按卡片关键词）
- 插件 ctx 扩展：`ctx.docs` 只读（官方示例可做「资料周报」）

---

## 五、技术风险与对策

| 风险 | 对策 |
|---|---|
| 几百 MB PDF 解析内存溢出 | pdf.js 逐页流式 + 进度 + 可取消；解析队列串行防并发 |
| OPFS 兼容性（旧浏览器） | 现代浏览器（Chrome/Edge/Safari 15+）支持；<10MB 小文件降级 IndexedDB |
| Tesseract 慢（几百页扫描件） | Worker 线程 + 页级进度 + 后台常驻提示；可选云端 OCR 切换 |
| Word 预览保真度 | mammoth 近似预览 + 明确标注；追求保真可后续接 LibreOffice 转换（超出纯前端范围） |
| 大文本同步负担 | 元数据同步、text/原文件本地（EXCLUDED），导出时可选携带 |
| embedding 质量 | 本地降级默认 + 语义 key 开关，`modelSig` 自动触发重建索引 |

---

## 六、测试规划

- `tests/docs.test.mjs`：docs 状态机、扩展名路由、文件名归一、OPFS 抽象层（mock）、解析器纯函数（txt/md 直读、sheet 文本化、docx 用最小样例）
- `tests/parsers.test.mjs`：pdf.js 在 Node 提取最小样例 PDF 文本（pdf.js 支持 Node）；SheetJS 小 xlsx 文本化断言
- `tests/docs-qa.test.mjs`：问答编排纯函数（检索过滤、prompt 拼装、引用段落格式化），mock retrieval
- 集成：fake-indexeddb 走「上传→解析→索引→问答检索」黄金路径
- OCR 不纳入 Node 测试（wasm 重），用「已用 OCR 标记」状态机测试替代

---

## 七、开发纪律（延续既有模式）

1. 抽纯函数 → 单测 → IO 编排 → 视图接入
2. 新表只在 `sync-manifest.js` 登记一次
3. 新数据先落 db 再进 sync
4. 每阶段一个 conventional commit，测试与实现同批
5. `npx vite build --emptyOutDir false` 验证（本机 dist 清空触发 safe-delete 拦截）
