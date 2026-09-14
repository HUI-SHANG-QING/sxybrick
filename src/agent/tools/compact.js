// src/agent/tools/compact.js
// 工具结果的「结构化压缩」：把要喂给大模型的 JSON 控制在预算内。
//
// 为什么需要（2026-09-14 实测）：ReAct 循环把工具结果原样 JSON.stringify 进上下文，
// 而 search_cards/semantic_search 会返回卡片全文（含 OCR 出来的整页长文本）。
// 一次检索 11 张卡就可能几万字符 → 加上多轮 ReAct 与系统提示，单请求轻易超限/超时，
// 表现为用户看到的「AI 合成回答暂不可用，请重试」反复失败。
//
// 设计取舍：不做「粗暴截断字符串」（会把 JSON 截半、模型无法解析、且丢失哪条被截的信息），
// 而是**按结构压缩**：数组留前 N 项、长字符串截断并标注原长度、对象递归但限深。
// 同时在结尾附一句明确的截断说明 —— 模型据此可以如实告知用户「只看到前 N 条」，
// 而不是以为这就是全部（防止幻觉式总结）。

const DEFAULTS = {
  maxChars: 4000,    // 单次工具结果进上下文的字符预算
  maxItems: 8,       // 数组最多保留几项
  maxStringLen: 300, // 单个字符串字段最长保留多少字符
  maxDepth: 3,       // 递归深度上限
};

/** 截断单个字符串（附原长度，便于模型判断"这里还有更多"） */
function clipString(s, maxLen) {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…（本字段共 ${s.length} 字，已截断）`;
}

/** 递归压缩：数组限量、长串截断、对象限深 */
function shrink(value, opt, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return clipString(value, opt.maxStringLen);
  if (typeof value !== 'object') return value;
  if (depth >= opt.maxDepth) return Array.isArray(value) ? `[…${value.length} 项，层级过深已省略]` : '…（层级过深已省略）';

  if (Array.isArray(value)) {
    const head = value.slice(0, opt.maxItems).map((v) => shrink(v, opt, depth + 1));
    if (value.length > opt.maxItems) head.push(`…还有 ${value.length - opt.maxItems} 项（已省略）`);
    return head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = shrink(v, opt, depth + 1);
  return out;
}

/** 原字符串（供长度判定） */
function rawLength(data) {
  try { return JSON.stringify(data)?.length ?? 0; } catch { return 0; }
}

/**
 * 把工具结果压成可安全进上下文的 JSON 文本。
 * 未超预算时原样返回（零开销，保证常见小结果不被改动）。
 * @param {*} data 工具返回的 data
 * @param {{ maxChars?: number, maxItems?: number, maxStringLen?: number, maxDepth?: number }} [opts]
 * @returns {string}
 */
export function compactToolPayload(data, opts = {}) {
  const opt = { ...DEFAULTS, ...(opts || {}) };
  let text;
  try {
    text = JSON.stringify(data);
  } catch {
    return String(data ?? '');
  }
  if (text == null) return '';
  if (text.length <= opt.maxChars) return text;
  // 极端小预算（< 200 字）：结构化压缩 + 截断说明本身就会超出预算，没有意义，直接硬截断
  if (opt.maxChars < 200) return text.slice(0, opt.maxChars);

  let compacted;
  try {
    compacted = JSON.stringify(shrink(data, opt));
  } catch {
    compacted = text.slice(0, opt.maxChars);
  }
  const notice = `（原始结果约 ${text.length} 字，已按结构压缩；若信息不足，可缩小查询范围或分批取，勿据此断言"只有这些"）`;
  if (compacted.length + notice.length <= opt.maxChars) return compacted + notice;
  return `${compacted.slice(0, Math.max(0, opt.maxChars - notice.length))}${notice}`;
}

/** 估算一段文本给模型的量级（供测试与调试展示） */
export function payloadLength(data) {
  return rawLength(data);
}
