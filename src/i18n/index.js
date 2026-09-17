// src/i18n/index.js
// 国际化地基（零依赖、无第三方库）：
//   - locale：当前语言（reactive ref），切语言时所有用到 t() 的模板自动重渲染
//   - t(key, fallback?)：点号路径取词；当前语言缺失则回退中文，再回退 fallback/key
//   - setLocale(code)：切换并持久化到 localStorage('sxy_locale')
// 设计原则：先搭地基（引擎 + 全局注入 + 语言切换 + 高频文案外置），
// 其余业务文案按模块分批迁移，不一次性改动全站。
import { ref } from 'vue';
// 业务视图字典片段：每个视图一个模块（src/i18n/views/<name>.js），
// 由 scripts/merge-view-i18n.mjs 自动生成下方合并块（import + 赋值）。
// 新增视图只需新建模块文件后重跑该脚本，勿手改合并块。

export const LOCALES = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: 'English' },
];

const STORAGE_KEY = 'sxy_locale';

function readInitial() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'zh-CN' || v === 'en') return v;
  } catch { /* ignore */ }
  return 'zh-CN';
}

// reactive：t() 内部读取 locale.value，模板用 t() 即自动追踪该依赖
export const locale = ref(readInitial());

const zh = {
  // ---------------- 顶部导航 ----------------
  nav: {
    overview: '总览', workspace: '工作台', cards: '卡片', groups: '卡组',
    cardLink: '联动分析', review: '背诵', stats: '数据', export: '导出',
    sync: '同步', ai: 'AI', agent: 'Agent', feynman: '费曼', memo: '备忘',
    notes: '笔记', categories: '分类', daily: '每日规划', wrong: '错题',
    pomodoro: '番茄', graph: '图谱', mindmap: '导图', plans: '计划',
    docs: '文档', weekly: '周报', exam: '模考', genquiz: '生成测验',
    search: '搜索', health: '体检', trash: '回收站', library: '书房',
    materials: '资料库', achievements: '成就', dashboard: '仪表盘',
    privacy: '超级监控', plugins: '插件',     insight: '卡片洞察', uikit: '组件库', words: '单词本', english: '英语中心',
    more: '更多',
  },

  // ---------------- 设置中心 ----------------
  settings: {
    title: '设置中心',
    appearance: '🎨 外观',
    remind: '⏰ 提醒与监控',
    engine: '🧠 学习引擎',
    nav: '🧭 导航',
    storage: '💾 存储',
    language: '界面语言',
    languageHint: '切换后整个应用立即生效（含导航与说明文案）。',
    clearPwaCache: '🧹 清缓存并刷新',
    clearPwaCacheHint: '注销 Service Worker 并清空离线缓存后刷新（保留全部本地数据）。用于修复「页面一直停留在旧版本」。',
    demo: {
      title: '演示模式',
      hint: '用一套示例数据体验全部功能。演示数据与真实数据物理隔离（不同的本地数据库），随时可退出、可重置，均不影响真实数据。',
      current: '当前数据域',
      on: '演示模式（示例数据）',
      off: '真实数据',
      enter: '进入演示模式',
      exit: '退出演示模式',
      reset: '重置示例数据',
    },
  },

  // ---------------- 学习引擎算法说明（#26） ----------------
  engine: {
    title: '复习调度器（记忆曲线算法）',
    intro: '调度器决定每张卡片「下次何时出现」。SxyBrick 内置两条记忆曲线：SM-2 变体（默认）与 FSRS-4.5（可选，机器学习拟合）。两者都基于「间隔重复」原理——在即将遗忘前复习，以最少次数达到目标记忆保持率。',
    sm2: {
      title: '一、SM-2 变体（默认调度器）',
      basis: '依据：经典 SM-2（SuperMemo 2, 1990）增强版；短期巩固状态机源自「测试效应」（Roediger & Karpicke, 2006）。',
      impl: [
        '状态：每卡记录 { level 等级, ease 难度系数, consolidation 巩固阶段 }。',
        '等级梯度：level 1~4 间隔为 1 / 3 / 7 / 15 天；level>4 后按 ease^(level-4) 指数增长。',
        '难度系数：易 / 中 / 难 = 1.15 / 1.0 / 0.8（越难间隔越短，拟合个性化遗忘曲线）。',
        '错因惩罚：答对后仍按错因轻重缩短间隔——概念混淆 ×0.6、记忆不牢 ×0.7、审题偏差 ×0.85、粗心 ×0.9、其他 ×1.0。',
        '短期巩固：新卡首次答对后，插入「当日 6 小时后」与「隔日」两次主动提取（24h 内首次提取是记忆巩固最强窗口），完成后才进入正常梯度。',
        '蒙对处理：蒙对不计真掌握——等级不升、ease 略降并退出巩固，间隔再按 0.6 打折。',
        '自适应节奏（可选）：近 10 次错误率 ≥40% → 间隔 ×0.8（加快重现）；全对且 level≥3 → ×1.1（稳定掌握则拉长）。',
        '检索强度（P1-3）：再认 ×0.7 / 回忆 ×1.0 / 生成 ×1.25 / 讲解 ×1.5（生成效应与费曼学习法）。',
      ],
    },
    fsrs: {
      title: '二、FSRS-4.5（可选调度器，opt-in）',
      basis: '依据：Free Spaced Repetition Scheduler（开源 FSRS-4.5）；实测相比 SM-2 省 20~30% 复习时间达到同等保持率。',
      impl: [
        '状态：每卡 { s 稳定度(天), d 难度[1..10], reps 复习次数, last 上次复习时刻 }。',
        '核心方程（可提取性）：R = (1 + t/(9·S))^-1，t 为距上次复习的天数；R 越接近 1 记得越牢。',
        '调度：由目标保持率 R*（默认 0.9）反解下次间隔 t = 9·S·(1/R* − 1)，再加 ±w17 抖动避免同日堆积。',
        '难度更新：评分越高难度下降，并向基准 w4 均值回归，钳制在 [1,10]。',
        '稳定度更新：回忆后按幂律增大（含遗忘驱动项 e^(w9·(1−R))−1）；遗忘(again)后按 D、S 重算并重学。',
      ],
      weights: '训练权重（19 个 w[0..18]）：w0~w2 初始稳定度 S0(again/hard/good)；w3 easy 乘子；w4 初始难度基准；w5 难度斜率；w6 难度均值回归；w7~w10 回忆后稳定度更新；w11~w14 遗忘后稳定度更新；w15 hard 惩罚（<1）；w16 easy 加成（>1）；w17 间隔抖动（不参与训练）；w18 未引用（保留位，实际上限为常量 365 天）。',
      train: '训练：用你的真实评分历史拟合权重，损失 = log-loss（二分类：回忆 vs 遗忘），有限差分梯度下降（19 维离线训练）。样本 ≥8 次即可用，越多越准；训练在 Web Worker 中进行，不阻塞主线程。',
      trainBtn: '训练中…',
      trainBtnDone: '训练权重',
      pretest: '冷启动前测：若某科目做过预测验 / 自评分，用其估计初始稳定度替代默认 S0，减少前几次复习的抖动（数学、线代等难科会有系数微调）。',
      guard: '方向铁律（2026-08-29 修正）：w15 是「惩罚」必须 <1、w16 是「加成」必须 >1；代码层面对 w15 做 ≤1 钳制，使「越不会的卡反而越晚复习」在结构上不可能发生。',
      // 调度器切换语义：FSRS 不使用 SM-2 的短巩固阶段（切换时如实提示，避免"文案说有、实际没有"）
      noConsolidationHint: '注意：启用 FSRS 后不再走 SM-2 的「当日巩固 / 隔日巩固」阶段（FSRS 用自身稳定度处理短期间隔）。切回 SM-2 会恢复该机制。',
    },
    choose: '如何选：默认 SM-2 零训练、即开即用；当你积累 ≥8 次真实评分后，切到 FSRS 并点「训练权重」，可进一步按你的遗忘曲线个性化，通常更省时。',
  },

  // ---------------- 工作台（Workspace） ----------------
  workspace: {
    title: '个人工作台',
    sub: '全模块可视化指挥中心',
    offline: '离线模式',
    backup: '💾 备份',
    loading: '加载中…',
    refresh: '↻ 刷新',
    todayDue: '今日待复习',
    startReview: '开始复习 →',
    startReviewNone: '今日无到期，去复习 →',
    overdueHint: '昨日遗留 {n} 张未清，已顺延至今天，优先处理',
    miniDoneToday: '今日已复习',
    miniMastery: '平均掌握度',
    miniRisk: '遗忘风险',
    kpiProfile: '学习画像分', kpiProfileHint: '画像等级',
    kpiCards: '卡片总数', kpiCardsHint: '全科目',
    kpiDue: '今日待复习', kpiDueHint: '快去清', kpiDueHintNone: '今日无到期',
    kpiDone: '今日已复习', kpiDoneHint: '去重计数',
    kpiMastery: '平均掌握度', kpiMasteryHint: '近 90 天',
    kpiPomodoro: '今日番茄', kpiPomodoroHint: '专注次数',
    matrix: '模块矩阵',
    searchPlaceholder: '🔍 搜索模块…',
    noMatch: '没有匹配的模块',
    secRisk: '遗忘风险 TOP3',
    secHealth: '资产健康',
    secDiag: '薄弱科目诊断',
    noRisk: '暂无遗忘风险卡',
    healthLoading: '体检数据加载中…',
    noDiag: '暂无科目数据',
    notifications: '通知中心',
    unread: '未读',
    noNotify: '暂无通知，智能体会在合适时机推送建议',
    recentActivity: '最近复习动态',
    noActivity: '还没有复习记录，去「开始复习」试试',
    deletedCard: '(已删除卡片)',
    loadingAgg: '正在聚合各模块数据…',
    noSync: '未同步',
    syncedAt: '同步于 {time}',
    warnBadge: '有预警',
    riskPct: '风险 {n}%',
    dueCount: '到期 {n}',
    moduleCount: '{n}/{total} 模块',
    healthDup: '重复卡', healthZombie: '僵尸卡', healthOrphan: '孤儿图片',
    rateOk: '答对', rateWarn: '模糊', rateFail: '答错',
    group: { study: '学习', plan: '规划', knowledge: '知识', english: '英语', smart: '智能', system: '系统' },
    mod: {
      cards: { label: '卡片', desc: '创建与编辑卡片' },
      groups: { label: '卡组', desc: '自定义分组管理' },
      review: { label: '背诵', desc: '到期卡复习' },
      wrong: { label: '错题', desc: '错题本重做' },
      stats: { label: '数据', desc: '统计与趋势' },
      exam: { label: '模考', desc: '组卷自测' },
      genquiz: { label: '生成测验', desc: 'AI 出题' },
      daily: { label: '每日规划', desc: '口述→任务→打卡' },
      plans: { label: '计划', desc: '学习计划管理' },
      pomodoro: { label: '番茄', desc: '专注计时' },
      weekly: { label: '周报', desc: '每周复盘' },
      achievements: { label: '成就', desc: '解锁徽章' },
      notes: { label: '笔记', desc: '厚笔记·双向链接' },
      memo: { label: '备忘', desc: '四象限短备忘' },
      docs: { label: '文档', desc: 'AI 文档问答' },
      mindmap: { label: '导图', desc: '思维导图' },
      graph: { label: '图谱', desc: '知识图谱' },
      categories: { label: '分类', desc: '自动归类' },
      search: { label: '搜索', desc: '全局检索' },
      library: { label: '书房', desc: '阅读书目' },
      materials: { label: '资料库', desc: '上传解析问答' },
      english: { label: '英语中心', desc: '单词·短语总览' },
      'english-book': { label: '单词本', desc: '词库管理·释义' },
      'english-study': { label: '英语背诵', desc: '13 种复习模式' },
      'english-ai': { label: 'AI 智能模式', desc: '释义例句补全' },
      'english-phrases': { label: '词组分组', desc: '自定义词单' },
      'english-learned': { label: '已掌握', desc: '熟悉词归档' },
      'english-groups': { label: '词单分组', desc: '分组管理' },
      'english-stats': { label: '英语统计', desc: '学习曲线' },
      'english-export': { label: '词单导出', desc: '打包导出' },
      'english-settings': { label: '英语设置', desc: '词库与背诵偏好' },
      ai: { label: 'AI', desc: '智能问答' },
      agent: { label: 'Agent', desc: 'Agent 工作台' },
      feynman: { label: '费曼', desc: '费曼练习' },
      insight: { label: '卡片洞察', desc: '遗忘曲线' },
      'card-link': { label: '联动分析', desc: '卡片智能关联' },
      health: { label: '体检', desc: '资产健康检查' },
      sync: { label: '同步', desc: '局域网/备份' },
      export: { label: '导出', desc: '备份与导出' },
      trash: { label: '回收站', desc: '删除恢复（30 天）' },
      uikit: { label: 'UI 规范', desc: '组件主题活样本' },
      'user-dashboard': { label: '仪表盘', desc: '行为监控' },
      privacy: { label: '超级监控', desc: '人生数据监控' },
      plugins: { label: '插件', desc: '扩展管理' },
    },
  },

  // ---------------- 常用 ----------------
  common: {
    more: '更多', resetTitle: '清空全部数据', resetConfirmHint: '此操作不可恢复，请谨慎。',
    chunkReload: '应用已更新，正在刷新以加载新版本…',
    zoom: {
      label: '阅读缩放', in: '放大字号', out: '缩小字号', reset: '恢复默认字号',
      level: '当前缩放 {n}', fit: '适应窗口', fullscreen: '大图模式', exitFullscreen: '退出大图',
    },
  },

  // ---------------- 学习画像（跨视图共用：Workspace 的 KPI 卡 + Stats 的画像面板） ----------------
  // 等级名放根字典而不是各视图字典：getLearningProfile 只回 levelCode，
  // 两个视图都要把 code 翻成等级名，各存一份迟早漂移。
  profile: {
    level: { excellent: '优秀', good: '良好', fair: '中等', needsWork: '待提升' },
    summary: '掌握度 {mastery}% · 正确率 {correct}% · 稳定度 {stable}% · 覆盖率 {coverage}% · 活跃度 {activity}% · 纠正力 {correction}%',
  },

  // ---------------- 知识图谱边标签（round11b N-1） ----------------
  // graphAuto 自动建边落库的是语义 code（labelKind），这里翻成显示文本。
  // 只用于 auto 派生边；AI / 用户手动边的 label 是内容本身，不经过字典。
  graph: {
    labelKind: { prereq: '前置', sameTag: '同标签', similar: '内容相似', coMistake: '易错同现', related: '相关' },
  },

  // ---------------- Agent 编排器（src/agent/orchestrator.js）UI-facing trace/name ----------------
  agent: {
    orchestrator: {
      pipelineStart: '检测到复杂多步任务，启动多智能体流水线',
      pipelineAgentName: '多智能体流水线',
      pipelineFallback: '流水线回退，改用单 Agent 模式',
      routedToAgent: '路由到 Agent：{name}',
      emptyReplyFallback: '（当前未生成回答内容，请重试或检查 AI 配置）',
    },
    // LLM 适配层（src/agent/llm.js）：超时语义为「空闲超时」，超时但有部分输出时交出已生成内容
    llm: {
      timeoutError: 'AI 请求超时（>{n}s 无新数据）',
      canceled: 'AI 请求已取消',
      timeoutPartial: '> ⏱️ 本次回答因超时中断，以上为**已生成的部分**。可把问题拆小（例如分批列卡片）后重试。',
      retried: '，已自动重试 {n} 次',
      requestFailed: 'AI 请求失败({info})：{detail}',
      // round105：流式空响应诊断（与非流式分支同口径）。
      // 之所以要分开四种，是因为"返回为空"的可行动作完全不同：
      // 换模型 / 调大预算 / 重试网络，用户按错的提示排查就是白费功夫。
      emptyReasoningBudget: '模型把输出预算全花在推理过程上（本次 max_tokens={n}，finish_reason=length，正文为空）——请到「AI 设置」把「最大输出长度」调大，或改用普通对话模型。',
      emptyTruncatedBody: 'AI 输出被 max_tokens 上限截断（本次 max_tokens={n}），且没来得及产出正文——请把「最大输出长度」调大后重试。',
      emptyReasoningOnly: '当前模型只返回了推理过程（reasoning_content）、正文为空——请在 AI 设置里改用普通对话模型。',
      emptyNoData: 'AI 服务返回了空响应且未收到任何数据（HTTP {status}）——通常是网络中断或网关异常，请重试。',
      emptyNoContent: 'AI 服务返回了响应但正文为空（HTTP {status}）——可能被内容过滤或网关改写，请重试或换个模型。',
    },
    // 工具返回给模型的提示/错误（src/agent/tools/index.js）。
    // 为什么进字典而不是硬编码：llm 不可达时 buildLocalAnswer 会把工具的错误/提示
    // 原样渲染给用户看（「工具 X 执行失败」+ 原因），所以它确实会到用户屏幕上，
    // 属于需要可本地化的文案（i18n 第三道闸按「短中文字符串 = 疑似 UI 文案」判定，一致）。
    toolMsg: {
      badDate: 'date 格式应为 YYYY-MM-DD，收到「{value}」。',
      noPlanThatDay: '这一天没有规划记录。',
      noNotes: '还没有任何笔记，请让用户在「笔记」页新建后再让我读。',
      emptyContent: '内容不能为空，请先给我要写入的正文。',
      emptyTaskTitle: '任务标题不能为空。',
      emptyPatch: '没有要修改的字段（content / newTitle / category / tags 至少给一个）。',
      noteVanished: '这篇笔记不存在或已被删除。',
      badCheckinStatus: '打卡状态只能是 done / partial / skipped。',
      taskNotFound: '未找到匹配的任务。可先用 list_daily_tasks 传日期查看当天任务，再用 taskId 打卡。',
      taskWriteFailed: '任务写入失败（计划创建后未返回任务行），请重试或改用 create_daily_plan。',
      // round88：英语单词模块（src/agent/tools/index.js 的 list_words / get_word_detail）
      noWords: '词库里还没有单词卡。请先在「单词」页导入或新建词卡，再让我分析。',
      wordNotFound: '未找到这张单词卡。可先用 list_words 查看完整列表（支持按关键词 / 类别 / 掌握状态过滤）。',
      wordsHint: '以上只是摘要（词形 + 释义片段）。完整释义 / 例句 / 笔记请用 get_word_detail（传 id 或 word）取全文；'
        + '总体进度与各组掌握率用 get_word_stats。',
      wordStatsHint: '以上是统计口径。要看具体单词内容请用 list_words（可带 q / kind / familiar 过滤），'
        + '再用 get_word_detail 取单张词卡的全文。',
    },
    // 有工具数据但 LLM 合成失败时的本地直出（src/agent/local-answer.js）
    localAnswer: {
      notice: '> ⚠️ **AI 合成回答暂不可用**（网络或服务异常）。以下是你本地数据的直接结果，未经模型改写。',
      // round71：带上**真实原因**。旧版一律写「网络或服务异常」，密钥过期/被限流/回答超长的用户
      // 都被误导成"网断了"，只能反复重试同一件错事。
      noticeWithReason: '> ⚠️ **AI 合成回答暂不可用**（{reason}）。以下是你本地数据的直接结果，未经模型改写。',
      reasonTimeout: '模型响应超时，已改为本地直出',
      reasonCanceled: '请求被取消',
      reasonAuth: 'API 密钥无效或无权限，请到「AI 设置」检查密钥',
      reasonModel: '接口或模型不存在，请检查 baseUrl / model',
      reasonRate: '触发频率限制（429），请稍后重试',
      reasonServer: '模型服务暂时不可用（5xx），请稍后重试',
      reasonHttp: '接口返回 HTTP {status}',
      reasonNetwork: '网络或服务异常',
      reasonOffline: 'AI 未生成可用的回答内容',
      // round88：Agent 步数预算耗尽。原先这里根本没有 key——base.js 直接硬编码
      // 「（已达到最大推理步数，Agent 提前结束）」并**丢掉已抓到的全部工具数据**。
      reasonStepLimit: '已达到工具调用步数上限，已改为本地直出',
      stepLimitNoData: '（已达到最大推理步数，Agent 提前结束）本轮没有取到可展示的数据。请把问题拆小一些再问，例如先「列出我的科目和标签」，或直接说明想看哪个模块的什么内容。',
      // 收尾步的硬指令：不给这句，模型大概率在该步继续调工具，白白浪费预留的收尾预算。
      finalizeInstruction: '（注意：本轮工具调用预算只剩最后一步，且这一步不允许再调用工具。请**立即**根据上面已得到的工具结果输出 <final> 回答；若数据仍不完整，就如实说明还差哪一项，不要重复调用工具。）',
      budgetHint: '（预算提示：本轮还可调用工具 {n} 次，之后必须输出 <final> 收尾。请把关键数据取全，并预留一次用于收尾。）',
      toolCallAfterBudget: '工具调用预算已用尽，已跳过本次 {tool} 调用，改用本地直出已抓到的数据',
      listFrom: '工具 {tool} · 共 {n} 条',
      more: '还有 {n} 条未展开',
      dataFrom: '工具 {tool} 返回',
      emptyFrom: '工具 {tool} 未返回数据',
      toolFailed: '工具 {tool} 执行失败',
      untitled: '（无标题）',
      kvSep: '，',
      retryHint: '以上内容由本地数据直接生成（AI 不可达时的降级结果），网络恢复后可重新提问获得完整回答。',
    },
  },

  // ---------------- 通用组件（src/components/*） ----------------
  components: {
    aiQuiz: {
      progress: '已答 {done}/{total}',
      score: '答对 {right}/{total}',
      reset: '重做',
      correct: '答对了',
      wrong: '答错了，正确选项是 {answer}',
      explain: '解析：',
      record: '记入复习',
      recorded: '已记入复习',
    },
    aiGraph: {
      renderFailed: '图表渲染失败，以下为原始结构：',
      truncated: '节点过多，已截断显示前 {n} 个（其余省略）。',
    },
  },

  // ---------------- 通用工具文案（src/utils/llm-json.js 等） ----------------
  utils: {
    llmJson: {
      emptyReply: 'AI 返回内容为空（可能被截断或模型异常），请重试',
      badFormat: 'AI 返回内容无法解析为 JSON，请重试',
      notArray: 'AI 返回格式异常：不是 JSON 数组',
    },
    // 情境变式生成（src/utils/genVariants.js）
    genVariants: {
      offlineNoKey: '离线模式无法生成变式，请先配置 AI 密钥',
      offlineFailed: '网络失败且离线变式生成失败，请稍后重试',
      noValidVariant: 'AI 未生成有效变式（返回内容里没有可用的题目，可再试一次或换个模型）',
    },
  },

  // ---------------- 业务视图（按视图分批外置，见 src/views/*.vue） ----------------
  views: {},
};

