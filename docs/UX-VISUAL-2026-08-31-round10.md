# SxyBrick 用户体验 / 视觉专项分析（第十轮补充 · 2026-08-31）

> 与前九轮"算法/数据层审计"不同，本轮只从 **UX + 视觉** 两个维度取证分析：全屏/沉浸、快速联动、视觉细节、视图设置体系。所有结论附代码位置。

## 1. 现状盘点（证据基线）

| 维度 | 现状 | 位置 |
|---|---|---|
| 导航 | 36 项平铺，`coreNavs` 机制已有（未设置时**全部显示**，设置后非核心折叠进「更多 ▼」全屏浮层） | App.vue:95-142, NavBar.vue:60-82 |
| 内容容器 | `.app-main` 固定 `max-width: 1080px`，**无宽屏档位** | styles.css:68 |
| 全屏 API | 全代码库 **0 处** `requestFullscreen` | grep 验证 |
| 沉浸模式 | 仅 Review 有 `focusMode`：`body.review-focus` 隐藏导航 + AI 浮层，主区收窄 760px（类名级伪沉浸） | Review.vue:92, styles.css:495-497 |
| 图表大屏 | KnowledgeGraph / Mindmap 有 `roam` + `window resize` 监听，但被 1080px 容器夹住，**无全屏按钮** | KnowledgeGraph.vue:206/314 |
| 深链 | 已建 8 个消费点（cards?subject/id/tag/q、card-link?cardIds、notes/docs/exam/memo/mindmap/plans?id） | 各视图 route.query |
| 命令面板 | Ctrl/Cmd+K：跳卡片 `/cards?id=`、跳页面、AI 提问 `/ai?q=`，全局快捷键已接 | CommandPalette.vue:59-65 |
| 主题体系 | 11 风格 × 3 配色 × 5 字体 + 自定义色相；`prefers-reduced-motion` 全覆盖；页面过渡 180ms | stores/theme.js |
| 加载/空态 | 7 视图有 v-loading；EmptyState 统一组件（compact 变体）已铺开 | grep 验证 |
| 反馈 | toast 走 ElMessage + `grouping` 同内容合并计数（防刷屏已做） | utils/toast.js |
| 全局浮层 | 右上角 3 件套常驻：settings-fab（14px, 42px 可拖）+ NotificationBell（64px）+ demo-banner（**常驻一整行**）；右下角 FloatAssistant | App.vue:431-469 |

## 2. 全屏 / 沉浸机会点（按收益排序）

| # | 内容 | 为什么适合全屏 | 建议做法 |
|---|---|---|---|
| F1 | **图谱 / 导图**（/graph, /mindmap） | 节点关系是"空间型"信息，1080px 下 200+ 节点只能缩到看不清；ECharts 已有 roam，全屏零成本 | 视图工具条加「⛶ 全屏」按钮：`document.documentElement.requestFullscreen()` + 监听 `fullscreenchange` 调 `chart.resize()`；Esc 原生退出。两视图共用一个 `useFullscreenChart()` composable |
| F2 | **背诵**（/review） | 已有 focusMode 雏形，但只是"隐藏元素"，没有放大 | 把 focusMode 升级为真沉浸：全屏 + 卡片字号 1.5× 档位 + 隐藏一切浮层（现有类名已隐藏 .app-nav/.fa-root，补 PWA bar/通知/演示横幅）；这是学习核心路径，值得做最重 |
| F3 | **模考 / 生成测验**（/exam, /genquiz） | 考试需要"试卷感"，当前与其他页共享 1080px 布局，干扰元素多 | 进入答题时套用与 F2 相同的沉浸壳（只读全屏 + 计时器常驻），交卷后恢复 |
| F4 | **费曼**（/feynman） | 长文写作 + 录音，需要大输入区 | 输入区提供「写作全屏」（仅该页 textarea 容器全屏即可，成本最低的一种） |
| F5 | **仪表盘 / 数据**（/user-dashboard, /stats） | 8+ 图表的监控墙，宽屏下信息密度翻倍更可读 | 不做真全屏，改做**容器宽屏档**（见 V3），全屏收益不如图表类视图 |

不建议全屏的：Cards 列表（翻页浏览不适合）、资料库（上传流）、同步/导出（表单型）。

## 3. 快速联动机会点

**已有基础不错**（深链 8 点 + 命令面板 + Dashboard 的 `goSubject/goWeak/goUntagged`），缺口集中在"学习闭环"上：

