// src/i18n/views/userDashboard.js
// 用户仪表盘（UserDashboard.vue）的 zh/en 字典片段。
//
// 迁移说明：本视图原本 0 处 t() 调用、69 行中文硬编码（含 12 张 ECharts 图的标题/轴/图例/ tooltip）。
// 图表文案集中在 chart.* / tip.* / legend.* 三组，改文案时不必翻组件代码。
// 拍档结论（partner.*）由 repo.bestWorstPartners 只回传 code+params，
// 文案在这组键下按语言拼装 —— 数据层不再产出 localized 散文。
export const zh = {
  title: '🛰️ 用户仪表盘（恐怖级操作监控）',
  levelA: '全量记录 = A 级业务',
  levelB: 'B 级 DOM',
  on: '✅ 开启',
  off: '⛔ 关闭',
  localOnly: '所有数据仅存在本地 IndexedDB，支持一键同步 / 导出 / 清空。',
  rangeLabel: '时间范围',
  rangeDays: '近 {n} 天',
  refresh: '🔄 刷新图表',

  // KPI 卡
  kpiOps365: '365 天总操作',
  kpiOps365Sub: '活跃 {active} / 365 天（{pct}%）',
  kpiStreak: '当前连续活跃',
  kpiStreakVal: '{n} 天 🔥',
  kpiStreakSub: '历史最长连续：{n} 天',
  kpiRange: '图表范围 {n} 天',
  kpiRangeLoading: '加载中…',
  kpiLab: '实验室状态',
  kpiLabVal: '12 图表 + 拍档 16 组合',
  kpiLabSub: '📥 数据可在「导出」页面一键打包同步',

  // 状态行
  loadingStatus: '拉取埋点 + 聚合中…',
  summary: '{days} 天共 {ops} 次操作',
  summaryModules: '{n} 个模块',
  summaryTypes: '{n} 种动作',
  active365: '近 365 天活跃 {days} 天 / 共 {ops} 次',

  // CSS 365 热力
  heat365Title: '📅 近 365 天活跃（CSS 丝滑版）',
  heat365Tip: '365 天活跃度',
  heatCellTip: '{date} · {n} 次',
  legendLess: '少',
  legendMore: '多',

  // 图表标题（12 张）
  chart: {
    heatmap: '近 365 天活跃（GitHub 式热力图）',
    hour: '24 小时使用时段（叠加 7d / 24h 对比）',
    modulePie: '模块使用偏好（Top 10）',
    typeBar: '动作类型 Top 15',
    actionDot: '近期 2D 交互散点（x=时间, y=模块，采样 {shown}/{total}）',
    weekRadar: '周维度 × 模块 极坐标雷达',
    week168: '168 小时热力（周 × 小时）',
    rateDist: '背诵自评分布（没记住 / 模糊 / 记住了）',
    cardCrud: '卡片 CRUD 堆叠区（新增/编辑/删除/错因标记）',
    events: '关键大事件：导出/同步/AI/番茄/模考/费曼',
    aiCloud: 'AI / Agent 调用词云（没有调用则为空）',
    mixTrend: '混合趋势：模块 × 日（堆叠曲线）',
  },

  // 空状态
  emptyTitle: '📊 暂无数据',
  emptySub: '使用系统后自动填充',

  // tooltip / 轴文案（{b}/{c}/{d} 是 ECharts 占位符，保持原样）
  tipOps: '操作 {n} 次',
  tipHeat: '{date}<br/>操作 {n} 次',
  tipHeat168: '{day} · {hour}<br/>操作 {n} 次',
  tipPie: '{b}<br/>{c} 次（{d}%）',
  tipDot: '{time}<br/>模块：{module}<br/>类型：{type}',
  tipDotCategory: '<br/>类别：{category}',

  // 图例 / 系列名
  legend: {
    avgRange: '{n}d 日均',
    avg7: '近 7d 平均',
    last24: '近 24h',
    study: '学习/复习',
    card: '卡片CRUD',
    ai: 'AI/Agent',
    business: '业务大按钮',
    dom: 'DOM点击',
    rateForgot: '① 没记住',
    rateVague: '② 还模糊',
    rateKnown: '③ 记住了',
    crudNew: '新增',
    crudEdit: '编辑',
    crudDelete: '删除',
    crudWrong: '错因标记',
    evExport: '导出',
    evSync: '同步',
    evAi: 'AI 调用',
    evPomodoro: '番茄',
    evExam: '模考',
    evFeynman: '费曼',
  },

  // 拍档 16 组合
  partner: {
    head: '🤝 近期 / 长期 · 最佳 / 最坏 · 拍档（16 种组合）',
    hint: '默认：D 类（最活跃单份资产）· 近 7 天 · 最佳。可自由切 A(科目) B(Agent) C(知识对) D(资产) × 近7/长期90 × 最佳/最坏。',
    kindLabel: '类别',
    rangeLabel: '区间',
    polarityLabel: '正反',
    kindA: 'A · 高频学习科目',
    kindB: 'B · 高频 Agent 工具',
    kindC: 'C · 共现知识对',
    kindD: 'D · 活跃/僵尸资产',
    range7: '近 7 天(近期)',
    range90: '近 90 天(长期)',
    best: '最佳',
    worst: '最坏',
    busy: '拍档计算中…',
    times: '{n} 次',
    zombie: '僵尸',
    loadFail: '拍档加载失败：{msg}',

    // 由 repo.bestWorstPartners 回传的 code 决定用哪一组（code 见 src/repo.js）。
    // ⚠️ 键名里不能带点：t() 用点号切分路径，'a.best' 这种字面键会被拆成两级而永远取不到。
    //    所以这里用嵌套对象（a.best.title），与 code 'a.best' 一一对应。
    notEnough: {
      title: '数据不足，继续积累',
      desc: '近 {days} 天操作样本偏少，无法稳定分析。再多使用几天系统就会有结果。',
      suggest: '',
    },
    a: {
      best: {
        title: '最高频学习科目（近 {days} 天）',
        desc: '{name}：{count} 次复习',
        suggest: '优势科目「{name}」已形成节奏，可推进到更难章节。',
      },
      worst: {
        title: '最冷门学习科目（近 {days} 天）',
        desc: '{name}：{count} 次复习',
        suggest: '建议优先补短板：在「{name}」安排 30 分钟专项复习',
      },
    },
    b: {
      best: {
        title: '最高频 Agent 工具（近 {days} 天）',
        desc: '{name}：{count} 次调用',
        suggest: '{name} 是你的得力助手，继续保持协同节奏。',
      },
      worst: {
        title: '最少被调 Agent 工具（近 {days} 天）',
        desc: '{name}：{count} 次调用',
        suggest: '{name} 还有挖掘空间，遇到不确定的知识可尝试调用它。',
      },
    },
    c: {
      best: {
        title: '最常共现知识对（近 {days} 天）',
        desc: '{name}：共现 {count} 次',
        suggest: '{name} 已经形成强关联，可尝试合并为高维模型。',
      },
      worst: {
        title: '最少共现知识对（近 {days} 天）',
        desc: '{name}：共现 {count} 次',
        suggest: '{name} 组合联系薄弱，建议把两者放一张导图里加强关联。',
      },
    },
    d: {
      best: {
        title: '最活跃单份资产「最佳拍档」（近 {days} 天）',
        desc: '{name} · 互动分数 {count}',
        suggest: '它是你近期最常用的知识点，考虑围绕它构建一张导图，把网络效应放大。',
      },
      worst: {
        title: '最不活跃的僵尸单份资产（近 {days} 天）',
        desc: '{name} · 创建于 {createdAt} · 从未复习',
        suggest: '建议今天就把它加入复习队列，把僵尸资产唤醒。',
      },
    },
  },

  // 兜底名（数据里缺失模块/标签时的占位）
  misc: '其它',
  loadFail: '仪表盘加载失败：{msg}',
};

