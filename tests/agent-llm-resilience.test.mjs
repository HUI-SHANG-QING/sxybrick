// tests/agent-llm-resilience.test.mjs —— round71
//
// 背景（用户实测原话）：「为什么有些是 agent 回复能成功，有些时候又不能，我明明已经设置成了
// 最大输出长度（Token）65536」。
//
// 根因不是随机的，而是可算的 —— 三条：
//  ① **全链路非流式 + 硬编码 60s 总超时**（src 里没有任何调用传 stream:true / onToken）。
//     非流式下 60s 的含义是「**整段回答必须在 60s 内写完**」，于是短问答能过、长回答必挂；
//  ② max_tokens=65536（≈4.7 万汉字）与 60s 互相矛盾 —— 模型 60s 最多写 ~1500~2000 汉字。
//     用户把输出上限调得越大，模型越想写长 → 越容易撞超时（把「截断」换成了「超时」）；
//  ③ 超时被归类成「网络或服务异常」（isNetworkError 对 aborted 返回 false），
//     且**已生成的内容被整段丢弃** → 上层只能顶一句「AI 合成回答暂不可用」。
//
// 本文件钉住修复后的行为契约：流式空闲超时 / 超时抢救已生成内容 / 真实失败原因 /
// 工具结果「多留条目且仍是合法 JSON」/ 卡片摘要必须带背面。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chat } from '../src/agent/llm.js';
import { compactToolPayload } from '../src/agent/tools/compact.js';
import { buildLocalAnswer } from '../src/agent/local-answer.js';
import { parseFinal } from '../src/agent/agents/base.js';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { createCard } from '../src/repo.js';
import { db } from '../src/db.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const CFG = { baseUrl: 'http://mock.local', apiKey: 'k', model: 'm' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const sseLine = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

/**
 * 造一个 SSE 假响应：按 script 逐步吐 delta。
 * script 元素：
 *   · 普通字符串 → 吐一段正文
 *   · 'HANG'      → 挂住，直到请求 signal 被中止（模拟真实 fetch 被 abort：read() 抛 AbortError）
 */
function sseOf(script, gapMs = 0) {
  let i = 0;
  let signal = null;
  return {
    ok: true,
    status: 200,
    _setSignal(s) { signal = s; },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= script.length) return { done: true, value: undefined };
            const piece = script[i];
            i += 1;
            if (piece === 'HANG') {
              await new Promise((resolve) => {
                if (signal?.aborted) return resolve();
                signal?.addEventListener('abort', resolve, { once: true });
                return undefined;
              });
              const e = new Error('The operation was aborted.');
              e.name = 'AbortError';
              throw e;
            }
            if (gapMs) await sleep(gapMs);
            return { done: false, value: enc.encode(sseLine(piece)) };
          },
          async cancel() { /* noop */ },
        };
      },
    },
    json: async () => ({}),
    text: async () => '',
  };
}

function mockFetch(factory) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = factory(url, init);
    res._setSignal?.(init.signal);
    // 真实 fetch 在 signal 中止时会让在途请求以 AbortError 拒绝；这里同步模拟
    return await Promise.race([
      Promise.resolve(res),
      new Promise((_r, rej) => {
        if (!init.signal) return;
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          rej(e);
        }, { once: true });
      }),
    ]);
  };
  return () => { globalThis.fetch = orig; };
}

// ---------------- A. 流式：超时是「空闲超时」，不是「总时长」 ----------------

test('流式：只要持续有增量，总耗时超过 timeoutMs 也不算超时（长回答不再被误杀）', async () => {
  // 5 片 × 40ms = 200ms 总时长 > 120ms 超时，但每次间隔 40ms < 120ms → 必须成功
  const restore = mockFetch(() => sseOf(['A', 'B', 'C', 'D', 'E'], 40));
  try {
    const out = await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true, timeoutMs: 120 });
    assert.equal(out, 'ABCDE', '持续输出不应被判超时');
  } finally { restore(); }
});

test('流式：真卡死（无新数据超过 timeoutMs）仍有超时保护', async () => {
  const restore = mockFetch(() => sseOf(['HANG']));
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { stream: true, timeoutMs: 120 }),
      (e) => { assert.equal(e.code, 'TIMEOUT'); return true; },
      '完全不吐数据时必须超时退出，不能永久挂起',
    );
  } finally { restore(); }
});

// ---------------- B. 超时抢救：已生成的内容不再整段丢弃 ----------------