const en = {
  nav: {
    overview: 'Overview', workspace: 'Workspace', cards: 'Cards', groups: 'Decks',
    cardLink: 'Link Analysis', review: 'Review', stats: 'Stats', export: 'Export',
    sync: 'Sync', ai: 'AI', agent: 'Agent', feynman: 'Feynman', memo: 'Memo',
    notes: 'Notes', categories: 'Categories', daily: 'Daily Plan', wrong: 'Mistakes',
    pomodoro: 'Pomodoro', graph: 'Graph', mindmap: 'Mindmap', plans: 'Plans',
    docs: 'Docs', weekly: 'Weekly', exam: 'Exam', genquiz: 'Quiz Gen',
    search: 'Search', health: 'Health', trash: 'Trash', library: 'Library',
    materials: 'Materials', achievements: 'Awards', dashboard: 'Dashboard',
    privacy: 'Super Monitor', plugins: 'Plugins',     insight: 'Insight', uikit: 'UI Kit', words: 'Words', english: 'English',
    more: 'More',
  },
  settings: {
    title: 'Settings',
    appearance: '🎨 Appearance',
    remind: '⏰ Reminders & Monitor',
    engine: '🧠 Learning Engine',
    nav: '🧭 Navigation',
    storage: '💾 Storage',
    language: 'Language',
    languageHint: 'Applies to the whole app immediately (incl. nav and docs).',
    clearPwaCache: '🧹 Clear cache & refresh',
    clearPwaCacheHint: 'Unregister the Service Worker and clear offline caches, then reload (all local data is kept). Use when the page is stuck on an old version.',
    demo: {
      title: 'Demo Mode',
      hint: 'Explore every feature with a sample dataset. Demo data is physically isolated from your real data (separate local database) — exit or reset anytime without touching real data.',
      current: 'Current data scope',
      on: 'Demo mode (sample data)',
      off: 'Real data',
      enter: 'Enter demo mode',
      exit: 'Exit demo mode',
      reset: 'Reset sample data',
    },
  },
  engine: {
    title: 'Review Scheduler (memory-curve algorithm)',
    intro: 'The scheduler decides when each card reappears. SxyBrick ships two memory curves: the SM-2 variant (default) and FSRS-4.5 (optional, ML-fitted). Both are built on spaced repetition — reviewing just before forgetting, to hit the target retention with the fewest reviews.',
    sm2: {
      title: '1. SM-2 variant (default scheduler)',
      basis: 'Basis: enhanced classic SM-2 (SuperMemo 2, 1990); the consolidation state machine derives from the testing effect (Roediger & Karpicke, 2006).',
      impl: [
        'State per card: { level, ease factor, consolidation stage }.',
        'Level steps: level 1~4 intervals are 1 / 3 / 7 / 15 days; beyond level 4 it grows exponentially as ease^(level-4).',
        'Difficulty factor: easy / medium / hard = 1.15 / 1.0 / 0.8 (harder → shorter interval, fitting a personal forgetting curve).',
        'Wrong-reason penalty: even on a correct answer the interval is shortened by severity — concept mix-up ×0.6, weak memory ×0.7, misread ×0.85, careless ×0.9, other ×1.0.',
        'Consolidation: after a new card’s first correct answer, two extra active recalls are inserted — "6 hours later today" and "next day" (the first recall within 24h is the strongest consolidation window) — before entering the normal ladder.',
        'Guess handling: a guess does not count as mastery — level stays, ease dips slightly and consolidation exits, interval further discounted by 0.6.',
        'Adaptive pace (optional): recent 10-review fail rate ≥40% → interval ×0.8 (recur sooner); all-correct and level≥3 → ×1.1 (stretch if stable).',
        'Retrieval strength (P1-3): recognize ×0.7 / recall ×1.0 / generate ×1.25 / explain ×1.5 (generation effect & Feynman technique).',
      ],
    },
    fsrs: {
      title: '2. FSRS-4.5 (optional scheduler, opt-in)',
      basis: 'Basis: Free Spaced Repetition Scheduler (open-source FSRS-4.5); measured to save 20~30% review time vs SM-2 at equal retention.',
      impl: [
        'State per card: { s stability (days), d difficulty [1..10], reps count, last review time }.',
        'Core equation (retrievability): R = (1 + t/(9·S))^-1, where t = days since last review; R closer to 1 means better recall.',
        'Scheduling: given target retention R* (default 0.9), invert to next interval t = 9·S·(1/R* − 1), plus ±w17 fuzz to avoid same-day pile-up.',
        'Difficulty update: higher grade lowers difficulty, with mean-reversion to baseline w4, clamped to [1,10].',
        'Stability update: after recall it grows by a power law (with a forgetting-driven term e^(w9·(1−R))−1); after a miss (again) it is recomputed from D and S and re-learned.',
      ],
      weights: 'Training weights (19 × w[0..18]): w0~w2 initial stability S0(again/hard/good); w3 easy multiplier; w4 initial-difficulty baseline; w5 difficulty slope; w6 difficulty mean-reversion; w7~w10 post-recall stability update; w11~w14 post-forget stability update; w15 hard penalty (<1); w16 easy bonus (>1); w17 interval fuzz (not trained); w18 unused (reserved slot — the real cap is the constant 365 days).',
      train: 'Training: fits weights to your real rating history; loss = log-loss (binary: recall vs forget), finite-difference gradient descent (19-dim offline). Usable from ≥8 samples, better with more; runs in a Web Worker, non-blocking.',
      trainBtn: 'Training…',
      trainBtnDone: 'Train weights',
      pretest: 'Cold-start pretest: if a subject has a pretest / self-rating, its estimated initial stability replaces the default S0, reducing early-review jitter (hard subjects like math / linear algebra get a coefficient tweak).',
      guard: 'Direction rule (2026-08-29 fix): w15 is a "penalty" and must be <1, w16 is a "bonus" and must be >1; code clamps w15 ≤1 so "harder cards reviewed later" is structurally impossible.',
      noConsolidationHint: 'Note: with FSRS enabled, the SM-2 "same-day consolidation / next-day consolidation" stages are no longer used (FSRS handles short intervals via its own stability). Switching back to SM-2 restores them.',
    },
    choose: 'Which to pick: SM-2 is zero-training and ready out of the box; once you have ≥8 real ratings, switch to FSRS and hit "Train weights" to personalize to your forgetting curve — usually saving more time.',
  },

  workspace: {
    title: 'Workspace',
    sub: 'Visual command center for all modules',
    offline: 'Offline mode',
    backup: '💾 Backup',
    loading: 'Loading…',
    refresh: '↻ Refresh',
    todayDue: 'Due today',
    startReview: 'Start review →',
    startReviewNone: 'Nothing due — review anyway →',
    overdueHint: '{n} cards left from yesterday, rolled over to today — handle first',
    miniDoneToday: 'Reviewed today',
    miniMastery: 'Avg mastery',
    miniRisk: 'Forget risk',
    kpiProfile: 'Profile score', kpiProfileHint: 'Profile level',
    kpiCards: 'Total cards', kpiCardsHint: 'All subjects',
    kpiDue: 'Due today', kpiDueHint: 'Go clear', kpiDueHintNone: 'Nothing due',
    kpiDone: 'Reviewed today', kpiDoneHint: 'Dedup count',
    kpiMastery: 'Avg mastery', kpiMasteryHint: 'Last 90d',
    kpiPomodoro: 'Pomodoros', kpiPomodoroHint: 'Focus sessions',
    matrix: 'Module matrix',
    searchPlaceholder: '🔍 Search modules…',
    noMatch: 'No matching modules',
    secRisk: 'Top 3 forget risks',
    secHealth: 'Asset health',
    secDiag: 'Weak-subject diagnosis',
    noRisk: 'No forget-risk cards',
    healthLoading: 'Loading health check…',
    noDiag: 'No subject data',
    notifications: 'Notifications',
    unread: 'unread',
    noNotify: 'No notifications yet — the agent will push tips at the right moment',
    recentActivity: 'Recent reviews',
    noActivity: 'No reviews yet — go "Start review" to try',
    deletedCard: '(deleted card)',
    loadingAgg: 'Aggregating module data…',
    noSync: 'Not synced',
    syncedAt: 'Synced at {time}',
    warnBadge: 'Has warning',
    riskPct: 'Risk {n}%',
    dueCount: 'Due {n}',
    moduleCount: '{n}/{total} modules',
    healthDup: 'Duplicate cards', healthZombie: 'Zombie cards', healthOrphan: 'Orphan images',
    rateOk: 'Correct', rateWarn: 'Vague', rateFail: 'Wrong',
    group: { study: 'Study', plan: 'Plan', knowledge: 'Knowledge', english: 'English', smart: 'Smart', system: 'System' },
    mod: {
      cards: { label: 'Cards', desc: 'Create & edit cards' },
      groups: { label: 'Groups', desc: 'Custom group mgmt' },
      review: { label: 'Review', desc: 'Due-card review' },
      wrong: { label: 'Mistakes', desc: 'Mistake redo' },
      stats: { label: 'Stats', desc: 'Stats & trends' },
      exam: { label: 'Exam', desc: 'Mock exam' },
      genquiz: { label: 'Quiz Gen', desc: 'AI question gen' },
      daily: { label: 'Daily Plan', desc: 'Speak→task→check-in' },
      plans: { label: 'Plans', desc: 'Study plan mgmt' },
      pomodoro: { label: 'Pomodoro', desc: 'Focus timer' },
      weekly: { label: 'Weekly', desc: 'Weekly review' },
      achievements: { label: 'Awards', desc: 'Unlock badges' },
      notes: { label: 'Notes', desc: 'Notes · bi-link' },
      memo: { label: 'Memo', desc: 'Quadrant memo' },
      docs: { label: 'Docs', desc: 'AI doc Q&A' },
      mindmap: { label: 'Mindmap', desc: 'Mind map' },
      graph: { label: 'Graph', desc: 'Knowledge graph' },
      categories: { label: 'Categories', desc: 'Auto classify' },
      search: { label: 'Search', desc: 'Global search' },
      library: { label: 'Library', desc: 'Reading list' },
      materials: { label: 'Materials', desc: 'Upload & parse' },
      english: { label: 'English Hub', desc: 'Words & phrases' },
      'english-book': { label: 'Wordbook', desc: 'Lexicon & meanings' },
      'english-study': { label: 'English Review', desc: '13 review modes' },
      'english-ai': { label: 'AI Modes', desc: 'Meaning & example fill' },
      'english-phrases': { label: 'Phrases', desc: 'Custom word lists' },
      'english-learned': { label: 'Mastered', desc: 'Familiar words' },
      'english-groups': { label: 'Word Groups', desc: 'Group mgmt' },
      'english-stats': { label: 'English Stats', desc: 'Learning curve' },
      'english-export': { label: 'Word Export', desc: 'Pack & export' },
      'english-settings': { label: 'English Settings', desc: 'Lexicon & review prefs' },
      ai: { label: 'AI', desc: 'Smart Q&A' },
      agent: { label: 'Agent', desc: 'Agent workbench' },
      feynman: { label: 'Feynman', desc: 'Feynman practice' },
      insight: { label: 'Insight', desc: 'Forgetting curve' },
      'card-link': { label: 'Link Analysis', desc: 'Smart card links' },
      health: { label: 'Health', desc: 'Asset health check' },
      sync: { label: 'Sync', desc: 'LAN / backup' },
      export: { label: 'Export', desc: 'Backup & export' },
      trash: { label: 'Trash', desc: 'Deleted (30-day restore)' },
      uikit: { label: 'UI Kit', desc: 'Live component samples' },
      'user-dashboard': { label: 'Dashboard', desc: 'Behavior monitor' },
      privacy: { label: 'Super Monitor', desc: 'Life-data monitor' },
      plugins: { label: 'Plugins', desc: 'Extension mgmt' },
    },
  },
  common: {
    more: 'More', resetTitle: 'Erase All Data', resetConfirmHint: 'This cannot be undone. Please be careful.',
    chunkReload: 'The app has been updated. Refreshing to load the new version…',
    zoom: {
      label: 'Text zoom', in: 'Increase text size', out: 'Decrease text size', reset: 'Reset text size',
      level: 'Zoom {n}', fit: 'Fit to window', fullscreen: 'Large view', exitFullscreen: 'Exit large view',
    },
  },

  profile: {
    level: { excellent: 'Excellent', good: 'Good', fair: 'Fair', needsWork: 'Needs work' },
    summary: 'Mastery {mastery}% · Accuracy {correct}% · Stability {stable}% · Coverage {coverage}% · Activity {activity}% · Correction {correction}%',
  },

  graph: {
    labelKind: { prereq: 'Prereq', sameTag: 'Same tag', similar: 'Similar', coMistake: 'Co-mistake', related: 'Related' },
  },

  // ---------------- Agent orchestrator UI-facing trace / name strings ----------------
  agent: {
    orchestrator: {
      pipelineStart: 'Multi-step task detected — starting multi-agent pipeline',
      pipelineAgentName: 'Multi-Agent Pipeline',
      pipelineFallback: 'Pipeline fallback, switching to single-agent mode',
      routedToAgent: 'Routed to Agent: {name}',
      emptyReplyFallback: '(Empty response — please retry or check your AI configuration)',
    },
    // LLM adapter (src/agent/llm.js): timeout means *idle* timeout; partial output is salvaged on timeout
    llm: {
      timeoutError: 'AI request timed out (no new data for >{n}s)',
      canceled: 'AI request was canceled',
      timeoutPartial: '> ⏱️ This answer was cut off by a timeout; the above is the part already generated. Try narrowing the question (e.g. list cards in batches) and retry.',
      retried: ', auto-retried {n} time(s)',
      requestFailed: 'AI request failed ({info}): {detail}',
      // round105: streaming empty-response diagnosis (same wording policy as the non-streaming path)
      emptyReasoningBudget: 'The model spent its whole output budget on reasoning (max_tokens={n} this call, finish_reason=length, empty body) — raise the "max output length" in AI settings, or switch to a regular chat model.',
      emptyTruncatedBody: 'Output hit the max_tokens limit (max_tokens={n} this call) before any body text was produced — raise the "max output length" and retry.',
      emptyReasoningOnly: 'The model returned only its reasoning (reasoning_content) with an empty body — switch to a regular chat model in AI settings.',
      emptyNoData: 'The AI service returned an empty response with no data (HTTP {status}) — usually a network drop or gateway issue; please retry.',
      emptyNoContent: 'The AI service responded but the body is empty (HTTP {status}) — possibly content filtering or a gateway rewrite; retry or switch models.',
    },
    // Tool-side notices/errors surfaced to the model (src/agent/tools/index.js)
    toolMsg: {
      badDate: 'date must be in YYYY-MM-DD format; received "{value}".',
      noPlanThatDay: 'No plan was recorded for this day.',
      noNotes: 'No notes yet — ask the user to create one on the Notes page, then I can read it.',
      emptyContent: 'Content cannot be empty.',
      emptyTaskTitle: 'Task title cannot be empty.',
      emptyPatch: 'Nothing to update (provide at least one of content / newTitle / category / tags).',
      noteVanished: 'That note does not exist or was deleted.',
      badCheckinStatus: 'Check-in status must be done / partial / skipped.',
      taskNotFound: 'No matching task found. Use list_daily_tasks with a date to list the tasks of that day, then check in by taskId.',
      taskWriteFailed: 'Task write failed (plan created but no task row returned). Retry, or use create_daily_plan instead.',
      noWords: 'No word cards in the vocabulary yet. Import or create some on the Words page, then I can analyse them.',
      wordNotFound: 'That word card was not found. Use list_words to see the full list (it supports keyword / kind / familiarity filters).',
      wordsHint: 'The above are summaries only (word form + a meaning snippet). Use get_word_detail (by id or word) for the full meaning / examples / notes; use get_word_stats for overall progress and per-group mastery.',
      wordStatsHint: 'The above are statistics only. Use list_words (with q / kind / familiar filters) to see actual words, then get_word_detail for one card in full.',
    },
    // Local fallback answer built from tool results when LLM synthesis fails
    localAnswer: {
      notice: '> ⚠️ **AI synthesis unavailable** (network or service error). Below is the direct result from your local data, not rewritten by a model.',
      noticeWithReason: '> ⚠️ **AI synthesis unavailable** ({reason}). Below is the direct result from your local data, not rewritten by a model.',
      reasonTimeout: 'the model timed out, so the local result is shown instead',
      reasonCanceled: 'the request was canceled',
      reasonAuth: 'invalid or unauthorized API key — check it in AI Settings',
      reasonModel: 'endpoint or model not found — check baseUrl / model',
      reasonRate: 'rate limited (429), please retry later',
      reasonServer: 'model service temporarily unavailable (5xx), please retry later',
      reasonHttp: 'endpoint returned HTTP {status}',
      reasonNetwork: 'network or service error',
      reasonOffline: 'the AI produced no usable answer',
      reasonStepLimit: 'the tool-call step limit was reached, so the local result is shown instead',
      stepLimitNoData: '(Maximum reasoning steps reached — the agent stopped early.) No displayable data was collected this round. Please narrow the question down (e.g. ask "list my subjects and tags" first), or name the module and field you want to see.',
      finalizeInstruction: '(Notice: this is the last step of the tool budget and no further tool calls are allowed. Output your <final> answer right now based on the tool results above; if the data is still incomplete, say which item is missing instead of calling tools again.)',
      budgetHint: '(Budget notice: you may call {n} more tool(s) this round, after which you must output <final>. Fetch the key data now and keep one call for wrapping up.)',
      toolCallAfterBudget: 'Tool budget exhausted — skipped this {tool} call and fell back to the local result built from data already fetched',
      listFrom: 'Tool {tool} · {n} item(s)',
      more: '{n} more not expanded',
      dataFrom: 'Tool {tool} returned',
      emptyFrom: 'Tool {tool} returned no data',
      toolFailed: 'Tool {tool} failed',
      untitled: '(untitled)',
      kvSep: ', ',
      retryHint: 'Generated directly from local data (degraded result while AI is unreachable). Retry when the network recovers for a full answer.',
    },
  },

  // ---------------- Shared components (src/components/*) ----------------
  components: {
    aiQuiz: {
      progress: 'Answered {done}/{total}',
      score: 'Correct {right}/{total}',
      reset: 'Redo',
      correct: 'Correct',
      wrong: 'Wrong — the answer is {answer}',
      explain: 'Why: ',
      record: 'Log as review',
      recorded: 'Logged as review',
    },
    aiGraph: {
      renderFailed: 'Chart rendering failed; raw structure below: ',
      truncated: 'Too many nodes — showing the first {n} only.',
    },
  },

  // ---------------- Shared utility strings (src/utils/llm-json.js etc.) ----------------
  utils: {
    // 情境变式生成（src/utils/genVariants.js）
    genVariants: {
      offlineNoKey: 'Cannot generate variants offline — please configure an AI key first.',
      offlineFailed: 'Network failed and offline variant generation also failed — please retry later.',
      noValidVariant: 'The AI produced no usable variants (no valid question in the response). Retry or switch models.',
    },
    llmJson: {
      emptyReply: 'AI returned empty content (possibly truncated) — please retry',
      badFormat: 'AI output could not be parsed as JSON — please retry',
      notArray: 'Unexpected AI output format: not a JSON array',
    },
  },

  // ---------------- Business views (externalized per view, see src/views/*.vue) ----------------
  views: {},
};

