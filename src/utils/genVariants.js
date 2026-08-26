// 情境变式生成：为同一知识点生成不同问法/场景的变式卡
// 认知科学依据：同一知识点在不同情境下回忆，避免"学会背题而非学会知识"
// 一次生成多张变式，写入卡片库关联原始卡
import { chatAI, hasAIKey } from '../ai.js';
import { createCard } from '../repo.js';
import { offlineGenVariants, shouldFallback, isNetworkError } from './offlineAI.js';

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
  // difficulty 梯度：basic / applied / challenge（P3-E 渐进式复杂度）
  const make = async (v) => createCard({
    front: String(v.front).slice(0, 8000),
    back: String(v.back).slice(0, 8000),
    subject: card.subject || '',
    tags: ['情境变式', ...(card.tags || []).slice(0, 3)],
    type: 'basic',
    source: '情境变式生成',
    sourceCardId: card.id,
    difficulty: ['basic', 'applied', 'challenge'].includes(v.difficulty) ? v.difficulty : 'applied',
  });

  // 离线兜底：无 key 时用本地模板变式（已带难度梯度）
  if (shouldFallback()) {
    const variants = offlineGenVariants(card, count);
    const created = [];
    for (const v of variants) { try { created.push(await make(v)); } catch {} }
    if (!created.length) throw new Error('离线模式无法生成变式，请先配置 AI 密钥');
    return created;
  }

  let arr;
  try {
    const r = await chatAI([
      {
        role: 'system',
        content: `你是出题老师。针对下面的知识点出 ${count} 道「情境变式」题，难度覆盖 basic（基础识记）/ applied（情境应用）/ challenge（综合辨析）三级梯度，每道换一个真实应用场景，避免简单换汤不换药。输出严格 JSON 数组：[{"front":"问题","back":"答案","difficulty":"basic|applied|challenge"}]。只输出 JSON，不要多余文字。`,
      },
      {
        role: 'user',
        content: `原题：${plain(card.front)}\n原答案：${plain(card.back)}\n科目：${card.subject || '未分类'}`,
      },
    ]);
    const m = String(r).match(/\[[\s\S]*\]/);
    arr = JSON.parse(m ? m[0] : r);
    if (!Array.isArray(arr)) throw new Error('AI 返回格式异常');
  } catch (e) {
    if (isNetworkError(e)) {
      // 网络失败：降级本地模板变式
      const variants = offlineGenVariants(card, count);
      const created = [];
      for (const v of variants) { try { created.push(await make(v)); } catch {} }
      if (!created.length) throw new Error('网络失败且离线变式生成失败，请稍后重试');
      return created;
    }
    throw e;
  }
  const created = [];
  for (const v of arr) {
    if (!v.front || !v.back) continue;
    try { created.push(await make(v)); } catch {}
  }
  if (!created.length) throw new Error('AI 未生成有效变式');
  return created;
}
