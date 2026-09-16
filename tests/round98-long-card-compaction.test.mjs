// tests/round98-long-card-compaction.test.mjs —— round98 P2-1 回归
//
// 缺陷：Agent 的工具结果进 ReAct 上下文前会走 compactToolPayload()，默认把**单个字符串字段
// 砍到 300 字**（防检索长文撑爆上下文）。于是 get_card_detail 取一张 1 万字长卡时，
// front 被砍成 300 字 → 整条结果只剩约 866 字（图引用还在，正文答案丢 96%）。
// 修复：工具可声明 compact 预算；get_card_detail/read_doc/read_note/read_lib_doc 放宽到
// { maxChars: 24000, maxStringLen: 20000+ }，长卡/长文档正文原样送达。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard } from '../src/repo.js';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { compactToolPayload } from '../src/agent/tools/compact.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const IMG_ID = '550e8400-e29b-41d4-a716-446655440000';
const IMG_REF = `![image](sxy-img://${IMG_ID})`;
// 约 7400 字长卡（createCard 上限 8000；正+背合计超默认 6000 预算即触发压缩）
const LONG = '错题详解：' + '二叉树先序与中序重构的分步推导，先序首元素定根，中序划左右子树，递归还原整棵树。'.repeat(180);

test('get_card_detail 声明了放宽的压缩预算（P2-1 修复的核心）', () => {
  const t = toolRegistry.get('get_card_detail');
  assert.ok(t, 'get_card_detail 必须存在');
  assert.ok(t.compact, '必须声明 compact 预算');
  assert.ok(t.compact.maxStringLen >= 5000, `maxStringLen 必须放宽（实际 ${t.compact.maxStringLen}）`);
  for (const n of ['read_doc', 'read_note', 'read_lib_doc']) {
    assert.ok(toolRegistry.get(n)?.compact, `${n} 也应放宽压缩预算`);
  }
});

test('长卡正文经工具压缩后基本完整（不再被砍到 300 字）', async () => {
  await db.cards.clear();
  const card = await createCard({ front: LONG, back: '结论：先序定根，中序分左右。' + IMG_REF, subject: '数据结构', source: 'test' });
  const tool = toolRegistry.get('get_card_detail');
  const res = await tool.execute({ id: card.id });
  assert.equal(res.ok, true);
  const compacted = compactToolPayload(res.data, tool.compact);
  assert.ok(compacted.length > LONG.length * 0.9,
    `长卡正文必须基本完整，实际压缩后 ${compacted.length} / 原文 front ${LONG.length}`);
  assert.ok(!compacted.includes('已截断'), '不应触发「已截断」');
  assert.match(compacted, /sxy-img:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/, '图片引用仍完整');
});

test('对照：用默认预算同样内容会被砍到约 300 字（证明本条修复的必要性）', () => {
  const compacted = compactToolPayload({ front: LONG, back: 'b' }, undefined);
  assert.ok(compacted.length < 1500, `默认预算应显著截断，实际 ${compacted.length}`);
  assert.ok(compacted.includes('已截断'), '默认路径应带「已截断」标注');
});
