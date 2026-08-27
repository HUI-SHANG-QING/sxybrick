// 多智能体协作中「发现/工件归因到哪个 Agent」的单一可信源。
// 修复前：orchestrator 单 Agent 路径与 pipeline 的 stepCtx 都没把 agentId 注入工具上下文，
//        导致 write_blackboard 恒归因到 'unknown'。现统一从这里解析，且调用方（orchestrator/pipeline）
//        已写入 ctx.agentId，故默认即可正确归因；缺失时回退 'unknown' 以保留旧行为。
export function resolveAgentId(ctx) {
  if (ctx && (ctx.agentId || ctx.currentAgentId)) return ctx.agentId || ctx.currentAgentId;
  return 'unknown';
}
