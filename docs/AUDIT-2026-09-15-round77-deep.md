# round77 深度审计报告（AI/agent 层 + PWA/worker/计时器层，承接 round70 清单两支未覆盖向量）

- 日期：2026-09-15 23:17
- HEAD：`7b62eac`（round76 审计报告）
- 工作区未提交改动：src/agent/analytics.js、src/repo-core.js、src/repo.js、tests/round57-perf.test.mjs、tests/round61-boundary.test.mjs（并行会话在途，本报告不裁决其内容）
- 承接关系：round70 报告（aa93ee6）标注了"未覆盖维度"；本轮补齐其中 AI/agent 与 PWA/worker/计时器两支。

## 〇、产物层验证

dist（23:12 构建，晚于 round76 全部 fix 提交）：
- 流式重试/降级（_streamRetry）✅、重试计数文案键（agent.llm.retried）✅、normalizeTs ✅、净化中文注释语义串命中 ✅
- round76 报告已对同步拉取/推送不对称做验收，本轮不重复。

## 一、AI / agent 层（已覆盖维度内零必修发现）

逐项验证、确认健在的防线：

| 防线 | 位置 | 结论 |
|---|---|---|
| 重试只打 429/5xx，4xx 确定性错误不重试；abort 绝不重试 | llm.js:81-123 | ✅ 语义正确 |
| 流式默认 + 空闲超时（重置计时）+ 超时抢救已生成内容 | ai.js:60-69、llm.js:200-213 | ✅ round73 修复完整 |
| 端点不支持流式（400/422+stream 文案）自动退回非流式一次 | llm.js:_streamRetry | ✅ |
| 200+{error}（无 choices）显式抛可读原因，不再静默空串 | llm.js 非 200/200 分支 | ✅ |
| 视觉降级（400/422 剥图重试）+ 首失败也记账 | llm.js visionCount 分支 | ✅ 账本不失真 |
| max_tokens 上限解析记忆（MAX_TOKEN_CAP per base\|model） | llm.js _maxTokenRetry | ✅ |
| `<final>` 残缺（流式砍半）剥标签兜底；无标签整段视为最终回答 | base.js:80-84 | ✅ round71 修复在码 |
| ReAct 步数硬上限 12（agent 自带值夹紧） | base.js:213-215 | ✅ 无死循环路径 |
| API key 仅存 localStorage，未发现 console/日志泄漏点 | ai.js:41-56、agent/embedding.js | ✅（localStorage 是单用户本地应用的既有取舍） |
| 图片字节预算（9f108b2）消费方覆盖 | dist 特征命中 | ✅ 抽验通过 |

P3 备忘（不改）：apiKey 在 localStorage 以明文 JSON 存放——本机其他程序/插件可读。毕设单用户本地应用可接受，论文"安全设计"一节应如实说明取舍。

## 二、PWA / worker / 计时器层（已覆盖维度内零必修发现）

| 验证项 | 结论 |
|---|---|
| SW 缓存错配风险 | ✅ registerType:'prompt'（新版由用户确认再刷新，不丢编辑中内容）；构建产物带 hash + maximumFileSize 5MB；预缓存瘦身（14.81MB→约4MB，globIgnores+manifestTransforms 双保险） |
| API 缓存污染 | ✅ chat/completions 等显式 NetworkOnly，且 hostname 兜底（openai.com/deepseek.com） |
| dev-dist 误用 | ✅ devOptions.enabled=false（2026-08-29 白屏修复在码）；dev-dist 仅 dev server 产物，不进生产 build |
| analytics worker | ✅ isMainThread 判定（typeof window）防 worker 内自建递归；onerror 清空引用回退主线程 inline，并 reject 悬挂 promise（无永久 pending）；terminate 前 await |
| 番茄钟/提醒 | ✅ 计时语义在 round57/61 等历轮已审（本轮 grep 复扫 stores/plugins 无新增未清理 setInterval） |

P3 备忘：runtimeCaching 的图片源 SWR 规则（request.destination==='image'）会缓存跨域图床图片 14 天/200 条——若用户更换图床同名文件，最长 14 天见旧图；影响仅显示层，不涉数据。

## 三、历轮修复完整性

- round68 八项修复（S1-S8）全部在码（本轮逐项 grep 核对）；06912aa 中 srs.js "602 行大 diff" 确认为 -w 视角下的换行符噪声，真实改动仅 S8 的 4 行。
- round71-76 修复（流式抢救、t 遮蔽、markdown 渲染、拉取/推送不对称等）在 dist 产物层抽验命中。
- 历轮累计：零回退。

## 四、结论（维度限定）

1. 已覆盖维度内（AI/agent 链路全防线、PWA 外壳、analytics worker、计时器扫描）零 P1/P2；2 条 P3 备忘（apiKey 明文、图床 SWR 时滞）。
2. 未覆盖：性能剖面、i18n 键漂移（round51 审过）、localStorage 剩余键盘点——不据此下结论。
3. 本项目连续多轮零必修，防线密度已达"每条历史踩坑都有对应护栏+注释"的状态；建议将审计重心从"找缺陷"转向"验收并行会话在途改动的合入质量"。
