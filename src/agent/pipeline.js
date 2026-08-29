// src/agent/pipeline.js
// 多智能体流水线编排：把复杂任务分解为子任务 → 分配给专业 Agent → 顺序执行 → 聚合结果。
// 这是 A 级 Agent 系统的核心：从「单兵作战」升级到「团队协作」。
//
// 设计要点：
//   1) 预设流水线：常见多步场景（深度学习/复习巩固/考前冲刺）开箱即用
//   2) LLM 分解：非预设的复杂任务，用 LLM 自动分解为子任务+目标 Agent
//   3) 黑板传递：每个 Agent 执行时注入黑板上已有发现，实现信息累积
//   4) 聚合收尾：所有子任务完成后，用 LLM 把黑板上的发现综合成最终回答

import { agentRegistry } from './registry.js';
import { runReActAgent } from './agents/base.js';
import { buildFullContext } from './context.js';
import { buildMemoryText } from './memory.js';
import { chat as llmChat } from './llm.js';
import { createBlackboard } from './blackboard.js';
import { TraceKind } from './types.js';
import { offlineChat, shouldFallback, isNetworkError } from '../utils/offlineAI.js';

// Agent 层离线兜底：与 ai.js chatAI 同款逻辑，避免在 agent 层直调 llm.js 绕过 P3-D 兜底。
// 不能直接 import { chatAI } from '../ai.js'，否则会与 ai.js → agentSystem → 本模块 形成循环依赖。
async function chatWithFallback(messages, cfg, opts = {}) {
  if (shouldFallback()) return offlineChat(messages);
  try {
    return await llmChat(messages, cfg, opts);
  } catch (e) {
    if (isNetworkError(e)) return offlineChat(messages);
    throw e;
  }
}

// ---------- 预设流水线：常见多智能体协作场景 ----------

export const PRESET_PIPELINES = {
  // 深度学习一个主题：组卡 → 讲解 → 测试 → 分析
  'deep-learn': {
    name: '深度学习',
    description: '组卡 → 讲解 → 测试 → 分析，一站式学透一个主题',
    keywords: ['学透', '深入学', '系统学', '彻底搞懂', '从头学', '全面掌握'],
    steps: [
      { agent: 'cardsmith', instruction: '把以下内容拆解成记忆卡片并入库' },
      { agent: 'tutor', instruction: '基于刚生成的卡片，讲解核心概念' },
      { agent: 'quizmaster', instruction: '基于刚讲解的内容出 3 道自测题' },
      { agent: 'analyst', instruction: '分析当前掌握情况，给出下一步建议' },
    ],
  },
  // 复习巩固薄弱点：找薄弱 → 补卡 → 复习清单 → 计划
  'review-consolidate': {
    name: '复习巩固',
    description: '找薄弱 → 补卡 → 复习清单 → 计划',
    keywords: ['复习巩固', '补薄弱', '查漏补缺', '巩固一下', '全面提升'],
    steps: [
      { agent: 'analyst', instruction: '分析薄弱科目和卡片，找出知识缺口' },
      { agent: 'cardsmith', instruction: '针对薄弱点生成补充卡片' },
      { agent: 'smart-reviewer', instruction: '生成针对性复习清单' },
      { agent: 'planner', instruction: '把复习清单编排成分阶段计划' },
    ],
  },
  // 考前冲刺：诊断 → 模考 → 错题分析 → 计划
  'exam-sprint': {
    name: '考前冲刺',
    description: '诊断 → 模考 → 错题分析 → 计划',
    keywords: ['考前', '冲刺', '马上考', '快考试了', '临考'],
    steps: [
      { agent: 'analyst', instruction: '做考前诊断：哪些科目/卡片最危险' },
      { agent: 'quizmaster', instruction: '出一份模考题（优先薄弱点）' },
      { agent: 'mistake-analyst', instruction: '分析模考错题的错因模式' },
      { agent: 'planner', instruction: '排一份考前冲刺计划' },
    ],
  },
};

