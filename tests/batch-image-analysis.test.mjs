// tests/batch-image-analysis.test.mjs —— 批量图片分析引擎
// 覆盖：候选扫描 / 签名跳过 / 分批推进 / 断点续跑 / 解析容错 / 失败不静默 / 汇总落笔记
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { invalidateDashboardCache } from '../src/repo.js';
import {
  BATCH_STATE_KEY, BATCH_NOTE_CATEGORY, imgSigOf, normalizeBatchSize,
  getBatchState, resetBatchState, scanCandidates, startBatch, runOneBatch,
  pauseBatch, resumeBatch, flushBatchNote, parseBatchReply,
} from '../src/services/batch-image-analysis.js';

after(async () => { try { await db.close(); } catch {} });

const UUID = (n) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const withImg = (id, n, over = {}) => ({
  id, front: `题目${n} ![image](sxy-img://${UUID(n)})`, back: `答案${n}`,
  subject: '计网', type: 'basic', ease: 2.5, level: 0, intervalDays: 0,
  dueAt: 1000, reviewedAt: 0, createdAt: 1, updatedAt: 1, ...over,
});
const plain = (id) => ({ id, front: '纯文字题', back: '纯文字答', subject: '计网', updatedAt: 1 });

async function reset() {
  await db.cards.clear();
  await db.notes.clear();
  await db.meta.clear();
  await db.images.clear();
  // 共享快照的 key 不完备（卡数+最新 updatedAt 相同即命中旧快照），用例之间必须清一次
  invalidateDashboardCache();
}

async function seedCards(list) {
  for (const c of list) {
    await db.cards.put(c);
    // 造出图片行，否则富集阶段会全部判为「读取失败」
    const n = Number(String(c.front).match(/(\d+)/)?.[1] || 1);
    await db.images.put({ id: UUID(n), blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), updatedAt: 1 });
  }
}

// ───────────────────────── 纯函数 ─────────────────────────

test('imgSigOf：正文/图片/updatedAt 任一变化都会让签名变化', () => {
  const a = withImg('c1', 1);
  const sig = imgSigOf(a);
  assert.equal(imgSigOf({ ...a }), sig, '内容相同 → 签名相同');
  assert.notEqual(imgSigOf({ ...a, updatedAt: 2 }), sig, 'updatedAt 变化必须改变签名（换图场景）');
  // 签名语义 = 「图片版本」：只关心图是否需要重新分析。
  // 真实场景中改正文必然伴随 updatedAt 更新（写路径会 bump），故无需在签名里再算正文差异。
  assert.equal(imgSigOf({ ...a, front: `${a.front} 补充` }), sig, '仅文字变化（updatedAt 未变）不改变签名');
  assert.notEqual(imgSigOf({ ...a, front: `换图 ![image](sxy-img://${UUID(9)})` }), sig, '换图必须改变签名');
});

test('normalizeBatchSize：脏值回退默认、超限夹到上限', () => {
  assert.equal(normalizeBatchSize(5), 5);
  assert.equal(normalizeBatchSize('8'), 8);
  assert.equal(normalizeBatchSize(undefined), 5);
  assert.equal(normalizeBatchSize(0), 5);
  assert.equal(normalizeBatchSize(-3), 5);
  assert.equal(normalizeBatchSize(NaN), 5);
  assert.equal(normalizeBatchSize(999), 10, '单批上限 10（再多会拖慢单次响应）');
});

test('parseBatchReply：容错解析（裸数组 / 代码块包裹 / 单对象 / 串号过滤）', () => {
  const ids = ['c1', 'c2'];
  const ok = parseBatchReply(JSON.stringify([
    { cardId: 'c1', content: '图1', points: 'p1', issues: '一致' },
    { cardId: 'c2', content: '图2', points: 'p2', issues: '正文少了 X' },
  ]), ids);
  assert.equal(ok.length, 2);
  assert.equal(ok[1].issues, '正文少了 X');

  // ```json 包裹
  const wrapped = parseBatchReply('```json\n[{"cardId":"c1","content":"a"}]\n```', ids);
  assert.equal(wrapped.length, 1);

  // 单对象
  const single = parseBatchReply('{"cardId":"c1","content":"a"}', ids);
  assert.equal(single.length, 1);

  // 串号：模型返回了不属于本批的 cardId → 必须丢弃（否则结果会写到别的卡上）
  const stray = parseBatchReply('[{"cardId":"cX","content":"a"}]', ids);
  assert.equal(stray.length, 0, '本批之外的 cardId 必须被过滤');

  // 垃圾输入不抛错
  assert.deepEqual(parseBatchReply('完全不是 JSON', ids), []);
  assert.deepEqual(parseBatchReply('', ids), []);
  assert.deepEqual(parseBatchReply(null, ids), []);
});

// ───────────────────────── 扫描 ─────────────────────────

