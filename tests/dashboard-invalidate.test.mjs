// tests/dashboard-invalidate.test.mjs —— 首页共享快照在「改排期」写路径上必须失效（round122 审计修复）
//
// 背景：dashboardSnapshot() 的缓存 key = mode|cards行数|reviews行数|最大updatedAt|最大reviewedAt。
//   错题本「加入今日复习」（WrongBook.vue）与卡片页「提前巩固」（Cards.vue）此前各自在 .vue 里
//   直接写 db.cards，只改 dueAt + reviewedAt：
//     · 不 bump updatedAt 是**对的** —— 内容字段按 updatedAt 合并决胜，推高它会让本机这份旧内容
//       成为 winner，把其他设备对卡面的文字编辑整段覆盖掉；
//     · 但代价是 key 四项全不变 → **命中陈旧快照**：首页「今日待复习」不涨，
//       且共享快照的其它消费方（知识净值 / 到期预测 / 来源血缘）也读到旧行。
// 修复：两处收口到 repo.rescheduleCardToNow（差量写 + 显式 invalidateDashboardCache）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db } from '../src/db.js';
import {
  getStats, rescheduleCardToNow, dashboardSnapshot, invalidateDashboardCache,
} from '../src/repo.js';

const T = Date.now();
const DAY = 86400000;

beforeEach(async () => {
  await db.cards.clear();
  await db.reviews.clear();
  invalidateDashboardCache();
});

// 造「陷阱」布局：B 的 updatedAt 最大，决定 key 里的「最大 updatedAt」；
// 于是 A/R 无论怎么改字段，只要不 bump updatedAt，key 就纹丝不动。
async function seedTrap(id, dueInDays) {
  await db.cards.put({
    id, front: id, back: 'b', subject: 's',
    dueAt: T + dueInDays * DAY, updatedAt: T, createdAt: T,
    ease: 2.5, level: 0, reviewedAt: 0,
  });
  await db.cards.put({
    id: 'MAX', front: 'MAX', back: 'b', subject: 's',
    dueAt: T + 10 * DAY, updatedAt: T + 5000, createdAt: T,
    ease: 2.5, level: 0, reviewedAt: 0,
  });
}

test('把卡加入今日复习后，首页统计必须立即反映（不得命中陈旧快照）', async () => {
  await seedTrap('A', 3); // 3 天后到期 → 不属于今日待复习

  const before = await getStats();
  assert.equal(before.dueToday, 0, '前置：两张卡都不在今日待复习里');
  assert.equal(before.totalCards, 2);

  await rescheduleCardToNow('A');

  const row = await db.cards.get('A');
  assert.ok(row.dueAt <= Date.now(), '排期应被拉到「现在」');
  assert.equal(row.updatedAt, T, '绝不能 bump updatedAt（否则会覆盖别的设备对卡面的文字编辑）');

  const after = await getStats();
  assert.equal(
    after.dueToday, 1,
    '加入今日复习后「今日待复习」必须立刻 +1。修复前：缓存 key 四项全不变 → 命中陈旧快照 → 恒为 0。',
  );
});

test('共享快照必须在写后立即反映新的到期日（其它消费方也依赖它）', async () => {
  await seedTrap('R', 2);
  await getStats(); // 先把快照热起来（内容是旧 dueAt）

  await rescheduleCardToNow('R');

  const snap = await dashboardSnapshot();
  const r = snap.cards.find((c) => c.id === 'R');
  assert.ok(r, '快照应含 R');
  assert.ok(
    r.dueAt <= Date.now(),
    `快照必须反映刚写入的 dueAt（当前快照里是 ${new Date(r.dueAt).toISOString()}）。` +
    '修复前快照返回旧的未来到期日，知识净值/到期预测/来源血缘全部读到陈旧值。',
  );
});

test('rescheduleCardToNow：卡不存在时返回 null，不抛错', async () => {
  const r = await rescheduleCardToNow('不存在的卡');
  assert.equal(r, null, '卡不存在应返回 null（UI 据此跳过提示）');
});

// 结构闸门：视图层不得再绕过 repo 直接写 db.cards。
// 为什么必须钉：round57 契约⑥ 的门禁原先只扫 src/repo.js，.vue 里的写路径完全在雷达外，
// 于是这类漏网可以长期存在且门禁显示绿。收口到 repo 后，写路径自动落回门禁视野内。
test('结构闸门：视图层不得再直接写 db.cards（写路径统一收口到 repo）', () => {
  for (const rel of ['src/views/WrongBook.vue', 'src/views/Cards.vue']) {
    const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    assert.doesNotMatch(
      src, /db\.cards\s*\.\s*(put|bulkPut|update|delete|add|clear)\(/,
      `${rel} 不得直接写 db.cards —— 写路径必须收口到 repo（那里统一负责 invalidateDashboardCache）。`,
    );
  }
});
