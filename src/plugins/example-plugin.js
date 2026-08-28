// 示例插件：字数统计 + 卡片摘要
// 安装方式：在「插件」页点击「从示例安装」按钮，会自动把本文件内容作为插件代码安装。
//
// 这个示例演示了插件机制的全部能力：
//   - manifest 声明工具与钩子
//   - 工具函数接收 args、返回结果
//   - 钩子函数在卡片保存时被调用（写日志到 console）
//   - agents 导出：注册一个自定义 Agent（安装后自动出现在「Agent 工作台」）
//
// 你可以基于本文件修改后用「粘贴代码安装」体验完整流程。

export const manifest = {
  name: 'word-count',
  version: '1.0.0',
  description: '统计卡片正反面字数，并可在卡片保存时输出摘要到控制台',
  author: 'sxybrick',
  tools: [
    {
      name: 'count',
      description: '统计给定文本的字符数（中文按 1 字、英文按单词）',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要统计的文本' },
        },
        required: ['text'],
      },
    },
    {
      name: 'summarize',
      description: '返回卡片 front/back 的摘要（前 30 字符）',
      inputSchema: {
        type: 'object',
        properties: {
          front: { type: 'string' },
          back: { type: 'string' },
        },
      },
    },
  ],
  hooks: {
    onCardSaved: 'onCardSaved',
  },
};

// 插件自定义 Agent：安装后自动注册进全局 Agent 注册表（agentRegistry），
// 在「Agent 工作台」即可看到并对话。tools 引用本插件的工具名。
export const agents = [
  {
    id: 'word-count-assistant',
    name: '字数助手',
    description: '统计卡片正反面字数，输出简洁报告（由 word-count 插件提供）',
    systemPrompt:
      '你是 SxyBrick 里的字数统计助手。用户要求统计字数时，调用 count 工具统计文本' +
      '（中文按字、英文按词），调用 summarize 工具查看卡片摘要，最后用一两行给出结论。' +
      '只做统计，不做其他事，不要寒暄。',
    tools: ['count', 'summarize'],
    useReAct: true,
    maxSteps: 4,
  },
];

export async function count(args) {
  const text = String(args?.text || '');
  const chars = text.length;
  // 中文字符数 + 英文单词数（粗略）
  const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;
  return { chars, chinese: cn, englishWords: en };
}

export async function summarize(args) {
  const front = String(args?.front || '').slice(0, 30);
  const back = String(args?.back || '').slice(0, 30);
  return { front, back };
}

export function onCardSaved(card) {
  // 仅做日志，不修改卡片
  console.log('[word-count] 卡片已保存：', card?.id, '字数：', String(card?.front || '').length);
}
