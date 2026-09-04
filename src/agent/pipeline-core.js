// src/agent/pipeline-core.js
// 多智能体流水线的纯逻辑层（无 IO、无 LLM 依赖，可独立单测）。
// 抽出原因：pipeline.js 经 offlineAI → genDeck → ai → agent/index 形成循环依赖，
// 直接 import pipeline.js 会触发 PRESET_PIPELINES 的 TDZ 错误（Cannot access before
// initialization），纯逻辑因此无法被单测覆盖。这里只放「解析 + 校验」，编排层复用。

/**
 * BUG-06：校验 LLM 分解产物，丢弃无效步骤（缺 agent/instruction 或类型不符），
 * 统一 trim 后截断到上限。
 * @param {any} steps LLM 解析出的数组（可能是任意形状）
 * @param {number} [limit=4]
 * @returns {Array<{agent:string, instruction:string}>}
 */
export function normalizeDecomposedSteps(steps, limit = 4) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && typeof s === 'object' && !Array.isArray(s))
    .filter((s) => typeof s.agent === 'string' && s.agent.trim())
    .filter((s) => typeof s.instruction === 'string' && s.instruction.trim())
    .map((s) => ({ agent: s.agent.trim(), instruction: s.instruction.trim() }))
    .slice(0, limit);
}

/**
 * 从 LLM 原始输出里提取并校验分解结果。返回合法步骤数组，失败/全无效返回 null。
 * @param {string} out LLM 原始输出（可能带 markdown 代码块）
 * @param {number} [limit=4]
 * @returns {Array<{agent:string, instruction:string}>|null}
 */
export function parseDecomposedOutput(out, limit = 4) {
  const text = String(out || '');
  // 从可能带 markdown 的输出中提取 JSON
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrMatch) return null;
  try {
    const steps = JSON.parse(arrMatch[0]);
    // P1-9：LLM 可能分解出任意多个子步骤，必须设上限——否则每个 step 又跑一轮 ReAct
    // （最大 12 次 LLM 调用），N 步 × 12 次调用全无界，既烧 token 又可能长时间无响应。
    // 这里硬性截断到 limit 步；截断前先做 schema 校验（BUG-06）。
    const valid = normalizeDecomposedSteps(steps, limit);
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}
