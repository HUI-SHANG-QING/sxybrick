// tests/max-tokens-resolve.test.mjs —— round105 补：用户设置的「最大输出长度」必须被尊重
//
// 用户实测（2026-09-17）：他在 AI 设置里把「最大输出长度」调到最大（131072），
// 点「变式」仍然报「预算花在推理上 / 被截断」。真因不是模型不行，而是：
//   变式/组卡/出题流程各自硬编码 maxTokens 3000~8000，
//   而 llm.js 取的是 `opts.maxTokens ?? cfg.maxTokens`（opts 优先）→ **用户设置被静默忽略**。
// 本文件钉住 resolveMaxTokens 的语义，并在 gen-variants 里端到端验证用户设置真的进了请求。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMaxTokens, DEFAULT_AI_MAX_TOKENS } from '../src/ai.js';

const setCfg = (maxTokens) => localStorage.setItem('sxy_ai_config', JSON.stringify({
  apiKey: 'k', baseUrl: 'http://mock.local', model: 'm', ...(maxTokens === undefined ? {} : { maxTokens }),
}));

test('用户设得大 → 用用户的（这正是「我调成最大了」的意图）', () => {
  setCfg(131072);
  assert.equal(resolveMaxTokens(3000), 131072, '变式这种流程不得把用户上限压回 3000');
  assert.equal(resolveMaxTokens(8000), 131072);
});

test('用户设得小 → 用流程下限（否则流程必然截断，等于换个方式失败）', () => {
  setCfg(500);
  assert.equal(resolveMaxTokens(3000), 3000);
});

test('配置缺失/非法 → 回落下限或默认值，不抛错', () => {
  localStorage.removeItem('sxy_ai_config');
  assert.equal(resolveMaxTokens(3000), Math.max(3000, DEFAULT_AI_MAX_TOKENS), '未配置时应不小于默认上限');
  setCfg('not-a-number');
  assert.equal(resolveMaxTokens(3000), Math.max(3000, DEFAULT_AI_MAX_TOKENS));
  setCfg(0);
  assert.equal(resolveMaxTokens(3000), 3000, '显式 0 不是合法上限 → 用下限');
  assert.equal(resolveMaxTokens(undefined), Math.max(DEFAULT_AI_MAX_TOKENS, DEFAULT_AI_MAX_TOKENS));
});
