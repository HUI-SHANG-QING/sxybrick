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
    privacy: '超级监控', plugins: '插件', insight: '卡片洞察', uikit: '组件库',
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
      weights: '训练权重（19 个 w[0..18]）：w0~w2 初始稳定度 S0(again/hard/good)；w3 easy 乘子；w4 初始难度基准；w5 难度斜率；w6 难度均值回归；w7~w10 回忆后稳定度更新；w11~w14 遗忘后稳定度更新；w15 hard 惩罚（<1）；w16 easy 加成（>1）；w17 间隔抖动；w18 稳定度上限。',
      train: '训练：用你的真实评分历史拟合权重，损失 = log-loss（二分类：回忆 vs 遗忘），有限差分梯度下降（19 维离线训练）。样本 ≥8 次即可用，越多越准；训练在 Web Worker 中进行，不阻塞主线程。',
      trainBtn: '训练中…',
      trainBtnDone: '训练权重',
      pretest: '冷启动前测：若某科目做过预测验 / 自评分，用其估计初始稳定度替代默认 S0，减少前几次复习的抖动（数学、线代等难科会有系数微调）。',
      guard: '方向铁律（2026-08-29 修正）：w15 是「惩罚」必须 <1、w16 是「加成」必须 >1；代码层面对 w15 做 ≤1 钳制，使「越不会的卡反而越晚复习」在结构上不可能发生。',
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
    healthDup: '重复卡', healthZombie: '僵尸卡', healthOrphan: '孤儿图片',
    rateOk: '答对', rateWarn: '模糊', rateFail: '答错',
    group: { study: '学习', plan: '规划', knowledge: '知识', smart: '智能', system: '系统' },
    mod: {
      cards: { label: '卡片', desc: '创建与编辑卡片' },
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
      ai: { label: 'AI', desc: '智能问答' },
      agent: { label: 'Agent', desc: 'Agent 工作台' },
      feynman: { label: '费曼', desc: '费曼练习' },
      insight: { label: '卡片洞察', desc: '遗忘曲线' },
      health: { label: '体检', desc: '资产健康检查' },
      sync: { label: '同步', desc: '局域网/备份' },
      export: { label: '导出', desc: '备份与导出' },
      'user-dashboard': { label: '仪表盘', desc: '行为监控' },
      privacy: { label: '超级监控', desc: '人生数据监控' },
      plugins: { label: '插件', desc: '扩展管理' },
    },
  },

  // ---------------- 常用 ----------------
  common: { more: '更多', resetTitle: '清空全部数据', resetConfirmHint: '此操作不可恢复，请谨慎。' },

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
    privacy: 'Super Monitor', plugins: 'Plugins', insight: 'Insight', uikit: 'UI Kit',
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
      weights: 'Training weights (19 × w[0..18]): w0~w2 initial stability S0(again/hard/good); w3 easy multiplier; w4 initial-difficulty baseline; w5 difficulty slope; w6 difficulty mean-reversion; w7~w10 post-recall stability update; w11~w14 post-forget stability update; w15 hard penalty (<1); w16 easy bonus (>1); w17 interval fuzz; w18 stability cap.',
      train: 'Training: fits weights to your real rating history; loss = log-loss (binary: recall vs forget), finite-difference gradient descent (19-dim offline). Usable from ≥8 samples, better with more; runs in a Web Worker, non-blocking.',
      trainBtn: 'Training…',
      trainBtnDone: 'Train weights',
      pretest: 'Cold-start pretest: if a subject has a pretest / self-rating, its estimated initial stability replaces the default S0, reducing early-review jitter (hard subjects like math / linear algebra get a coefficient tweak).',
      guard: 'Direction rule (2026-08-29 fix): w15 is a "penalty" and must be <1, w16 is a "bonus" and must be >1; code clamps w15 ≤1 so "harder cards reviewed later" is structurally impossible.',
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
    healthDup: 'Duplicate cards', healthZombie: 'Zombie cards', healthOrphan: 'Orphan images',
    rateOk: 'Correct', rateWarn: 'Vague', rateFail: 'Wrong',
    group: { study: 'Study', plan: 'Plan', knowledge: 'Knowledge', smart: 'Smart', system: 'System' },
    mod: {
      cards: { label: 'Cards', desc: 'Create & edit cards' },
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
      ai: { label: 'AI', desc: 'Smart Q&A' },
      agent: { label: 'Agent', desc: 'Agent workbench' },
      feynman: { label: 'Feynman', desc: 'Feynman practice' },
      insight: { label: 'Insight', desc: 'Forgetting curve' },
      health: { label: 'Health', desc: 'Asset health check' },
      sync: { label: 'Sync', desc: 'LAN / backup' },
      export: { label: 'Export', desc: 'Backup & export' },
      'user-dashboard': { label: 'Dashboard', desc: 'Behavior monitor' },
      privacy: { label: 'Super Monitor', desc: 'Life-data monitor' },
      plugins: { label: 'Plugins', desc: 'Extension mgmt' },
    },
  },
  common: { more: 'More', resetTitle: 'Erase All Data', resetConfirmHint: 'This cannot be undone. Please be careful.' },

  // ---------------- Business views (externalized per view, see src/views/*.vue) ----------------
  views: {},
};

