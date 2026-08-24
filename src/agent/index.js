// src/agent/index.js
// Agent 框架的公共入口。对外只暴露“稳定的高层 API”，隐藏内部模块细节，符合封装原则。
//
// 用法示例：
//   import { agentSystem } from './agent/index.js';
//   const { reply, trace } = await agentSystem.runTask({ userInput, cfg, onTrace });
//   // 运行时扩展（可扩展接口）：
//   agentSystem.registerTool({ name, description, parameters, execute });
//   agentSystem.registerAgent({ id, name, description, systemPrompt, tools });

import { toolRegistry, agentRegistry } from './registry.js';
import { registerDefaultTools } from './tools/index.js';
import { registerDefaultAgents } from './agents/index.js';
import { runTask, listAgents, listTools } from './orchestrator.js';
import { extractMemories } from './memory.js';
import { chat as llmChat } from './llm.js';

// 一次性注册内置 Agent 与工具（幂等）
registerDefaultAgents();
registerDefaultTools();

export const agentSystem = {
  // —— 核心能力 ——
  runTask, // 执行一次任务（自动路由 + 多步编排）
  listAgents, // 当前所有可用 Agent
  listTools, // 当前所有可用工具

  // —— 可扩展接口（开闭原则）——
  registerTool: (spec) => toolRegistry.register(spec),
  registerAgent: (spec) => agentRegistry.register(spec),
  getAgent: (id) => agentRegistry.get(id),
  getTool: (name) => toolRegistry.get(name),

  // —— 记忆与底层能力（供上层复用）——
  extractMemories,
  chat: llmChat,
};

export default agentSystem;
