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

// ---------- AI 输出质量监控（round19 扩展） ----------
// 每次 stringifyReply 被调用时记录：total=总调用数，fallback=触发兜底的次数，
// reasons=按触发原因分类计数（null/empty/object/error）。
// 设计为模块级单例：浏览器生命周期内全局唯一，页面刷新归零。
// 供 analytics 健康仪表盘消费（getReplyStats），无需 IndexedDB 持久化。
const _stats = { total: 0, fallback: 0, reasons: {} };
function _incReason(reason) {
  _stats.reasons[reason] = (_stats.reasons[reason] || 0) + 1;
}

/**
 * 获取 AI 回复质量统计（只读快照，供仪表盘/调试用）。
 * @returns {{ total: number, fallback: number, fallbackRate: number, reasons: Record<string,number> }}
 */
export function getReplyStats() {
  return {
    total: _stats.total,
    fallback: _stats.fallback,
    fallbackRate: _stats.total ? Math.round((_stats.fallback / _stats.total) * 1000) / 10 : 0,
    reasons: { ..._stats.reasons },
  };
}

/** 重置统计（仅供测试隔离） */
export function resetReplyStats() {
  _stats.total = 0; _stats.fallback = 0; _stats.reasons = {};
}

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
  _stats.total++;
  const fb = fallback || DEFAULT_EMPTY_REPLY();
  // 快速路径：合法非空 string 直接返回（绝大多数情况）
  if (typeof r === 'string') {
    if (r) return r;
    _stats.fallback++; _incReason('empty');
    return fb;
  }
  if (r == null) {
    _stats.fallback++; _incReason('null');
    return fb;
  }
  if (typeof r === 'object') {
    for (const k of ['text', 'content', 'message', 'reply', 'answer']) {
      if (typeof r[k] === 'string' && r[k]) return r[k];
    }
    // 对象无可用字段 → 序列化或兜底
    try {
      const s = JSON.stringify(r, null, 2);
      if (s && s !== '{}' && s !== 'null') { _stats.fallback++; _incReason('object'); return s; }
    } catch { /* 序列化失败 → 兜底 */ }
    _stats.fallback++; _incReason('object');
    return fb;
  }
  // 其他类型（number/boolean/symbol/function）
  try {
    const s = String(r);
    if (s) return s;
  } catch { /* String 转换失败 */ }
  _stats.fallback++; _incReason('error');
  return fb;
}
