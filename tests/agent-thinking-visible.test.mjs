// tests/agent-thinking-visible.test.mjs —— round135：思考过程不再被丢弃，走轨迹通道供前端折叠展示
//
// 起因（用户原话）：「思考过程应该是可选的吧，网页版 AI 选了深度思考里面的思考过程不是显示出来了吗」
// round134 我把 `<think>` 内容连同标签一起**整个丢掉** —— 治好了"标签泄漏"，却砍掉了有价值的内容。
// 本轮改为：**标签不显示（技术噪音）+ 内容保留（可折叠查看）**。
//
// 实现路径（已核实链路真实存在，不是照注释想当然）：
//   base.js 主循环 → onTrace(TraceKind.THOUGHT) → orchestrator 的 push（真实透传）→ AIAssistant 收集
//   （此前 AIAssistant.vue **压根没传 onTrace**，所以这条路径没有任何出口）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/agent/tools/index.js';
import { splitThinking, stripThinking, parseFinal, runReActAgent } from '../src/agent/agents/base.js';
import { TraceKind } from '../src/agent/types.js';

test('splitThinking：思考与正文分离，标签不留在任一侧', () => {
  const a = splitThinking('<think>用户想要最新的卡片，我应该先查卡片库。</think>这是给你的回答。');
  assert.equal(a.thinking, '用户想要最新的卡片，我应该先查卡片库。');
  assert.equal(a.body, '这是给你的回答。');
  assert.ok(!a.thinking.includes('<think>'), '思考侧不应残留开始标签');
  assert.ok(!a.body.includes('</think>'), '正文侧不应残留结束标签');
});

test('splitThinking：覆盖三种残缺形态（流式抢救常见）', () => {
  // 只有开始标签（被 max_tokens / 空闲超时砍断）
  const b = splitThinking('正文在前<think>被砍断的思考');
  assert.equal(b.body, '正文在前');
  assert.equal(b.thinking, '被砍断的思考');
  // 只有结束标签（分片拼接偶发）
  const c = splitThinking('思考内容</think>正式回答');
  assert.equal(c.thinking, '思考内容');
  assert.equal(c.body, '正式回答');
  // 纯思考、无正文 → 正文为空（上层据此判「没有可给用户看的内容」）
  assert.equal(splitThinking('<think>只有思考</think>').body, '');
});

test('splitThinking：无思考标签时原样返回（回归）', () => {
  assert.deepEqual(splitThinking('普通回答'), { thinking: '', body: '普通回答' });
  assert.equal(stripThinking('普通回答'), '普通回答');
  // 归零：思考为空字符串而不是 undefined
  assert.equal(splitThinking('普通回答').thinking, '');
});

test('parseFinal：仍然只返回正文（思考已被剥掉，API 语义不变）', () => {
  const raw = '<final><think>先查卡片</think>这是答案</final>';
  assert.equal(parseFinal(raw), '这是答案');
  // 无 final 标签但含 thinking 的自由文本
  assert.equal(parseFinal('<think>先查</think>答案正文'), '答案正文');
});

test('端到端：思考通过 THOUGHT 轨迹交给上层（而不是被丢弃）', async () => {
  const traces = [];
  const chat = async () => '<think>用户问最新的卡片，我应该先调工具查。</think>这是给你的答案。';
  const agent = { id: 't', systemPrompt: '你是助手', tools: [] };
  const reply = await runReActAgent({
    agent,
    userMessages: [{ role: 'user', content: '最新的卡片内容是什么' }],
    ctx: { chat, cfg: {} },
    onTrace: (n) => traces.push(n),
  });
  assert.equal(reply, '这是给你的答案。', '返回值只应是正文');
  const thoughts = traces.filter((n) => n.kind === TraceKind.THOUGHT);
  assert.equal(thoughts.length, 1, '应恰好发出一条 THOUGHT 轨迹');
  assert.equal(thoughts[0].text, '用户问最新的卡片，我应该先调工具查。', '思考内容必须完整送达');
  assert.ok(!reply.includes('<think>'), '正文里绝不能残留标签');
});

test('端到端：没有思考时不发空轨迹（不制造噪音）', async () => {
  const traces = [];
  const chat = async () => '这是纯答案，没有思考。';
  const agent = { id: 't', systemPrompt: '你是助手', tools: [] };
  await runReActAgent({
    agent,
    userMessages: [{ role: 'user', content: '你好' }],
    ctx: { chat, cfg: {} },
    onTrace: (n) => traces.push(n),
  });
  assert.equal(traces.filter((n) => n.kind === TraceKind.THOUGHT).length, 0);
});