// —— 合并业务视图字典（每个视图一个模块，见 src/i18n/views/*.js） ——
import { zh as achievementsZh, en as achievementsEn } from './views/achievements.js';
import { zh as agentWorkbenchZh, en as agentWorkbenchEn } from './views/agentWorkbench.js';
import { zh as aiAssistantZh, en as aiAssistantEn } from './views/aiAssistant.js';
import { zh as cardGroupsZh, en as cardGroupsEn } from './views/cardGroups.js';
import { zh as cardInsightZh, en as cardInsightEn } from './views/cardInsight.js';
import { zh as cardLinkAnalysisZh, en as cardLinkAnalysisEn } from './views/cardLinkAnalysis.js';
import { zh as cardsZh, en as cardsEn } from './views/cards.js';
import { zh as categoryZh, en as categoryEn } from './views/category.js';
import { zh as dailyPlanZh, en as dailyPlanEn } from './views/dailyPlan.js';
import { zh as dashboardZh, en as dashboardEn } from './views/dashboard.js';
import { zh as docsZh, en as docsEn } from './views/docs.js';
import { zh as examZh, en as examEn } from './views/exam.js';
import { zh as exportZh, en as exportEn } from './views/export.js';
import { zh as feynmanZh, en as feynmanEn } from './views/feynman.js';
import { zh as genQuizZh, en as genQuizEn } from './views/genQuiz.js';
import { zh as healthZh, en as healthEn } from './views/health.js';
import { zh as knowledgeGraphZh, en as knowledgeGraphEn } from './views/knowledgeGraph.js';
import { zh as libraryZh, en as libraryEn } from './views/library.js';
import { zh as libraryFilesZh, en as libraryFilesEn } from './views/libraryFiles.js';
import { zh as memoZh, en as memoEn } from './views/memo.js';
import { zh as mindmapZh, en as mindmapEn } from './views/mindmap.js';
import { zh as notesViewZh, en as notesViewEn } from './views/notesView.js';
import { zh as plansZh, en as plansEn } from './views/plans.js';
import { zh as pluginsZh, en as pluginsEn } from './views/plugins.js';
import { zh as pomodoroZh, en as pomodoroEn } from './views/pomodoro.js';
import { zh as privacyDataZh, en as privacyDataEn } from './views/privacyData.js';
import { zh as recycleBinZh, en as recycleBinEn } from './views/recycleBin.js';
import { zh as reviewZh, en as reviewEn } from './views/review.js';
import { zh as searchZh, en as searchEn } from './views/search.js';
import { zh as statsZh, en as statsEn } from './views/stats.js';
import { zh as syncZh, en as syncEn } from './views/sync.js';
import { zh as uiKitZh, en as uiKitEn } from './views/uiKit.js';
import { zh as userDashboardZh, en as userDashboardEn } from './views/userDashboard.js';
import { zh as weeklyReportZh, en as weeklyReportEn } from './views/weeklyReport.js';
import { zh as wordAiModesZh, en as wordAiModesEn } from './views/wordAiModes.js';
import { zh as wordBookZh, en as wordBookEn } from './views/wordBook.js';
import { zh as wordExportZh, en as wordExportEn } from './views/wordExport.js';
import { zh as wordGroupsZh, en as wordGroupsEn } from './views/wordGroups.js';
import { zh as wordHubZh, en as wordHubEn } from './views/wordHub.js';
import { zh as wordLearnedZh, en as wordLearnedEn } from './views/wordLearned.js';
import { zh as wordPhrasesZh, en as wordPhrasesEn } from './views/wordPhrases.js';
import { zh as wordReviewZh, en as wordReviewEn } from './views/wordReview.js';
import { zh as wordSettingsZh, en as wordSettingsEn } from './views/wordSettings.js';
import { zh as wordStudyZh, en as wordStudyEn } from './views/wordStudy.js';
import { zh as wrongBookZh, en as wrongBookEn } from './views/wrongBook.js';

