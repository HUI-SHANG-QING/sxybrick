// src/agent/orchestrator.js
// 编排器：Agent 应用的“大脑调度层”。负责
//  1) 意图路由：判断用户诉求该交给哪个 Agent（关键词启发式，零额外 token 开销）；
//  2) 任务执行：把上下文（学习数据 + 长期记忆）注入，驱动被选中的 Agent 跑 ReAct 循环；
//  3) 轨迹回传：把“路由→思考→工具→观察→结论”全过程回传给 UI，体现透明的任务编排。

import { agentRegistry, toolRegistry } from './registry.js';
import { runReActAgent } from './agents/base.js';
import { stringifyReply } from './reply.js'; // 归一化 reply 为非空 string，杜绝 UI 空白行
import { buildStudyContext, buildFullContext } from './context.js';
import { buildMemoryText } from './memory.js';
import { chat as llmChat } from './llm.js';
import { TraceKind } from './types.js';
import { runPipeline, shouldUsePipeline, PRESET_PIPELINES } from './pipeline.js';
import { offlineChat, shouldFallback, isNetworkError } from '../utils/offlineAI.js';
import { t } from '../i18n/index.js'; // UI-facing trace / agentName 经 i18n 字典（check-view-i18n --js 闸门）

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

// 意图关键词 → Agent 映射（更具体的放前面）
const INTENT_RULES = [
  { agent: 'cardsmith', keys: ['组卡', '拆', '整理', '笔记', '讲义', '提取知识点', '生成卡片', '导入', '做卡', '知识点'] },
  { agent: 'quizmaster', keys: ['出题', '测验', '考我', '自测', '做题', '测一下', '来道题'] },
  { agent: 'mnemonist', keys: ['口诀', '记忆口诀', '联想', '怎么记', '记不住', '助记', '谐音'] },
  { agent: 'smart-reviewer', keys: ['复习清单', '今天复习什么', '针对性复习', '智能复习', '先复习什么', '复习计划怎么排', '优先复习'] },
  { agent: 'mistake-analyst', keys: ['错题', '错因', '为什么错', '老错', '错题分析', '错题集', '总错'] },
  { agent: 'graph-builder', keys: ['图谱', '知识图谱', '关联', '知识点关联', '串起来', '知识网络', '关系图'] },
  { agent: 'planner', keys: ['计划', '规划', '安排', '时间表', '复习计划', '怎么安排', '日程', '节奏'] },
  { agent: 'analyst', keys: ['周报', '薄弱', '数据', '统计', '掌握度', '分析', '建议复习', '哪里差', '趋势', '报表'] },
  { agent: 'memorykeeper', keys: ['记住', '我的目标', '考研目标', '我是', '偏好', '长期记忆', '了解我'] },
];

function routeIntent(text) {
  const t = String(text || '');
  for (const rule of INTENT_RULES) {
    if (rule.keys.some((k) => t.includes(k))) return rule.agent;
  }
  return 'tutor'; // 默认：答疑导师（知识点疑问）
}

/**
 * 执行一次用户任务（一轮对话）。
 * @param {object} opt
 *   userInput: 用户输入文本
 *   history:   历史消息（role/content 数组，不含 system）
 *   cfg:       AI 配置 { baseUrl, apiKey, model }
 *   agentId:   显式指定 Agent（工作台手动选择），为空则自动路由
 *   onTrace:   轨迹回调 (node) => void
 *   signal:    可中断信号
 * @returns {Promise<{reply:string, agentId:string, agentName:string, trace:Array}>}
 */
export async function runTask(opt) {
  const { userInput, history = [], cfg, agentId = null, onTrace = null, signal = null } = opt;
  const trace = [];
  const push = (node) => { trace.push(node); onTrace?.(node); };

  // 0) 多智能体流水线判断：自动路由模式下，复杂多步任务走流水线
  if (!agentId && shouldUsePipeline(userInput)) {
    push({ kind: TraceKind.ROUTE, text: t('agent.orchestrator.pipelineStart'), agentId: 'pipeline' });
    const result = await runPipeline({ query: userInput, cfg, onTrace: push, signal });
    if (!result.fallback) {
      return {
        // Bug fix: 统一 reply 为 string，避免 MarkdownRenderer 收到 null/对象 → 空白行
        reply: stringifyReply(result.reply),
        agentId: 'pipeline',
        agentName: t('agent.orchestrator.pipelineAgentName'),
        trace: [...trace, ...result.trace],
      };
    }
    // 流水线回退 → 继续走单 Agent
    push({ kind: TraceKind.ROUTE, text: t('agent.orchestrator.pipelineFallback'), agentId: 'tutor' });
  }

  // 1) 构建上下文（学习数据 + RAG 检索增强 + 长期记忆）
  const [studyContext, memoryText] = await Promise.all([buildFullContext(userInput), buildMemoryText()]);
  // 2) 路由 / 选定 Agent（先于 ctx 解析，便于把 agentId 注入工具上下文，
  //    这样多智能体协作时 write_blackboard 能把发现正确归因到调用它的 Agent，而非 'unknown'）
  const resolvedId = agentId || routeIntent(userInput);
  const agent = agentRegistry.get(resolvedId) || agentRegistry.get('tutor');
  push({ kind: TraceKind.ROUTE, text: t('agent.orchestrator.routedToAgent', { name: agent.name }), agentId: agent.id });

  const ctx = {
    agentId: agent.id,
    cfg,
    studyContext,
    memoryText,
    chat: (messages, opts = {}) => chatWithFallback(messages, cfg, { ...opts, signal, source: `agent:${agent.id}` }),
  };

  // 3) 拼接对话（保留最近若干轮历史，控制 token）
  const recent = history.slice(-12);
  const userMessages = [...recent, { role: 'user', content: userInput }];

  // 4) 执行 Agent 的 ReAct 循环
  const reply = await runReActAgent({ agent, userMessages, ctx, onTrace: push });

  // Bug fix: 统一 reply 为 string（经验 934245：content 为 null/undefined/对象时 MarkdownRenderer 空白）
  return { reply: stringifyReply(reply), agentId: agent.id, agentName: agent.name, trace };
}

export function listAgents() {
  return agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    tools: a.tools,
  }));
}

export function listTools() {
  return toolRegistry.list().map((t) => ({
    name: t.name,
    description: t.description,
    readsData: t.readsData,
    writesData: t.writesData,
  }));
}
