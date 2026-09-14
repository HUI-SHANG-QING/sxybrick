// 测试：P2-27 AI 用量账本——token 估算 / 费用估算 / 记录与聚合 / 排除清单
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';
import { EXCLUDED_FROM_SYNC, SYNC_TABLES } from '../src/sync-manifest.js';
import { estimateTokens, estimateCost, recordUsage, aggregateUsage, clearUsage } from '../src/utils/ai-usage.js';

after(async () => { try { await db.close(); } catch {} });

test('token 估算：中文按字、英文按词，空串为 0', () => {
  assert.equal(estimateTokens(''), 0);
  const zh = estimateTokens('间隔重复算法');
  assert.ok(zh >= 6, `中文 6 字估算应 ≥6，实际 ${zh}`);
  const en = estimateTokens('spaced repetition algorithm works well');
  assert.ok(en >= 5, `英文 5 词估算应 ≥5，实际 ${en}`);
  assert.ok(estimateTokens('混合 mixed 文本 test') > Math.max(zh, en) / 2);
});

test('round43 N4: 多模态数组 content 按部件展平，不再被 String() 压成 0', () => {
  // 修复前：[{type:'text',text:'你好'},{type:'image_url',...}] 被 String() 强转成
  // '[object Object]' → 估算几乎为 0，用量账本 token/费用失真。
  const textOnly = estimateTokens('你好世界');
  const multimodal = estimateTokens([
    { type: 'text', text: '你好世界' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
  ]);
  assert.ok(multimodal > textOnly, `数组 content 估算（${multimodal}）必须大于纯文本部件（${textOnly}）：图片部件计入`);
  assert.ok(multimodal >= textOnly + 1000, 'image_url 部件按 ≥1000 token 计入');
  // 纯字符串数组（罕见但合法）也不失真
  assert.equal(estimateTokens(['你好世界', '更多']), estimateTokens('你好世界') + estimateTokens('更多'));
  // 非法部件（null/未知 type）不崩、不计
  assert.equal(estimateTokens([null, { type: 'unknown' }, { type: 'text', text: '你好世界' }]), textOnly);
});

test('费用估算：费率表命中 + 未知模型回退默认费率', () => {
  // deepseek-chat 输入 1 元/M token
  assert.equal(estimateCost(1000000, 0, 'deepseek-chat'), 1);
  // 输出按 2 元/M
  assert.ok(Math.abs(estimateCost(0, 1000000, 'deepseek-v4-flash') - 2) < 1e-9);
  // 子串命中：deepseek-chat-v2 → 仍按 deepseek-chat 费率
  assert.equal(estimateCost(1000000, 0, 'deepseek-chat-v2'), 1);
  // 未知模型回退默认 [1,2]
  assert.equal(estimateCost(1000000, 1000000, 'mystery-model'), 3);
  assert.ok(estimateCost(100, 100, 'deepseek-chat') > 0);
});

test('记录 + 聚合：token 求和、按来源/模型分组、时间窗口', async () => {
  await clearUsage();
  const now = Date.now();
  await recordUsage({ source: 'chat', model: 'deepseek-chat', promptTokens: 100, completionTokens: 50, durationMs: 1200, ok: true, est: 1 });
  await recordUsage({ source: 'chat', model: 'deepseek-chat', promptTokens: 200, completionTokens: 100, durationMs: 2000, ok: true, est: 0 });
  await recordUsage({ source: 'agent:tutor', model: 'deepseek-reasoner', promptTokens: 50, completionTokens: 25, durationMs: 900, ok: false, est: 1 });
  // 窗口外记录（31 天前）不应计入
  await recordUsage({ t: now - 31 * 86400000, source: 'chat', model: 'deepseek-chat', promptTokens: 9999, completionTokens: 9999, durationMs: 1, ok: true, est: 0 });

  const agg = await aggregateUsage(30);
  assert.equal(agg.calls, 3);
  assert.equal(agg.promptTokens, 350);
  assert.equal(agg.completionTokens, 175);
  assert.equal(agg.totalTokens, 525);
  assert.equal(agg.durationMs, 4100);
  assert.equal(agg.bySource.length, 2);
  assert.equal(agg.bySource[0].source, 'chat'); // 按 token 降序
  assert.equal(agg.bySource[0].calls, 2);
  assert.equal(agg.byModel.find(m => m.model === 'deepseek-reasoner').calls, 1);
  assert.ok(agg.costCny > 0);

  await clearUsage();
  const empty = await aggregateUsage(30);
  assert.equal(empty.calls, 0);
});

test('aiUsage 已入同步表（round38）：用量账本跨设备统一', () => {
  assert.ok(SYNC_TABLES.some(t => t.table === 'aiUsage'), 'aiUsage 应登记在 SYNC_TABLES');
  assert.ok(!EXCLUDED_FROM_SYNC.includes('aiUsage'), 'aiUsage 不应再在排除清单');
});
