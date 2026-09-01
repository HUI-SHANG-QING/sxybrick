// tests/round15-analytics-srs.test.mjs —— round15 深度审计回归
// 覆盖：
//   1) F4 getForgetRisk：dueAt 缺失的卡不再被当成「逾期 2 万天」霸榜
//   2) F5 getSubjectDiagnosis：零复习科目（noData）不误判「掌握度偏低」
//   3) F6 FSRS 蒙对：S 不按 good 完整提升（与 SM-2「蒙对不升级」语义一致）
//   4) F8 livenessTs：wordSyllabusMeta 的 loadedAt 进增量判定
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDbInstance, getDb } from '../src/db.js';
import { scheduleReview } from '../src/srs.js';
import { livenessTs } from '../src/sync-manifest.js';

const { getForgetRisk, getSubjectDiagnosis } = await import('../src/agent/analytics.js');

const T = Date.now();
const DAY = 86400000;

function mkCard(over = {}) {
  return {
    id: `rc-${Math.random().toString(36).slice(2, 8)}`,
    front: 'Q', back: 'A', subject: '计网', tags: [],
    type: 'basic', marked: 0, source: 't',
    ease: 2.5, level: 2, intervalDays: 2,
    dueAt: T - DAY, reviewedAt: T - 2 * DAY,
    createdAt: T - 10 * DAY, updatedAt: T - DAY,
    ...over,
  };
}

test('F4 getForgetRisk：dueAt 缺失的卡不进预警（不再霸榜）', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.clear(); await db.reviews.clear();
    // 两张都 ≥2 次复习；A 有正常排期，B dueAt 缺失（同步/导入旧卡）
    await db.cards.bulkPut([
      mkCard({ id: 'rc-a', dueAt: T + DAY }),       // 明天到期：正常
      mkCard({ id: 'rc-b', dueAt: 0 }),             // 缺失：此前被判逾期 ~2 万天霸榜
    ]);
    const r = (cid, rating) => ({ id: `rv-${cid}-${Math.random()}`, cardId: cid, rating, reviewedAt: T - 3 * DAY, intervalDays: 1 });
    await db.reviews.bulkPut([r('rc-a', 0), r('rc-a', 2), r('rc-b', 0), r('rc-b', 2)]);
  });
  const risk = await getForgetRisk(20);
  const ids = risk.map(x => x.id);
  assert.ok(!ids.includes('rc-b'), 'dueAt 缺失卡不应出现在预警（无排期不算逾期）');
  setDbInstance('real');
});

test('F5 getSubjectDiagnosis：零复习科目不误判「掌握度偏低」', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.clear(); await db.reviews.clear();
    // 高数：有复习（掌握度数据）；计组：零复习（noData，此前被当掌握度 0 建议「放慢加卡」）
    await db.cards.bulkPut([
      mkCard({ id: 'rc-m1', front: '级数', back: 'a', subject: '高数', dueAt: T + DAY }),
      mkCard({ id: 'rc-c1', front: 'Cache', back: 'a', subject: '计组', dueAt: T + DAY }),
    ]);
    await db.reviews.bulkPut([
      { id: 'rm1', cardId: 'rc-m1', rating: 2, reviewedAt: T - 2 * DAY, intervalDays: 1 },
      { id: 'rm2', cardId: 'rc-m1', rating: 2, reviewedAt: T - DAY, intervalDays: 2 },
    ]);
  });
  const diag = await getSubjectDiagnosis();
  const cg = diag.find(d => d.subject === '计组');
  assert.ok(cg, '计组应在诊断列表');
  assert.ok(!cg.advice.includes('掌握度偏低'), '零复习科目不应给掌握度建议（此前误判学得最差）');
  setDbInstance('real');
});

test('F6 FSRS 蒙对：S 提升远小于真记住（此前按 good 完整提升）', () => {
  // 同一张卡、同一时刻：蒙对 vs 真记住（good）
  const card = { level: 2, ease: 2.5, fsrs: { s: 5, d: 5, reps: 3, last: Date.now() - 3 * DAY } };
  const honest = scheduleReview(card, 2, 1, false, { scheduler: 'fsrs', weights: undefined });
  const guessed = scheduleReview(card, 2, 1, true, { scheduler: 'fsrs', weights: undefined });
  assert.ok(honest.fsrs.s > card.fsrs.s, '真记住 S 应提升');
  assert.ok(guessed.fsrs.s <= honest.fsrs.s, `蒙对 S（${guessed.fsrs.s}）不应超过真记住（${honest.fsrs.s}）`);
  assert.ok(honest.intervalDays > guessed.intervalDays, '蒙对间隔应短于真记住');
});

test('F8 livenessTs：wordSyllabusMeta 的 loadedAt 计入增量判定', () => {
  const ts = 1234567890;
  assert.equal(livenessTs({ loadedAt: ts }), ts, 'loadedAt 应被识别为活跃时间戳');
  assert.ok(livenessTs({ loadedAt: ts }) > livenessTs({}), '有 loadedAt 的行应判定为活跃');
});
