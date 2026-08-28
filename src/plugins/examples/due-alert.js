// 官方示例插件：到期提醒（due-alert）
// 演示能力：事件钩子（onReviewRated）+ 系统通知（ctx.notify）+ 到期预测工具
// 每次复习评分后，若未来 3 天到期卡超过阈值，浏览器通知提醒（需授权通知权限）。
//
// manifest 声明：
//   - hooks.onReviewRated：复习评分后触发，检查到期洪峰
//   - tools.due_forecast：查看未来 N 天到期卡分布（读 analytics.getDueForecast）
//
// 本文件自包含（不 import 应用内模块），全部能力经 ctx 注入。

export const manifest = {
  name: 'due-alert',
  version: '1.0.0',
  description: '到期提醒：复习后若未来 3 天到期卡超阈值则系统通知；可查到期洪峰分布',
  author: 'sxybrick',
  hooks: {
    onReviewRated: 'onReviewRated',
  },
  tools: [
    {
      name: 'due_forecast',
      description: '查看未来 N 天每天到期卡片数（洪峰分布），返回每日数量与峰值日期',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '预测天数，默认 14' },
        },
      },
    },
  ],
};

export const agents = [
  {
    id: 'due-alert-agent',
    name: '到期提醒助手',
    description: '查询未来到期卡洪峰，提示提前复习安排（由 due-alert 插件提供）',
    systemPrompt:
      '你是 SxyBrick 的到期提醒助手。用户询问到期/复习压力时，调用 due_forecast 工具' +
      '查看未来 14 天到期卡分布。输出：总到期卡数、峰值日期与当日数量、' +
      '如果某天超过 100 张建议提前分散复习。简洁中文，不要寒暄。',
    tools: ['due_forecast'],
    useReAct: true,
    maxSteps: 3,
  },
];

const THRESHOLD = 30; // 未来 3 天到期卡超过该值则提醒

export async function due_forecast(args, ctx) {
  const days = Math.max(1, Math.min(60, Number(args?.days) || 14));
  const forecast = await ctx.analytics.getDueForecast(days);
  const daily = (forecast?.daily || []).map(d => ({
    date: d.date,
    count: d.count,
  }));
  const peak = daily.reduce((best, d) => (d.count > (best?.count || -1) ? d : best), null);
  const total = daily.reduce((s, d) => s + d.count, 0);
  return { days, totalDue: total, peak, daily };
}

export async function onReviewRated(review, ctx) {
  try {
    const forecast = await ctx.analytics.getDueForecast(3);
    const next3 = (forecast?.daily || []).reduce((s, d) => s + (d.count || 0), 0);
    if (next3 > THRESHOLD) {
      ctx.notify(`未来 3 天有 ${next3} 张卡到期，建议提前分散复习，避免洪峰堆积。`);
    }
  } catch (e) {
    ctx.log('到期提醒计算失败（忽略）:', e?.message || e);
  }
}
