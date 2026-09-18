// tests/ai-chat-args.test.mjs —— round109：chatAI 入参契约（防"传字符串"这类误用）
//
// 背景：PrivacyData.vue 曾把字符串直接当 messages 传 → chatAI 内部 messages.reduce 抛
// `messages.reduce is not a function`，「AI 增强报告」按钮必然失败，用户只看到不可读报错。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { chatAI } from '../src/ai.js';

test('传字符串：按单条 user 消息归一（不再崩在 messages.reduce）', async () => {
  // 无密钥 → 走离线兜底分支，返回可读文本（而不是抛 TypeError）
  localStorage.removeItem('sxy_ai_config');
  const r = await chatAI('帮我看看这段内容');
  assert.equal(typeof r, 'string');
  assert.ok(r.length > 0, '应返回离线提示文本');
});

test('传非数组非字符串：抛**可读**错误并说明类型', async () => {
  await assert.rejects(
    () => chatAI({ role: 'user', content: 'x' }),
    (e) => {
      assert.match(e.message, /messages 必须是数组|must be an array/, '错误信息要指出怎么改');
      assert.match(e.message, /object/, '要带上实际收到的类型，便于定位');
      assert.doesNotMatch(e.message, /reduce is not a function/, '不得再出现底层 TypeError 文案');
      return true;
    },
  );
  await assert.rejects(() => chatAI(42), /number/);
  await assert.rejects(() => chatAI(undefined), /undefined/);
});
