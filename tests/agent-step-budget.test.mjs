// tests/agent-step-budget.test.mjs —— round88
//
// 背景（用户实测原话）：
//   「？？？为什么会这样，还是看不到图片和各个模块的具体内容，
//     而且（已达到最大推理步数，Agent 提前结束）这是个什么鬼，进行修复」
//
// 根因是一个**唯一丢弃数据的失败出口**：runReActAgent 的 for 循环跑完 maxSteps 后，
// 直接 `return '（已达到最大推理步数，Agent 提前结束）'`，把 observations 里已经抓到的
// 真实工具数据**整批扔掉**。它是四条失败出口（chat 抛错 / 离线占位 / 无标签异常 / 步数耗尽）
// 里唯一不调 buildLocalAnswer 的一条 —— 于是用户看到的就是
// 「Agent 查了一堆数据，最后只回一句提前结束」。
//
// 本文件钉住修复后的三条行为契约：
//   ① 步数耗尽必须先本地直出已抓数据，绝不空手而归；
//   ② 在 maxSteps **之外**多留一格「只收尾」的预算（不削减任何原有工具调用机会）；
//   ③ 收尾前剩余工具机会 ≤ 2 时给出预算提示；收尾格再调工具则不执行、直接落抢救出口。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { runReActAgent } from '../src/agent/agents/base.js';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { db } from '../src/db.js';
import { t } from '../src/i18n/index.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

// ---------- 测试替身 ----------

/**
 * 造一个「按脚本逐轮回话」的假模型；`seen` 记录每轮真实收到的 messages。
 *
 * 注意：必须**快照**收到的 messages —— `compactConvo` 在「未超预算且无内部标记」时
 * 会**原样返回同一个数组引用**（零拷贝快路径），而 runReActAgent 之后还会继续
 * `convo.push(...)`。直接存引用会让早先那几轮的记录被后续轮次污染，
 * 于是「第 0 轮就带着收尾指令」这种假故障会骗过整条断言链。
 */
function scriptedChat(script) {
  const seen = [];
  let i = 0;
  const chat = async (messages) => {
    seen.push(messages.map((m) => ({ ...m })));
    const raw = script[Math.min(i, script.length - 1)];
    i += 1;
    return raw;
  };
  chat.seen = seen;
  return chat;
}

const call = (name, args = '{}') => `<tool>${name}</tool><args>${args}</args>`;
const flat = (messages) => messages.map((m) => String(m?.content ?? '')).join('\n');

/** 注册一个可控探针工具，返回其调用次数（测试结束请 unregister） */
function probeTool(name, dataOf = (args) => ({ echo: args })) {
  let calls = 0;
  toolRegistry.register({
    name,
    description: '测试探针：把入参原样回显，用于验证 ReAct 循环的步数预算与抢救出口。',
    parameters: { n: '任意整数，回显用' },
    readsData: true,
    async execute(args = {}) {
      calls += 1;
      return { ok: true, data: dataOf(args) };
    },
  });
  return {
    get calls() { return calls; },
    dispose() { toolRegistry.unregister(name); },
  };
}

const agentOf = (maxSteps, tools) => ({
  id: 'probe-agent', name: '探针 Agent', systemPrompt: '你是探针', tools, maxSteps,
});

const ctxOf = (chat) => ({ chat, cfg: {}, studyContext: '', memoryText: '' });

// ---------- A. 核心 bug：步数耗尽不得丢弃已抓数据 ----------

test('步数耗尽：已抓到的工具结果必须本地直出，而不是只回一句「提前结束」', async () => {
  const probe = probeTool('__probe_echo');
  try {
    // 每一轮都在调工具、永远不写 <final> —— 旧实现会跑满循环然后丢掉全部数据
    const chat = scriptedChat([call('__probe_echo', '{"n":7}')]);
    const out = await runReActAgent({
      agent: agentOf(2, ['__probe_echo']),
      userMessages: [{ role: 'user', content: '帮我看下各个模块的内容' }],
      ctx: ctxOf(chat),
      onTrace: () => {},
    });
    assert.ok(probe.calls >= 2, `工具确实被调用过（实际 ${probe.calls} 次）`);
    assert.ok(!/Agent 提前结束/.test(out), '不能只剩占位文案把数据全丢掉');
    assert.match(out, /__probe_echo/, '必须把已抓到的工具数据渲染出来（数据源名要可见）');
    assert.match(out, /已达到工具调用步数上限/, '要如实说明为什么是本地直出，而不是伪装成正常回答');
    assert.match(out, /7/, '工具返回的真实内容要出现在回答里');
  } finally { probe.dispose(); }
});

test('步数耗尽且确实一无所获：给可执行的指引，而不是一句干巴巴的「提前结束」', async () => {
  const probe = probeTool('__probe_echo');
  try {
    // args 不是合法 JSON → 每轮都走 parseError 分支 continue（不产生 observation）
    // → 循环耗尽时 observations 仍为空，落到「无数据」文案
    const chat = scriptedChat([call('__probe_echo', '这不是JSON')]);
    const out = await runReActAgent({
      agent: agentOf(2, ['__probe_echo']),
      userMessages: [{ role: 'user', content: '随便问问' }],
      ctx: ctxOf(chat),
      onTrace: () => {},
    });
    assert.equal(probe.calls, 0, '参数解析失败不得调用工具');
    assert.match(out, /拆小/, '空手而归时必须告诉用户下一步怎么做，而不是丢一句「提前结束」');
    assert.equal(out, t('agent.localAnswer.stepLimitNoData'), '应走 i18n 字典（不再硬编码文案）');
  } finally { probe.dispose(); }
});