| # | 联动 | 现状 | 建议 |
|---|---|---|---|
| L1 | **任何入口 → 带上下文背诵** | Review.vue **不读 route.query**——Dashboard「开始复习」只能进全量队列，无法"只背这一科/这一组/这张卡" | Review 支持 `?subject=xxx` / `?group=xxx` / `?card=xxx` 三种过滤（repo 层取卡逻辑已有对应函数，改动集中在视图）；Dashboard「科目掌握度弱科」点击直达该科背诵 |
| L2 | **图谱/导图节点 → 单卡洞察** | 节点点击目前只跳 `/cards?id=`（卡片列表） | 节点点击改为弹内联预览卡（CardModal 已有），提供「查看遗忘曲线」→ `/insight?card=` 深链（insight 视图已存在） |
| L3 | **背诵答错 → 错题本回流** | 答错后无出口，用户要手动去 /wrong | 评分为 again 时卡片底部出一行「已记入错题本 →」（跳 /wrong?card=xxx，错题视图加 ?id 消费） |
| L4 | **资料 → 卡片 → 溯源** 反向 | 正链（cards?docId）已有；从 Cards 页点一张资料生成的卡，回不到原资料 | Cards 详情若带 docId 来源，显示「📄 来自《xxx》」→ /materials?id= |
| L5 | **通知 → 直达上下文** | NotificationBell 通知多为纯文本 | 通知 item 加 `?path` 载荷：主动智能体推送"数学堆积 12 张"→ 点击直达 /review?subject=数学（配合 L1 成立） |
| L6 | **书房 Library 快捷方式** | 10 个静态 push，不带任何上下文 | 保留（它本就是导航面板），但把「去复习」升级为带今日科目优先的深链（L1 落地后） |

**统一机制建议**：新增 `src/utils/deep-link.js` 收口"视图声明可接收的 query 参数 → 参数校验 → 提示无效参数"，避免 query 协议散落在 8 个视图里各写各的（现状无 schema，拼错参数静默无效）。

## 4. 视觉与用户体验改进清单

### P0（体验痛点，建议尽快）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| V1 | **11 套导航音效无全局开关**：切页必响 playBlip（每风格不同音色），设置面板里没有声音项 | NavBar.vue:31-56 每风格 tap* 函数；grep `sxy_sound` 0 结果 | 设置面板「提醒与监控」加「界面音效」开关（localStorage `sxy_sound`，sound.js 统一静音闸门）；默认建议跟随主题：adventure/card/moba/space 开、其余关 |
| V2 | **演示模式横幅常驻占位**：真实数据模式下 demo-banner-off 仍永久占顶部一整行（"想试试功能？"），纯干扰 | App.vue:450-453, styles.css:647 | 默认收起为右上角一个 🧪 小图标（与通知铃铛同排），hover 展开；或首次访问后不再显示（localStorage 标记） |
| V3 | **1080px 硬顶**：27 寸屏 + 监控墙/图谱类页面大量留白 | styles.css:68 | `.app-main` 加宽屏档：`@media (min-width: 1600px) { max-width: 1440px }`，(min-width: 1920px) → 1680px；图表容器同步。零风险纯 CSS |

### P1（明显可感知提升）

| # | 问题 | 建议 |
|---|---|---|
| V4 | **字号体系缺失**：全局表只有 7 个 px 字号（12/13/14/14.5/15/16），视图内大量内联 style="font-size" | 在 styles.css 立 4 级 type scale 令牌（--fs-sm/md/lg/xl），新增视图遵循；存量不强制回改，但 P1-2 的 UserDashboard/Workspace 迁移时顺手对齐 |
| V5 | **骨架屏缺席**：7 视图 v-loading（转圈）之外，Stats/UserDashboard 等图表页首屏是"空白 → 图表弹出" | 给图表容器加轻量 skeleton（纯 CSS 灰块 + shimmer，复用 EmptyState 的克制风格）；`degraded` 模式（低性能）下可跳过 |
| V6 | **右上角浮层拥挤**：settings-fab(42px) + 铃铛 紧贴，FAB 可拖但默认位置与铃铛面板展开区重叠风险 | FAB 初始下移到右下角 FloatAssistant 上方 80px（右下纵向队列），或铃铛与 FAB 合并进一个"系统托盘"小竖列 |
| V7 | **移动端底部 Tab 无选中强化**：nav-mobile 只有颜色变化 | 加 2px 顶部指示条（accent），与桌面 router-link-active 的"实心块"语言区分开，移动端用手势语言 |
| V8 | **Review focusMode 是隐式入口**：按钮在工具条 chip 里，新用户不知道 | 首次进入背诵时在卡片下方一次性提示条"想专注？点此隐藏一切 →"（点击即开 + localStorage 不再提示） |

### P2（打磨项）

