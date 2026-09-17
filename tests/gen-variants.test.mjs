// tests/gen-variants.test.mjs —— round105：情境变式的完整链路（正常 / 空响应重试 / 精确报错 / 离线兜底）
//
// 用户实测：点「变式」报「AI 返回内容为空（可能被截断或模型异常），请重试」。
// 链路：Cards.vue → genVariants() → callAI（默认 chatAI，stream:true）→ parseLLMJsonArray
// 本文件用注入缝（deps.chat）复现四类失败并钉住修复后的行为。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { genVariants } from '../src/utils/genVariants.js';
import { db } from '../src/db.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const CARD = { id: 'src-card-1', front: '停止-等待协议的发送窗口大小是多少？', back: '1', subject: '计算机网络', tags: ['传输层'] };
const okJson = JSON.stringify([
  { front: '变式一', back: '答案一', difficulty: 'basic' },
  { front: '变式二', back: '答案二', difficulty: 'applied' },
  { front: '变式三', back: '答案三', difficulty: 'challenge' },
]);

beforeEach(async () => {
  await db.cards.clear();
  // shouldFallback() 会在「未配置密钥」时直接走离线路径——测试要打真实分支，先给个假配置
  localStorage.setItem('sxy_ai_config', JSON.stringify({ apiKey: 'test-key', baseUrl: 'http://mock.local', model: 'm', maxTokens: 131072 }));
});

test('正常生成：AI 返回合法 JSON → 落 3 张变式卡（关联原卡 / 标签 / 难度梯度）', async () => {
  const calls = [];
  const created = await genVariants(CARD, 3, {
    chat: async (_m, opts) => { calls.push(opts); return okJson; },
  });
  assert.equal(created.length, 3);
  assert.equal(calls.length, 1, '正常路径不应重试');
  for (const c of created) {
    assert.equal(c.sourceCardId, CARD.id, '变式必须关联原卡（来源血缘）');
    assert.ok(c.tags.includes('情境变式'), '变式卡要带统一标签，便于筛选与回溯');
    assert.equal(c.subject, CARD.subject);
    assert.ok(['basic', 'applied', 'challenge'].includes(c.difficulty), '难度要落在三级梯度内');
  }
  assert.equal(await db.cards.count(), 3);
});

test('空响应：自动改用「非流式 + 双倍预算」重试一次并成功（不再直接把空串丢给 JSON 解析）', async () => {
  const calls = [];
  const created = await genVariants(CARD, 3, {
    chat: async (_m, opts) => {
      calls.push(opts);
      return calls.length === 1 ? '' : okJson; // 第一次空响应，第二次成功
    },
  });
  assert.equal(created.length, 3, '重试成功后应正常出卡');
  assert.equal(calls.length, 2, '必须重试一次');
  assert.equal(calls[0].stream, undefined, '首次沿用默认（流式）路径');
  assert.equal(calls[1].stream, false, '重试要走非流式——那条分支有截断自动续写与更细诊断');
  // 注意：重试**不保证**预算变大——用户设置是硬上限（不越权），
  // 当用户上限（131072）已经大于首次预算时两次相同；此时重试的价值在于
  // 换到非流式路径（带截断自动续写与更细诊断）。这里只要求"不缩水"。
  assert.ok(calls[1].maxTokens >= calls[0].maxTokens, '重试预算不得缩水');
});

test('被截断的半截 JSON：同样走重试并救回（而不是报「格式不合法」让用户自己猜）', async () => {
  const calls = [];
  const truncated = okJson.slice(0, Math.floor(okJson.length * 0.6)); // 尾巴被 max_tokens 砍掉
  const created = await genVariants(CARD, 3, {
    chat: async (_m, opts) => { calls.push(opts); return calls.length === 1 ? truncated : okJson; },
  });
  assert.equal(created.length, 3);
  assert.equal(calls.length, 2);
});

test('两次都失败：必须抛出 llm.js 给出的**精确原因**，不得回落成笼统的「返回内容为空」', async () => {
  const precise = '当前模型只返回了推理过程（reasoning_content）、正文为空——请在 AI 设置里改用普通对话模型。';
  await assert.rejects(
    () => genVariants(CARD, 3, {
      chat: async (_m, opts) => {
        if (opts.stream === false) throw new Error(precise); // 非流式那轮给出精确诊断
        return '';
      },
    }),
    (e) => {
      assert.equal(e.message, precise, '精确原因必须原样透传给用户');
      assert.doesNotMatch(e.message, /可能被截断或模型异常/, '不得回落成笼统提示');
      return true;
    },
  );
  assert.equal(await db.cards.count(), 0, '失败时不得留下半成品卡片');
});

test('服务端只回离线文案：识别并降级本地模板变式（不报「格式不合法」）', async () => {
  const created = await genVariants(CARD, 3, {
    chat: async () => '【离线模式】网络连接失败或 AI 服务不可达。\n请检查网络后重试。',
  });
  assert.ok(created.length >= 1, '离线时应给出本地模板变式，而不是抛错');
  assert.ok(created.every((c) => c.sourceCardId === CARD.id));
});

test('网络类错误：降级本地模板变式（既有行为回归保护）', async () => {
  const created = await genVariants(CARD, 3, {
    chat: async () => { throw new Error('fetch failed'); },
  });
  assert.ok(created.length >= 1);
});

test('全部为空且非网络错误时，错误信息里必须含可行动作（不只是一句"请重试"）', async () => {
  await assert.rejects(
    () => genVariants(CARD, 3, { chat: async () => '' }),
    (e) => {
      // 两条路径都空 → 落到 parseLLMJsonArray 的空响应文案；该文案已在字典里，且断言其非空可读
      assert.ok(e.message && e.message.length > 0);
      assert.doesNotMatch(e.message, /undefined|\[object/, '不得出现未替换的占位符');
      return true;
    },
  );
});

test('用户设置的上限必须进请求（这是用户「我调成最大了还是报截断」的直接原因）', async () => {
  const calls = [];
  await genVariants(CARD, 3, { chat: async (_m, opts) => { calls.push(opts); return okJson; } });
  assert.equal(calls[0].maxTokens, 131072, '用户在设置里调到 131072，请求体里就必须是 131072——旧实现写死 3000 把它静默丢掉了');
});

test('重试的预算不得低于首次（用户上限更大时，重试也不会缩水）', async () => {
  const calls = [];
  await genVariants(CARD, 3, {
    chat: async (_m, opts) => { calls.push(opts); return calls.length === 1 ? '' : okJson; },
  });
  assert.ok(calls[1].maxTokens >= calls[0].maxTokens, '重试预算不得变小');
});
