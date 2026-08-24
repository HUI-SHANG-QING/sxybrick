// src/agent/types.js
// Agent 框架的类型约定与枚举。纯数据描述，无运行时依赖，方便外部插件/扩展对齐接口。

/** Agent / 工具角色类型 */
export const Role = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool', // 工具执行结果以 TOOL 角色回灌给模型
};

/** 编排轨迹节点类型（用于 UI 展示 Agent 的思考-行动-观察过程） */
export const TraceKind = {
  THOUGHT: 'thought', // 模型推理
  TOOL_CALL: 'tool_call', // 决定调用某个工具
  TOOL_RESULT: 'tool_result', // 工具返回
  ROUTE: 'route', // 编排器路由到某个 Agent
  PLAN: 'plan', // 多步任务拆解
  FINAL: 'final', // 最终答案
  ERROR: 'error', // 出错
};

/** 工具定义：声明式契约，任何扩展工具都遵循此结构 */
export function defineTool(spec) {
  // spec: { name, description, parameters, execute }
  if (!spec || !spec.name || !spec.execute) {
    throw new Error('工具定义必须包含 name 与 execute');
  }
  return {
    name: spec.name,
    description: spec.description || '',
    // parameters: 人类可读的参数说明（用于拼进 prompt），例如 { "q": "string: 搜索关键词" }
    parameters: spec.parameters || {},
    execute: spec.execute,
    // 可选：该工具是否需要只读访问用户学习数据
    readsData: !!spec.readsData,
    // 可选：该工具是否会修改本地数据（如建卡），用于 UI 提示
    writesData: !!spec.writesData,
  };
}

/** Agent 定义：声明式契约 */
export function defineAgent(spec) {
  if (!spec || !spec.id || !spec.name) {
    throw new Error('Agent 定义必须包含 id 与 name');
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description || '',
    // 该 Agent 可使用的工具名列表（空数组 = 纯对话，无工具）
    tools: spec.tools || [],
    // 系统提示词（角色设定）。可包含 {context} / {memory} 占位符，运行期注入
    systemPrompt: spec.systemPrompt || '',
    // 是否启用 ReAct 工具循环；false 表示直接对话
    useReAct: spec.useReAct !== false,
    // 最大推理步数（防止死循环）
    maxSteps: spec.maxSteps || 8,
    // 可选自定义 run 覆盖默认循环
    run: spec.run || null,
    // 是否允许用户数据上下文注入
    injectContext: spec.injectContext !== false,
    injectMemory: spec.injectMemory !== false,
  };
}

/** 统一的任务执行结果 */
export function makeResult({ reply = '', agent = null, trace = [], usedTools = [] } = {}) {
  return { reply, agent, trace, usedTools };
}

/** 工具执行结果包装 */
export function toolResult({ ok = true, data = null, error = null } = {}) {
  return { ok, data, error };
}
