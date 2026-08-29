// src/agent/agents/base.js
// Agent 基类能力：基于 ReAct（推理-行动-观察）范式的通用执行循环。
// 设计要点：
//  - 用“文本协议”调用工具（<tool>/<args>/<final>），对任意 OpenAI 兼容端点零依赖、零配置。
//  - 每轮把工具结果以 tool 角色回灌，形成可多步推理的闭环——这就是“任务编排”的最小单元。
//  - 全程通过 onTrace 回传轨迹节点，UI 可实时展示 Agent 的思考过程。

import { toolRegistry } from '../registry.js';
import { TraceKind } from '../types.js';

const PROTOCOL = `
你可以使用下方列出的工具来辅助回答。调用与收尾严格遵循以下格式：

1) 如需调用工具（每次仅一个），输出：
<tool>工具名</tool><args>{"参数名":"参数值"}</args>
2) 工具返回后，你会看到“工具 X 返回：...”，据此继续推理；
3) 当你已能完整回答用户时，必须输出：
<final>这里写给用户的最终回答</final>
注意：不要同时混用两种标签；<final> 之外不要输出多余说明。`;

function buildSystemPrompt(agent, ctx) {
  let p = agent.systemPrompt || '';
  if (agent.injectContext && ctx.studyContext) p = p.replace(/\{context\}/g, ctx.studyContext);
  if (agent.injectMemory && ctx.memoryText) p = p.replace(/\{memory\}/g, ctx.memoryText);
  if (agent.tools && agent.tools.length) {
    p += '\n\n【可用工具】\n' + toolRegistry.toPrompt(agent.tools) + '\n' + PROTOCOL;
  }
  return p;
}

function parseToolCall(raw) {
  const m = String(raw).match(/<tool>([^<]+)<\/tool>\s*<args>([\s\S]*?)<\/args>/);
  if (!m) return null;
  const name = m[1].trim();
  let args = {};
  try {
    args = JSON.parse(m[2].trim() || '{}');
  } catch {
    args = {};
  }
  // 提取工具标记之前的“思考”文字
  const thought = String(raw).slice(0, m.index).trim();
  return { name, args, thought };
}

function parseFinal(raw) {
  const m = String(raw).match(/<final>([\s\S]*?)<\/final>/);
  if (m) return m[1].trim();
  // 没有 <final> 标签时，若也没有 <tool> 标签，则整段视为最终回答
  if (!/<tool>/.test(raw)) return String(raw).trim();
  return null;
}

async function executeTool(name, args, ctx, onTrace) {
  const tool = toolRegistry.get(name);
  if (!tool) {
    const err = `未知工具：${name}`;
    onTrace?.({ kind: TraceKind.ERROR, text: err });
    return { ok: false, error: err };
  }
  onTrace?.({
    kind: TraceKind.TOOL_CALL,
    text: `调用工具 ${name}`,
    detail: JSON.stringify(args),
    tool: name,
  });
  try {
    const res = await tool.execute(args || {}, ctx);
    const preview = JSON.stringify(res?.data ?? res?.error ?? res);
    onTrace?.({
      kind: TraceKind.TOOL_RESULT,
      text: `工具 ${name} 返回`,
      detail: preview.length > 1200 ? preview.slice(0, 1200) + '…' : preview,
      tool: name,
    });
    return res;
  } catch (e) {
    onTrace?.({ kind: TraceKind.ERROR, text: `工具 ${name} 执行出错：${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * 运行一个 ReAct Agent。
 * @param {object} agent  Agent 定义
 * @param {Array} userMessages  历史消息（role/content）
 * @param {object} ctx  { chat, cfg, studyContext, memoryText }
 * @param {function} onTrace  轨迹回调
 * @returns {Promise<string>} 最终回答
 */
export async function runReActAgent({ agent, userMessages, ctx, onTrace }) {
  const systemPrompt = buildSystemPrompt(agent, ctx);
  const convo = [{ role: 'system', content: systemPrompt }, ...userMessages];

  // P1-9：step 上限同时取「agent 声明值」与「硬上限 12」的最小值，
  // 防止插件在 manifest 里自报 9999 导致单轮近万次 LLM 调用（费用爆炸 / 长时间无响应）。
  const MAX_STEPS = 12;
  const maxSteps = Math.min(Number.isFinite(agent.maxSteps) ? agent.maxSteps : 8, MAX_STEPS);
  for (let step = 0; step < maxSteps; step++) {
    const raw = await ctx.chat(convo);
    const toolCall = parseToolCall(raw);

    if (toolCall) {
      if (toolCall.thought) onTrace?.({ kind: TraceKind.THOUGHT, text: toolCall.thought });
      const res = await executeTool(toolCall.name, toolCall.args, ctx, onTrace);
      convo.push({ role: 'assistant', content: raw });
      const payload = res?.ok === false ? `错误：${res.error}` : JSON.stringify(res?.data ?? res);
      convo.push({ role: 'tool', content: `工具 ${toolCall.name} 返回：\n${payload}` });
      continue;
    }

    const final = parseFinal(raw);
    if (final != null) {
      onTrace?.({ kind: TraceKind.FINAL, text: final });
      return final;
    }
    // 兜底：既无 tool 也无 final，视为异常，直接返回原文
    onTrace?.({ kind: TraceKind.FINAL, text: raw });
    return raw;
  }
  const msg = '（已达到最大推理步数，Agent 提前结束）';
  onTrace?.({ kind: TraceKind.FINAL, text: msg });
  return msg;
}
