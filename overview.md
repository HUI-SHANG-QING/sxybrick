# #9 智能模式改选单词本批量出题（commit `39d70fc`）

## 改动摘要
英语「AI 智能模块」从「选单张单词卡」改为「选**单词本范围**批量出题」，对齐用户"英语智能模块应改为选单词本"的诉求。

### 1. `src/services/word-ai-modes.js`
新增 `batchGenerateModeQuestions({ cards, settings, agentCtx, onProgress, saveFn })`：
- 逐卡调用既有 `generateModeQuestions`（13 模式判分口径、不合规丢弃逻辑全部复用）。
- `onProgress({ done, total, generated, failed, saved, current })` 进度回调；回调返回 `false` 即中断后续卡。
- 单卡失败不阻断其余卡（`failed` 计数准确）。
- `saveFn` 可选——调用方注入 `updateWordCard`，服务层保持无 DB 依赖；自动合并 `modeQuestions` 落库；`saved` 反映真实落库成功。

### 2. `src/views/WordAIModes.vue`
- 范围选择器：**全部 / 按卡组(groupId) / 按分类(kind: word|phrase|sentence)**，group 走异步 `wordGroupCardIds`。
- 一键「为选中的 N 张卡批量生成 13 模式题目」，生成中可停止。
- 结果按卡汇总预览，可逐卡展开看 Q/A，失败卡标注原因，成功卡标不合规丢弃项。

### 3. `src/i18n/views/wordAiModes.js`
补充 word-book 范围/批量/汇总中英文文案；模板唯一硬编码"模式"也走 `t()`（`modesUnit`）→ i18n 严格闸 **0 新增**、zh/en 键位对齐。

### 4. `tests/word-ai-modes.test.mjs`（+4 回归）
批量全链路(含 template 卡失败计入 failed) / 空表返 `empty-cards` / `onProgress` 中断 / `saveFn` 抛错被吞且不阻断批次。

## 验证
- `node --test` **910/910 全绿**（基线 906→910）。
- i18n 双闸（正向/反向严格/数据层）+ `dep-check` 0 环，全通过。
- `npm run build` ✓ built in 30.96s。
- 已提交 `39d70fc`；`trash`/`meta` 同步维持现状（用户已确认不改动）。

## 备注
- 本地领先 `origin/main` 多个提交（`c1e4ef1`、`39d70fc` 等），push 由用户终端执行：
  `GIT_TERMINAL_PROMPT=0 "/c/Program Files/Git/bin/git.exe" push origin main`（沙箱 PortableGit 缺 git-remote-https.exe）。
