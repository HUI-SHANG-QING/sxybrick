// 锁定多智能体协作的「发现归因」逻辑（N3 修复的核心）。
// 修复前：orchestrator 单 Agent 路径与 pipeline 的 stepCtx 都没把 agentId 注入工具上下文，
//        write_blackboard 恒归因到 'unknown'。现统一由 resolveAgentId(ctx) 解析，
//        调用方（orchestrator/pipeline）已写入 ctx.agentId，默认即可正确归因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentId } from '../src/agent/attribution.js';

test('resolveAgentId 优先使用 ctx.agentId', () => {
  assert.equal(resolveAgentId({ agentId: 'smart-reviewer' }), 'smart-reviewer');
  assert.equal(resolveAgentId({ agentId: 'graph-builder', currentAgentId: 'x' }), 'graph-builder');
});

test('resolveAgentId 退化到 currentAgentId', () => {
  assert.equal(resolveAgentId({ currentAgentId: 'tutor' }), 'tutor');
});

test('ctx 无 agent 信息时回退 unknown（保留旧行为）', () => {
  assert.equal(resolveAgentId({ blackboard: {} }), 'unknown');
  assert.equal(resolveAgentId(undefined), 'unknown');
  assert.equal(resolveAgentId({}), 'unknown');
});
