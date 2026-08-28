// src/plugins/agent-bridge.js
// 插件 ↔ Agent 编排器桥接层（纯函数 + 轻编排，无浏览器副作用依赖）。
//
// 目标：把 db.plugins 中声明式 manifest 的插件工具/Agent，「注册」进全局
// agentSystem（toolRegistry / agentRegistry），让 Agent 工作台、runTask、
// 多 Agent 流水线都能直接使用插件能力——这是 Phase 4「平台化」的关键一跳：
//   安装插件 → 自动出现在 Agent 可用工具/Agent 列表 → 模型可直接调用。
//
// 本文件保持纯函数可测：所有不依赖 IO 的转换（schema→参数、冲突检测、
// 钩子映射、Agent 定义归一）都在这里；真正调用注册表 / invokeTool 的
// 编排逻辑在 plugins/registry.js（生命周期）完成。

/**
 * MCP JSON Schema（inputSchema）→ Agent 工具的人类可读参数说明
 * 产物与 defineTool().parameters 兼容：{ "字段名": "类型（必填）: 说明" }
 * @param {object} schema MCP 风格 JSON Schema（含 properties / required）
 * @returns {Record<string, string>}
 */
export function inputSchemaToParams(schema) {
  const params = {};
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  for (const [k, v] of Object.entries(props)) {
    if (!v || typeof v !== 'object') { params[k] = 'any'; continue; }
    const type = v.type || 'any';
    const desc = v.description ? `: ${v.description}` : '';
    params[k] = `${type}${required.has(k) ? '（必填）' : ''}${desc}`;
  }
  return params;
}

/**
 * 描述一个插件工具（不含 execute，纯数据）
 * @param {string} pluginId 插件 id
 * @param {object} toolDef manifest.tools[] 中的一项
 * @returns {object} defineTool 兼容 spec 的数据部分
 */
export function describePluginTool(pluginId, toolDef) {
  return {
    name: toolDef.name,
    description: `[插件 ${pluginId}] ${toolDef.description || ''}`,
    parameters: inputSchemaToParams(toolDef.inputSchema),
    // 插件工具无法静态判定是否读/写数据，按最保守口径提示
    readsData: false,
    writesData: true,
    plugin: pluginId,
  };
}

/**
 * 组装完整工具 spec：数据部分 + execute 桥接。
 * @param {string} pluginId 插件 id
 * @param {object} toolDef manifest.tools[] 中的一项
 * @param {(args: object) => Promise<any>} invokeFn 实际调用函数（注入，避免循环依赖）
 */
export function buildToolSpec(pluginId, toolDef, invokeFn) {
  return {
    ...describePluginTool(pluginId, toolDef),
    execute: async (args) => invokeFn(args),
  };
}

/**
 * 归一化插件模块导出的 Agent 定义。
 * 支持三种导出形态：
 *   export const agents = [ { id, name, description, systemPrompt, tools, useReAct, maxSteps }, ... ]
 *   export const agentManifest = { ... }
 *   export const agents = { ... }（单个）
 * @param {object} mod import() 返回的模块对象
 * @returns {object[]} 归一后的 Agent spec 数组（非法项过滤）
 */
export function parseAgentDefs(mod) {
  if (!mod || typeof mod !== 'object') return [];
  let raw = null;
  if (mod.agents != null) raw = mod.agents;
  else if (mod.agentManifest != null) raw = mod.agentManifest;
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object' || !a.id || !a.name) continue;
    out.push({
      id: String(a.id),
      name: String(a.name),
      description: a.description || '',
      systemPrompt: a.systemPrompt || '',
      tools: Array.isArray(a.tools) ? a.tools.map(String) : [],
      useReAct: a.useReAct !== false,
      maxSteps: a.maxSteps || 8,
      injectContext: a.injectContext !== false,
      injectMemory: a.injectMemory !== false,
      plugin: a.plugin || null,
    });
  }
  return out;
}

/**
 * 收集响应某事件的所有插件（纯函数，registry.triggerHook 的分发依据）
 * @param {object[]} rows db.plugins 行（含 hooks 字段）
 * @param {string} event 事件名（见 SUPPORTED_HOOKS）
 * @returns {Array<{ pluginId: string, fnName: string }>}
 */
export function collectHookHandlers(rows, event) {
  return (rows || [])
    .filter((r) => r && r.hooks && r.hooks[event])
    .map((r) => ({ pluginId: r.id, fnName: r.hooks[event] }));
}

/**
 * 冲突检测：待注册的工具/Agent 与现有注册表是否重名。
 * 返回冲突名单，由调用方决定是阻止安装还是提示覆盖。
 * @param {object[]} toolSpecs describePluginTool 产物
 * @param {object[]} agentDefs parseAgentDefs 产物
 * @param {{ toolNames: Set<string>, agentIds: Set<string> }} current 现有注册表快照
 * @returns {{ tools: string[], agents: string[] }}
 */
export function findConflicts(toolSpecs, agentDefs, current) {
  const tools = (toolSpecs || [])
    .filter((s) => current?.toolNames?.has(s.name))
    .map((s) => s.name);
  const agents = (agentDefs || [])
    .filter((a) => current?.agentIds?.has(a.id))
    .map((a) => a.id);
  return { tools, agents };
}

/**
 * 汇总一个插件的注册清单（纯数据）：注册了哪些工具 / 哪些 Agent。
 * 用于 UI 展示「已接入 Agent 编排器」状态。
 * @param {object} row db.plugins 行
 * @param {object|null} mod 已加载模块（可 null）
 * @returns {{ tools: string[], agents: string[] }}
 */
export function pluginActivationSummary(row, mod) {
  const tools = (row?.tools || []).map((t) => t.name);
  const agents = parseAgentDefs(mod).map((a) => a.id);
  return { tools, agents };
}
