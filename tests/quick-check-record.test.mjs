// tests/quick-check-record.test.mjs —— recordQuickCheck 的写入原子性（v35 审计修复）
//
// 背景：此前 reviews.put 在事务外、卡片标记另起一个事务。若后者失败（配额满等），
//   校验记录已落库但卡未标 quickCheckedAt → 窗口判定仍命中 → **快速校验重复弹**，
//   且统计里多出一条 type='quick'。
// 修复：两步包进同一个事务（db.cards + db.reviews），任一步失败整体回滚；
//   并先取卡，卡不存在时连校验记录也不写（避免指向幽灵卡的孤儿 reviews）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { recordQuickCheck, isQuickDue } from '../src/utils/quickCheck.js';

const T = Date.now();

beforeEach(async () => {
  await db.cards.clear();
  await db.reviews.clear();
});

test('记录快速校验：校验记录与卡片标记都落库（正常路径）', async () => {
  await db.cards.put({ id: 'c1', front: 'f', back: 'b', subject: 's', level: 1, reviewedAt: T - 20 * 60 * 1000, createdAt: T, updatedAt: T });
  await recordQuickCheck('c1', true);

  const rs = (await db.reviews.toArray()).filter((r) => r.type === 'quick');
  assert.equal(rs.length, 1, '应写入 1 条 quick 校验记录');
  assert.equal(rs[0].rating, 2, 'remembered=true 应记 rating=2');
  const card = await db.cards.get('c1');
  assert.ok(card.quickCheckedAt > 0, '卡片应标记校验时间');
  // 标记后窗口判定不再命中 → 不会重复弹
  assert.equal(isQuickDue(card, Date.now()), false, '校验后不应再次进入窗口');
});

test('原子性：卡片写入失败时，校验记录必须一并回滚（否则会重复弹）', async () => {
  await db.cards.put({ id: 'c2', front: 'f', back: 'b', subject: 's', level: 1, reviewedAt: T - 20 * 60 * 1000, createdAt: T, updatedAt: T });

  // 注入失败：让 db.cards.update 抛错（模拟配额满 / 事务中止）
  const origUpdate = db.cards.update.bind(db.cards);
  db.cards.update = async () => { throw new Error('QuotaExceededError（注入）'); };
  let threw = false;
  try {
    await recordQuickCheck('c2', true);
  } catch {
    threw = true;
  } finally {
    db.cards.update = origUpdate;
  }
  assert.ok(threw, '卡片写入失败应向上抛出');

  // 关键：reviews 里的 quick 记录必须**不存在**（与卡片标记同事务，整体回滚）
  const rs = (await db.reviews.toArray()).filter((r) => r.type === 'quick');
  assert.equal(rs.length, 0,
    `卡片标记失败后，校验记录必须回滚（否则卡未标记 → 窗口仍命中 → 重复弹），实际残留 ${rs.length} 条`);
});

test('卡片不存在时：连校验记录也不写（不留指向幽灵卡的孤儿 reviews）', async () => {
  await recordQuickCheck('no-such-card', true);
  const rs = await db.reviews.toArray();
  assert.equal(rs.length, 0, `幽灵卡不应留下任何复习记录，实际 ${rs.length} 条`);
});
