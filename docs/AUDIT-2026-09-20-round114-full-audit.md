# 全面代码审计报告 · round114（并行 AI round122 交付后）

- 日期：2026-09-20
- 范围：并行 AI 新增 1 个提交 `c1d2327`（正面卡片文字发虚修复）+ 遗留未跟踪审计脚本 audit122_layout.mjs
- 方法：逐提交读 diff/源码 → 渲染链路与全局样式副作用核查 → 全量 `npm test` → 生产 `npm run build`
- 结论（先说）：**可直接使用**。本轮是「卡片文字发虚」的**真因定案与修复**，质量很高，含诚实修正前一轮的错误结论。全量 1480 测试 0 失败、构建成功。

---

## 一、本轮审查的 1 个新提交

| commit | 内容 | 审查结论 |
|---|---|---|
| `c1d2327` | **正面卡片文字发虚**修复：静止态关闭 3D 渲染上下文（仅翻转动画 600ms 临时开启） | ✅ 通过 |

## 二、关键逻辑核查

### 1. 文字发虚的真因（本轮最硬核的部分）
- **根因**：`.flip-inner` 的 `transform-style: preserve-3d` + `.flip-scene` 的 `perspective` 会建立 **3D 渲染上下文**，而 Chrome 在 3D 上下文中**关闭 LCD 次像素抗锯齿**、改用灰度抗锯齿 → 文字笔画变细、边缘发虚，观感"蒙了一层雾"。
- **量化实测**：文字边缘 RGB 色度 chromaMax（>100 = 次像素已恢复）：baseline 22（灰度）→ 去掉 perspective 或 preserve-3d 均为 **179**（次像素）。且 `backface-visibility`/`will-change` 无关（仍 22）——排除干扰项。
- **用户线索印证**："全屏里正常"——全屏层是 Teleport 到 body 的 fixed 层，不在 3D 上下文中，所以不虚。
- **修法**：静止态 `transform-style: flat` + 无 perspective（99.9% 时间走次像素抗锯齿、文字锐利）；**仅在翻转过渡 600ms 内**临时开启 `.flip-3d`（preserve-3d + perspective 1400px）保留 3D 动画；定时器 onBeforeUnmount 清理。
- **防双影**：正反面显隐由 visibility 规则负责（`.flip-inner.flipped .flip-front{visibility:hidden}` + 反向），不依赖 backface 剔除 → flat 状态无双影（实测确认）。

### 2. 全局样式清理的副作用核查（重点审计项）
- `styles.css` 删除了全局 `.flip-scene{perspective:1200px}` 和 `.flip-inner{transform-style:preserve-3d}`，注释明确"不要再写 perspective/preserve-3d"。
- **我全局搜索确认**：`.flip-scene/.flip-inner/.flip-face/.flip-back` 类名**只用于 FlipCard.vue 和 styles.css**，无其他组件使用 → 清理不会误伤。
- **FlipCard.vue scoped 样式完整性**：`.flip-scene.flip-3d{perspective:1400px}`、`.flip-inner.flip-3d{transform-style:preserve-3d}`、`.flip-inner.flipped{transform:rotateY(180deg)}`、transition 0.55s、visibility 规则、grid 自适应高度——原全局能力全部补全。
- progress 主题的 `.card-item` 3D 鼠标倾斜保留，仅排除 `.flip-scene .card-item`（翻转卡的两面不参与倾斜，避免叠出 3D 上下文）。

### 3. 动画能力保留验证（提交自带）
- 翻转 mid-transform 为真实 matrix3d；轨迹 60/200/350/700ms 均 preserve-3d，900ms 回落 flat——3D 动画效果完整保留，只是不再常驻。

### 4. 诚实修正
- 上一轮（round121）"预览模糊不成立"的结论，用的灰度 Laplacian 指标**对抗锯齿模式不敏感**、且采样区含大量空白稀释差异 → 本轮推翻，改为 chromaMax 量化。这种自我推翻是正确的审计行为。

## 三、验证结果（实跑）

| 项 | 结果 |
|---|---|
| `npm test` | ✅ **# tests 1480 / # pass 1479 / # fail 0 / # todo 1**（todo 为既有"dist 不存在跳过产物校验"标记，非缺陷；新增 4 条 flip 抗锯齿用例） |
| `npm run build` | ✅ 构建成功（37.4s） |
| i18n 三道闸 | ✅ 无新增硬编码 |

## 四、环境异常（与代码无关，但需知晓）

1. **远端 main 又被重置回 `0775a26`**（旧状态）：本地领先 **15 个提交**。这是并行 AI 在另一处工作区反复重置 main 导致（与上一轮相同模式）。线上网页因此停留在旧版（缺图谱修复/Markdown 6 色/卡片预览全屏化/文字发虚修复等全部 15 个提交）。
2. **未跟踪文件 `audit122_layout.mjs`**：并行 AI 的 round122 布局审计脚本（验证 .flip-inner 去掉 width:100% 是否回归），尚未入库——属过程产物，不入库不影响。
3. git 写盘偶发被 QQ 电脑管家拦截（上轮用项目自带 force 脚本绕过，本轮未再触发）。

## 五、结论

**项目达到可直接投入使用的状态。** 文字发虚问题从"观感"变成了"可量化、可复现、已修复"（chromaMax 22→179），修复方案在保留 3D 翻转效果的同时消除了静止态模糊，全局样式清理无副作用。唯一动作项：**推送 15 个提交到远端**（由用户确认后执行）。
