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
  description: '番茄专注统计：汇总今日/本周专注次数与时长，按标签拆解',
  author: 'sxybrick',
  tools: [
    {
      name: 'pomo_stats',
      description: '统计番茄专注记录：todayMinutes/todaySessions/weekSessions/weekMinutes/按标签聚合',
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
      '获取今日与本周的专注统计。输出：今日番茄数与时长、本周总时长、日均时长，' +
      '若本周日均不足 4 个番茄（100 分钟），提醒用户注意节奏。简洁中文，不要寒暄。',
    tools: ['pomo_stats'],
    useReAct: true,
    maxSteps: 3,
  },
];

export async function pomo_stats(args, ctx) {
  const onlyTag = String(args?.tag || '').trim();
  const sessions = await ctx.data.listPomoSessions(2000);
  const filtered = onlyTag ? sessions.filter(s => (s.tag || '') === onlyTag) : sessions;

  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // 本周一

  const inRange = (t, from) => t >= from.getTime();
  const today = filtered.filter(s => inRange(s.startedAt, dayStart));
  const week = filtered.filter(s => inRange(s.startedAt, weekStart));

  const sum = (arr) => arr.reduce((s, x) => s + (x.duration || 0), 0);
  const byTag = {};
  for (const s of week) {
    const k = s.tag || '未分类';
    byTag[k] = byTag[k] || { sessions: 0, minutes: 0 };
    byTag[k].sessions += 1;
    byTag[k].minutes += s.duration || 0;
  }

  return {
    scope: onlyTag || '全部',
    today: { sessions: today.length, minutes: sum(today) },
    week: {
      sessions: week.length,
      minutes: sum(week),
      avgDailyMinutes: Math.round(sum(week) / 7),
    },
    byTag: Object.entries(byTag)
      .sort((a, b) => b[1].minutes - a[1].minutes)
      .map(([tag, v]) => ({ tag, sessions: v.sessions, minutes: v.minutes })),
  };
}
