// tests/doc-graph.test.mjs —— Phase 6.6 知识图谱联动测试
// 覆盖：doc-graph.js 纯函数（匹配/边构造/片段定位/血缘）
//       + linkDocToCards 黄金路径（资料解析→自动关联→图谱边→溯源→删除清理；fake-indexeddb）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';

// ---------- 纯函数 ----------
import {
  stripForMatch, cardInDoc, buildDocCardEdges, excerptAround, traceCardDocId, docNodeLabel,
} from '../src/utils/doc-graph.js';
// ---------- IO ----------
import {
  uploadFile, getDocText, deleteDocFile, linkDocToCards, traceCardSource,
} from '../src/docs-lib.js';
import { createCard } from '../src/repo.js';
import { listGraphEdges } from '../src/repo.js';

after(async () => { try { await db.close(); } catch {} });

async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
}

// ---------- 纯函数 ----------

test('stripForMatch：去空白/标点，保留中英数', () => {
  assert.equal(stripForMatch('Cache 的替换策略有 LRU、FIFO。'), 'Cache的替换策略有LRUFIFO');
  assert.equal(stripForMatch('  冯诺依曼机：运算器、控制器\n存储器  '), '冯诺依曼机运算器控制器存储器');
  assert.equal(stripForMatch(''), '');
  assert.equal(stripForMatch(null), '');
});

test('cardInDoc：卡片 front 核心是资料子串（真题/讲义场景）', () => {
  const doc = '第三章 存储系统。Cache 的替换策略有 LRU、FIFO、随机替换。冯诺依曼机由运算器、控制器、存储器、输入输出设备组成。';
  assert.equal(cardInDoc({ front: 'Cache 的替换策略有哪些？' }, doc), true);
  assert.equal(cardInDoc({ front: '冯诺依曼机由哪几部分组成？' }, doc), true);
  assert.equal(cardInDoc({ front: '完全无关的内容' }, doc), false);
  assert.equal(cardInDoc({ front: '短' }, doc), false); // <6 字不匹配
});

test('buildDocCardEdges：生成 doc-card 边，带 docId/type', () => {
  const doc = { id: 'd1', name: '计组真题.pdf', subject: '计组' };
  const edges = buildDocCardEdges(doc, [{ front: 'Cache 替换策略' }, { front: '冯诺依曼机组成' }]);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].from, '📄 计组真题.pdf');
  assert.equal(edges[0].to, 'Cache 替换策略');
  assert.equal(edges[0].label, '涵盖');
  assert.equal(edges[0].docId, 'd1');
  assert.equal(edges[0].type, 'doc-card');
});

test('excerptAround：定位关键词并截取上下文', () => {
  const text = '前文铺垫内容。Cache 的替换策略有 LRU、FIFO 等，考试常考。后文其他内容。';
  const ex = excerptAround(text, 'Cache 的替换策略', { radius: 10 });
  assert.match(ex, /Cache的替换策略/); // 去标点片段
  assert.equal(excerptAround(text, '不存在的词'), '');
});

test('docNodeLabel + traceCardDocId', () => {
  assert.equal(docNodeLabel({ name: '线代讲义.pdf' }), '📄 线代讲义.pdf');
  assert.equal(docNodeLabel({ title: '笔记' }), '📄 笔记');
  assert.equal(docNodeLabel({}), '📄 未命名资料');
  assert.equal(traceCardDocId({ source: 'doc-123' }), 'doc-123');
  assert.equal(traceCardDocId({ source: '' }), '');
  assert.equal(traceCardDocId({}), '');
});

// ---------- 黄金路径 ----------

test('资料解析→自动关联→图谱边→溯源→删除清理', async () => {
  // 1) 先建两张同科目卡片（内容出自即将上传的资料）
  await createCard({ front: 'Cache 的替换策略有哪些？', back: 'LRU、FIFO、随机', subject: '计组' });
  await createCard({ front: '冯诺依曼机由哪几部分组成？', back: '运算器、控制器、存储器、输入输出', subject: '计组' });
  // 一张无关卡片（不同内容）
  await createCard({ front: '什么是中断？', back: 'CPU 响应外部事件的机制', subject: '计组' });

  // 2) 上传资料（txt），解析完成会 fire-and-forget linkDocToCards
  const txt = '第三章 存储系统\nCache 的替换策略有 LRU、FIFO、随机替换。\n冯诺依曼机由运算器、控制器、存储器、输入输出设备组成。';
  const row = await uploadFile(new File([txt], '计组讲义.txt', { type: 'text/plain' }), { subject: '计组' });

  // 3) 等解析 ready
  const ready = await waitFor(async () => {
    const r = await db.docFiles.get(row.id);
    return r?.status === 'ready' ? r : null;
  });
  assert.equal(ready.status, 'ready');
  assert.ok(await getDocText(row.id));

  // 4) 等自动关联完成（fire-and-forget，轮询边数量）
  const edges = await waitFor(async () => {
    const es = await listGraphEdges();
    return es.filter((e) => e.docId === row.id).length >= 2 ? es : null;
  });
  const docEdges = edges.filter((e) => e.docId === row.id);
  assert.equal(docEdges.length, 2); // 两张内容匹配的卡片（无关的「中断」不建边）
  assert.ok(docEdges.every((e) => e.type === 'doc-card' && e.label === '涵盖' && e.from === `📄 计组讲义.txt`));

  // 5) linkDocToCards 幂等：重复调用不产生新边
  const again = await linkDocToCards(row.id);
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 2);

  // 6) 溯源：有 source 血缘的卡片可反查资料 + 原文片段
  await createCard({ front: 'Cache 的替换策略有哪些？', back: 'LRU', subject: '计组', source: row.id });
  const cards = await db.cards.filter((c) => c.source === row.id).toArray();
  assert.equal(cards.length, 1);
  const trace = await traceCardSource(cards[0].id);
  assert.ok(trace);
  assert.equal(trace.doc.id, row.id);
  assert.match(trace.excerpt, /Cache的替换策略/);

  // 无血缘卡片返回 null
  const other = await db.cards.filter((c) => c.front === '什么是中断？').first();
  assert.equal(await traceCardSource(other.id), null);

  // 7) 删除资料 → 图谱边一并清理
  await deleteDocFile(row.id);
  const remain = await listGraphEdges();
  assert.equal(remain.filter((e) => e.docId === row.id).length, 0);
});