test('流式：中途超时时交出已生成内容 + 明确标注（不再白等一分钟一个字都拿不到）', async () => {
  const restore = mockFetch(() => sseOf(['前半段正文', 'HANG']));
  try {
    const out = await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true, timeoutMs: 120 });
    assert.match(out, /前半段正文/, '已生成内容必须交出来');
    assert.match(out, /超时/, '要如实标注这是被超时中断的部分');
  } finally { restore(); }
});

test('非流式：超时仍然抛 TIMEOUT（不改变既有语义，回归保护）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_u, init) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        rej(e);
      }, { once: true });
    }),
    text: async () => '',
  });
  try {
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }], CFG, { timeoutMs: 100 }),
      (e) => { assert.equal(e.code, 'TIMEOUT'); return true; },
    );
  } finally { globalThis.fetch = orig; }
});

test('流式：服务端忽略 stream 参数、直接回整段 JSON 时也能取到正文', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: enc.encode(JSON.stringify({ choices: [{ message: { content: '整段正文' }, finish_reason: 'stop' }] })) };
          },
          async cancel() { /* noop */ },
        };
      },
    },
    json: async () => ({}),
    text: async () => '',
  });
  try {
    const out = await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true, timeoutMs: 2000 });
    assert.equal(out, '整段正文', '非 SSE 响应必须兜底解析，不能返回空串让上层报「AI 返回了空内容」');
  } finally { globalThis.fetch = orig; }
});

// ---------------- B2. 端点不支持流式时自动退回非流式 ----------------

test('流式请求被端点拒绝（错误文本含 stream）时自动退回非流式重试，不打死请求', async () => {
  const bodies = [];
  const okRes = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });
  const orig = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (bodies.length === 1) {
      return { ok: false, status: 400, text: async () => '{"error":{"message":"stream is not supported by this endpoint"}}', json: async () => ({}) };
    }
    return okRes({ choices: [{ message: { content: '非流式兜底OK' }, finish_reason: 'stop' }], usage: {} });
  };
  try {
    assert.equal(await chat([{ role: 'user', content: 'hi' }], CFG, { stream: true }), '非流式兜底OK');
    assert.equal(bodies.length, 2, '应重试一次');
    assert.equal(bodies[0].stream, true);
    assert.equal(bodies[1].stream, false, '重试必须关掉 stream（否则换个自建端点就全挂）');
  } finally { globalThis.fetch = orig; }
});

test('接线的源码形态闸门：Agent / 流水线 / 分析链路与 chatAI 都必须默认开启流式', () => {
  const must = [
    ['../src/agent/orchestrator.js', /stream:\s*true/],
    ['../src/agent/pipeline.js', /stream:\s*true/],
    ['../src/analysis/ai-analyzer.js', /stream:\s*true/],
    ['../src/ai.js', /stream:\s*true/],
  ];
  for (const [rel, re] of must) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.match(src, re, rel + ' 未开启流式：非流式下 60s 是「整段回答必须 60s 内写完」，长回答必挂');
  }
});

// ---------------- C. 降级文案必须给出真实原因 ----------------

test('本地直出：带 reason 时文案写真实原因，不再一律「网络或服务异常」', async () => {
  const { t } = await import('../src/i18n/index.js');
  const obs = [{ name: 'search_cards', ok: true, data: { total: 1, items: [{ front: '# 卡A', back: '答案' }] } }];
  const withReason = buildLocalAnswer({ observations: obs, reason: t('agent.localAnswer.reasonAuth') });
  assert.match(withReason, /API 密钥无效或无权限/, '密钥类失败必须点明，否则用户只会反复重启网络');
  assert.ok(!/网络或服务异常/.test(withReason), '不该再出现笼统的「网络或服务异常」');
  const noReason = buildLocalAnswer({ observations: obs });
  assert.match(noReason, /AI 合成回答暂不可用/, '不传 reason 时保持旧文案（向后兼容）');
});

test('截断抢救回来的残句：<final> 未闭合时剥掉标签，不把标签当正文', () => {
  assert.equal(parseFinal('<final>正常收尾</final>'), '正常收尾');
  assert.equal(parseFinal('<final>被砍在中间的回答'), '被砍在中间的回答');
  assert.equal(parseFinal('没有标签的普通回答'), '没有标签的普通回答');
  assert.equal(parseFinal('<tool>search_cards</tool><args>{}</args>'), null, '工具调用不能被当成最终回答');
});

