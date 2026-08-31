// src/i18n/views/stats.js
// 复习数据视图（Stats.vue）的 zh/en 字典片段。
// 由 src/i18n/index.js 在启动时合并进 zh.views.stats / en.views.stats。
// 说明：
//   - ECharts 自带的占位符（{b}/{c}/{d}）原样保留在字典值里，取词时不传 params 即可逐字返回；
//   - calendarMonthMap 是 ECharts monthLabel.nameMap 的内置语言标识（'cn'/'en'），属技术取值但随语言切换；
//   - 图表 tooltip 里的 <br/> 由 ECharts 自身渲染（非 v-html），故拆成前后段在代码里拼接。
export const zh = {
  // ——— 页面骨架 ———
  loading: '加载中…',
  title: '复习数据',

  // ——— 顶部指标卡 ———
  kpiTotalCards: '总卡片数',
  kpiTotalReviews: '总复习次数',
  kpiTodayReviews: '今日复习（张）',
  kpiAvgMastery: '平均掌握度',
  kpiDueToday: '待复习',

  // ——— 学习画像条 ———
  profileLabel: '学习画像 · {level}',

  // ——— 各面板标题 ———
  heatTitle: '复习热力图（近一年）',
  calibTitle: '校准回测 · 预测记忆概率 vs 实际正确率',
  forecastTitle: '到期洪峰预测 · 未来 30 天（按当前复习节奏模拟）',
  radarTitle: '各科掌握度雷达图（近 90 天自评）',
  trendTitle: '复习趋势',
  pieTitle: '各科卡片占比',
  ratingTitle: '自评分布（全部复习）',
  profileRadarTitle: '学习画像雷达（六维）',
  hourlyTitle: '复习时间分布（24 小时）',
  forgotTitle: '遗忘率趋势（近 30 天，越低越好）',
  tagTitle: '标签 Top 10',
  wordTitle: '标签词云',
  diagTitle: '单科诊断（掌握度 · 待背 · 错题 · 易混 → 处置建议）',

  // ——— 校准回测摘要 ———
  calibStats: '样本 {n} · Brier {brier} · ECE {ece} · 偏差 {bias}',
  calibVerdict: '{verdict} —— {note}',

  // ——— 到期洪峰摘要 ———
  forecastStats: '逾期待补 {backlog} · 30 天累计 {total} · 日均 {avg} · 峰值 {peakDate}（{peakCount} 张）',

  // ——— 趋势区（范围切换 + 周对比） ———
  rangeDays: '{n} 天',
  wdThisWeek: '本周复习',
  wdLastWeek: '上周复习',

  // ——— 单科诊断行 ———
  diagStats: '卡片 {cards} · 待背 {due} · 错题 {marked} · 易混 {pairN} 组 · 掌握度 {mastery}%',

  // ——— 空状态 ———
  emptyCalibTitle: '暂无校准数据',
  emptyCalibMsg: '还没有可用的校准回测样本',
  emptyForecastTitle: '暂无到期卡片',
  emptyForecastMsg: '未来 30 天没有到期卡片，保持节奏！',
  emptyRadarTitle: '暂无复习记录',
  emptyRadarMsg: '开始复习后这里会显示各科掌握度雷达',
  emptyDiagTitle: '暂无卡片数据',
  emptyDiagMsg: '导入或新建卡片后，这里会生成单科诊断',

  // ——— 热力图（日历坐标系） ———
  heatTip: '{date}：复习 {n} 次',
  calendarMonthMap: 'cn',
  dowSun: '日',
  dowMon: '一',
  dowTue: '二',
  dowWed: '三',
  dowThu: '四',
  dowFri: '五',
  dowSat: '六',

  // ——— 能力四维雷达（round11b N-2 接回 noData 空态） ———
  abilityTitle: '能力四维雷达',
  emptyAbilityTitle: '暂无复习数据',
  emptyAbilityMsg: '完成第一轮复习后，这里会显示掌握度 / 正确率 / 稳定度 / 覆盖率四维能力',

  // ——— 雷达图维度与系列名 ———
  radarMasteryName: '掌握度 %',
  dimMastery: '掌握度',
  dimCorrect: '正确率',
  dimStable: '稳定度',
  dimCoverage: '覆盖率',
  dimActivity: '活跃度',
  dimCorrection: '纠正力',
  abilitySeriesName: '能力',
  profileSeriesName: '学习画像',

  // ——— 占比环形图 / 自评分布 / 24h 分布 ———
  pieTip: '{b}: {c} 张 ({d}%)',
  ratingLabelFail: '没记住',
  ratingLabelVague: '还模糊',
  ratingLabelOk: '记住了',
  hourLabel: '{n}时',

  // ——— 标签词云 ———
  wordTip: '{name}：{n} 张',

  // ——— 校准回测图表内文案 ———
  calibTipMain: '预测 {pred}% · 实际 {actual}%',
  calibTipSample: '样本 {n} 次',
  calibTipSim: ' · 模拟补估 {pct}%',
  calibXName: '预测记忆 %',
  calibYName: '实际正确 %',
  calibSeriesActual: '实测',
  calibSeriesPerfect: '完美校准',

  // ——— 到期洪峰图表内文案 ———
  forecastTip: '{date}：预计到期 {n} 张',
};

