// tests/agent-streaming.test.mjs —— round137：真流式链路的端到端验证
//
// 用户诉求：「它输出的不是流式输出，SSE 那个，要改成流式输出」。
// 根因：llm.js **早就有** `opts.onToken(delta, full)` 钩子（`llm.js:402`），
//   但**全仓无人使用** —— Agent 只能等整段返回，前端的「打字机」是**客户端模拟**的。
// 本轮把它接上：llm.js 的 onToken → base.js 主循环 → TraceKind.STREAM_* → 三个视图。
//
// 关键难点：ReAct 的**中间步可能是工具调用**而不是答案，它的流式内容不该显示给用户 ⇒
//   设计成三态状态机（STREAM_BEGIN / STREAM_DELTA / STREAM_CLEAR）由前端呈现。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/agent/tools/index.js';
import { runReActAgent } from '../src/agent/agents/base.js';
import { TraceKind } from '../src/agent/types.js';

const AGENT = { id: 't', systemPrompt: '你是助手', tools: [] };

async function runWith(chatImpl) {
  const traces = [];
  const reply = await runReActAgent({
    agent: AGENT,
    userMessages: [{ role: 'user', content: 'hi' }],
    ctx: { chat: chatImpl, cfg: {} },
    onTrace: (n) => traces.push(n),
  });
  return { reply, traces, of: (k) => traces.filter((n) => n.kind === k) };
}

test('真流式：增量随生成实时到达（不必等整段返回）', async () => {
  const { reply, of } = await runWith(async (_msgs, opts) => {
    opts?.onToken?.('你');
    opts?.onToken?.('好');
    opts?.onToken?.('，世界');
    return '你好，世界';
  });
  const deltas = of(TraceKind.STREAM_DELTA);
  assert.equal(deltas.length, 3, '每个增量都应作为一条 STREAM_DELTA 轨迹到达');
  assert.equal(deltas.map((d) => d.text).join(''), '你好，世界', '增量拼起来必须等于最终回答');
  assert.equal(reply, '你好，世界');
  assert.equal(of(TraceKind.STREAM_BEGIN).length, 1, '每步开始前应先发 STREAM_BEGIN（前端据此清空气泡）');
});

test('工具调用步的流式内容会被 CLEAR 作废（否则用户看到半截调用语法）', async () => {
  let step = 0;
  const { traces, of } = await runWith(async (_msgs, opts) => {
    step += 1;
    if (step === 1) {
      opts?.onToken?.('让我查一下卡片库');
      opts?.onToken?.('<tool>get_stats</tool>');
      return '<tool>get_stats</tool><args>{}</args>';
    }
    opts?.onToken?.('你共有');
    opts?.onToken?.(' 3 张卡');
    return '你共有 3 张卡';
  });

  // 轨迹是**完整历史**（工具调用那步的增量确实发出来了）——作废靠前端收到 CLEAR 后清空。
  const clearIdx = traces.findIndex((n) => n.kind === TraceKind.STREAM_CLEAR);
  assert.ok(clearIdx >= 0, '判定为工具调用的那一步必须发 STREAM_CLEAR');

  // CLEAR **之后**的增量才是最终展示的内容：必须只有答案，不含工具调用字样
  const after = traces.slice(clearIdx + 1)
    .filter((n) => n.kind === TraceKind.STREAM_DELTA)
    .map((n) => n.text).join('');
  assert.ok(after.includes('你共有'), '最终答案的流式内容必须保留');
  assert.ok(!after.includes('<tool>'), 'CLEAR 之后（即最终展示内容）不应含工具调用字样');
  assert.equal(of(TraceKind.STREAM_BEGIN).length, 2, '两步各发一次 BEGIN');
});

test('回归：没有流式增量时也必须照常工作（离线 / 非流式端点的兜底）', async () => {
  const { reply, of } = await runWith(async () => '一次性返回的答案');
  assert.equal(reply, '一次性返回的答案');
  assert.equal(of(TraceKind.STREAM_DELTA).length, 0, '非流式时不应有增量轨迹');
  // 但 STREAM_BEGIN 仍会发 —— 前端据此清空气泡，行为与「收到最终结果后覆盖」一致
  assert.equal(of(TraceKind.STREAM_BEGIN).length, 1);
});

test('回归：不传 onTrace 的调用方不受影响（onTrace 可选）', async () => {
  const reply = await runReActAgent({
    agent: AGENT,
    userMessages: [{ role: 'user', content: 'hi' }],
    ctx: { chat: async () => '答案', cfg: {} },
    // 故意不传 onTrace
  });
  assert.equal(reply, '答案');
});