- **V9 图表配色统一**：Stats / UserDashboard / WeeklyReport 各写各的 ECharts 色板，应抽 `src/utils/chart-theme.js` 从当前主题 `--accent/--blue/--green/--red/--amber` 生成系列色（现在切主题图表不跟着变）。
- **V10 空态行动一致性**：EmptyState 已统一，但各视图空态的"第一个按钮"文案/跳转不统一（有的"去导入"有的"新建"），建议每个空态固定 [主行动][次行动] 两段式。
- **V11 主题风格 × 内容适配提示**：adventure 主题底部 380px 场景 + `padding-bottom: 410px`（styles.css:307）在数据密集页（Stats/表格）非常吃空间；可在设置面板风格卡片上标注"占屏较多，建议浏览型页面使用"。
- **V12 深色模式图表**：dark 模式下 ECharts 默认浅色轴标签/网格未全覆盖（依赖 V9 落地后一并处理）。
- **V13 键盘导航**：命令面板已有 Ctrl+K；可再加 `←/→` 切换卡片（Review 已有键盘评分）、`g+字母` 跳转（仿 VSCode），低优先级。

## 5. 视图设置体系：放大 / 收纳 / 不占用

**现状**：唯一的视图级设置是「功能精简」（coreNavs 勾选），且**默认未设置 = 36 项全平铺**——新用户首次打开就是全量过载，机制的默认值与"精简"目标相反。

### 5.1 学习核心 —— 应放大 / 常驻 / 强化

| 视图 | 建议 |
|---|---|
| 背诵 /review | 沉浸化（F2），键盘评分已有；**默认核心导航** |
| 卡片 /cards | 默认核心导航（现状 ✓）；宽屏档加列宽 |
| 图谱 /graph、导图 /mindmap | 全屏（F1）；这两页是"空间学习"，值得给最大画布 |
| 资料库 /materials | 学习输入源头，保持一级；上传区视觉放大（拖拽区最小高度 200px → 280px） |
| 每日规划 /daily | 晨间入口，Dashboard 首屏"今日待办"卡片加大一号 |

### 5.2 学习无关 / 低频 —— 应收纳（默认进「更多」）

| 类别 | 视图 | 理由 |
|---|---|---|
| 开发/演示 | **UIKit（组件库）、插件、超级监控** | 开发者自检工具，学生用户永远用不到，占导航心智 |
| 元数据 | 同步、导出、回收站、体检 | 维护型操作，用 CommandPalette（Ctrl+K）直达比常驻导航更顺手 |
| 成就/游戏化 | 成就 | 低频查看，通知驱动（达成时铃铛推）比入口常驻更好 |
| 监控/实验 | 仪表盘、周报、卡片洞察、联动分析 | 数据消费型，从 Stats/通知/图谱节点**按需进入**（L2/L5 落地后）比常驻更好 |

**具体建议**：`DEFAULT_CORE_NAVS` 从 `['/cards','/review']` 改为显式默认组 `['/cards','/review','/materials','/daily']`，且 `hasCoreSetting=false` 时**也应用该默认组**（其余进「更多」）——把"精简"从 opt-in 变成默认体验；设置面板保留"全部显示"逃生舱。

### 5.3 不应占用学习空间的全局元素

| 元素 | 现状 | 建议 |
|---|---|---|
| demo-banner-off | 常驻整行 | 收为图标（V2） |
| pwa-bar | 临时（离线/更新/配额） | 保持，但加 10s 自动淡出（离线除外） |
| adventure 场景 380px | 固定吃底部 | 提供"迷你场景"档（高度 380→160，仅留地面+角色），设置项 |
| FloatAssistant | 右下常驻 | 已有拖拽；补"收起为边缘 1/3 露出"的 dock 态，给阅读型页面让位 |

## 6. 建议落地顺序

1. **一周内可完成（纯增量、低风险）**：V1 音效开关 → V2 横幅收纳 → V3 宽屏档 → 5.2 默认核心导航组
2. **第二批（功能型）**：F1 图谱/导图全屏（composable 一次做两视图）→ L1 Review 深链（L3/L5 的前置）
3. **第三批（体系型）**：V9 图表主题色 + V5 骨架屏 + deep-link.js 协议收口 → F2/F3 真沉浸壳（复用同一套）
4. **持续**：V4 字号令牌随后续视图迁移顺手执行；P2 打磨项按手感安排

> 取证方式说明：全部结论来自代码 grep/read（styles.css、App.vue、NavBar.vue、Review.vue、KnowledgeGraph/Mindmap、CommandPalette、theme store、toast.js、sxy_* 设置键盘点），无浏览器实测项；V6/V7 的"观感"类判断建议落地前开浏览器确认一次。