export const en = {
  // ——— Page shell ———
  loading: 'Loading…',
  title: 'Review Stats',

  // ——— Top metric cards ———
  kpiTotalCards: 'Total cards',
  kpiTotalReviews: 'Total reviews',
  kpiTodayReviews: 'Reviewed today (cards)',
  kpiAvgMastery: 'Avg mastery',
  kpiDueToday: 'Due',

  // ——— Learning profile bar ———
  profileLabel: 'Learning profile · {level}',

  // ——— Panel titles ———
  heatTitle: 'Review heatmap (past year)',
  calibTitle: 'Calibration backtest · predicted recall vs actual accuracy',
  forecastTitle: 'Due-load forecast · next 30 days (simulated at your current pace)',
  radarTitle: 'Mastery radar by subject (self-rated, last 90 days)',
  trendTitle: 'Review trend',
  pieTitle: 'Card share by subject',
  ratingTitle: 'Self-rating distribution (all reviews)',
  profileRadarTitle: 'Learning profile radar (6 dimensions)',
  hourlyTitle: 'Review time distribution (24 hours)',
  forgotTitle: 'Forgetting-rate trend (last 30 days, lower is better)',
  tagTitle: 'Top 10 tags',
  wordTitle: 'Tag word cloud',
  diagTitle: 'Per-subject diagnosis (mastery · due · mistakes · confusable → advice)',

  // ——— Calibration summary ———
  calibStats: 'Samples {n} · Brier {brier} · ECE {ece} · Bias {bias}',
  calibVerdict: '{verdict} — {note}',

  // ——— Due-load summary ———
  forecastStats: 'Overdue backlog {backlog} · 30-day total {total} · daily avg {avg} · peak {peakDate} ({peakCount} cards)',

  // ——— Trend area (range switch + week delta) ———
  rangeDays: '{n} days',
  wdThisWeek: 'This week',
  wdLastWeek: 'Last week',

  // ——— Diagnosis row ———
  diagStats: 'Cards {cards} · Due {due} · Mistakes {marked} · Confusable {pairN} pairs · Mastery {mastery}%',

  // ——— Empty states ———
  emptyCalibTitle: 'No calibration data',
  emptyCalibMsg: 'No usable calibration backtest samples yet',
  emptyForecastTitle: 'No due cards',
  emptyForecastMsg: 'Nothing falls due in the next 30 days — keep the pace!',
  emptyRadarTitle: 'No review records',
  emptyRadarMsg: 'Once you start reviewing, the per-subject mastery radar shows up here',
  emptyDiagTitle: 'No card data',
  emptyDiagMsg: 'Import or create cards and the per-subject diagnosis appears here',

  // ——— Heatmap (calendar coordinate system) ———
  heatTip: '{date}: {n} reviews',
  calendarMonthMap: 'en',
  dowSun: 'Sun',
  dowMon: 'Mon',
  dowTue: 'Tue',
  dowWed: 'Wed',
  dowThu: 'Thu',
  dowFri: 'Fri',
  dowSat: 'Sat',

  // ——— Ability radar (round11b N-2 noData empty state) ———
  abilityTitle: 'Ability radar (4-dim)',
  emptyAbilityTitle: 'No review data yet',
  emptyAbilityMsg: 'After your first review round, this shows the 4-dimension ability: mastery / accuracy / stability / coverage',

  // ——— Radar dimensions & series names ———
  radarMasteryName: 'Mastery %',
  dimMastery: 'Mastery',
  dimCorrect: 'Accuracy',
  dimStable: 'Stability',
  dimCoverage: 'Coverage',
  dimActivity: 'Activity',
  dimCorrection: 'Correction',
  abilitySeriesName: 'Ability',
  profileSeriesName: 'Learning profile',

  // ——— Pie / rating / hourly ———
  pieTip: '{b}: {c} cards ({d}%)',
  ratingLabelFail: 'Forgot',
  ratingLabelVague: 'Vague',
  ratingLabelOk: 'Recalled',
  hourLabel: '{n}:00',

  // ——— Tag word cloud ———
  wordTip: '{name}: {n} cards',

  // ——— Calibration chart internals ———
  calibTipMain: 'Predicted {pred}% · Actual {actual}%',
  calibTipSample: 'Samples {n}',
  calibTipSim: ' · Simulated fill-in {pct}%',
  calibXName: 'Predicted recall %',
  calibYName: 'Actual accuracy %',
  calibSeriesActual: 'Measured',
  calibSeriesPerfect: 'Perfect calibration',

  // ——— Due-load chart internals ———
  forecastTip: '{date}: {n} cards due',
};
