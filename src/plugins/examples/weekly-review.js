// 官方示例插件：错题周报（weekly-review）
// 演示能力：插件工具访问统一只读数据层（ctx.analytics）+ 自定义 Agent
// 安装后在「Agent 工作台」可对话：「帮我看看最近一周的错题」
//
// manifest 声明：
//   - tools.mistake_report：统计近 N 天错题（读 analytics.getRecentMistakes）
//   - agents.weekly-reviewer：周报 Agent（绑定本插件工具）
//
// 本文件自包含（不 import 应用内模块），全部能力经 ctx 注入。

export const manifest = {
  name: 'weekly-review',
  version: '1.0.0',
  description: '错题周报：统计近 7 天错题与正确率，生成复习建议（Agent 工作台可用）',
  author: 'sxybrick',
  tools: [
    {
      name: 'mistake_report',
      description: '统计最近 N 天内答错过的卡片（错误次数/复习总数/正确率），按错误次数降序返回',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '统计天数，默认 7' },
          limit: { type: 'number', description: '最多返回条数，默认 20' },
        },
      },
    },
  ],
};

// 插件自定义 Agent：tools 引用本插件工具名
export const agents = [
  {
    id: 'weekly-reviewer',
    name: '错题周报助手',
    description: '分析最近一周错题，输出错误率排行与复习建议（由 weekly-review 插件提供）',
    systemPrompt:
      '你是 SxyBrick 的错题周报助手。用户要周报/错题分析时，调用 mistake_report 工具' +
      '（days=7）获取近 7 天错题清单。基于返回数据输出：① 错题总数与平均正确率；' +
      '② 按科目归纳高频错因；③ 给出 2-3 条具体复习建议（针对错误次数最多的卡片）。' +
      '用中文简洁输出，可用小标题分节，不要寒暄。',
    tools: ['mistake_report'],
    useReAct: true,
    maxSteps: 4,
  },
];

export async function mistake_report(args, ctx) {
  const days = Math.max(1, Math.min(90, Number(args?.days) || 7));
  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
  const mistakes = await ctx.analytics.getRecentMistakes(days);
  const top = mistakes.slice(0, limit);
  const reviewed = mistakes.reduce((s, x) => s + (x.total || 0), 0);
  const wrong = mistakes.reduce((s, x) => s + (x.wrongCount || 0), 0);
  const bySubject = {};
  for (const m of mistakes) {
    const k = m.subject || '未分类';
    bySubject[k] = bySubject[k] || { wrong: 0, total: 0 };
    bySubject[k].wrong += m.wrongCount || 0;
    bySubject[k].total += m.total || 0;
  }
  return {
    days,
    totalMistakes: mistakes.length,
    reviewedCount: reviewed,
    accuracy: reviewed ? Number((1 - wrong / reviewed).toFixed(3)) : null,
    bySubject: Object.entries(bySubject).map(([subject, v]) => ({
      subject,
      wrong: v.wrong,
      total: v.total,
      accuracy: v.total ? Number((1 - v.wrong / v.total).toFixed(3)) : null,
    })),
    top: top.map(m => ({
      id: m.id,
      subject: m.subject || '未分类',
      front: m.front,
      wrongCount: m.wrongCount,
      total: m.total,
    })),
  };
}
