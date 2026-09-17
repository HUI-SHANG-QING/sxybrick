# round105 审计报告：变式空响应 + max_tokens 硬编码覆盖两修复的全新审计

- 日期：2026-09-17
- 新提交范围：`6d186c8`（变式"返回内容为空"修复）+ `7703a0a`（max_tokens 用户设置尊重修复）
- 基线：`3fe91fa`（round104 报告）
- 范围：两个新 commit 的全部 diff 逐行复核 + 全量测试复跑 + 漏网扫描

## 一、结论

| 项 | 结果 |
|---|---|
| 严重问题（P1/P2） | ✅ **零** |
| 新引入隐患 | ✅ 未发现（1 个 P3 漏网，见下） |
| 回归 | ✅ 全量 `npm test`：**1387 pass / 0 fail / 0 todo**（todo 从 1→0）；eslint 0 error（1 warning 为既有"同步"提示）；i18n 门禁过 |
| 改动范围 | 2 个 commit，共 15 个文件（源 9 + 测试 6 + i18n 1），改动聚焦 |

## 二、两个新 commit 改了什么（复核结论）

### 6d186c8：变式"返回内容为空"的根因修复
- **根因**：llm.js 流式分支只读 `delta.content`，不读 `delta.reasoning_content`（推理模型的增量），也不读 `finish_reason`（截断信号）→ 空串静默上交，上层只能抛笼统文案。
- **修复**：流式分支补齐 reasoning 累计（兼容 reasoning/thinking 命名）+ finish_reason 独立记录；空结果按 5 类抛错（推理吃光预算 / 截断无正文 / 只回推理 / 零字节空响应 / 有响应但正文空）；空响应如实记**失败**用量（此前被记成功）。
- **genVariants**：首次解析失败自动改非流式+双倍预算重试一次；识别 chatAI 的离线文案（此前会误报"格式不合法"）→ 降级本地模板变式。
- **复核**：重试只跑一次（再失败抛精确原因）；`isOfflineReply` 双检查；`reportUsage(null,'',false)` 记失败 ✓。

### 7703a0a：max_tokens 用户设置被静默覆盖的修复
- **根因**：llm.js 取 `opts.maxTokens ?? cfg.maxTokens`，而变式/组卡/出题/文档总结四处**硬编码** 3000~8000 → 用户设置被静默丢掉。
- **修复**：新增 `resolveMaxTokens(floor)` = max(流程下限, 用户设置)；用户设大就用用户的；用户设得小或配置缺失回落到下限。
- **复核**：`resolveMaxTokens` 边界全兜底（floor 非法→默认；cap 非法/缺失→下限）；`getAIConfig()` 有 try/catch（localStorage 损坏返回默认配置）✓。

## 三、新发现（P3）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| P3-5 | `src/views/WordAIModes.vue:37` | **漏网**：单词 AI 模式走 `llmChat` 直调链路（source='english-modes'），maxTokens 仍写死 1600，未走 resolveMaxTokens——用户调大"最大输出长度"对单词模式不生效 | 低：单词场景输出短，1600 够用；但与 7703a0a 的"尊重用户上限"初衷不完全一致 |
| P3-6 | `src/utils/genVariants.js` 重试路径 | 重试 `resolveMaxTokens(budget*2)` 在用户设大时失去"双倍"意义（首次已是用户预算，重试还是同一值） | 无害：用户最大预算下翻倍本就无意义 |
| P3-7 | `src/ai.js` resolveMaxTokens | 用户故意设小（如 500）省成本时，流程 floor（如 3000）会覆盖 | 设计取舍（commit 注释已说明：避免流程必然失败）；非 bug |

## 四、遗留 P3（前轮记录，未授权修）

- P3-1 `ai-analyzer.js`：合法 JSON 但忘包 type/data 键时仍显示裸 JSON
- P3-2 `WordBook.vue:450`：批量删除不检查返回值
- P3-3 `base.js`：确认门同工具连续调用需二次确认
- P3-4 `sync.js`：图片 base64 全量打包内存峰值（round89 遗留）

## 五、验证（实测）

- 全量测试 **1387 pass / 0 fail / 0 todo**；eslint 0 error；i18n 反向扫描 179 行无新增
- 全项目 maxTokens 硬编码扫描：仅 WordAIModes.vue:37 一处漏网（见 P3-5）
- `res.status` 在空响应诊断处作用域正确（eslint 通过佐证）

## 六、结论（维护度限定）

两个新 commit 诊断扎实、修复聚焦、测试充分（新增 27 条测试全过）。除 WordAIModes 一处 P3 漏网外，未发现新隐患。建议 P3-5 下次触碰 AI 设置链路时顺手走 resolveMaxTokens；其余维持遗留清单。
