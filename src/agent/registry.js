// src/agent/registry.js
// 注册表：Agent 与 Tool 的全局登记中心。这是“可扩展接口”的核心——
// 任何插件、第三方扩展或用户脚本都可以在运行时 registerTool / registerAgent，
// 无需改动框架内核。编排器只认注册表，实现真正的开闭原则（对扩展开放、对修改封闭）。

import { defineTool, defineAgent } from './types.js';

export class ToolRegistry {
  constructor() {
    this.map = new Map();
  }
  register(spec) {
    const tool = defineTool(spec);
    // 同名工具会**静默覆盖**（后者赢）——2026-09-14 就因此把「列 AI 文档」的 list_docs
    // 顶成了「列资料库文件」，功能凭空消失且不报错。插件热重载确实需要覆盖能力，
    // 所以这里只告警不抛错；内置工具的重名由 tests/agent-tools-registry.test.mjs 兜住。
    if (this.map.has(tool.name)) {
      console.warn(`[agent] 工具名重复：${tool.name} 被重新注册，先前实现将被覆盖（改个名，或确认这是插件热重载）`);
    }
    this.map.set(tool.name, tool);
    return tool;
  }
  /** 反注册：插件禁用/卸载时移出注册表；内置工具不在此列 */
  unregister(name) {
    const existed = this.map.has(name);
    this.map.delete(name);
    return existed;
  }
  get(name) {
    return this.map.get(name) || null;
  }
  list() {
    return [...this.map.values()];
  }
  /** 生成给模型看的工具说明书（名称 + 描述 + 参数） */
  toPrompt(toolNames) {
    const names = toolNames && toolNames.length ? toolNames : [...this.map.keys()];
    const lines = names
      .map((n) => this.map.get(n))
      .filter(Boolean)
      .map((t) => {
        const params = Object.entries(t.parameters || {})
          .map(([k, v]) => `    - ${k}: ${v}`)
          .join('\n');
        return `• ${t.name}\n  用途：${t.description}\n  参数：\n${params || '    - （无参数）'}`;
      });
    return lines.join('\n\n');
  }
}

export class AgentRegistry {
  constructor() {
    this.map = new Map();
  }
  register(spec) {
    const agent = defineAgent(spec);
    this.map.set(agent.id, agent);
    return agent;
  }
  /** 反注册：插件禁用/卸载时移出注册表；内置 Agent 不在此列 */
  unregister(id) {
    const existed = this.map.has(id);
    this.map.delete(id);
    return existed;
  }
  get(id) {
    return this.map.get(id) || null;
  }
  list() {
    return [...this.map.values()];
  }
}

// 全局单例：整个应用共享同一套 Agent / Tool 注册表
export const toolRegistry = new ToolRegistry();
export const agentRegistry = new AgentRegistry();
