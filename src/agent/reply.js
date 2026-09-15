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

// ---------- 结构化结果的可读化（round64） ----------
// 历史行为：LLM / 工具返回「无 text/content/... 字段」的对象时，直接
// `JSON.stringify(r, null, 2)` 甩给 MarkdownRenderer → 用户在对话里看到一坨带引号和花括号的 JSON 源码。
// 结构本身没丢，但完全不像「助手说的话」。改为按形状渲染成可读列表：
//   - 数组 / {items|list|rows|results: [...]} → 逐行 `- 字段: 值`
//   - {ok, data} 工具结果标准包装 → 解包后递归
//   - {error: '...'} → 显式错误提示
//   - 纯标量对象 → `- key: value`
// 形状无法识别时返回 null，由调用方回退到原 JSON 序列化（信息优先于美观，绝不返回空）。
const _isScalar = (v) => v === null || typeof v !== 'object';

/** 单元格取值：标量直出；数组以「、」连接；对象优先取标识字段，否则 JSON */
function _cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.filter(_isScalar).map(String).join('、');
  for (const k of ['title', 'name', 'label', 'text', 'id']) {
    if (_isScalar(v[k]) && v[k] !== null && v[k] !== undefined) return String(v[k]);
  }
  try { return JSON.stringify(v); } catch { return ''; }
}

/** 单行渲染：`- k: v · k: v`（对象）或 `- v`（标量 / 数组）；无可渲染字段时返回空串由调用方过滤 */
function _row(item) {
  if (_isScalar(item)) return `- ${String(item)}`;
  if (Array.isArray(item)) return `- ${item.map(_cell).filter(Boolean).join('、')}`;
  const parts = Object.entries(item)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${_cell(v)}`);
  return parts.length ? `- ${parts.join(' · ')}` : '';
}

export function humanizeStructured(r, depth = 0) {
  if (depth > 3) return null; // 防深层包装递归
  if (Array.isArray(r)) {
    const body = r.map(_row).filter(Boolean).join('\n');
    return body || null;
  }
  if (!r || typeof r !== 'object') return null;
  if (typeof r.error === 'string' && r.error) return `⚠️ ${r.error}`;
  // 工具结果标准包装 {ok, data, error}：解包后交给下一层（data 为数组也走这里）
  if (r.data !== null && r.data !== undefined && typeof r.data === 'object') {
    const inner = humanizeStructured(r.data, depth + 1);
    if (inner) return inner;
  }
  // 列表容器：条目 + 其余标量字段作为上下文（如 {items:[...], total: 30}）
  for (const key of ['items', 'list', 'rows', 'results']) {
    if (Array.isArray(r[key])) {
      const lines = [];
      const ctx = Object.entries(r)
        .filter(([k, v]) => k !== key && v !== undefined && _isScalar(v))
        .map(([k, v]) => `${k}: ${_cell(v)}`);
      if (ctx.length) lines.push(ctx.join(' · '));
      const body = r[key].map(_row).filter(Boolean).join('\n');
      if (body) lines.push(body);
      return lines.length ? lines.join('\n') : null;
    }
  }
  // 键值对象 → 列表（数组值以「、」连接；含嵌套对象时不处理，避免把它压成一行难读的 JSON）
  const entries = Object.entries(r).filter(([, v]) => v !== undefined);
  if (entries.length && entries.every(([, v]) => _isScalar(v) || Array.isArray(v))) {
    return entries.map(([k, v]) => `- ${k}: ${_cell(v)}`).join('\n');
  }
  return null;
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
    // 对象一律计入 fallback（它们不是正常的「文本回复」），但出口必须可读：
    // round64 — 先按形状渲染成人类可读列表；形状不可识别才回退 JSON 序列化；仍为空则兜底提示。
    _stats.fallback++; _incReason('object');
    const human = humanizeStructured(r);
    if (human) return human;
    try {
      const s = JSON.stringify(r, null, 2);
      if (s && s !== '{}' && s !== 'null') return s;
    } catch { /* 序列化失败 → 兜底 */ }
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
