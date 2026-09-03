// src/i18n/views/privacyData.js
// 人生隐私数据超级监控视图（PrivacyData.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.privacyData / en.views.privacyData。
// 说明：
//   - 取词统一用 t('views.privacyData.<key>')；带占位符的调用用 3 参形式 t(key, undefined, {n:..})；
//   - type.* 为顶级数据分类名；sub.<type>.<中文子类型> 为子类型（值仍存中文，仅显示本地化）；
//   - bristol.<1-7> 与 portion.<中文份量> 同理，值存内部中文、显示本地化。
export const zh = {
  // ——— 页面标题 / 提示 / 加载 ———
  pageTitle: '🧾 隐私数据总览（详细记录）',
  pageHint: '把你每一天的物理行为 + 精神心得按"时间段 · 结构化块"详细录入，从 1 天 → 1 周 → 1 月 → 1 年，刻画真实的人物数字肖像。所有记录都在本地 IndexedDB，可跨设备同步、可导出 JSON+CSV、可一键清空。',
  loading: '加载中…',

  // ——— 顶部标签 / 按钮 ———
  tabRecord: '📝 记录',
  tabList: '📚 列表',
  tabReport: '🔮 画像报告',
  btnExport: '📤 导出 JSON+CSV',

  // ——— 记录表头 ———
  todayRecorded: '今天共记录',
  seg: '段',
  fillNow: '⏱ 填入 现在 + 1 小时',
  clearNew: '🔁 清空 / 新建',
  saving: '保存中…',
  updateRec: '✓ 更新记录',
  recordSeg: '💾 记录这一段',
  quickSlots: '快速时间段',

  // ——— 基础元信息 ———
  baseMeta: '🗓 基础元信息',
  fDate: '日期',
  fStart: '开始时间',
  fEnd: '结束时间',
  fType: '主类型',
  fSub: '子类型',
  subPlaceholder: '自填子类型',
  fLocation: '地点',
  locPlaceholder: '例：家 / 公司 / 图书馆 / 地铁',
  fPeople: '相关人物（回车添加）',
  peoplePlaceholder: '例：妈妈 / 同学A / 导师',
  addPeople: '+ 人物',

  // ——— 情绪 6 维 ———
  moodTitle: '🌈 精神物理 6 维评分',
  painTitle: '🎭 情绪 / 精神深度评估（锦衣卫级）',
  stressSourceTitle: '压力源 stressSource',
  stressSourcePlaceholder: '例：考试 / 人际 / 经济 / 健康',
  textDesc: '文字描述',
  painIndex: '疼痛指数',
  painPlaceholder: '例：肩颈 / 腰部 / 左膝',
  addPart: '+ 部位',

  // ——— 维度名 + 滑块端点 ———
  dimMood: '心情', dimEnergy: '能量', dimFocus: '专注', dimPleasure: '愉悦', dimStress: '压力',
  dimPain: '疼痛', dimAnxiety: '焦虑', dimDepression: '抑郁', dimConfidence: '自信', dimStressSource: '压力源',
  scoreLow: '低', scoreHigh: '高',
  lowMood: '低落', highMood: '兴奋',
  lowEnergy: '倦怠', highEnergy: '满血',
  lowFocus: '涣散', highFocus: '心流',
  lowPleasure: '压抑', highPleasure: '狂喜',
  lowStress: '松弛', highStress: '过载',
  lowAnxiety: '平静', highAnxiety: '惊恐',
  lowDepression: '开朗', highDepression: '沉郁',
  lowConfidence: '自弃', highConfidence: '笃定',

  // ——— 顶级数据分类名 ———
  typeSleep: '😴 睡眠', typeEat: '🍽️ 饮食', typeMove: '🏃 运动', typeLearn: '📖 学习',
  typeWork: '💼 工作', typeScreen: '📱 屏幕', typeSocial: '👥 社交', typeMeditation: '🧘 冥想',
  typeCommute: '🚗 通勤', typeHousework: '🧹 家务', typeMedical: '🏥 医疗', typeShop: '🛒 消费',
  typeFinance: '💰 财务', typeExcrete: '🚽 排泄', typeOther: '🛈 其它', typeMental: '🧠 精神/心得',

  // ——— 子类型（值存中文，仅显示本地化）———
  sub: {
    sleep: { '整晚': '整晚', '午睡': '午睡', '小憩': '小憩', '补觉': '补觉', '失眠片段': '失眠片段' },
    eat: { '早餐': '早餐', '午餐': '午餐', '晚餐': '晚餐', '加餐': '加餐', '宵夜': '宵夜', '饮水': '饮水', '咖啡因': '咖啡因', '酒精': '酒精', '补品': '补品' },
    move: { '有氧': '有氧', '力量': '力量', '拉伸': '拉伸', '瑜伽': '瑜伽', '球类': '球类', '户外徒步': '户外徒步', '通勤运动': '通勤运动', '康复训练': '康复训练' },
    learn: { '复习卡片': '复习卡片', '费曼讲解': '费曼讲解', '模考': '模考', '阅读': '阅读', '网课': '网课', '写作': '写作', '专题练习': '专题练习', '错题复盘': '错题复盘' },
    work: { '会议': '会议', '深度工作': '深度工作', '杂务': '杂务', '沟通': '沟通', '文档': '文档', '代码': '代码', '汇报': '汇报', '复盘': '复盘' },
    screen: { '手机': '手机', '电脑': '电脑', '电视': '电视', '短视频': '短视频', '社交平台': '社交平台', '游戏': '游戏', '摸鱼浏览': '摸鱼浏览' },
    social: { '家人': '家人', '朋友': '朋友', '同事': '同事', '聚会': '聚会', '1v1 深聊': '1v1 深聊', '网络社交': '网络社交', '线下活动': '线下活动' },
    meditation: { '正念': '正念', '呼吸': '呼吸', '观想': '观想', '放松': '放松', '白噪音': '白噪音', '祈祷': '祈祷' },
    commute: { '步行': '步行', '骑车': '骑车', '公交': '公交', '地铁': '地铁', '自驾': '自驾', '打车': '打车', '长途旅行': '长途旅行' },
    housework: { '做饭': '做饭', '清洁': '清洁', '整理': '整理', '购物': '购物', '维修': '维修', '照护家人': '照护家人', '衣物': '衣物', '园艺': '园艺' },
    medical: { '体检': '体检', '就医': '就医', '复诊': '复诊', '吃药': '吃药', '手术': '手术', '牙齿': '牙齿', '眼科': '眼科', '理疗': '理疗' },
    shop: { '日用品': '日用品', '服装': '服装', '电子': '电子', '餐饮': '餐饮', '学习用品': '学习用品', '娱乐': '娱乐', '冲动消费': '冲动消费' },
    finance: { '收入': '收入', '支出': '支出', '储蓄': '储蓄', '投资': '投资', '还款': '还款', '意外花销': '意外花销', '捐赠': '捐赠' },
    excrete: { '小便': '小便', '大便': '大便', '腹泻': '腹泻', '便秘': '便秘', '尿频': '尿频', '夜尿': '夜尿' },
    other: { '娱乐': '娱乐', '休息躺平': '休息躺平', '洗澡': '洗澡', '碎片时间': '碎片时间' },
    mental: { '每日总结': '每日总结', '情绪记录': '情绪记录', '灵感': '灵感', '感恩': '感恩', '反思': '反思', '计划展望': '计划展望', '梦境笔记': '梦境笔记' },
  },

  // ——— Bristol 大便形状量表 1-7 ———
  bristol1: '1 · 硬球状（严重便秘）',
  bristol2: '2 · 块状（便秘）',
  bristol3: '3 · 干裂香肠（轻度便秘）',
  bristol4: '4 · 正常光滑香肠（理想）',
  bristol5: '5 · 软块状（纤维不足）',
  bristol6: '6 · 糊状（轻度腹泻）',
  bristol7: '7 · 水样（严重腹泻）',

  // ——— 快捷时间段 ———
  slotMorning: '🌅 清晨时段', slotMorningStudy: '📚 上午学习', slotNoon: '🌤️ 午间',
  slotAfternoon: '💼 下午工作', slotEvening: '🏃 晚间运动', slotDinner: '🍽️ 晚餐',
  slotNight: '🌙 夜学习/复盘', slotNightSleep: '😴 睡眠',
  slot: '时段', bristol: '布里斯托分型',

  // ——— 餐次份量选项 ———
  portion: {
    '小碗': '小碗', '中碗': '中碗', '大碗': '大碗', '小份': '小份',
    '中份': '中份', '大份': '大份', '两口': '两口', '一盘': '一盘',
  },

  // ——— 专用块：睡眠 ———
  secSleep: '😴 睡眠专属指标',
  slHours: '时长 (小时)', slBedtime: '入睡时间', slWaketime: '起床时间',
  slLatency: '入睡 latency (分)', slLatencyPh: '躺下到睡着', slNap: '午休时长 (分)',
  slQuality: '质量 (1~5)', slWakeCount: '夜醒次数', slLight: '浅睡(分钟)', slDeep: '深睡(分钟)',
  slRem: 'REM(分钟)', slSnore: '打鼾 (0-10)', slInterrupt: '干扰因素', slInterruptPh: '例：噪音 / 咖啡因 / 小孩哭闹',

  // ——— 专用块：饮食 ———
  secEat: '🍽️ 饮食 / 营养',
  eatCalories: '总热量 (kcal)', eatMeals: '用餐次数', eatProtein: '蛋白质 (g)', eatCarbs: '碳水 (g)',
  eatFat: '脂肪 (g)', eatSugar: '糖分 (g)', eatSalt: '盐分 (g)', eatFiber: '纤维 (g)',
  eatWater: '饮水 (ml)', eatCaffeine: '咖啡因 (mg)', eatAlcohol: '酒精 (ml)', eatNotes: '备注',
  eatNotesPh: '例：外食偏油，蔬菜偏少', eatTblName: '餐次名称', eatTblKcal: '估计 kcal',
  eatTblPortion: '份量', eatAddMeal: '+ 餐次', eatDelMeal: '删除',

  // ——— 专用块：运动 ———
  secMove: '🏃 运动 / 体能',
  mvType: '类型', mvMinutes: '时长 (分钟)', mvHrAvg: '平均心率', mvHrMax: '最高心率',
  mvSteps: '步数', mvDist: '距离 (km)', mvCal: '消耗 kcal',
  mvHrZone: '心率分区 Z1-Z5（分钟，可留空）', mvNotes: '备注',

  // ——— 专用块：学习 ———
  secLearn: '📖 学习（深度联动卡片系统）',
  lnSubject: '科目', lnTopic: '专题 / 知识点', lnSource: '材料来源', lnSourcePh: '课本 / MOOC / 教程 / SxyBrick',
  lnMinutes: '时长 (分钟)', lnDeepFocus: '深度专注 (分)', lnFocusEff: '专注效率 (1-5)',
  lnInterrupts: '打断次数', lnCardsReviewed: '复习卡片数', lnCardsNew: '新卡数',
  lnCardsMastered: '掌握卡片', lnAiCalls: 'AI 调用次', lnInterruptPh: '例：手机消息 / 同学问问题 / 突发会议',
  lnAddReason: '+ 原因', lnGoals: '目标', lnAddGoal: '+ 目标',
  lnOutcomes: '成果 / 产出', lnAddOutcome: '+ 成果', lnNotes: '备注',

  // ——— 专用块：工作 ———
  secWork: '💼 工作',
  wkProject: '项目', wkRole: '角色', wkMinutes: '总时长 (分)', wkDeep: '深度 (分)',
  wkMeetings: '会议数', wkSatisfaction: '满意度 (1-5)', wkDecisions: '关键决策',
  wkAddDecision: '+ 决策', wkDeliverables: '交付物', wkAddDeliverable: '+ 交付', wkNotes: '备注',

  // ——— 专用块：屏幕 ———
  secScreen: '📱 屏幕时间',
  scDevice: '设备', scTotal: '总时长 (分)', scBlue: '蓝光减免(0-10)', scEye: '护眼次',
  scAppTbl: 'App / 用途', scAppTblMin: '分钟', scAddApp: '+ App 明细', scDelApp: '删除', scNotes: '备注',

  // ——— 专用块：财务 ———
  secFinance: '💰 财务',
  fnCurrency: '币种', fnIncome: '收入', fnExpense: '支出', fnDelta: '净变动',
  fnAccount: '账户', fnAccountPh: '银行卡 / 支付宝 / 现金', fnCategory: '分类',
  fnCategoryPh: '房租 / 餐饮 / 投资 / 捐赠', fnNotes: '备注',

  // ——— 专用块：排泄 ———
  secExcrete: '🚽 排泄监控（锦衣卫级 · Bristol 量表）',
  exUrine: '小便次数', exBowel: '大便次数', exForm: '大便形状 (Bristol 1-7)',
  exBloodUrine: '血尿', yes: '有', no: '无', exBloodStool: '血便', exNotes: '备注',
  exNotesPh: '例：夜尿频繁 / 腹泻伴绞痛 / 便秘 3 天',

  // ——— 心得 / 自定义 ———
  secMental: '🧠 精神 / 心得体会（Markdown 富文本）',
  mentalPh: '今天发生了什么？想到什么？想感谢谁？情绪/压力/反思/灵感... Markdown 渲染',
  preview: '预览',
  secCustom: '🏷️ 自定义标签 + KV 元数据',
  customTags: '自定义标签', customTagsPh: '例：#周一日 #情绪低谷 #恋爱', addTag: '+ 标签',
  customKV: '自定义 KV（最多 8 组，用于未来 AI 画像）',
  kvKeyPh: '键（例：体重kg）', kvValPh: '值', addKV: '+ KV',

  // ——— 列表 ———
  fFrom: '起始日', fTo: '结束日', allTypes: '全部类型',
  tagFilter: '标签筛选（已有：{tags}）', none: '无',
  filterBtn: '🔍 筛选', refreshing: '刷新中…', addRec: '+ 新增记录',
  loadingList: '载入中…', emptyTitle: '暂无记录',
  emptyMsg: '试试切换到「📝 记录」填第一段，或者放开日期筛选',
  detail: '👁 详情', edit: '✏️ 编辑', close: '关闭',
  totalDurLabel: '总时长', minUnit: '分钟',
  recentDays: '近 {n} 天', refreshReport: '🔄 刷新报告',
  aiEnhance: '🤖 AI 增强版调节（仅文字）', aiGenerating: 'AI 生成中…', copyReport: '📋 复制完整报告',
  generatingPersona: '正在结合 userOps + privacyRecords 生成画像…',
  reportHint: '请先点「🔄 刷新报告」。',
  statCount: '记录数', statSleep: '平均睡眠', statMood: '平均心情', statEnergy: '平均能量', statStress: '平均压力',
  repPhysical: '🌿 物理画像', repBehavioral: '🧭 行为画像（融合系统真实操作埋点）',
  repMental: '🧘 情绪 / 精神画像',
  repPred1: '下一步预测 / 调节建议（实验室文字版，', repPred2: '不改系统', repPred3: '）',
  repAi: '🤖 AI 增强版调节报告（仅文字输出 · 数字生命画像分析）',
  repAiHint: '💡 若希望 AI 基于上面的"结构化画像"给出更有洞察力的建议，可点击右上角「🤖 AI 增强版调节」。输出为纯文字报告，不会真的修改系统任何设置或调度。',
  reportPeriod: '画像周期',

  // ——— 详情弹窗 ———
  dTimeRange: '时间段', dLocationPeople: '地点/人物', dSixDim: '6 维', dEmotionDeep: '情绪深度',
  detailSleep: '😴 睡眠明细', detailEat: '🍽️ 饮食明细', detailMove: '🏃 运动明细',
  detailLearn: '📖 学习明细', detailWork: '💼 工作明细', detailScreen: '📱 屏幕明细',
  detailFinance: '💰 财务明细', detailExcrete: '🚽 排泄明细',
  detailTags: '自定义标签', detailKV: '自定义 KV', detailMental: '精神/心得',

  // ——— 提示 / 确认 ———
  toastRecorded: '已记录「{name}」', toastUpdated: '已更新「{name}」',
  saveFail: '保存失败：', recNotFound: '记录不存在',
  toastLoaded: '已载入 {date} {type} 记录，可编辑后保存。',
  confirmDelete: '确定删除这条人生记录？此删除会通过同步链传播到其他设备。',
  deleted: '已删除', listLoadFail: '列表加载失败：', personaLoadFail: '画像加载失败：',
  aiEnhanceWarn: '请先生成一份本地报告再做 AI 增强',
  aiKeyWarn: '当前未配置 AI 密钥，无法使用 AI 增强。请在 AI 助手页面设置 API Key。',
  aiEnhanced: 'AI 增强报告已生成（仅文字输出，未动系统任何设置）',
  aiFail: 'AI 增强失败：', copyOk: '报告已复制到剪贴板', copyFail: '复制失败，请手动复制',
  slotFilled: '已填时间段：{start} ~ {end}',

  // ——— 单位 / 分隔 ———
  minutes: '{n} 分钟', hours: '{n} 小时', sep: '、',
};

