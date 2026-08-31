// 官方示例插件：番茄统计（pomo-stats）
// 演示能力：插件工具访问轻量只读数据（ctx.data.pomo 相关）+ 自定义 Agent
// 安装后「Agent 工作台」可对话：「今天专注了多久？」
//
// manifest 声明：
//   - tools.pomo_stats：按天/周/月聚合番茄专注时长（读 ctx.data）
//
// 本文件自包含（不 import 应用内模块），全部能力经 ctx 注入。

export const manifest = {
  name: 'pomo-stats',
  version: '1.0.0',
  description: '番茄专注统计：汇总今日/本周专注次数与时长，按标签拆解（基于最近 2000 条记录采样）',
  author: 'sxybrick',
  tools: [
    {
      name: 'pomo_stats',
      description: '统计番茄专注记录：todayMinutes/todaySessions/weekSessions/weekMinutes/按标签聚合。' +
        '本周起点=本周一 00:00；仅读取最近 2000 条记录，超量历史不计入。',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '只统计该标签（如 数学/英语），缺省统计全部' },
        },
      },
    },
  ],
};

export const agents = [
  {
    id: 'pomo-stats-agent',
    name: '番茄统计助手',
    description: '查询番茄专注时长与次数，输出学习节奏小结（由 pomo-stats 插件提供）',
    systemPrompt:
      '你是 SxyBrick 的番茄统计助手。用户询问专注时长/番茄数/学习节奏时，调用 pomo_stats 工具' +
      '获取今日与本周的专注统计。输出：今日番茄数与时长、本周总时长、日均时长' +
      '（日均已按本周「已过天数」折算，周一不会被稀释）。' +
      '若本周日均不足 4 个番茄（100 分钟），提醒用户注意节奏。简洁中文，不要寒暄。',
    tools: ['pomo_stats'],
    useReAct: true,
    maxSteps: 3,
  },
];

export async function pomo_stats(args, ctx) {
  const onlyTag = String(args?.tag || '').trim();
  const raw = await ctx.data.listPomoSessions(2000);
  const sessions = Array.isArray(raw) ? raw : [];
  const filtered = onlyTag ? sessions.filter(s => (s.tag || '') === onlyTag) : sessions;

  // 时钟注入点：ctx.now() 由 createPluginCtx 提供，测试可注入固定时刻。
  // 绝不直接 Date.now()——否则「今日/本周」判定随运行时刻漂移，
  // 会在周一凌晨等边界上产生与日期相关的假失败。
  const nowMs = Number(typeof ctx?.now === 'function' ? ctx.now() : Date.now()) || Date.now();

  const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(nowMs); weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // 本周一 00:00

  const dayFrom = dayStart.getTime();
  const weekFrom = weekStart.getTime();
  // 区间为 [起点, now]：带下界也带上界，未来时间戳（设备时钟回拨 / 脏数据）不计入
  const inWeek = (t) => Number.isFinite(t) && t >= weekFrom && t <= nowMs;
  const today = filtered.filter(s => inWeek(s.startedAt) && s.startedAt >= dayFrom);
  const week = filtered.filter(s => inWeek(s.startedAt));

  // 本周已过天数（周一=1 … 周日=7）。按「已过天数」而非恒 7 取日均：
  // 否则周一即使打满也会被 /7 稀释成「日均不足」的假预警。
  const elapsedDays = Math.min(7, Math.max(1, Math.round((dayFrom - weekFrom) / 86400000) + 1));

  const sum = (arr) => arr.reduce((s, x) => s + (Number(x?.duration) || 0), 0);
  const byTag = {};
  for (const s of week) {
    const k = s.tag || '未分类';
    byTag[k] = byTag[k] || { sessions: 0, minutes: 0 };
    byTag[k].sessions += 1;
    byTag[k].minutes += Number(s.duration) || 0;
  }

  return {
    scope: onlyTag || '全部',
    today: { sessions: today.length, minutes: sum(today) },
    week: {
      sessions: week.length,
      minutes: sum(week),
      avgDailyMinutes: Math.round(sum(week) / elapsedDays),
      // 日均的分母：本周已过天数（1~7），让调用方能解释 avgDailyMinutes 的口径
      avgDailyBasis: elapsedDays,
    },
    // 按时长降序；时长相同时按标签名升序，保证输出稳定（Agent 引用结果时不会随机漂移）
    byTag: Object.entries(byTag)
      .sort((a, b) => (b[1].minutes - a[1].minutes) || String(a[0]).localeCompare(String(b[0])))
      .map(([tag, v]) => ({ tag, sessions: v.sessions, minutes: v.minutes })),
  };
}
