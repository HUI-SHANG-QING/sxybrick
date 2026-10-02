// round118 审计：快速检验（quick check）「跳过」后的窗口语义
// 背景：旧实现 skipQuick() 只关面板，卡零改动 → 60s 轮询把同批卡无限重弹。
// 修复（方案 B）：跳过 = 推迟到窗口尾部（锚点推到距过期 1 分钟，最多再弹 1 次），
// 第 2 次跳过 = 本轮放弃（写 quickCheckedAt）。复习时 repo.review 重置锚点。
// 这里锁住纯函数语义 + 结构闸，防止改回「跳过=无操作」或污染 reviewedAt。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const {
  quickAnchorOf,
  isQuickDue,
  skipDecision,
} = await import('../src/utils/quickCheck.js');

const MIN = 10 * 60 * 1000;
const MAX = 60 * 60 * 1000;
const HOLD = 60 * 1000;

test('quickAnchorOf：无锚点回退 reviewedAt，有锚点优先，非法归 0', () => {
  const t = 1_700_000_000_000;
  assert.equal(quickAnchorOf({ reviewedAt: t }), t, '无 quickAnchorAt → 用 reviewedAt');
  assert.equal(quickAnchorOf({ reviewedAt: t, quickAnchorAt: t - 59 * 60 * 1000 }), t - 59 * 60 * 1000, '有 quickAnchorAt → 优先用锚点（被跳过推迟）');
  assert.equal(quickAnchorOf({ reviewedAt: t, quickAnchorAt: 0 }), t, 'quickAnchorAt=0 → 视为无锚点');
  assert.equal(quickAnchorOf({ reviewedAt: 'bad' }), 0, '非法 reviewedAt → 0');
  assert.equal(quickAnchorOf({}), 0, '空卡 → 0');
  assert.equal(quickAnchorOf(undefined), 0, 'undefined → 0');
});

test('isQuickDue：窗口判定（level / elapsed 边界 / 已校验去重）', () => {
  const now = 1_700_000_000_000;
  const base = { level: 1, reviewedAt: now - 30 * 60 * 1000 }; // 30min 前复习
  assert.equal(isQuickDue(base, now), true, '30min 前复习、level=1 → 命中');
  assert.equal(isQuickDue({ ...base, level: 2 }, now), false, 'level=2 → 不命中');
  assert.equal(isQuickDue({ ...base, reviewedAt: 0 }, now), false, '无复习 → 不命中');
  assert.equal(isQuickDue({ ...base, reviewedAt: now - 9 * 60 * 1000 }, now), false, '9min 前复习 → 未到窗口（<10min）');
  assert.equal(isQuickDue({ ...base, reviewedAt: now - 61 * 60 * 1000 }, now), false, '61min 前复习 → 已过窗口（>1h）');
  assert.equal(isQuickDue({ ...base, reviewedAt: now - 59 * 60 * 1000 }, now), true, '59min 前 → 窗口尾部仍命中');
  // 已校验去重：quickCheckedAt > 锚点 → 不再命中
  assert.equal(isQuickDue({ ...base, quickCheckedAt: now }, now), false, '已校验（quickCheckedAt=now > 锚点）→ 不命中');
  // 锚点化：跳过把锚点推到 59min 前 → elapsed≈59min → 尾部命中
  const deferred = { ...base, quickAnchorAt: now - 59 * 60 * 1000 };
  assert.equal(isQuickDue(deferred, now), true, '被推迟到尾部 → 仍命中（最后 1 次机会）');
  // 第 2 次跳过放弃：quickCheckedAt=now > 锚点(now-59min) → 不再命中
  assert.equal(isQuickDue({ ...deferred, quickCheckedAt: now }, now), false, '放弃（quickCheckedAt > 推迟锚点）→ 不命中');
});

test('skipDecision：首次推迟到窗口尾部，第 2 次放弃，复习重置后回到「未推迟」', () => {
  const now = 1_700_000_000_000;
  const rev = now - 30 * 60 * 1000;
  const card = { reviewedAt: rev, level: 1 };

  // 首次跳过：无 quickAnchorAt → defer 到距过期 1 分钟
  const d1 = skipDecision(card, now);
  assert.equal(d1.type, 'defer');
  assert.equal(d1.anchor, now - (MAX - HOLD), '锚点 = now - (1h - 1min) = now-59min');

  // 第 2 次跳过：quickAnchorAt(≠reviewedAt) → abandon
  const d2 = skipDecision({ ...card, quickAnchorAt: now - (MAX - HOLD) }, now);
  assert.equal(d2.type, 'abandon', '锚点已被推迟过 → 第 2 次跳过放弃本轮');

  // 复习重置后：quickAnchorAt == reviewedAt（repo.review 重置）→ 视为未推迟
  const afterReview = { ...card, reviewedAt: now, quickAnchorAt: now };
  const d3 = skipDecision(afterReview, now);
  assert.equal(d3.type, 'defer', '复习重置后 quickAnchorAt==reviewedAt → 回到未推迟');
  assert.equal(d3.anchor, now - (MAX - HOLD));
});

test('round118 结构闸：跳过必须走 skipQuickCheck，复习必须重置锚点', () => {
  const review = read(`${SRC}/views/Review.vue`);
  assert.match(review, /function skipQuick\(\) \{[\s\S]{0,500}?skipQuickCheck\(/, 'Review.vue 的 skipQuick 必须调用 skipQuickCheck（不再「只关面板」）');

  const repo = read(`${SRC}/repo.js`);
  assert.match(repo, /cardUpdate\.quickAnchorAt = nowTs;/, 'repo.review 必须把窗口锚点重置回本次复习时刻');
  assert.match(repo, /cardUpdate\.fieldTs = \{ \.\.\.\(card\.fieldTs \|\| \{\}\), quickAnchorAt: nowTs \};/, '锚点重置必须随 fieldTs 独立记录（跨设备字段级同步）');
});
