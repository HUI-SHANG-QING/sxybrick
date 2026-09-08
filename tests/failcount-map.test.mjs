// tests/failcount-map.test.mjs —— round29：答错次数聚合（failCountMap）回归
// 背景（用户实测缺陷）：卡片上的红色「答错 N 次」不是卡片持久字段，而是 reviews 流水
// 的聚合值，此前只在「错题集」模式计算 → 没开该开关的设备永远看不到红标，被误判为
// 「同步丢了数据」。列表统一附加该值后必须保证：
//   1) 只统计 rating===0，按 cardId 正确聚合
//   2) 带缓存但不返回陈旧值（新增复习后必须失效）
//   3) 无复习数据时返回空 Map，不抛异常
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard, review, failCountMap, attachFailCounts, invalidateFailCountCache } from '../src/repo.js';

after(async () => { try { await db.close(); } catch { /* 已关闭 */ } });

const mkCard = (f) => createCard({ front: f, back: 'b', subject: '计组', source: 'test' });

test('failCountMap：只统计 rating=0，按卡聚合', async () => {
  const a = await mkCard('A-round29');
  const b = await mkCard('B-round29');
  await review(a.id, 0, 1);
  await review(a.id, 0, 1);
  await review(a.id, 2, 1); // 记得（rating 仅 0/1/2）→ 不计入
  await review(b.id, 1, 1); // 模糊 → 不计入
  const m = await failCountMap();
  assert.equal(m.get(a.id), 2, 'A 两次 rating=0 应聚合为 2');
  assert.equal(m.get(b.id), undefined, '非 rating=0 的复习不应产生计数');
});

test('failCountMap：缓存随新复习失效（不返回陈旧计数）', async () => {
  const c = await mkCard('C-round29');
  await review(c.id, 0, 1);
  const m1 = await failCountMap();
  assert.equal(m1.get(c.id), 1);
  await review(c.id, 0, 1);
  const m2 = await failCountMap();
  assert.equal(m2.get(c.id), 2, '新增复习后缓存必须失效，否则列表显示过期的答错次数');
});

test('failCountMap：始终返回 Map，无数据时不抛', async () => {
  const m = await failCountMap();
  assert.ok(m instanceof Map);
  assert.equal(typeof m.get, 'function');
});

// round29 收口：attachFailCounts 是「卡片行 → 带 failCount」的唯一入口。
// db.cards 原始行没有该字段，此前各处直读 c.failCount 恒为 undefined（静默失效）。
test('attachFailCounts：注入答错次数，无记录的卡保持原引用（零拷贝）', async () => {
  const hit = await mkCard('D-hit-round29');
  const clean = await mkCard('D-clean-round29');
  await review(hit.id, 0, 1);
  const out = await attachFailCounts([{ ...clean }, { ...hit }]);
  const byId = new Map(out.map(c => [c.id, c]));
  assert.equal(byId.get(hit.id).failCount, 1, '答错过的卡应带上次数');
  assert.equal(byId.get(clean.id).failCount, undefined, '无失败记录不应凭空造 0');
});

test('attachFailCounts：空数组 / 非数组输入不抛且原样返回', async () => {
  assert.deepEqual(await attachFailCounts([]), []);
  assert.equal(await attachFailCounts(null), null);
  assert.equal(await attachFailCounts(undefined), undefined);
});

// round29 审查：复合缓存键（行数 + 最新 reviewedAt）不完备——「原地改写一条非最新复习」
// 时行数与最新时间戳都不变，键相同会返回陈旧计数。故写路径必须显式失效。
test('invalidateFailCountCache：原地改写复习后必须显式失效才拿到新值', async () => {
  const c = await mkCard('E-invalidate');
  await review(c.id, 0, 1);
  const first = (await failCountMap()).get(c.id);
  assert.equal(first, 1);

  // 模拟原地改写：把这条复习从「答错」改成「记得」（行数不变、最新 reviewedAt 不变）
  const row = (await db.reviews.toArray()).find(r => r.cardId === c.id);
  await db.reviews.put({ ...row, rating: 2 });
  await invalidateFailCountCache();

  const after = (await failCountMap()).get(c.id);
  assert.equal(after, undefined, '改写为「记得」后不应再计入答错次数');
});
