// tests/ai-assistant-image-visibility.test.mjs —— round91 复验
//
// 用户纠正：「AI 学习助手（普通问答）是真的不看到图片，请修复。」
// 普通问答链路 = AIAssistant.vue → chatAI(src/ai.js) → llmChat(agent/llm.js:169) → enrichForLlm。
// 它不像 Agent 那样能调 get_card_detail 取完整卡片正文，而是靠 buildFullContext 把
// 学习数据概览 + RAG 检索片段注入 system 消息，再交给 enrichForLlm 解析图片引用。
//
// 本文件复验：用户问「一张带图卡」时，普通问答能否真的把图送出去（vision>0），
// 而不是报「本机图库里没有这张图」。覆盖 buildStudyContext 的薄弱卡 + buildRAGContext 的检索片段。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { putImage } from '../src/images.js';
import { buildFullContext } from '../src/agent/context.js';
import { enrichForLlm } from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const VISION = { imageAnalysis: { mode: 'visionFirst', visionLimit: 4, imageQuality: 'high' } };
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });
const IMG_ID = '550e8400-e29b-41d4-a716-446655440000';
const IMG_REF = `![image](sxy-img://${IMG_ID})`;

async function seedCardWithImage() {
  await db.cards.clear();
  await db.images.clear();
  await db.reviews.clear();
  // 这张卡正文前面带图（贴近真实：文字在前、图在后）
  await db.cards.put({
    id: 'card-net',
    front: `停止-等待协议超时重传机制分析${IMG_REF}`,
    back: `超时重传要设定时器${IMG_REF}`,
    subject: '计算机网络', tags: ['错题', 'OTHER'], source: 'OTHER',
    createdAt: Date.now(), updatedAt: Date.now(), level: 2, ease: 2.5,
  });
  // 让它是「薄弱卡」：种 2 条 rating=0 复习记录（weakCards 按 rating=0 次数排名）
  await db.reviews.put({ id: 'rv-1', cardId: 'card-net', reviewedAt: Date.now() - 86400000, rating: 0, type: 'grade' });
  await db.reviews.put({ id: 'rv-2', cardId: 'card-net', reviewedAt: Date.now() - 43200000, rating: 0, type: 'grade' });
  // 图确实在库里（完整 id 行存在）
  await putImage(IMG_ID, pngBlob(), 'image/png');
}

test('普通问答：buildFullContext 检索到带图卡后，enrichForLlm 必须把图送出去（不再假报缺失）', async () => {
  await seedCardWithImage();
  // 普通问答入口：buildFullContext(query) 注入 system 消息
  const ctx = await buildFullContext('停止等待协议超时重传');
  assert.ok(/计算机网络/.test(ctx), '上下文应含该卡科目');
  // 模拟普通问答真实发送：system 承载学习数据上下文，user 承载用户问题
  const messages = [
    { role: 'system', content: ctx },
    { role: 'user', content: '帮我看看这张「停止-等待协议」错题卡里的图讲了什么？' },
  ];
  const { messages: out, vision } = await enrichForLlm(messages, { settings: VISION });
  // 关键断言：图明明在库里（IMG_ID 行存在），普通问答链路必须能把图送出去
  assert.equal(vision, 1, `普通问答应送出 1 张图，实际 ${vision}（若 0 说明引用没进上下文或被切坏）`);
  const text = out.map((m) => JSON.stringify(m.content)).join('\n');
  assert.ok(!/本机图库里没有这张图|本机没有这张图/.test(text), '不得对库里存在的图假报缺失');
  assert.match(text, /已作为附图发送/, '图必须正常送出');
});

test('普通问答：上下文里的 sxy-img 引用必须是完整 uuid（不得是半截，否则 enrichForLlm 假报缺失）', async () => {
  await seedCardWithImage();
  const ctx = await buildFullContext('随便聊聊');
  // RAG 片段里允许存在**完整**引用（enrichForLlm 要据此解析送图）；
  // 但绝不允许**残缺**引用 —— 残缺 = 摘要/上下文切坏了 id，会触发「本机没有这张图」假告警。
  const FULL = /sxy-img:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const ANY = /sxy-img:\/\/[0-9a-fA-F-]+/g;
  const fulls = ctx.match(FULL) || [];
  const anys = ctx.match(ANY) || [];
  // 任一引用若不是完整 36 位 uuid 形态，就是被切坏的半截
  assert.equal(anys.length, fulls.length,
    `上下文里出现 ${anys.length} 个 sxy-img 引用，但只有 ${fulls.length} 个是完整 uuid —— 有半截引用会触发假缺失`);
});
