# round79 深度审计报告（三个全新向量：样式/字体层 + 构建部署链 + 监听器配对/可达性）

- 日期：2026-09-16
- HEAD：`7b62eac`（round76 报告）；本轮新增 round78（浏览器兼容性）之后首份新向量报告
- 选向量依据：grep 历代 71 份审计报告标题/正文，确认"样式与字体内嵌""构建/部署链""事件监听器配对与可达性"三支从未被系统性审查过。

## 一、样式 / 字体层（已覆盖维度内零发现）

| 验证项 | 结论 |
|---|---|
| @font-face 内嵌 | ✅ src/styles.css（1587 行）零 @font-face、零 @import——无字体加载失败路径可炸 |
| KaTeX 字体 | ✅ font-display: block(20)/swap(7)（swap 用于正文合理，block 用于公式避免布局跳动）；woff2 走 assets SWR 规则，离线可回源 |
| sxy-img:// 自定义协议 | ✅ styles.css 无硬编码依赖该协议的选择器（占位符仅由 images.js 渲染层消费） |
| z-index 纪律 | ✅ 全文件仅 8 处，层级 0→300 单调（遮罩 100 / toast 300 / 特例 95!），无失控堆叠 |
| !important 滥用 | ✅ 仅 1 处（z-index:95，覆盖第三方组件浮层），克制 |

## 二、构建配置与部署链（已覆盖维度内零发现）

| 验证项 | 结论 |
|---|---|
| base 路径一致性 | ✅ `base:'/sxybrick/'` 与 manifest.start_url/scope、shortcuts url 全部同源同前缀 |
| CI 门禁真实性 | ✅ deploy.yml：npm test（含 i18n/dep/sync-coverage 闸）→ build → check-build-shards 兜底断言（补 npm test 在 build 前跑导致产物断言跳过的空档）→ 发 Pages |
| CI 环境漂移 | ✅ 注释留痕的 4 个历史根因（Node 版本 / baseline 路径分隔符 / serveStatic ENOENT / 测试串行）均已根治，非"注释式修复" |
| 混合内容 | ✅ 源码 grep 无 http:// 硬编码资源（排除 localhost/文档注释后零命中）；AI 端点 https |
| manualChunks 陷阱 | ✅ katex/hljs 已移出手动分chunk（2026-08-29 首屏 40.5% 优化在码）；icons-vue 与 element-plus 同 chunk 防 TDZ 循环依赖——注释明确禁止再拆 |
| 论文页构建 | ✅ continue-on-error 安全网：paper 渲染失败不影响主应用上线 |

## 三、事件监听器配对 / 可达性（已覆盖维度内零发现）

全视图 add/remove 配对扫描（12 个含监听器的视图逐一核对）：

| 视图 | add/remove | 定性 |
|---|---|---|
| Review / DailyPlanView / Pomodoro / Dashboard / Mindmap / KnowledgeGraph / CardLinkAnalysis | 1:1 配对 | ✅ |
| FlipCard | add 1 / remove 2 | ✅ remove 多于 add 是防御式（onUnmounted 双保险），无害 |
| Export | add 1 / remove 0 | ✅ `{ once: true }` 自移除（afterprint），注释明确说明取消不记的取舍 |

- 组件层（components/）32 处 addEventListener 抽查均挂载于 onMounted/onBeforeUnmount 生命周期内，无模块级全局泄漏点。
- 键盘可达性：核心复习链路（Review/FlipCard）空格/数字评分快捷键在历轮 UX 审计已覆盖，本轮复扫无新增回归。

## 四、历轮修复完整性

- round78（浏览器兼容性）报告在码，本轮未重复其维度。
- dist 产物（23:12 构建）晚于全部 fix 提交，抽验特征命中（round77 已验证，本轮不重复跑）。
- 历轮累计：零回退。

## 五、结论（维度限定）

1. **已覆盖维度内（样式/字体、构建/部署链、监听器配对/可达性）零 P1/P2/P3 发现**——三个新向量全部干净。
2. 未覆盖：无障碍完整 WCAG 剖析、性能 profile、服务端（项目无服务端，不适用）。
3. 攻击面状态：71+ 份审计覆盖 数据/同步/调度/AI/PWA/兼容/样式/构建/监听器 全 major 向量，连续多轮零必修。**审计收益已进入边际递减区**，建议后续仅在以下时机触发新审计：① 大规模重构合入后；② 新增依赖/新子系统时；③ 并行会话事故（如 stash 冲突类现场）后。
