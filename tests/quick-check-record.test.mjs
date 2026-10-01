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
import { readFileSync } from 'node:fs';
import { db } from '../src/db.js';
import { invalidateDashboardCache } from '../src/repo.js';
import { recordQuickCheck, isQuickDue, getQuickCheckDue } from '../src/utils/quickCheck.js';

const T = Date.now();

beforeEach(async () => {
  await db.cards.clear();
  await db.reviews.clear();
  // getQuickCheckDue 走共享快照，快照缓存**跨测试存活**——不清会让上一个测试的卡片
  // 泄漏进下一个测试（本文件第 4 个测试正是要验证「新卡能被捞到」，必须见干净快照）。
  invalidateDashboardCache();
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

// ─────────────────────────────────────────────────────────────────────────────
// round122 审计回归：getQuickCheckDue 的「到期日预筛」曾把 FSRS 的 level=1 卡全部静默排除
//
// 原写法 `db.cards.where('dueAt').belowOrEqual(now + 1天)` 是拿**排期字段（到期日）**
// 去筛**短期巩固窗口**，隐含假设「level ≤ 1 的卡到期日必在 1 天内」。
// 该假设只在 SM-2（默认调度器）下成立；FSRS 下不成立：
//   · level 由稳定度 S 派生（fsrs.js:216 `S < 3 → level 1`）；
//   · 间隔 nextInterval(S, 0.9) = 9 * S * (1/0.9 - 1) ≈ S 天
//     ⇒ level=1 的卡间隔是 **1.1 ~ 3.4 天**，全部落在「now + 1 天」之外。
// 于是 isQuickDue() 判定「该弹」、预筛却把它们全筛掉 ⇒ **功能静默失效，无报错无日志**
// （实测 S=1 / 1.5 / 2 / 2.9 四种情形：isQuickDue 全 true，预筛全 false）。
// 修复：去掉预筛，改走共享快照 dashboardSnapshot()——语义不再依赖任何排期假设，
// 且**零额外全表读**（复习页/首页已物化过同一份快照）。
// ─────────────────────────────────────────────────────────────────────────────

test('FSRS 下 level=1（间隔 > 1 天）的卡必须能被快速校验捞到——regression round122', async () => {
  await db.cards.put({
    id: 'c-fsrs', front: 'f', back: 'b', subject: 's',
    level: 1,                        // FSRS：S ∈ [1, 3) → level 1
    reviewedAt: T - 20 * 60 * 1000,  // 20 分钟前复习 → 落在 [10min, 1h] 窗口内
    dueAt: T + 2.4 * 86400000,       // FSRS 实际间隔 ≈ 2.4 天 → 远超旧的「now + 1 天」预筛上界
    createdAt: T, updatedAt: T,
  });

  // 先确认「该弹」这个前提成立（否则下面的断言没有意义）
  const card = await db.cards.get('c-fsrs');
  assert.equal(isQuickDue(card, Date.now()), true, '前置：该卡应处于快速校验窗口内');

  const due = await getQuickCheckDue();
  assert.ok(
    due.some((c) => c.id === 'c-fsrs'),
    '窗口内的卡必须被 getQuickCheckDue 捞到。旧的 dueAt<=now+1天 预筛会把它静默排除'
      + ' ⇒ FSRS 用户的快速校验对该卡永久失效，且没有任何报错或日志。',
  );
});

test('结构闸门：getQuickCheckDue 不得再用 dueAt 做预筛——regression round122', () => {
  // ⚠️ 必须先剥掉注释：本文件上方的说明性注释里就写着 `where('dueAt')` 这个字面量，
  //    不剥注释会把注释当成违规（与契约⑤ 同款陷阱，实测误报过一次）。
  const src = readFileSync(new URL('../src/utils/quickCheck.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:'"`])\/\/[^\n]*/, '$1'))
    .join('\n');
  assert.doesNotMatch(
    src, /where\('dueAt'\)/,
    'getQuickCheckDue 不得再用 dueAt 索引做预筛——到期日是排期字段，与短期巩固窗口无关；'
      + 'FSRS 下 level=1 的卡间隔 1.1~3.4 天会被静默排除。改用 dashboardSnapshot() 复用共享快照。',
  );
});