/** 关键词匹配预设流水线 */
function matchPreset(query) {
  const q = String(query || '');
  for (const [id, p] of Object.entries(PRESET_PIPELINES)) {
    if (p.keywords.some((k) => q.includes(k))) return { id, ...p };
  }
  return null;
}

// ---------- LLM 自动分解（非预设场景）----------

const DECOMPOSE_PROMPT = `你是一个任务分解器。用户提出了一个复杂的学习需求，请把它分解为 2-4 个子任务，每个子任务指定一个专业 Agent 执行。

可用 Agent 列表：
- tutor: 知识点答疑讲解
- analyst: 学习数据分析、薄弱点诊断
- cardsmith: 拆解内容生成卡片、入库
- quizmaster: 出题自测
- mnemonist: 记忆口诀生成
- smart-reviewer: 智能复习清单
- mistake-analyst: 错题分析
- graph-builder: 知识图谱构建
- planner: 学习计划编排

输出严格 JSON 数组，每项 {"agent":"agent-id","instruction":"具体指令"}。只输出 JSON，不要多余说明。`;

async function decomposeTask(query, ctx) {
  const out = await ctx.chat([
    { role: 'system', content: DECOMPOSE_PROMPT },
    { role: 'user', content: `用户需求：${query}` },
  ]);
  // 从可能带 markdown 的输出中提取 JSON
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : out;
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrMatch) return null;
  try {
    const steps = JSON.parse(arrMatch[0]);
    // P1-9：LLM 可能分解出任意多个子步骤，必须设上限——否则每个 step 又跑一轮 ReAct
    // （最大 12 次 LLM 调用），N 步 × 12 次调用全无界，既烧 token 又可能长时间无响应。
    // 这里硬性截断到 4 步（覆盖绝大多数「拆解→并行执行」场景，超出部分丢弃并提示）。
    if (Array.isArray(steps) && steps.length) return steps.slice(0, 4);
  } catch { /* noop */ }
  return null;
}

// ---------- 流水线执行 ----------

/**
 * 执行多智能体流水线。
 * @param {object} opt
 *   query: 用户原始问题
 *   cfg: AI 配置
 *   preset: 预设流水线 id（可选，不传则自动匹配或 LLM 分解）
 *   onTrace: 轨迹回调
 *   signal: 可中断信号
 * @returns {Promise<{reply, blackboard, trace}>}
 */
