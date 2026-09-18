// tests/agent-pipeline-fallback.test.mjs —— round110：多智能体流水线的兜底（不许把异常甩给用户）
//
// 修复的真实症状：runPipeline 此前只对「分解结果解析为 null」回退；分解阶段的 LLM 调用一旦抛错
// （401/429/超时/网络），异常会一路冒到 UI —— 用户看到一句报错，而不是拿到任何答案。
// 本文件钉住：无论走哪条路，runTask 都必须给出回答（或明确降级），不得抛出。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { runTask } from '../src/agent/orchestrator.js';
import { shouldUsePipeline } from '../src/agent/pipeline.js';
import '../src/agent/agents/index.js';
import '../src/agent/tools/index.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });
before(() => { localStorage.removeItem('sxy_ai_config'); }); // 无密钥 → 走离线兜底

const COMPLEX = '先帮我总结这周的复习情况，然后把薄弱点整理成一篇笔记，最后再排进明天的计划里';

test('前置自检：这条输入确实会触发流水线（否则下面的断言没有意义）', () => {
  assert.equal(shouldUsePipeline(COMPLEX), true, '复杂多步任务应命中流水线判定');
});

test('流水线路径：无密钥/不可用时不抛错，且必须给出回答（降级到单 Agent 或本地直出）', async () => {
  const res = await runTask({ userInput: COMPLEX, cfg: {}, history: [] });
  assert.equal(typeof res.reply, 'string', 'reply 必须是字符串（曾出现过 null → 空白行）');
  assert.ok(res.reply.trim().length > 0, '必须给出非空回答，而不是一句报错');
  assert.ok(Array.isArray(res.trace), 'trace 必须是数组');
  assert.ok(!res.trace.some((n) => n?.kind === 'error' && /Cannot read|TypeError|undefined is not/.test(String(n.text))),
    'trace 里不得出现底层 TypeError 这类不可读错误');
});

test('显式指定 Agent 时不走流水线（回归保护：既有行为不变）', async () => {
  const res = await runTask({ userInput: COMPLEX, cfg: {}, history: [], agentId: 'tutor' });
  assert.equal(res.agentId, 'tutor', '指定了 Agent 就必须用它');
  assert.ok(res.reply.trim().length > 0);
});
