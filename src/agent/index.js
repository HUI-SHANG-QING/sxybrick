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
import { ensureIndex, rebuildIndex, getIndexStatus, hybridSearch, retrieveContext } from './retrieval.js';
import { runPipeline, shouldUsePipeline, PRESET_PIPELINES } from './pipeline.js';
import { createBlackboard } from './blackboard.js';
import {
  getProactiveScheduler,
  generateRuleSuggestions,
  commitSuggestions,
  maybeGenerateAISummary,
  pushNotification,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  clearAllNotifications,
  deleteNotification,
} from './proactive.js';

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

  // —— RAG 检索增强（Agent 的「眼睛」）——
  ensureIndex,        // 增量索引（后台补 embedding）
  rebuildIndex,       // 全量重建索引
  getIndexStatus,     // 索引健康状态
  hybridSearch,       // 混合检索（语义+关键词）
  retrieveContext,    // 检索增强上下文

  // —— 多智能体协作（A 级核心）——
  runPipeline,        // 执行多智能体流水线
  shouldUsePipeline,  // 判断是否该用流水线
  PRESET_PIPELINES,   // 预设流水线列表
  createBlackboard,   // 创建共享黑板

  // —— 主动智能体（A 级核心：从被动应答到主动关怀）——
  getProactiveScheduler,    // 主动调度器单例（应用启动 start，关闭 stop）
  generateRuleSuggestions,  // 规则建议引擎（免费、零延迟）
  commitSuggestions,        // 提交建议到通知库（去重 + 持久化 + 系统通知）
  maybeGenerateAISummary,   // 每日 AI 智能总结（需配置 Key）
  pushNotification,         // 写入一条通知
  listNotifications,       // 列出通知
  unreadCount,              // 未读数
  markRead,                 // 标记已读
  markAllRead,              // 全部已读
  clearAllNotifications,    // 清空全部
  deleteNotification,       // 删除单条
};

export default agentSystem;