export const en = {
  title: '🛰️ User Dashboard (deep activity monitor)',
  levelA: 'Full recording = level A',
  levelB: 'Level B DOM',
  on: '✅ On',
  off: '⛔ Off',
  localOnly: 'All data stays in your local IndexedDB — sync / export / wipe in one click.',
  rangeLabel: 'Range',
  rangeDays: 'Last {n} days',
  refresh: '🔄 Refresh charts',

  kpiOps365: 'Actions (365d)',
  kpiOps365Sub: 'Active {active} / 365 days ({pct}%)',
  kpiStreak: 'Current streak',
  kpiStreakVal: '{n} days 🔥',
  kpiStreakSub: 'Longest streak: {n} days',
  kpiRange: 'Chart range: {n} days',
  kpiRangeLoading: 'Loading…',
  kpiLab: 'Lab status',
  kpiLabVal: '12 charts + 16 partner combos',
  kpiLabSub: '📥 Data can be packed & synced on the Export page',

  loadingStatus: 'Collecting telemetry + aggregating…',
  summary: '{ops} actions in {days} days',
  summaryModules: '{n} modules',
  summaryTypes: '{n} action types',
  active365: 'Active {days} / last 365 days · {ops} actions total',

  heat365Title: '📅 Activity in the last 365 days (CSS edition)',
  heat365Tip: '365-day activity',
  heatCellTip: '{date} · {n} actions',
  legendLess: 'Less',
  legendMore: 'More',

  chart: {
    heatmap: 'Activity in the last 365 days (GitHub-style heatmap)',
    hour: '24-hour usage curve (7d / 24h overlay)',
    modulePie: 'Module preference (Top 10)',
    typeBar: 'Action types Top 15',
    actionDot: 'Recent 2D interaction scatter (x=time, y=module, sampled {shown}/{total})',
    weekRadar: 'Weekday × module polar radar',
    week168: '168-hour heatmap (weekday × hour)',
    rateDist: 'Self-rating distribution (forgot / vague / got it)',
    cardCrud: 'Card CRUD stacked area (create/edit/delete/mark-wrong)',
    events: 'Key events: export / sync / AI / pomodoro / exam / Feynman',
    aiCloud: 'AI / Agent call word cloud (empty if no calls)',
    mixTrend: 'Mixed trend: module × day (stacked curves)',
  },

  emptyTitle: '📊 No data yet',
  emptySub: 'Fills in automatically as you use the app',

  tipOps: '{n} actions',
  tipHeat: '{date}<br/>{n} actions',
  tipHeat168: '{day} · {hour}<br/>{n} actions',
  tipPie: '{b}<br/>{c} actions ({d}%)',
  tipDot: '{time}<br/>module: {module}<br/>type: {type}',
  tipDotCategory: '<br/>category: {category}',

  legend: {
    avgRange: '{n}d daily avg',
    avg7: 'Last 7d avg',
    last24: 'Last 24h',
    study: 'Study / review',
    card: 'Card CRUD',
    ai: 'AI / Agent',
    business: 'Business buttons',
    dom: 'DOM clicks',
    rateForgot: '① Forgot',
    rateVague: '② Vague',
    rateKnown: '③ Got it',
    crudNew: 'Create',
    crudEdit: 'Edit',
    crudDelete: 'Delete',
    crudWrong: 'Mark wrong',
    evExport: 'Export',
    evSync: 'Sync',
    evAi: 'AI calls',
    evPomodoro: 'Pomodoro',
    evExam: 'Exam',
    evFeynman: 'Feynman',
  },

  partner: {
    head: '🤝 Short / long term · best / worst · partners (16 combos)',
    hint: 'Default: type D (most active single asset) · last 7 days · best. Switch freely between A(subject) B(Agent) C(knowledge pair) D(asset) × 7d/90d × best/worst.',
    kindLabel: 'Type',
    rangeLabel: 'Range',
    polarityLabel: 'Order',
    kindA: 'A · Top study subjects',
    kindB: 'B · Top Agent tools',
    kindC: 'C · Co-occurring pairs',
    kindD: 'D · Active / zombie assets',
    range7: 'Last 7 days (short)',
    range90: 'Last 90 days (long)',
    best: 'Best',
    worst: 'Worst',
    busy: 'Computing partners…',
    times: '{n}×',
    zombie: 'zombie',
    loadFail: 'Failed to load partners: {msg}',

    // 键名不得含点（t() 按点切分路径），故与 zh 一样用嵌套结构
    notEnough: {
      title: 'Not enough data yet',
      desc: 'Only a few actions in the last {days} days — too thin to analyse. Use the app a few more days and results will show up.',
      suggest: '',
    },
    a: {
      best: {
        title: 'Most-studied subject (last {days} days)',
        desc: '{name}: {count} reviews',
        suggest: '「{name}」 has momentum — push into harder chapters.',
      },
      worst: {
        title: 'Least-studied subject (last {days} days)',
        desc: '{name}: {count} reviews',
        suggest: 'Patch the weak spot first: schedule 30 focused minutes on 「{name}」.',
      },
    },
    b: {
      best: {
        title: 'Most-used Agent tool (last {days} days)',
        desc: '{name}: {count} calls',
        suggest: '{name} is your go-to helper — keep that rhythm.',
      },
      worst: {
        title: 'Least-used Agent tool (last {days} days)',
        desc: '{name}: {count} calls',
        suggest: '{name} is underused — try it next time you hit uncertain knowledge.',
      },
    },
    c: {
      best: {
        title: 'Most co-occurring pair (last {days} days)',
        desc: '{name}: {count} co-occurrences',
        suggest: '{name} is tightly linked — consider merging them into one higher-level model.',
      },
      worst: {
        title: 'Least co-occurring pair (last {days} days)',
        desc: '{name}: {count} co-occurrences',
        suggest: '{name} is weakly linked — put both on one mindmap to strengthen the link.',
      },
    },
    d: {
      best: {
        title: 'Most active single asset — "best partner" (last {days} days)',
        desc: '{name} · engagement score {count}',
        suggest: 'It is your most-used knowledge point — build a mindmap around it to amplify the network effect.',
      },
      worst: {
        title: 'Least active zombie asset (last {days} days)',
        desc: '{name} · created {createdAt} · never reviewed',
        suggest: 'Add it to today\'s review queue and wake this zombie up.',
      },
    },
  },

  misc: 'Other',
  loadFail: 'Dashboard failed to load: {msg}',
};