// ---------- B. 预留收尾格：不得挤占原有工具预算 ----------

test('预留的收尾格是「额外一格」：maxSteps=3 的 agent 仍能调满 3 次工具', async () => {
  const probe = probeTool('__probe_echo');
  try {
    // 前 3 轮调工具，第 4 轮（收尾格）才给出 <final>
    const chat = scriptedChat([
      call('__probe_echo', '{"n":1}'),
      call('__probe_echo', '{"n":2}'),
      call('__probe_echo', '{"n":3}'),
      '<final>三轮查完了，这是结论。</final>',
    ]);
    const out = await runReActAgent({
      agent: agentOf(3, ['__probe_echo']),
      userMessages: [{ role: 'user', content: '查三轮' }],
      ctx: ctxOf(chat),
      onTrace: () => {},
    });
    assert.equal(probe.calls, 3, '收尾格是额外的，原有 3 次工具预算一次都不能少');
    assert.equal(out, '三轮查完了，这是结论。', '收尾格应能正常产出模型自己写的最终回答');
    assert.equal(chat.seen.length, 4, '共 3 次工具轮 + 1 次收尾轮');
  } finally { probe.dispose(); }
});

test('收尾格之前必须注入「不许再调工具、立即 output <final>」的硬指令', async () => {
  const probe = probeTool('__probe_echo');
  try {
    const chat = scriptedChat([
      call('__probe_echo', '{"n":1}'),
      '<final>结论</final>',
    ]);
    await runReActAgent({
      agent: agentOf(1, ['__probe_echo']),
      userMessages: [{ role: 'user', content: 'q' }],
      ctx: ctxOf(chat),
      onTrace: () => {},
    });
    // maxSteps=1 → 第 0 轮调工具，第 1 轮即收尾格
    const lastReq = flat(chat.seen[chat.seen.length - 1]);
    assert.match(lastReq, /不允许再调用工具/, '收尾格必须先声明「不许再调工具」，否则模型会继续调、白费这格预算');
    assert.match(lastReq, /<final>/, '要明确指示输出 <final>');
  } finally { probe.dispose(); }
});

test('收尾格仍在调工具：不执行该调用，直接落抢救出口（不空转、不丢数据）', async () => {
  const probe = probeTool('__probe_echo');
  try {
    const chat = scriptedChat([call('__probe_echo', '{"n":1}')]); // 永远调工具
    const traces = [];
    const out = await runReActAgent({
      agent: agentOf(1, ['__probe_echo']),
      userMessages: [{ role: 'user', content: 'q' }],
      ctx: ctxOf(chat),
      onTrace: (n) => traces.push(n),
    });
    assert.equal(probe.calls, 1, '收尾格的工具调用不得被执行（执行了也没下一步来总结）');
    assert.match(out, /__probe_echo/, '被跳过的调用不影响已抓数据的抢救');
    assert.ok(traces.some((n) => /工具调用预算已用尽/.test(n.text || '')), '要留一条可诊断的轨迹');
  } finally { probe.dispose(); }
});

// ---------- C. 预算提示：剩余机会告急时主动促收敛 ----------

test('剩余工具机会 ≤2 时给出预算提示（附「还可调用 N 次」），收尾格不再提示', async () => {
  const probe = probeTool('__probe_echo');
  try {
    const chat = scriptedChat([call('__probe_echo')]);
    await runReActAgent({
      agent: agentOf(4, ['__probe_echo']),
      userMessages: [{ role: 'user', content: 'q' }],
      ctx: ctxOf(chat),
      onTrace: () => {},
    });
    // maxSteps=4 → 工具轮 0..3（toolStepsLeft = 3,2,1,0），收尾格是第 5 次请求
    const hints = chat.seen.map((msgs) => {
      const found = flat(msgs).match(/还可调用工具 \d+ 次/g);
      return found ? found[found.length - 1] : null;
    });
    assert.ok(hints.slice(0, 2).every((h) => h === null), '前两轮不该打扰模型（此时还剩 3/2 次机会）');
    assert.ok(hints.slice(2).some((h) => /还可调用工具 2 次/.test(h)), '剩 2 次时应开始提示');
    assert.ok(hints.slice(2).some((h) => /还可调用工具 1 次/.test(h)), '剩 1 次时也要提示');
    assert.ok(!hints.some((h) => h && /还可调用工具 0 次/.test(h)), '不出现「还可调用 0 次」这种无意义提示');  } finally { probe.dispose(); }
});

// ---------- D. 反向闸门：不得回退成硬编码占位文案 ----------

test('反向闸门：base.js 不得再硬编码「已达到最大推理步数，Agent 提前结束」', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/agent/agents/base.js', import.meta.url)), 'utf8');
  assert.ok(
    !/已?达到最大推理步数/.test(src.replace(/^\s*\/\/.*$/gm, '')),
    '步数耗尽的文案必须走 i18n 字典，且必须是 buildLocalAnswer 之后的兜底（不能一上来就丢数据）',
  );
  assert.match(src, /reasonStepLimit/, '步数耗尽出口必须先尝试 buildLocalAnswer 抢救已抓数据');
});

test('反向闸门：四条失败出口必须全部经过 buildLocalAnswer（本轮 bug 的本质）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/agent/agents/base.js', import.meta.url)), 'utf8');
  const hits = src.match(/buildLocalAnswer\(/g) || [];
  assert.ok(hits.length >= 4, `四条失败出口应统一走本地直出（实际只找到 ${hits.length} 处调用）`);
});
