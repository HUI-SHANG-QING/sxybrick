// tests/round95-agent-full-visibility.test.mjs —— round95 回归
//
// 用户诉求：「AI 要能看到所有信息，尤其是图片」。
// 数据分析师(analyst) Agent 手上此前**缺 get_card_detail**（只有 get_weak_cards 的 60 字摘要）
// → 用户问「卡片里写了什么 / 图里是什么」时它只能答「我看不到」；番茄钟逐次明细与历史对话内容
// 更是完全没有工具（工具不存在 = AI 永久看不到，同 round74/88 的缺陷类别）。
//
// 本文件锁定：
//   ① analyst 已挂 get_card_detail + 检索/番茄/对话工具；
//   ② 三个新工具（get_pomodoro_sessions / list_chats / read_chat）已注册；
//   ③ get_card_detail 返回完整正文（不截断）+ 完整图片引用；
//   ④ 该结果经 enrichForLlm 真的把卡片图送出去（vision=1）——即「AI 能看到图」的端到端证据。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard } from '../src/repo.js';
import { putImage } from '../src/images.js';
import { toolRegistry, agentRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { registerDefaultAgents } from '../src/agent/agents/index.js';
import { enrichForLlm } from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const IMG_ID = '550e8400-e29b-41d4-a716-446655440000';
const IMG_REF = `![image](sxy-img://${IMG_ID})`;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });
const VISION = { imageAnalysis: { mode: 'visionFirst', visionLimit: 4, imageQuality: 'high' } };

// 正面 > 80 字：证明 get_card_detail 返回的是全文而非列表摘要
const LONG_FRONT = '二叉树先序遍历与中序遍历重构完整算法说明：给定先序序列 pre 与中序序列 in，先序首元素即为根节点，'
  + '在中序中找到根的位置即可划分出左右子树区间，再对左右子树递归构建。' + IMG_REF;

test('数据分析师(analyst) 已挂「看全卡正文+图片」与「番茄/对话」工具', () => {
  registerDefaultAgents();
  const analyst = agentRegistry.get('analyst');
  assert.ok(analyst, 'analyst 必须存在');
  for (const t of ['get_card_detail', 'search_cards', 'semantic_search', 'get_pomodoro_sessions', 'list_chats', 'read_chat']) {
    assert.ok(analyst.tools.includes(t), `analyst 必须挂 ${t}（否则「看不到」会复现）`);
  }
});

test('三个新工具已注册（番茄明细 / 对话列表 / 对话内容）', () => {
  for (const n of ['get_pomodoro_sessions', 'list_chats', 'read_chat']) {
    const t = toolRegistry.get(n);
    assert.ok(t, `${n} 必须已注册`);
    assert.equal(typeof t.execute, 'function', `${n} 必须有 execute`);
  }
});

test('get_card_detail：返回完整正文（不截断）且含完整图片引用', async () => {
  await db.cards.clear(); await db.images.clear();
  const card = await createCard({ front: LONG_FRONT, back: '先序定根，中序分左右，递归构建。' + IMG_REF, subject: '数据结构', source: 'test' });
  const res = await toolRegistry.get('get_card_detail').execute({ id: card.id });
  assert.equal(res.ok, true);
  assert.ok(res.data.front.includes('递归构建'), '必须是完整正文（含 80 字之后内容）');
  assert.ok(res.data.front.length > 100, '不能被截断到 60 字摘要');
  assert.match(res.data.front, /sxy-img:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/, '图片引用必须完整 36 位 uuid');
});

test('get_card_detail 的结果经 enrichForLlm 必须真的把卡片图送出（vision=1）', async () => {
  await db.cards.clear(); await db.images.clear();
  const card = await createCard({ front: LONG_FRONT, back: 'b' + IMG_REF, subject: '数据结构', source: 'test' });
  await putImage(IMG_ID, pngBlob(), 'image/png');
  const res = await toolRegistry.get('get_card_detail').execute({ id: card.id });
  // 真实链路：工具结果进 ReAct 观察 → enrichForLlm 扫到 sxy-img 引用 → 作为附图发送
  const messages = [
    { role: 'system', content: '你是数据分析师' },
    { role: 'user', content: JSON.stringify(res) },
  ];
  const { vision } = await enrichForLlm(messages, { settings: VISION });
  assert.equal(vision, 1, `卡片图必须作为附图送出，实际 ${vision}`);
});

test('番茄明细 / 对话工具：能读到逐次明细与消息内容', async () => {
  await db.pomoSessions.clear(); await db.aiChats.clear();
  await db.pomoSessions.put({ id: 'p1', startedAt: Date.now() - 3600000, duration: 25, tag: '线代', partial: 0, createdAt: Date.now() });
  const r = await toolRegistry.get('get_pomodoro_sessions').execute({ limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.data.count, 1);
  assert.equal(r.data.items[0].minutes, 25);
  assert.ok(r.data.items[0].startedLocal, '必须给出本地可读时刻');

  await db.aiChats.put({ id: 'c1', title: '线代问答', type: 'feynman', updatedAt: Date.now(), messages: [{ role: 'user', content: '矩阵秩怎么算' }, { role: 'assistant', content: '用行阶梯形' }] });
  const lc = await toolRegistry.get('list_chats').execute({});
  assert.ok(lc.data.items.some((c) => c.id === 'c1' && c.msgCount === 2), 'list_chats 必须列出对话与消息数');
  assert.ok(lc.data.items.some((c) => c.id === 'c1' && c.type === 'feynman'), 'list_chats 必须暴露 type（区分 问答/Agent/费曼）');
  const rc = await toolRegistry.get('read_chat').execute({ id: 'c1' });
  assert.equal(rc.ok, true);
  assert.equal(rc.data.type, 'feynman', 'read_chat 必须回传 type');
  assert.ok(rc.data.messages.some((m) => m.content.includes('矩阵秩')), 'read_chat 必须返回消息内容');
});
