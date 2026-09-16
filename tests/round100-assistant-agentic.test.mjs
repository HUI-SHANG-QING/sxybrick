// tests/round100-assistant-agentic.test.mjs —— round100 回归
//
// 诉求（用户原话：「就两个核心：AI 自己分析，数据全部能丢给 AI，尤其是图片」）：
//   普通问答（AI 学习助手）此前是**单次调用无工具**，只能靠「预注入上下文」，于是要么
//   猜不准（关键词意图表边界：错把"测试"当复习、漏掉"思维导图/截图"、误触"总结"）、
//   要么无条件全量外发。根本解法 = 把它接到 Agent 框架，让 AI **自己决定**调哪些工具取数。
// 本文件锁定：① 新增 'assistant' Agent 且握有全部读取工具；② 工具全部已注册；
//            ③ 视图确实改走 runAgentTurn(agentId=assistant)，不再调用关键词猜模块的函数。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';
import { agentRegistry, toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { registerDefaultAgents } from '../src/agent/agents/index.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

// 去掉注释再断言——注释里提到旧函数名不算「调用」
const VUE = readFileSync(fileURLToPath(new URL('../src/views/AIAssistant.vue', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');

test('assistant Agent：已注册且握有「取全卡/笔记/文档/资料库/会话/番茄」等读取工具', () => {
  registerDefaultAgents();
  const a = agentRegistry.get('assistant');
  assert.ok(a, 'assistant Agent 必须存在');
  for (const t of ['get_card_detail', 'read_note', 'read_doc', 'read_lib_doc', 'read_chat', 'get_pomodoro_sessions', 'search_cards', 'semantic_search', 'list_words', 'read_plan', 'list_memos', 'get_weak_cards']) {
    assert.ok(a.tools.includes(t), `assistant 必须挂 ${t}（否则「取不到数据」会复现）`);
  }
});

test('assistant Agent 的工具全部已注册（未注册 = 对模型等于不存在）', () => {
  const a = agentRegistry.get('assistant');
  assert.ok(a.tools.length >= 30, `工具应覆盖全模块（实际 ${a.tools.length} 个）`);
  for (const n of a.tools) assert.ok(toolRegistry.get(n), `工具未注册：${n}`);
});

test('AI 学习助手改为「自己查数据」：走 runAgentTurn(agentId=assistant)', () => {
  assert.match(VUE, /runAgentTurn/, '必须调用 runAgentTurn');
  assert.match(VUE, /agentId:\s*'assistant'/, "必须指定 agentId: 'assistant'");
});

test('视图不再调用「关键词猜模块」的预注入函数（意图词表边界问题从根上退场）', () => {
  assert.ok(!/buildModuleNodesContext\s*\(/.test(VUE), '不应再调用 buildModuleNodesContext');
  assert.ok(!/buildQuestionCardContext\s*\(/.test(VUE), '不应再调用 buildQuestionCardContext');
  assert.ok(!/buildFullContext\s*\(/.test(VUE), '不应再自建上下文（改由 Agent 框架注入）');
});
