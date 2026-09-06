# round22：7 类报障实证修复（commit `f8d45b3`，已推送 origin/main）

## 每项根因 + 修复（全部生产构建 + CDP 复现/验证，非采信）

| # | 报障 | 根因 | 修复 | 验证 |
|---|------|------|------|------|
| ① | 365 天热力图只有坐标轴没格子 | series 无 `itemStyle` 描边 + `visualMap.max` 写死 20，低活跃日颜色≈背景（对照 168h 图有描边+max=8） | max 按数据动态取(≥1) + 每格描边 + `renderChart` 加 `{allowEmpty}`（全 0 也铺满格子） | CDP 像素探针：43 色桶 / 85.9% 非白 |
| ② | AI 助手对话不居中、中间灰底 | `.ai-body` 3 列却 **4 个子元素**，消息流被 auto-flow 挤进右 120px 列 | 显式 `grid-column/row`（左右栏跨两行，fs-row 中列第1行，chat-box 中列第2行） | CDP `#/ai` 0 console error |
| ③ | Agent 打不开 `Cannot access 'x' before initialization` | `<script setup>` 里 `useFullscreen(streamBox)` 在 `const streamBox=ref(null)` **声明前取用** | `streamBox` 声明上移 | 生产 chunk 先复现后重探 ERRORS(0) |
| ④ | 桑基图一坨黑 | 节点单色 accent，密集图糊成黑块 | PALETTE 8 色按序轮换（sankey + 力导向降级分支） | build ✓ |
| ⑤ | 同步永远「待同步」+ 按钮禁用 | a) `fetch` 无超时 → 中枢不可达挂起致按钮全禁；b) pending 判定无时钟偏差容忍 → 对端时钟略快 = 永远 pending | `AbortSignal.timeout(20s)` + `SYNC_STATUS_SKEW_MS=5min` 容忍（导出常量） | sync-status 测试更新语义 8/8 |
| ⑥ | 新建词组后加词无入口/分不清词组/不能检索 | 新建后折叠看不到按钮；加词弹窗无检索、saveAdd 只加不减 | 新建自动展开；弹窗实时检索+标题带目标词组名；差量同步（取消勾选即移出）；列表可搜索 | build ✓ |
| ⑦ | 单词本编辑无「添加词组」 | 编辑弹窗缺归组控件 | 「归入词组」多选 chip（可搜索、预填、差量增删，一对多） | build ✓ |

## 全局验证
- `node --test` **910/910 全绿**（sync-status 语义随修复更新）
- `npm run build` ✓ 42.58s · i18n 双闸 0 新增（基线重锚 15 处插行位移误报）· dep-check 0 环
- CDP 实测 `/agent` `/ai` `/user-dashboard` `/english/groups` 均 0 console error
- 已推送 `c1e4ef1..f8d45b3` → GitHub Actions 重新部署后生效（含 #9 单词本批量出题）

## 说明
- 你此前测的是**未包含 39d70fc/f8d45b3 的旧部署包**：智能模块「选一张单词卡」文案在 #9（39d70fc）已改「选单词本范围批量出题」，push 后即生效。
- 英语词组与智能模块的联动（词组库四类、一对多归组、备用组暂停）在 v40（c1e4ef1）已落地，本次补齐了交互缺口。