// ---------------- D. 工具结果：多留条目 + 仍是合法 JSON ----------------

test('compact：17 张卡的完整摘要（正+背面）不再被腰斩', () => {
  const data = {
    total: 17,
    items: Array.from({ length: 17 }, (_, i) => ({
      id: `id-${i}`, subject: '计算机网络',
      front: `第${i + 1}题正面：${'流'.repeat(80)}`,
      back: `第${i + 1}题背面：${'控'.repeat(80)}`,
    })),
  };
  const out = compactToolPayload(data);
  assert.equal(out, JSON.stringify(data), '17 张卡应在预算内原样进上下文（maxItems=20 / maxChars=6000）');
  assert.ok(!/还有 \d+ 项/.test(out), '不该出现省略提示');
});

test('compact：超预算时按条数递减，产出仍是合法 JSON（旧实现会切出半个 JSON）', () => {
  const data = {
    total: 40,
    items: Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, front: '正'.repeat(200), back: '背'.repeat(200),
    })),
  };
  const out = compactToolPayload(data, { maxChars: 2000 });
  const cut = out.indexOf('（原始结果约');
  assert.ok(cut > 0, '压缩后应带说明');
  const parsed = JSON.parse(out.slice(0, cut));
  assert.ok(Array.isArray(parsed.items), 'items 必须仍是数组');
  assert.match(parsed.items[parsed.items.length - 1], /还有 \d+ 项/, '最后一项应是"还有 N 项"的可读标记');
  assert.ok(parsed.items.length >= 2, `应尽量多留条目，实际 ${parsed.items.length}`);
  assert.equal(parsed.total, 40, '顶层字段（total）必须保留，否则模型会断言"只有这些"');
});

test('compact：默认保留条数已提到 20（此前 8 条会让模型以为库里只有 8 张卡）', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, title: `t${i}` }));
  const out = compactToolPayload({ items: rows });
  assert.equal(out, JSON.stringify({ items: rows }), '25 条小结果应在默认预算内完整保留');
});

// ---------------- E. 卡片摘要必须带背面（「AI 看不到卡背」的直接原因） ----------------

test('search_cards：返回背面摘要 + 翻页字段 + 明确引导 get_card_detail', async () => {
  await db.cards.clear();
  const N = 25;
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await createCard({ front: `正面问题${i}`, back: `背面答案${i}`, subject: '计算机网络', source: 'test' });
  }
  const tool = toolRegistry.get('search_cards');
  assert.match(tool.description, /get_card_detail/, '描述必须告诉模型「完整正文要另取」，否则它只会答「我看不到」');
  assert.match(tool.description, /背面/, '描述必须说明概要有背面');

  const p1 = await tool.execute({ q: '正面问题', limit: 20 });
  assert.equal(p1.data.total, N);
  assert.equal(p1.data.items.length, 20, '默认返回 20 条');
  assert.equal(p1.data.hasMore, true, '还有剩余时必须标记 hasMore，模型据此翻页');
  assert.ok(p1.data.items.every((x) => typeof x.back === 'string' && x.back.length > 0), '每项都要带背面摘要');

  const p2 = await tool.execute({ q: '正面问题', limit: 20, offset: 20 });
  assert.equal(p2.data.items.length, 5, '翻阅第二页应拿到剩下的 5 条');
  assert.equal(p2.data.hasMore, false);

  const all = [...p1.data.items, ...p2.data.items].map((x) => x.back).sort();
  assert.equal(new Set(all).size, N, '两页合起来应覆盖全部卡片，无遗漏无重复');
  await db.cards.clear();
});

test('get_weak_cards：同样补上 id 与背面摘要（否则模型无法引用答案侧内容）', async () => {
  await db.cards.clear();
  await createCard({ front: '弱卡正面', back: '弱卡背面', subject: '计算机网络', source: 'test' });
  // eslint-disable-next-line no-await-in-loop
  const { review } = await import('../src/repo.js');
  const [card] = (await db.cards.toArray());
  await review(card.id, 0);
  const tool = toolRegistry.get('get_weak_cards');
  const r = await tool.execute({ limit: 10, minFail: 1 });
  const row = r.data.find((x) => x.id === card.id) || r.data[0];
  assert.ok(row?.id, '必须返回 id（否则无法跟进 get_card_detail）');
  assert.equal(row.back, '弱卡背面');
  await db.cards.clear();
});