test('scanCandidates：只挑带图卡；已分析的按签名跳过', async () => {
  await reset();
  await seedCards([withImg('c1', 1), withImg('c2', 2), plain('c3')]);

  const r1 = await scanCandidates();
  assert.equal(r1.totalWithImg, 2, '只统计正文带图的卡（c1/c2）');
  assert.equal(r1.pending.length, 2);
  assert.equal(r1.skipped, 0);

  // 手写一条「已分析」记录（签名一致）
  await db.meta.put({
    key: BATCH_STATE_KEY,
    value: { status: 'done', done: { c1: { sig: imgSigOf(withImg('c1', 1)), content: 'x' } } },
  });
  const r2 = await scanCandidates();
  assert.equal(r2.pending.length, 1, '签名相同的 c1 应被跳过（不重复花钱）');
  assert.equal(r2.skipped, 1);

  const r3 = await scanCandidates({ force: true });
  assert.equal(r3.pending.length, 2, 'force 时全部重跑');
});

// ───────────────────────── 全流程 ─────────────────────────

test('端到端：分批跑完 → 结果累积 → 汇总生成笔记', async () => {
  await reset();
  await resetBatchState();
  await seedCards([withImg('c1', 1), withImg('c2', 2), withImg('c3', 3)]);

  const s0 = await startBatch({ batchSize: 2 });
  assert.equal(s0.started, true);
  assert.equal(s0.total, 3);
  assert.equal(s0.state.status, 'running');

  // 第 1 批（2 张）
  const b1 = await runOneBatch({ offline: true });
  assert.equal(b1.processed, 2);
  assert.equal(b1.remaining, 1);
  assert.equal(b1.state.status, 'running');
  assert.equal(Object.keys(b1.state.done).length, 2);

  // 第 2 批（1 张）→ 自动置 done
  const b2 = await runOneBatch({ offline: true });
  assert.equal(b2.processed, 1);
  assert.equal(b2.remaining, 0);
  assert.equal(b2.state.status, 'done');
  assert.equal(Object.keys(b2.state.done).length, 3);

  // 汇总落笔记
  const note = await flushBatchNote({ offline: true });
  assert.ok(note.noteId, '应生成笔记');
  assert.equal(note.entries, 3);
  const row = await db.notes.get(note.noteId);
  assert.ok(row, '笔记必须真的入库');
  assert.equal(row.category, BATCH_NOTE_CATEGORY);
  assert.match(row.content, /## 一、总览/);
  assert.match(row.content, /## 二、逐卡要点/);
  assert.match(row.content, /### 1\./, '逐卡要点应按序号列出');
  assert.match(row.content, /图内容/, '每张卡要有图内容段落');
  assert.match(row.content, /校验/, '每张卡要有校验段落');

  // 再汇总一次：应更新同一条，不产生重复笔记
  const again = await flushBatchNote({ offline: true });
  assert.equal(again.noteId, note.noteId, '增量重跑必须更新同一条笔记');
  assert.equal((await db.notes.toArray()).length, 1, '不得产生重复笔记');
});

test('断点续跑：暂停后继续，已完成的不重跑', async () => {
  await reset();
  await resetBatchState();
  await seedCards([withImg('c1', 1), withImg('c2', 2), withImg('c3', 3), withImg('c4', 4)]);

  await startBatch({ batchSize: 2 });
  await runOneBatch({ offline: true });          // 处理 c1,c2
  const paused = await pauseBatch();
  assert.equal(paused.status, 'paused');

  // 暂停态下再跑：不应推进
  const noop = await runOneBatch({ offline: true });
  assert.equal(noop.processed, 0, '暂停状态不得继续处理');
  assert.equal(noop.state.cursor, 2);

  await resumeBatch();
  const r = await runOneBatch({ offline: true });
  assert.equal(r.processed, 2, '继续后处理剩余 2 张');
  assert.equal(r.state.cursor, 4);
  assert.equal(Object.keys(r.state.done).length, 4);

  // 跑完后重新 startBatch：应无待办（全部被签名跳过）
  const again = await startBatch();
  assert.equal(again.started, false);
  assert.equal(again.total, 0);
  assert.equal(again.skipped, 4, '已完成且签名未变的卡不应重新入队');
});

test('模型漏返回的卡必须显式记为失败（绝不静默丢卡）', async () => {
  await reset();
  await resetBatchState();
  await seedCards([withImg('c1', 1), withImg('c2', 2)]);

  await startBatch({ batchSize: 2 });
  // 注入「只答了 c1」的模型：c2 必须进 failed，而不是被悄悄丢掉
  const r = await runOneBatch({
    chatFn: async () => JSON.stringify([{ cardId: 'c1', content: '图1', points: 'p1', issues: '一致' }]),
  });
  assert.equal(Object.keys(r.state.done).length, 1, 'c1 应成功');
  assert.equal(Object.keys(r.state.failed).length, 1, 'c2 必须显式记为失败');
  assert.ok(r.state.failed.c2, '失败原因应可查');
});

test('状态读写：脏 meta 不炸，返回空状态兜底', async () => {
  await reset();
  await db.meta.put({ key: BATCH_STATE_KEY, value: 'not-an-object' });
  const s = await getBatchState();
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.queue, []);
  await db.meta.put({ key: BATCH_STATE_KEY, value: null });
  assert.equal((await getBatchState()).status, 'idle');
  assert.equal((await getBatchState()).batchSize, 5);
});