zh.views.achievements = achievementsZh;
en.views.achievements = achievementsEn;
zh.views.agentWorkbench = agentWorkbenchZh;
en.views.agentWorkbench = agentWorkbenchEn;
zh.views.aiAssistant = aiAssistantZh;
en.views.aiAssistant = aiAssistantEn;
zh.views.cardGroups = cardGroupsZh;
en.views.cardGroups = cardGroupsEn;
zh.views.cardInsight = cardInsightZh;
en.views.cardInsight = cardInsightEn;
zh.views.cardLinkAnalysis = cardLinkAnalysisZh;
en.views.cardLinkAnalysis = cardLinkAnalysisEn;
zh.views.cards = cardsZh;
en.views.cards = cardsEn;
zh.views.category = categoryZh;
en.views.category = categoryEn;
zh.views.dailyPlan = dailyPlanZh;
en.views.dailyPlan = dailyPlanEn;
zh.views.dashboard = dashboardZh;
en.views.dashboard = dashboardEn;
zh.views.docs = docsZh;
en.views.docs = docsEn;
zh.views.exam = examZh;
en.views.exam = examEn;
zh.views.export = exportZh;
en.views.export = exportEn;
zh.views.feynman = feynmanZh;
en.views.feynman = feynmanEn;
zh.views.genQuiz = genQuizZh;
en.views.genQuiz = genQuizEn;
zh.views.health = healthZh;
en.views.health = healthEn;
zh.views.knowledgeGraph = knowledgeGraphZh;
en.views.knowledgeGraph = knowledgeGraphEn;
zh.views.library = libraryZh;
en.views.library = libraryEn;
zh.views.libraryFiles = libraryFilesZh;
en.views.libraryFiles = libraryFilesEn;
zh.views.memo = memoZh;
en.views.memo = memoEn;
zh.views.mindmap = mindmapZh;
en.views.mindmap = mindmapEn;
zh.views.notesView = notesViewZh;
en.views.notesView = notesViewEn;
zh.views.plans = plansZh;
en.views.plans = plansEn;
zh.views.plugins = pluginsZh;
en.views.plugins = pluginsEn;
zh.views.pomodoro = pomodoroZh;
en.views.pomodoro = pomodoroEn;
zh.views.privacyData = privacyDataZh;
en.views.privacyData = privacyDataEn;
zh.views.recycleBin = recycleBinZh;
en.views.recycleBin = recycleBinEn;
zh.views.review = reviewZh;
en.views.review = reviewEn;
zh.views.search = searchZh;
en.views.search = searchEn;
zh.views.stats = statsZh;
en.views.stats = statsEn;
zh.views.sync = syncZh;
en.views.sync = syncEn;
zh.views.uiKit = uiKitZh;
en.views.uiKit = uiKitEn;
zh.views.userDashboard = userDashboardZh;
en.views.userDashboard = userDashboardEn;
zh.views.weeklyReport = weeklyReportZh;
en.views.weeklyReport = weeklyReportEn;
zh.views.wordAiModes = wordAiModesZh;
en.views.wordAiModes = wordAiModesEn;
zh.views.wordBook = wordBookZh;
en.views.wordBook = wordBookEn;
zh.views.wordExport = wordExportZh;
en.views.wordExport = wordExportEn;
zh.views.wordGroups = wordGroupsZh;
en.views.wordGroups = wordGroupsEn;
zh.views.wordHub = wordHubZh;
en.views.wordHub = wordHubEn;
zh.views.wordLearned = wordLearnedZh;
en.views.wordLearned = wordLearnedEn;
zh.views.wordPhrases = wordPhrasesZh;
en.views.wordPhrases = wordPhrasesEn;
zh.views.wordReview = wordReviewZh;
en.views.wordReview = wordReviewEn;
zh.views.wordSettings = wordSettingsZh;
en.views.wordSettings = wordSettingsEn;
zh.views.wordStudy = wordStudyZh;
en.views.wordStudy = wordStudyEn;
zh.views.wrongBook = wrongBookZh;
en.views.wrongBook = wrongBookEn;

export const DICTS = { 'zh-CN': zh, en };

function resolve(dict, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

/**
 * 取词：优先当前语言，缺失回退中文，再回退 fallback/key。
 * 读取 locale.value ⇒ 模板中调用会自动追踪语言切换。
 * @param {object} [params] 可选占位符：字符串值中的 {name} 会被 params.name 替换（用于「已加入 {n} 张」这类带动态数的文案）。
 *   数组值（如 engine.sm2.impl）原样返回，不做插值。
 */
export function t(key, fallback, params) {
  const cur = DICTS[locale.value] || zh;
  let v = resolve(cur, key);
  if (v === undefined) v = resolve(zh, key);
  if (v === undefined) return fallback !== undefined ? fallback : key;
  if (typeof v === 'string' && params && typeof params === 'object') {
    return v.replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m));
  }
  return v;
}

export function setLocale(code) {
  if (code !== 'zh-CN' && code !== 'en') return;
  locale.value = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = code === 'en' ? 'en' : 'zh-CN';
}

// 启动即同步 <html lang>
if (typeof document !== 'undefined') {
  document.documentElement.lang = locale.value === 'en' ? 'en' : 'zh-CN';
}
