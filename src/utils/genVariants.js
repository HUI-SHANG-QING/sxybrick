// 情境变式生成：为同一知识点生成不同问法/场景的变式卡
// 认知科学依据：同一知识点在不同情境下回忆，避免"学会背题而非学会知识"
// 一次生成多张变式，写入卡片库关联原始卡
import { chatAI, hasAIKey } from '../ai.js';
import { createCard } from '../repo.js';

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 为一张卡生成多张情境变式卡
 * @param {object} card 原始卡 { front, back, subject, tags }
 * @param {number} count 生成数量（默认 3）
 * @returns {Promise<Array>} 生成的变式卡数组
 */
export async function genVariants(card, count = 3) {
  if (!hasAIKey()) throw new Error('请先在「AI 设置」里填入密钥');
  const r = await chatAI([
    {
      role: 'system',
      content: `你是出题老师。针对下面的知识点出 ${count} 道「情境变式」题（同知识点、不同问法/场景、难度相当），每道换一个真实应用场景，避免简单换汤不换药。输出严格 JSON 数组：[{"front":"问题","back":"答案"}]。只输出 JSON，不要多余文字。`,
    },
    {
      role: 'user',
      content: `原题：${plain(card.front)}\n原答案：${plain(card.back)}\n科目：${card.subject || '未分类'}`,
    },
  ]);
  const m = String(r).match(/\[[\s\S]*\]/);
  const arr = JSON.parse(m ? m[0] : r);
  if (!Array.isArray(arr)) throw new Error('AI 返回格式异常');
  const created = [];
  for (const v of arr) {
    if (!v.front || !v.back) continue;
    const c = await createCard({
      front: String(v.front).slice(0, 8000),
      back: String(v.back).slice(0, 8000),
      subject: card.subject || '',
      tags: ['情境变式', ...(card.tags || []).slice(0, 3)],
      type: 'basic',
      source: '情境变式生成',
      sourceCardId: card.id,   // 变式卡溯源：记录原卡 ID
    });
    created.push(c);
  }
  if (!created.length) throw new Error('AI 未生成有效变式');
  return created;
}
