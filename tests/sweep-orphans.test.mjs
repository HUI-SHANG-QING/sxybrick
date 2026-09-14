// tests/sweep-orphans.test.mjs —— round43 N3 回归（2026-09-14 审计）
// sweepOrphanRows 清孤儿复习行的墓碑纪律：
//   1) 父卡已不存在的 reviews/wordReviews 被物理删除
//   2) 删除的每一行都写 kind='review'/'wordReview' 墓碑（对端不再回灌幽灵复习）
//   3) 父卡仍在的复习行不受影响、不写墓碑
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../src/db.js';
import { createCard, sweepOrphanRows } from '../src/repo.js';

after(async () => { try { await db.close(); } catch {} });

test('round43 N3: sweepOrphanRows 删孤儿复习并写墓碑；在用复习不动', async () => {
  const card = await createCard({ front: 'F', back: 'B', subject: 't', source: 'test' });

  // 在用复习（父卡存在）+ 孤儿复习（父卡不存在）+ 在用/孤儿 wordReview 各一行
  const keepReview = { id: uid(), cardId: card.id, rating: 2, reviewedAt: Date.now(), type: 'normal' };
  const orphanReview = { id: uid(), cardId: 'ghost-card-1', rating: 0, reviewedAt: Date.now(), type: 'normal' };
  const keepWord = { id: uid(), cardId: 'word-alive', rating: 2, reviewedAt: Date.now(), type: 'normal' };
  const orphanWord = { id: uid(), cardId: 'ghost-word-1', rating: 1, reviewedAt: Date.now(), type: 'normal' };
  await db.reviews.bulkPut([keepReview, orphanReview]);
  // word-alive 词卡要真实存在，否则 keepWord 也会被判定为孤儿
  await db.wordCards.put({ id: 'word-alive', word: 'alive', createdAt: Date.now(), updatedAt: Date.now() });
  await db.wordReviews.bulkPut([keepWord, orphanWord]);

  const n = await sweepOrphanRows();
  assert.equal(n, 2, '清掉 2 行孤儿（review + wordReview 各一）');

  // 物理删除到位
  assert.equal(await db.reviews.get(orphanReview.id), undefined, '孤儿 review 已删');
  assert.equal(await db.wordReviews.get(orphanWord.id), undefined, '孤儿 wordReview 已删');
  // 在用行保留
  assert.ok(await db.reviews.get(keepReview.id), '父卡在用的 review 保留');
  assert.ok(await db.wordReviews.get(keepWord.id), '父词卡在用的 wordReview 保留');

  // 墓碑纪律：删谁就给谁写墓碑，且只给被删的写
  const tombs = await db.tombstones.toArray();
  assert.ok(tombs.some((t) => t.kind === 'review' && t.id === orphanReview.id), '孤儿 review 写 kind=review 墓碑');
  assert.ok(tombs.some((t) => t.kind === 'wordReview' && t.id === orphanWord.id), '孤儿 wordReview 写 kind=wordReview 墓碑');
  assert.ok(!tombs.some((t) => t.kind === 'review' && t.id === keepReview.id), '在用 review 不得写墓碑');
  assert.ok(!tombs.some((t) => t.kind === 'wordReview' && t.id === keepWord.id), '在用 wordReview 不得写墓碑');

  // 幂等：再跑一次 0 清理、0 新墓碑
  const tombsBefore = (await db.tombstones.toArray()).length;
  assert.equal(await sweepOrphanRows(), 0, '第二次运行无孤儿可清');
  assert.equal((await db.tombstones.toArray()).length, tombsBefore, '不产生多余墓碑');
});
