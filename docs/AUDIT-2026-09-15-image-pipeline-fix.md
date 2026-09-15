# 交付报告：打通「图片 → AI」全链路（round67）

> 起因：用户反馈「云端 AI 看不懂卡片里的图片」「为什么只能传 3 张」。
> 基线 HEAD `813453e`（并行会话的 round68 报告）。提交 `d9ad3aa` + `5e0835b`。

## 一、诊断结论（全部代码实证）

| 问题 | 结论 |
|---|---|
| 图片链路本身通不通？ | **通**。`CardModal.vue:213` 插图时把 `![image](sxy-img://uuid)` 写进正文 → `agent/llm.js:55` 的 `enrichForLlm()` 富集后送多模态 |
| 「未随本次发送」是谁说的？ | **SxyBrick 自己**（`image-analysis.js:392`），**不是 LLM 幻觉** |
| 「3 张」谁定的？ | 硬编码常量 `VISION_LIMIT_FIRST = 3`，理由注释只写「费用护栏」，**设置里不可配** |
| 一次请求能带几张？ | **多张**（`attachVisionToLastUser`：`content: [{text}, ...vision]`）。额度限的是**张数**，不是请求次数 |

**真缺陷（前两轮都漏掉的核心）**：列表类工具 `front.slice(0, 60 / 80)` 把 **56 字符**的图片标记
拦腰截断 → 残缺 uuid → `db.images.get()` 查不到 → `if (!row) continue` **静默跳过**。

实测（真实验证脚本）：

```
正文：「计算机网络习题：停止-等待协议的重传机制与超时重传分析」+ 图片标记（起始于第 28 字符）
slice(0, 60) → 只剩 `sxy-img://a1b2c3d4-e5f6`        ✗ 切坏
slice(0, 80) → 只剩 `...ef1234567`（差 3 个字符）      ✗ 切坏
```

即：**正文前面多写 5 个字（60 档）/ 25 个字（80 档），图片就丢了**，而 AI 只会收到一句
「未随本次发送」——于是它回答用户「你重发一张试试」，而真正原因是引用被上游截断了。

## 二、修复

**新增 `src/utils/clip.js`**（零依赖纯函数，所有消费方共用）：

| 函数 | 用途 |
|---|---|
| `clipText(text, n)` | 正文照常截断，**图片引用完整保留**（追加末尾）。覆盖 `sxy-img://` 与 `sxy-doc://` 两条协议；**码点安全**（不劈 emoji） |
| `stripImageRefs(text)` | 取卡名 / 做去重 key 时**剥掉**引用，防残缺标记污染文本 |
| `hasImageRef(text)` | 列表类工具用，附 `hasImage` 提示 |

**全链路接线**（原先只有 `tools/index.js` 被入库，其余为本次补齐）：

| 位置 | 改动 |
|---|---|
| `agent/tools/index.js` | 7 处摘要加 `hasImage`；`semantic_search` / `read_lib_doc` 保留完整引用；2 个工具描述说明 `hasImage` 与看图方式 |
| `agent/retrieval.js` | RAG 片段（图片进 AI 的**主入口**）Q/A/doc 截断全部改走 `clipText` |
| `agent/analytics.js` | 9 处卡片摘要改走 `clipText`；卡名类走 `stripImageRefs` |
| `agent/agents/base.js` | 上下文压缩出口改走 `clipText`（tool 消息切坏引用 = 丢图） |
| `analysis/local-analyzer.js` 等 | 11 处卡名剥离引用 |

**列表类 vs 内容类分开处理**（刻意设计）：列表工具**不保留**完整引用——否则几十张卡一次把
送图额度吃光；只给 `hasImage: true`，引导 AI 按需调 `get_card_detail` 拿完整正文看图。

**额度可配置**（回答「为什么只能传 3 张」）：

- `VISION_LIMIT_DEFAULT = 3`、`normalizeVisionLimit()` 夹到 **[1, 20]**（脏值 `'abc'` / `0` / `1e9` 全兜住）
- `DOC_VISION_MAX = 20` 为资料页硬上限；`resolveImagePolicy` 带出 `visionLimit`
- `ImagePolicySetting.vue` 新增输入框（`@change` 改即保存，脏输入当场纠正后回显）；i18n zh/en 各补 3 键
- `ocrFirst` 仍恒 0、`auto` 兜底仍恒 1（保守，那是 OCR 失败后的补救，不该按用户额度放大）

**文案拆分**：「超出送图额度」与「读取失败」不再共用一句——这是让 AI 误判的直接原因。

## 三、验证

| 项 | 结果 |
|---|---|
| `npm test` | **1173 passed / 0 fail**（1158 → +15） |
| 新增用例 | `tests/clip.test.mjs` 11 条（含「任何 maxLen 下 uuid 必须完整」「列表工具 60/80 档回归」「sxy-doc 页码后缀」）；额度 4 条（含端到端「一次请求带 5 张、仍是单条消息」） |
| 期望变更 | `doc-vision` 2 条（护栏从「硬截 3 页」改为「默认 3、可放宽至 20」+ 新文案）、`image-analysis` 1 条（策略对象新增 `visionLimit` 字段） |
| i18n | 三闸全过；数据层基线重锚（行号漂移，非真新增） |

## 四、过程中的两次返工（如实记录）

1. **码点安全回归**：`clipText` 初版在「无图片」分支用了 `s.slice(0, n)` —— 按 UTF-16 码元切，
   会劈开 emoji。被 round50 N2 的既有测试当场拦下，抽出 `clipByCodePoint()` 修正。
2. **行尾事故（本项目第 2 次）**：用 `node -e writeFileSync` 批量改文件，把 4 个文件从 LF 写成 CRLF
   → 提交统计 1209+/1005-（真实只需 309+/105-）。转回 LF 后 `--amend` 修正。
   **MEMORY.md 里早就写着这条教训，仍然踩了** —— 脚本改完必须 `git show --stat` 复核。

## 五、未完成

- **未推送到远端**：`git push` 连续失败（`CONNECT tunnel failed, response 502`），沙箱内外均不通，
  属网络问题非代码问题。**提交已在本地**（`d9ad3aa` + `5e0835b`），网络恢复后 `git push origin main` 即可。
- 并行会话曾把本轮的 WIP 部分收编为 `f128cd8`（只含 `clip.js` + `tools/index.js`），
  其余 6 个文件被清空后由本轮重新实现；期间 `image-analysis.js` 一度处于引用未定义变量的半改状态，已修复。
