// src/utils/genScoring.js
// 智能卡组「评分 + 题型决策」纯函数层（无 IO、无模块依赖，可独立单测）。
//
// 抽出原因：offlineAI.js ↔ genDeck.js 原本互相顶层 import（offlineAI → genDeck ← offlineAI），
// 再经 ai.js → agent/index → orchestrator → pipeline → offlineAI 形成大环。
// 在 Vite/Rollup 打包提升后，该环可能在某个入口（如 ai.js 的 export { agentSystem }）
// 遭遇绑定尚未初始化即被访问 → 运行时抛 `Cannot access 'X' before initialization`。
// 把这两个纯函数下沉到无依赖的 genScoring.js，offlineAI 与 genDeck 均改为从这里引用，
// 直接断开双向环；函数体逻辑与行为不变。

/**
 * 卡片质量评分（0-100 加权）。
 * 从 4 个维度打分：atomicity(幂等) / answerability(可答性) / clarity(清晰度) / length(长度)。
 * @param {{front:string, back:string}} card
 * @returns {{atomicity:number, answerability:number, clarity:number, length:number, overall:number}}
 */
export function scoreCard(card) {
  const front = String(card?.front || '');
  const back = String(card?.back || '');
  const fLen = [...front].length;
  const bLen = [...back].length;

  let atomicity = 100;
  if (fLen > 40) atomicity -= Math.min(40, (fLen - 40) * 0.5);
  if (bLen > 200) atomicity -= Math.min(30, (bLen - 200) * 0.15);
  if (fLen < 4) atomicity -= 30;
  atomicity = Math.max(0, Math.round(atomicity));

  const qWords = /[?？]|什么是|解释|定义|列举|比较|区别|原理|计算|求|为何|为什么|如何|哪些|哪一|填空|___|\(\s*\)/;
  let answerability = qWords.test(front) ? 90 : 60;
  if (/^[^?？]*[。.]$/.test(front) && !qWords.test(front)) answerability -= 20;
  answerability = Math.max(0, Math.min(100, answerability));

  const vague = /(这|那|如下|上述|该|此|其)[一者项]/;
  let clarity = vague.test(front) ? 60 : 85;
  if (vague.test(back) && bLen < 30) clarity -= 10;
  clarity = Math.max(0, Math.min(100, clarity));

  let lengthScore = 80;
  if (fLen >= 8 && fLen <= 35 && bLen >= 5 && bLen <= 150) lengthScore = 100;
  else if (fLen < 6 || bLen < 3) lengthScore = 50;
  lengthScore = Math.max(0, Math.min(100, lengthScore));

  const overall = Math.round(
    atomicity * 0.3 + answerability * 0.3 + clarity * 0.2 + lengthScore * 0.2,
  );
  return { atomicity, answerability, clarity, length: lengthScore, overall };
}

/**
 * 多题型自动决策：根据卡片形态推断题型。
 * @param {{front:string, back:string}} card
 * @returns {'basic'|'cloze'|'choice'}
 */
export function decideType(card) {
  if (!card) return 'basic';
  const front = String(card.front || '');
  const back = String(card.back || '');
  if (/___|_{3,}|\(\s*[A-Da-d]\s*\)|\[填空\]|【填空】/.test(front)) return 'cloze';
  if (/\n\s*[A-D][.、)]/.test(back) || /^[A-D][.、)]/m.test(back)) return 'choice';
  return 'basic';
}