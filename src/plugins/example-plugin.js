// 示例插件：字数统计 + 卡片摘要
// 安装方式：在「插件」页点击「从示例安装」按钮，会自动把本文件内容作为插件代码安装。
//
// 这个示例演示了插件机制的全部能力：
//   - manifest 声明工具与钩子
//   - 工具函数接收 args、返回结果
//   - 钩子函数在卡片保存时被调用（写日志到 console）
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
