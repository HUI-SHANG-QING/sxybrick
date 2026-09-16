// tests/round92-qna-full-card.test.mjs —— round92 复验
//
// 用户诉求：「AI 学习助手（普通问答）看不到全库卡片正文」「AI 文档/备忘/知识图谱只看计数看不到节点」。
// round92 给普通问答加了两条独立上下文构建函数（只在 AIAssistant.vue 注入，不动 Agent 编排路径）：
//   · buildQuestionCardContext(query)：按问题主动搜卡，取**完整正/背面**（含图片引用）注入 system 消息，
//     与 Agent 的 get_card_detail 对齐——不再是 RAG 80/120 字碎片。
//   · buildModuleNodesContext()：列出备忘全文 / AI 文档标题 / 知识图谱边端点，把「计数」升级为「节点可见」。
// 本文件复验：普通问答真的能拿到完整卡片正文 + 图，且能看见分表模块的具体节点。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { putImage } from '../src/images.js';
import { buildFullContext, buildQuestionCardContext, buildModuleNodesContext } from '../src/agent/context.js';
import { enrichForLlm } from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const VISION = { imageAnalysis: { mode: 'visionFirst', visionLimit: 4, imageQuality: 'high' } };
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });
const IMG_ID = '550e8400-e29b-41d4-a716-446655440000';
const IMG_REF = `![image](sxy-img://${IMG_ID})`;

// 正面 > 80 字：用来证明「注入的是全文而非 RAG 80 字碎片」（RAG 会把算法正文截掉、还可能切坏图引用）
const LONG_FRONT = `二叉树先序遍历与中序遍历重构完整算法说明：给定先序序列 pre 与中序序列 in，先序首元素即为根节点，`
  + `在中序中找到根的位置即可划分出左右子树区间，再对左右子树递归构建。${IMG_REF}`;
const BACK = `先序确定根，中序划分左右子树，递归构建即可还原整棵树。${IMG_REF}`;

async function seedLongCardWithImage() {
  await db.cards.clear();
  await db.images.clear();
  await db.reviews.clear();
  await db.cards.put({
    id: 'card-bt',
    front: LONG_FRONT,
    back: BACK,
    subject: '数据结构', tags: ['树', 'OTHER'], source: 'OTHER',
    createdAt: Date.now(), updatedAt: Date.now(), level: 2, ease: 2.5,
  });
  await putImage(IMG_ID, pngBlob(), 'image/png');
}

test('普通问答：buildQuestionCardContext 按问题搜卡，注入的是完整正文（突破 RAG 80 字截断）', async () => {
  await seedLongCardWithImage();
  const ctx = await buildQuestionCardContext('二叉树先序遍历');
  assert.ok(ctx, '应返回非空上下文');
  // 完整正文（>80 字）必须出现——RAG 片段只会给前 80 字，这里证明是全文
  assert.ok(ctx.includes('在中序中找到根的位置即可划分出左右子树区间'), '必须包含 80 字之后的完整算法正文');
  assert.ok(ctx.includes('递归构建'), '必须包含正文尾部（递归构建）');
  assert.ok(ctx.includes('数据结构'), '应带科目');
  // 图片引用必须完整（36 位 uuid），否则 enrichForLlm 会假报缺失
  assert.ok(ctx.includes(IMG_REF), '完整图片引用必须随全文注入');
  assert.match(ctx, /sxy-img:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
    '图片引用必须是完整 uuid（被切坏会触发假缺失）');
});

test('普通问答：带图卡命中后 enrichForLlm 必须把图送出去（vision=1，不假报缺失）', async () => {
  await seedLongCardWithImage();
  // 普通问答真实链路：system = buildFullContext(统计+碎片) + buildQuestionCardContext(全文)
  const [base, full] = await Promise.all([buildFullContext('二叉树先序遍历'), buildQuestionCardContext('二叉树先序遍历')]);
  const messages = [
    { role: 'system', content: base + '\n\n' + full },
    { role: 'user', content: '帮我讲讲这张「二叉树重构」错题卡里的图讲了什么？' },
  ];
  const { messages: out, vision } = await enrichForLlm(messages, { settings: VISION });
  assert.equal(vision, 1, `普通问答应送出 1 张图，实际 ${vision}`);
  const text = out.map((m) => JSON.stringify(m.content)).join('\n');
  assert.ok(!/本机图库里没有这张图|本机没有这张图/.test(text), '不得对库里存在的图假报缺失');
  assert.match(text, /已作为附图发送/, '图必须正常送出');
});

test('普通问答：buildModuleNodesContext 列出备忘/文档/图谱边（节点可见，而非只计数）', async () => {
  await Promise.all([db.memos.clear(), db.docs.clear(), db.graphEdges.clear()]);
  await db.memos.put({ id: 'm1', text: '明天复习计算机网络', important: true, urgent: false, at: Date.now() });
  await db.memos.put({ id: 'm2', text: '周末做计网错题', important: false, urgent: true, at: Date.now() });
  await db.docs.put({ id: 'doc1', title: '操作系统进程线程笔记', content: '进程是资源分配基本单位，线程是调度基本单位。', type: 'note', tags: ['OS'], createdAt: Date.now(), updatedAt: Date.now() });
  await db.graphEdges.put({ id: 'e1', from: '二叉树', to: '树', label: '属于', fromCardId: 'card-bt', toCardId: 'card-tree', subject: '数据结构' });
  await db.graphEdges.put({ id: 'e2', from: '先序遍历', to: '中序遍历', label: '配合', fromCardId: 'card-bt', toCardId: 'card-in', subject: '数据结构' });

  const ctx = await buildModuleNodesContext();
  assert.ok(ctx, '应返回非空节点目录');
  // 备忘：全文可见（不再只报「备忘 N 条」）
  assert.ok(ctx.includes('明天复习计算机网络'), '备忘全文必须可见');
  assert.ok(ctx.includes('周末做计网错题'), '第二条备忘全文必须可见');
  // AI 文档：标题可见
  assert.ok(ctx.includes('操作系统进程线程笔记'), 'AI 文档标题必须可见');
  // 知识图谱：边端点可见（from（起点）→to（终点），关联关系为：label）
  assert.ok(ctx.includes('二叉树（起点）→树（终点），关联关系为：属于'), '图谱边端点必须可见');
  assert.ok(ctx.includes('先序遍历（起点）→中序遍历（终点），关联关系为：配合'), '第二条图谱边端点必须可见');
});

test('普通问答：题干太短（<2 字）时两个新函数安全返回空，不报错', async () => {
  await Promise.all([db.memos.clear(), db.docs.clear(), db.graphEdges.clear(), db.cards.clear()]);
  assert.equal(await buildQuestionCardContext('a'), '', '短 query 应返回空');
  assert.equal(await buildModuleNodesContext(), '', '无模块数据时返回空');
});