// —— 合并业务视图字典（每个视图一个模块，见 src/i18n/views/*.js） ——
import { zh as achievementsZh, en as achievementsEn } from './views/achievements.js';
import { zh as agentWorkbenchZh, en as agentWorkbenchEn } from './views/agentWorkbench.js';
import { zh as cardGroupsZh, en as cardGroupsEn } from './views/cardGroups.js';
import { zh as cardInsightZh, en as cardInsightEn } from './views/cardInsight.js';
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
import { zh as libraryZh, en as libraryEn } from './views/library.js';
import { zh as memoZh, en as memoEn } from './views/memo.js';
import { zh as notesViewZh, en as notesViewEn } from './views/notesView.js';
import { zh as plansZh, en as plansEn } from './views/plans.js';
import { zh as pluginsZh, en as pluginsEn } from './views/plugins.js';
import { zh as pomodoroZh, en as pomodoroEn } from './views/pomodoro.js';
import { zh as recycleBinZh, en as recycleBinEn } from './views/recycleBin.js';
import { zh as reviewZh, en as reviewEn } from './views/review.js';
import { zh as searchZh, en as searchEn } from './views/search.js';
import { zh as syncZh, en as syncEn } from './views/sync.js';
import { zh as uiKitZh, en as uiKitEn } from './views/uiKit.js';
import { zh as weeklyReportZh, en as weeklyReportEn } from './views/weeklyReport.js';
import { zh as wrongBookZh, en as wrongBookEn } from './views/wrongBook.js';

zh.views.achievements = achievementsZh;
en.views.achievements = achievementsEn;
zh.views.agentWorkbench = agentWorkbenchZh;
en.views.agentWorkbench = agentWorkbenchEn;
zh.views.cardGroups = cardGroupsZh;
en.views.cardGroups = cardGroupsEn;
zh.views.cardInsight = cardInsightZh;
en.views.cardInsight = cardInsightEn;
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
zh.views.library = libraryZh;
en.views.library = libraryEn;
zh.views.memo = memoZh;
en.views.memo = memoEn;
zh.views.notesView = notesViewZh;
en.views.notesView = notesViewEn;
zh.views.plans = plansZh;
en.views.plans = plansEn;
zh.views.plugins = pluginsZh;
en.views.plugins = pluginsEn;
zh.views.pomodoro = pomodoroZh;
en.views.pomodoro = pomodoroEn;
zh.views.recycleBin = recycleBinZh;
en.views.recycleBin = recycleBinEn;
zh.views.review = reviewZh;
en.views.review = reviewEn;
zh.views.search = searchZh;
en.views.search = searchEn;
zh.views.sync = syncZh;
en.views.sync = syncEn;
zh.views.uiKit = uiKitZh;
en.views.uiKit = uiKitEn;
zh.views.weeklyReport = weeklyReportZh;
en.views.weeklyReport = weeklyReportEn;
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
