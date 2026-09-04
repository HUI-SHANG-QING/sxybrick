// src/agent/reply.js
// 把任意 Agent 回复归一化为「非空 string」，杜绝 MarkdownRenderer 收到
// null / undefined / '' / 对象 → 前端渲染出「没有内容的空白行」。
//
// 历史坑（经验 934245）：runTask 早期直接 `return { reply }` 把 LLM 原始结果透传给 UI，
// 当 LLM 返回空内容（choices[0].message.content === ''）或结构化对象时，
// AgentWorkbench 把它直接塞进 MarkdownRenderer → 整条回复是一行空白。
// 统一在编排层把 reply 收口成 string：空值回退到可读提示，绝不把 "" 静默抛给 UI。
import { t } from '../i18n/index.js';

const DEFAULT_EMPTY_REPLY = () => t('agent.orchestrator.emptyReplyFallback');

/**
 * 把任意 reply 归一化为非空字符串，兜底 UI 空白行。
 *  - 合法 string（非空）→ 原样返回
 *  - '' / null / undefined / 对象 / 数字 / 布尔 → 尽量提取可读文本，否则回退到用户可见提示
 *  - 绝不返回空字符串
 * @param {any} r 原始回复
 * @param {string} [fallback] 自定义兜底文案（缺省用字典 agent.orchestrator.emptyReplyFallback）
 * @returns {string} 一定非空
 */
export function stringifyReply(r, fallback) {
  const fb = fallback || DEFAULT_EMPTY_REPLY();
  if (typeof r === 'string') return r || fb;
  if (r == null) return fb;
  if (typeof r === 'object') {
    for (const k of ['text', 'content', 'message', 'reply', 'answer']) {
      if (typeof r[k] === 'string' && r[k]) return r[k];
    }
    try { return JSON.stringify(r, null, 2); } catch { return fb; }
  }
  try { return String(r) || fb; } catch { return fb; }
}
