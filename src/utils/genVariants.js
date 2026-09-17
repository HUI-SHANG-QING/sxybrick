// 情境变式生成：为同一知识点生成不同问法/场景的变式卡
// 认知科学依据：同一知识点在不同情境下回忆，避免"学会背题而非学会知识"
// 一次生成多张变式，写入卡片库关联原始卡
import { chatAI, resolveMaxTokens } from '../ai.js';
import { createCard } from '../repo.js';
import { offlineGenVariants, shouldFallback, isNetworkError, isOfflineReply } from './offlineAI.js';
import { parseLLMJsonArray } from './llm-json.js';
import { t } from '../i18n/index.js';

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
export async function genVariants(card, count = 3, deps = {}) {
  // 注入缝：默认就是 chatAI（生产行为不变），测试可传 deps.chat 以复现空响应/截断
  const callAI = typeof deps.chat === 'function' ? deps.chat : chatAI;
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

  /** 本地模板兜底（无 key / 网络失败 / 服务端只回离线文案时共用一条路径） */
  const offline = async (failMsg) => {
    const variants = offlineGenVariants(card, count);
    const created = [];
    for (const v of variants) { try { created.push(await make(v)); } catch {} }
    if (!created.length) throw new Error(failMsg);
    return created;
  };

  // 离线兜底：无 key 时用本地模板变式（已带难度梯度）
  if (shouldFallback()) return offline(t('utils.genVariants.offlineNoKey'));

  const budget = Math.min(6000, Math.max(3000, count * 600)); // 防 max_tokens 截断 JSON
  const messages = [
    {
      role: 'system',
      content: `你是出题老师。针对下面的知识点出 ${count} 道「情境变式」题，难度覆盖 basic（基础识记）/ applied（情境应用）/ challenge（综合辨析）三级梯度，每道换一个真实应用场景，避免简单换汤不换药。输出严格 JSON 数组：[{"front":"问题","back":"答案","difficulty":"basic|applied|challenge"}]。只输出 JSON，不要多余文字。`,
    },
    {
      role: 'user',
      content: `原题：${plain(card.front)}\n原答案：${plain(card.back)}\n科目：${card.subject || '未分类'}`,
    },
  ];

  let arr;
  try {
    // round105：budget 只是「够用的下限」，不能覆盖用户设置——用户在「AI 设置」里把
    // 最大输出长度调到 131072，旧写法却把请求写死成 3000，于是他怎么调都没用。
    const r = await callAI(messages, { maxTokens: resolveMaxTokens(budget) });
    // chatAI 在**网络失败/未配置密钥**时并不抛错，而是返回一段【离线模式】文案。
    // 旧实现把它直接送去 JSON 解析 → 报「格式不合法」，用户看到的原因与真实原因（网络/密钥）完全不符。
    if (isOfflineReply(r)) return offline(t('utils.genVariants.offlineFailed'));

    try {
      arr = parseLLMJsonArray(r); // 空输出/非 JSON → 可读报错，而非 "Unexpected end of JSON input"
    } catch {
      // round105【重试】空响应或被 max_tokens 截断的半截 JSON：换**非流式 + 双倍预算**再试一次。
      // 这不是"重试碰运气"：非流式分支带「截断自动续写」（llm.js MAX_CONTINUATIONS）与更细的
      // 空响应诊断，对「预算不够 / 推理模型吃光预算」这两类失败成功率显著更高；仍失败则把
      // llm.js 给出的**精确原因**原样抛出（不再回落到笼统的"返回内容为空"）。
      const r2 = await callAI(messages, { stream: false, maxTokens: resolveMaxTokens(budget * 2) });
      if (isOfflineReply(r2)) return offline(t('utils.genVariants.offlineFailed'));
      arr = parseLLMJsonArray(r2);
    }
  } catch (e) {
    if (isNetworkError(e)) return offline(t('utils.genVariants.offlineFailed'));
    throw e;
  }
  const created = [];
  for (const v of arr) {
    if (!v.front || !v.back) continue;
    try { created.push(await make(v)); } catch {}
  }
  if (!created.length) throw new Error(t('utils.genVariants.noValidVariant'));
  return created;
}