export async function runPipeline(opt) {
  const { query, cfg, preset: presetId = null, onTrace = null, signal = null } = opt;
  const trace = [];
  const push = (node) => { trace.push(node); onTrace?.(node); };

  // 1) 确定流水线步骤
  let steps = null;
  let pipelineName = '自动分解';

  if (presetId && PRESET_PIPELINES[presetId]) {
    steps = PRESET_PIPELINES[presetId].steps;
    pipelineName = PRESET_PIPELINES[presetId].name;
  } else {
    const matched = matchPreset(query);
    if (matched) {
      steps = matched.steps;
      pipelineName = matched.name;
    }
  }

  // 2) 构建基础上下文
  const ctx = {
    cfg,
    studyContext: '',
    memoryText: await buildMemoryText(),
    chat: (messages, opts = {}) => chatWithFallback(messages, cfg, { ...opts, signal }),
  };

  // 3) 无预设匹配 → LLM 自动分解
  if (!steps) {
    push({ kind: TraceKind.THOUGHT, text: '无预设匹配，用 LLM 自动分解任务' });
    steps = await decomposeTask(query, ctx);
    if (!steps || !steps.length) {
      // 分解失败 → 回退到单 Agent 模式
      push({ kind: TraceKind.ERROR, text: '任务分解失败，回退到单 Agent 模式' });
      return { reply: null, blackboard: null, trace, fallback: true };
    }
  }

  // 4) 创建黑板并注册子任务
  const bb = createBlackboard(query);
  for (const s of steps) {
    bb.addSubtask(s.agent, s.instruction);
  }
  push({
    kind: TraceKind.ROUTE,
    text: `启动「${pipelineName}」流水线：${steps.map((s) => s.agent).join(' → ')}`,
    agentId: 'pipeline',
  });

  // 5) 顺序执行每个子任务
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const agent = agentRegistry.get(step.agent);
    if (!agent) {
      push({ kind: TraceKind.ERROR, text: `Agent 不存在：${step.agent}，跳过` });
      continue;
    }

    push({
      kind: TraceKind.ROUTE,
      text: `步骤 ${i + 1}/${steps.length}：${agent.name} 执行「${step.instruction}」`,
      agentId: agent.id,
    });

    // 构建上下文：学习数据 + RAG + 黑板已有发现
    const studyContext = await buildFullContext(`${query} ${step.instruction}`).catch(() => '');
    const bbContext = bb.toContextText();
    const fullContext = [studyContext, bbContext ? `\n【协作黑板】\n${bbContext}` : ''].filter(Boolean).join('\n');

    const stepCtx = {
      agentId: agent.id, // 让本步 Agent 经 write_blackboard 写入的发现正确归因到自己
      cfg,
      studyContext: fullContext,
      memoryText: ctx.memoryText,
      chat: ctx.chat,
      blackboard: bb, // 把黑板传给 Agent，让它能读写
    };

    // 构造该步骤的输入消息
    const stepInput = `【子任务指令】${step.instruction}\n【原始用户需求】${query}\n请基于黑板上的已有发现继续工作，完成后把关键发现写入黑板。`;
    const userMessages = [{ role: 'user', content: stepInput }];

    try {
      const reply = await runReActAgent({ agent, userMessages, ctx: stepCtx, onTrace: push });
      bb.addFinding(agent.id, reply);
      bb.log(agent.id, `步骤${i + 1}完成`);
      if (bb.subtasks[i]) bb.completeSubtask(bb.subtasks[i].id, reply);
    } catch (e) {
      push({ kind: TraceKind.ERROR, text: `${agent.name} 执行出错：${e.message}` });
      bb.addFinding(agent.id, `执行出错：${e.message}`);
    }
  }

  // 6) 聚合：用 LLM 把黑板上的发现综合成最终回答
  push({ kind: TraceKind.ROUTE, text: '聚合所有 Agent 的发现，生成最终回答', agentId: 'pipeline' });
  const aggPrompt = `你是多智能体协作的聚合器。以下是一个团队协作完成「${query}」的全过程发现，请综合成一份结构清晰的最终回答给用户。

${bb.toContextText()}

要求：分点输出，标注每个结论来自哪个 Agent 的发现，让用户看到团队协作的全貌。`;

  let finalReply = '';
  try {
    finalReply = await ctx.chat([
      { role: 'system', content: aggPrompt },
      { role: 'user', content: '请综合以上发现，给出最终回答。' },
    ]);
  } catch (e) {
    // 聚合 LLM 调用失败（网络/限流/Key 问题）：用黑板已有发现拼成兜底回复，
    // 不让前几个 Agent 已产出的发现因聚合失败而全部丢失
    push({ kind: TraceKind.ERROR, text: `聚合失败，使用原始发现兜底：${e.message}` });
    finalReply = `【多智能体流水线·原始发现（聚合步骤出错，以下为各 Agent 产出原文）】\n\n${bb.toContextText()}`;
  }

  bb.done();
  push({ kind: TraceKind.FINAL, text: finalReply });

  return { reply: finalReply, blackboard: bb, trace };
}
/** 判断是否应该用流水线（而非单 Agent） */
export function shouldUsePipeline(query) {
  const q = String(query || '');
  // 预设关键词命中 → 直接用流水线
  for (const p of Object.values(PRESET_PIPELINES)) {
    if (p.keywords.some((k) => q.includes(k))) return true;
  }
  // 多动词+多目标 → 可能需要多 Agent
  const verbs = (q.match(/学|复|测|分析|计划|组卡|讲解|背|练|整理/g) || []).length;
  const goals = (q.match(/[，；。].*?[，；。]/g) || []).length;
  return verbs >= 2 && goals >= 1;
}