export const en = {
  // ——— Page title / hint / loading ———
  pageTitle: '🧾 Life Privacy Data · Super Monitor (Tier-B detailed)',
  pageHint: 'Log each day’s physical behavior + mental notes as "time-slot · structured blocks", from 1 day → 1 week → 1 month → 1 year, to sketch a real personal digital portrait. All records stay in local IndexedDB, synced across devices, exportable as JSON+CSV, and clearable in one click.',
  loading: 'Loading…',

  // ——— Top tabs / buttons ———
  tabRecord: '📝 Record',
  tabList: '📚 List',
  tabReport: '🔮 Persona Report',
  btnExport: '📤 Export JSON+CSV',

  // ——— Record header ———
  todayRecorded: 'Recorded today',
  seg: 'blocks',
  fillNow: '⏱ Fill now + 1 hour',
  clearNew: '🔁 Clear / New',
  saving: 'Saving…',
  updateRec: '✓ Update record',
  recordSeg: '💾 Record this block',
  quickSlots: 'Quick time-slots',

  // ——— Basic meta ———
  baseMeta: '🗓 Basic metadata',
  fDate: 'Date',
  fStart: 'Start time',
  fEnd: 'End time',
  fType: 'Main type',
  fSub: 'Sub-type',
  subPlaceholder: 'Custom sub-type',
  fLocation: 'Location',
  locPlaceholder: 'e.g. home / office / library / subway',
  fPeople: 'Related people (enter to add)',
  peoplePlaceholder: 'e.g. Mom / classmate A / advisor',
  addPeople: '+ Person',

  // ——— Mood 6 dims ———
  moodTitle: '🌈 Mind & body 6-dimension score',
  painTitle: '🎭 Emotion / mental deep assessment (Tier-B)',
  stressSourceTitle: 'Stress source',
  stressSourcePlaceholder: 'e.g. exam / social / finance / health',
  textDesc: 'Text description',
  painIndex: 'Pain index',
  painPlaceholder: 'e.g. neck / lower back / left knee',
  addPart: '+ Part',

  // ——— Dim names + slider ends ———
  dimMood: 'Mood', dimEnergy: 'Energy', dimFocus: 'Focus', dimPleasure: 'Pleasure', dimStress: 'Stress',
  dimPain: 'Pain', dimAnxiety: 'Anxiety', dimDepression: 'Depression', dimConfidence: 'Confidence', dimStressSource: 'Stress source',
  scoreLow: 'Low', scoreHigh: 'High',
  lowMood: 'Low', highMood: 'Excited',
  lowEnergy: 'Drained', highEnergy: 'Full',
  lowFocus: 'Scattered', highFocus: 'Flow',
  lowPleasure: 'Depressed', highPleasure: 'Elated',
  lowStress: 'Relaxed', highStress: 'Overloaded',
  lowAnxiety: 'Calm', highAnxiety: 'Panic',
  lowDepression: 'Cheerful', highDepression: 'Low',
  lowConfidence: 'Insecure', highConfidence: 'Certain',

  // ——— Top-level data category names ———
  typeSleep: '😴 Sleep', typeEat: '🍽️ Diet', typeMove: '🏃 Exercise', typeLearn: '📖 Study',
  typeWork: '💼 Work', typeScreen: '📱 Screen', typeSocial: '👥 Social', typeMeditation: '🧘 Meditation',
  typeCommute: '🚗 Commute', typeHousework: '🧹 Housework', typeMedical: '🏥 Medical', typeShop: '🛒 Shopping',
  typeFinance: '💰 Finance', typeExcrete: '🚽 Excretion', typeOther: '🛈 Other', typeMental: '🧠 Mental/Notes',

  // ——— Sub-types (value stored in Chinese, display localized) ———
  sub: {
    sleep: { '整晚': 'Whole night', '午睡': 'Nap', '小憩': 'Short rest', '补觉': 'Catch-up sleep', '失眠片段': 'Insomnia episode' },
    eat: { '早餐': 'Breakfast', '午餐': 'Lunch', '晚餐': 'Dinner', '加餐': 'Snack', '宵夜': 'Late-night snack', '饮水': 'Water', '咖啡因': 'Caffeine', '酒精': 'Alcohol', '补品': 'Supplements' },
    move: { '有氧': 'Cardio', '力量': 'Strength', '拉伸': 'Stretching', '瑜伽': 'Yoga', '球类': 'Ball sports', '户外徒步': 'Hiking', '通勤运动': 'Commute exercise', '康复训练': 'Rehab' },
    learn: { '复习卡片': 'Review cards', '费曼讲解': 'Feynman explain', '模考': 'Mock exam', '阅读': 'Reading', '网课': 'Online course', '写作': 'Writing', '专题练习': 'Topic practice', '错题复盘': 'Mistake review' },
    work: { '会议': 'Meeting', '深度工作': 'Deep work', '杂务': 'Chores', '沟通': 'Communication', '文档': 'Docs', '代码': 'Code', '汇报': 'Report', '复盘': 'Retro' },
    screen: { '手机': 'Phone', '电脑': 'Computer', '电视': 'TV', '短视频': 'Short video', '社交平台': 'Social app', '游戏': 'Games', '摸鱼浏览': 'Idle browsing' },
    social: { '家人': 'Family', '朋友': 'Friends', '同事': 'Colleagues', '聚会': 'Party', '1v1 深聊': '1-on-1 deep chat', '网络社交': 'Online social', '线下活动': 'Offline event' },
    meditation: { '正念': 'Mindfulness', '呼吸': 'Breathing', '观想': 'Visualization', '放松': 'Relaxation', '白噪音': 'White noise', '祈祷': 'Prayer' },
    commute: { '步行': 'Walk', '骑车': 'Bike', '公交': 'Bus', '地铁': 'Subway', '自驾': 'Drive', '打车': 'Taxi', '长途旅行': 'Long trip' },
    housework: { '做饭': 'Cooking', '清洁': 'Cleaning', '整理': 'Tidying', '购物': 'Shopping', '维修': 'Repair', '照护家人': 'Caregiving', '衣物': 'Laundry', '园艺': 'Gardening' },
    medical: { '体检': 'Checkup', '就医': 'See doctor', '复诊': 'Follow-up', '吃药': 'Medication', '手术': 'Surgery', '牙齿': 'Dental', '眼科': 'Eye care', '理疗': 'Physio' },
    shop: { '日用品': 'Daily goods', '服装': 'Clothing', '电子': 'Electronics', '餐饮': 'Dining', '学习用品': 'Study supplies', '娱乐': 'Entertainment', '冲动消费': 'Impulse buy' },
    finance: { '收入': 'Income', '支出': 'Expense', '储蓄': 'Savings', '投资': 'Investment', '还款': 'Repayment', '意外花销': 'Unexpected cost', '捐赠': 'Donation' },
    excrete: { '小便': 'Urination', '大便': 'Bowel', '腹泻': 'Diarrhea', '便秘': 'Constipation', '尿频': 'Frequent urination', '夜尿': 'Nocturia' },
    other: { '娱乐': 'Entertainment', '休息躺平': 'Rest', '洗澡': 'Shower', '碎片时间': 'Fragmented time' },
    mental: { '每日总结': 'Daily summary', '情绪记录': 'Mood log', '灵感': 'Inspiration', '感恩': 'Gratitude', '反思': 'Reflection', '计划展望': 'Plan ahead', '梦境笔记': 'Dream notes' },
  },

  // ——— Bristol stool scale 1-7 ———
  bristol1: '1 · Hard lumps (severe constipation)',
  bristol2: '2 · Lumpy (constipation)',
  bristol3: '3 · Cracked sausage (mild constipation)',
  bristol4: '4 · Smooth soft sausage (ideal)',
  bristol5: '5 · Soft blobs (low fiber)',
  bristol6: '6 · Mushy (mild diarrhea)',
  bristol7: '7 · Watery (severe diarrhea)',

  // ——— Quick time-slots ———
  slotMorning: '🌅 Early morning', slotMorningStudy: '📚 Late morning study', slotNoon: '🌤️ Midday',
  slotAfternoon: '💼 Afternoon work', slotEvening: '🏃 Evening exercise', slotDinner: '🍽️ Dinner',
  slotNight: '🌙 Night study/review', slotNightSleep: '😴 Sleep',
  slot: 'Time slot', bristol: 'Bristol type',

  // ——— Meal portion options ———
  portion: {
    '小碗': 'Small bowl', '中碗': 'Medium bowl', '大碗': 'Large bowl', '小份': 'Small',
    '中份': 'Medium', '大份': 'Large', '两口': 'Two bites', '一盘': 'One plate',
  },

  // ——— Block: sleep ———
  secSleep: '😴 Sleep metrics',
  slHours: 'Duration (hours)', slBedtime: 'Bedtime', slWaketime: 'Wake time',
  slLatency: 'Sleep latency (min)', slLatencyPh: 'Lying down to asleep', slNap: 'Nap (min)',
  slQuality: 'Quality (1~5)', slWakeCount: 'Night awakenings', slLight: 'Light sleep (min)', slDeep: 'Deep sleep (min)',
  slRem: 'REM (min)', slSnore: 'Snore (0-10)', slInterrupt: 'Interruptions', slInterruptPh: 'e.g. noise / caffeine / kid crying',

  // ——— Block: eat ———
  secEat: '🍽️ Diet / Nutrition',
  eatCalories: 'Total kcal', eatMeals: 'Meals', eatProtein: 'Protein (g)', eatCarbs: 'Carbs (g)',
  eatFat: 'Fat (g)', eatSugar: 'Sugar (g)', eatSalt: 'Salt (g)', eatFiber: 'Fiber (g)',
  eatWater: 'Water (ml)', eatCaffeine: 'Caffeine (mg)', eatAlcohol: 'Alcohol (ml)', eatNotes: 'Notes',
  eatNotesPh: 'e.g. oily takeout, few veggies', eatTblName: 'Meal name', eatTblKcal: 'Est. kcal',
  eatTblPortion: 'Portion', eatAddMeal: '+ Meal', eatDelMeal: 'Delete',

  // ——— Block: move ———
  secMove: '🏃 Exercise / Fitness',
  mvType: 'Type', mvMinutes: 'Duration (min)', mvHrAvg: 'Avg HR', mvHrMax: 'Max HR',
  mvSteps: 'Steps', mvDist: 'Distance (km)', mvCal: 'Calories',
  mvHrZone: 'HR zones Z1-Z5 (min, optional)', mvNotes: 'Notes',

  // ——— Block: learn ———
  secLearn: '📖 Study (deep card-system link)',
  lnSubject: 'Subject', lnTopic: 'Topic / point', lnSource: 'Source', lnSourcePh: 'Textbook / MOOC / tutorial / SxyBrick',
  lnMinutes: 'Duration (min)', lnDeepFocus: 'Deep focus (min)', lnFocusEff: 'Focus efficiency (1-5)',
  lnInterrupts: 'Interruptions', lnCardsReviewed: 'Cards reviewed', lnCardsNew: 'New cards',
  lnCardsMastered: 'Cards mastered', lnAiCalls: 'AI calls', lnInterruptPh: 'e.g. phone msg / classmate question / sudden meeting',
  lnAddReason: '+ Reason', lnGoals: 'Goals', lnAddGoal: '+ Goal',
  lnOutcomes: 'Outcomes', lnAddOutcome: '+ Outcome', lnNotes: 'Notes',

  // ——— Block: work ———
  secWork: '💼 Work',
  wkProject: 'Project', wkRole: 'Role', wkMinutes: 'Total (min)', wkDeep: 'Deep (min)',
  wkMeetings: 'Meetings', wkSatisfaction: 'Satisfaction (1-5)', wkDecisions: 'Key decisions',
  wkAddDecision: '+ Decision', wkDeliverables: 'Deliverables', wkAddDeliverable: '+ Deliverable', wkNotes: 'Notes',

  // ——— Block: screen ———
  secScreen: '📱 Screen time',
  scDevice: 'Device', scTotal: 'Total (min)', scBlue: 'Blue-light reduce (0-10)', scEye: 'Eye breaks',
  scAppTbl: 'App / purpose', scAppTblMin: 'Min', scAddApp: '+ App detail', scDelApp: 'Delete', scNotes: 'Notes',

  // ——— Block: finance ———
  secFinance: '💰 Finance',
  fnCurrency: 'Currency', fnIncome: 'Income', fnExpense: 'Expense', fnDelta: 'Net change',
  fnAccount: 'Account', fnAccountPh: 'Bank card / Alipay / cash', fnCategory: 'Category',
  fnCategoryPh: 'Rent / dining / investment / donation', fnNotes: 'Notes',

  // ——— Block: excrete ———
  secExcrete: '🚽 Excretion monitor (Tier-B · Bristol scale)',
  exUrine: 'Urinations', exBowel: 'Bowels', exForm: 'Stool form (Bristol 1-7)',
  exBloodUrine: 'Blood in urine', yes: 'Yes', no: 'No', exBloodStool: 'Blood in stool', exNotes: 'Notes',
  exNotesPh: 'e.g. frequent nocturia / diarrhea with cramps / 3-day constipation',

  // ——— Mental / custom ———
  secMental: '🧠 Mental / notes (Markdown rich text)',
  mentalPh: 'What happened today? What came to mind? Who to thank? Emotion/stress/reflection/inspiration... Markdown rendered',
  preview: 'Preview',
  secCustom: '🏷️ Custom tags + KV metadata',
  customTags: 'Custom tags', customTagsPh: 'e.g. #Monday #low-mood #love', addTag: '+ Tag',
  customKV: 'Custom KV (up to 8 pairs, for future AI portrait)',
  kvKeyPh: 'Key (e.g. weight kg)', kvValPh: 'Value', addKV: '+ KV',

  // ——— List ———
  fFrom: 'From', fTo: 'To', allTypes: 'All types',
  tagFilter: 'Tag filter (existing: {tags})', none: 'none',
  filterBtn: '🔍 Filter', refreshing: 'Refreshing…', addRec: '+ New record',
  loadingList: 'Loading…', emptyTitle: 'No records yet',
  emptyMsg: 'Switch to "📝 Record" to log your first block, or widen the date filter',
  detail: '👁 Detail', edit: '✏️ Edit', close: 'Close',
  totalDurLabel: 'Total duration', minUnit: 'min',
  recentDays: 'Last {n} days', refreshReport: '🔄 Refresh report',
  aiEnhance: '🤖 AI enhanced advice (text only)', aiGenerating: 'AI generating…', copyReport: '📋 Copy full report',
  generatingPersona: 'Generating persona from userOps + privacyRecords…',
  reportHint: 'Click "🔄 Refresh report" first.',
  statCount: 'Records', statSleep: 'Avg sleep', statMood: 'Avg mood', statEnergy: 'Avg energy', statStress: 'Avg stress',
  repPhysical: '🌿 Physical portrait', repBehavioral: '🧭 Behavior portrait (with real system op telemetry)',
  repMental: '🧘 Emotion / mental portrait',
  repPred1: 'Next-step forecast / advice (lab text, ', repPred2: 'no system change', repPred3: ')',
  repAi: '🤖 AI enhanced advice report (text only · digital-life portrait analysis)',
  repAiHint: '💡 If you want the AI to give more insightful advice based on the structured portrait above, click "🤖 AI enhanced advice" at the top-right. Output is plain text and will not actually change any system setting or scheduling.',
  reportPeriod: 'Report period',

  // ——— Detail modal ———
  dTimeRange: 'Time range', dLocationPeople: 'Location/people', dSixDim: '6 dims', dEmotionDeep: 'Emotion depth',
  detailSleep: '😴 Sleep detail', detailEat: '🍽️ Diet detail', detailMove: '🏃 Exercise detail',
  detailLearn: '📖 Study detail', detailWork: '💼 Work detail', detailScreen: '📱 Screen detail',
  detailFinance: '💰 Finance detail', detailExcrete: '🚽 Excretion detail',
  detailTags: 'Custom tags', detailKV: 'Custom KV', detailMental: 'Mental/notes',

  // ——— Toasts / confirm ———
  toastRecorded: 'Recorded "{name}"',
  toastUpdated: 'Updated "{name}"',
  saveFail: 'Save failed: ', recNotFound: 'Record not found',
  toastLoaded: 'Loaded {date} {type} record, editable — save to apply.',
  confirmDelete: 'Delete this life record? This deletion propagates to other devices via sync.',
  deleted: 'Deleted', listLoadFail: 'List load failed: ', personaLoadFail: 'Persona load failed: ',
  aiEnhanceWarn: 'Generate a local report first before AI enhancement',
  aiKeyWarn: 'No AI key configured; AI enhancement unavailable. Set the API key on the AI Assistant page.',
  aiEnhanced: 'AI enhanced report generated (text only, no system settings changed)',
  aiFail: 'AI enhancement failed: ', copyOk: 'Report copied to clipboard', copyFail: 'Copy failed, please copy manually',
  slotFilled: 'Filled time-slot: {start} ~ {end}',

  // ——— Units / separator ———
  minutes: '{n} min', hours: '{n} h', sep: ', ',
};
