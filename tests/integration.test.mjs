// tests/integration.test.mjs —— fake-indexeddb 集成测试：三条黄金路径
// 1) 建卡 → 复习 → 到期再出现（SRS 闭环）
// 2) 导入备份 → 双时间戳字段级冲突合并（内容 vs SRS 各归各）
// 3) 删除 → 墓碑 → 模拟另一设备导入后级联删除
// 必须最先 import fake-indexeddb/auto（提供全局 indexedDB），再 import 任何依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard, review, reviewQueue, deleteCard, getStats, attachSelfExplanation } from '../src/repo.js';
import { getCalibration } from '../src/agent/analytics.js';
import { buildBackup, importBackup } from '../src/sync.js';

const DAY = 86400000;

// fake-indexeddb + Dexie 会保持打开连接，导致事件循环不空、进程挂起。
// 测试结束后显式关闭连接，让 node --test 能正常退出。
import { after } from 'node:test';
after(async () => { try { await db.close(); } catch {} });

// ---------- 黄金路径 1：建卡 → 复习 → 到期再出现 ----------
test('黄金路径1：建卡→复习→到期再出现（SRS 闭环）', async () => {
  const c = await createCard({ front: '什么是可提取性 R？', back: 'R=(1+t/9S)^-1', subject: '线性代数', tags: ['FSRS'] });
  assert.ok(c.id);

  // 新卡应在队列里（dueAt = 创建时间）
  let q = await reviewQueue(100, false, {});
  assert.ok(q.some(x => x.id === c.id), '新卡应出现在复习队列');

  // 复习一次：rating=2（记住了）→ 到期时间推到未来
  const r = await review(c.id, 2);
  assert.ok(r.dueAt > Date.now(), '复习后 dueAt 应在未来');
  q = await reviewQueue(100, false, {});
  assert.ok(!q.some(x => x.id === c.id), '未到期的卡不应出现在队列');

  // 复习记录落盘，且带校准 predR（新卡首答无先验 → null）
  const rs = await db.reviews.where('cardId').equals(c.id).toArray();
  assert.equal(rs.length, 1);
  assert.equal(rs[0].rating, 2);
  assert.equal(rs[0].predR, null, '首条复习无先验状态，predR=null');

  // 时间快进 100 天 → 卡片到期，重新出现在队列
  const realNow = Date.now;
  const T = realNow();
  try {
    Date.now = () => T + 100 * DAY;
    q = await reviewQueue(100, false, {});
    assert.ok(q.some(x => x.id === c.id), '到期后卡片应重新出现');
  } finally {
    Date.now = realNow;
  }

  // 统计闭环：totalCards / totalReviews / 覆盖率
  const s = await getStats();
  assert.equal(s.totalCards, 1);
  assert.equal(s.totalReviews, 1);

  // 校准回测闭环：单条首复习无先验 → 样本数为 0（不误报）
  const calib = await getCalibration();
  assert.equal(calib.n, 0);
});

// ---------- 黄金路径 2：导入备份 → 双时间戳字段级冲突合并 ----------
test('黄金路径2：importBackup 冲突合并——内容归内容、SRS 归 SRS', async () => {
  const c = await createCard({ front: '本地正面 v1', back: '本地背面', subject: '计算机网络' });
  await review(c.id, 2); // 本地产生了复习历史（SRS 字段较新）

  const local = await db.cards.get(c.id);
  assert.ok(local.reviewedAt > 0);

  // 构造远端备份：内容编辑更晚（front 变化），但 SRS 状态更旧（reviewedAt 更早）
  const backup = await buildBackup();
  const remote = JSON.parse(JSON.stringify(backup));
  const rc = remote.cards.find(x => x.id === c.id);
  assert.ok(rc, '备份应包含该卡');
  rc.front = '远端正面 v2（内容冲突）';
  rc.updatedAt = local.updatedAt + 60000;          // 内容时间戳：远端更新
  rc.reviewedAt = local.reviewedAt - 60000;        // 复习时间戳：远端更旧
  rc.ease = 1.11; rc.level = 0; rc.intervalDays = 0.01;
  rc.dueAt = Date.now() - 30 * DAY;                // 远端 SRS 旧值（不应覆盖本地）

  const stats = await importBackup(remote);
  assert.equal(stats.cards, 0, '同 id 卡不算新增');
  assert.ok(stats.overridden >= 1, '同 id 卡应触发更新');

  const merged = await db.cards.get(c.id);
  // 内容字段：远端 updatedAt 更晚 → 取远端
  assert.equal(merged.front, '远端正面 v2（内容冲突）');
  // SRS 字段：本地 reviewedAt 更新 → 保留本地
  assert.equal(merged.ease, local.ease);
  assert.equal(merged.level, local.level);
  assert.equal(merged.intervalDays, local.intervalDays);
  assert.equal(merged.dueAt, local.dueAt);
});

// ---------- 黄金路径 3：删除 → 墓碑 → 模拟另一设备同步删除 ----------
test('黄金路径3：删除→墓碑→另一设备导入后级联删除', async () => {
  const c = await createCard({ front: '将被删除的卡', back: '背面', subject: '操作系统' });
  await review(c.id, 1);

  // 设备 A 导出「删除前」备份
  const backupBefore = await buildBackup();

  // 设备 A 删除：卡片 + 复习记录级联 + 写墓碑
  await deleteCard(c.id);
  assert.equal(await db.cards.get(c.id), undefined, '本地卡片已删除');
  assert.equal((await db.reviews.where('cardId').equals(c.id).toArray()).length, 0, '本地复习记录级联删除');
  const ts = await db.tombstones.toArray();
  assert.equal(ts.length, 1);
  assert.equal(ts[0].id, c.id);
  assert.equal(ts[0].kind, 'card');

  // 设备 A 导出「删除后」备份（含墓碑）
  const backupAfter = await buildBackup();
  assert.ok((backupAfter.tombstones || []).some(t => t.id === c.id), '备份应携带墓碑');

  // 模拟设备 B：清空业务表（全新状态），先导入「删除前」备份 → 卡复活
  await db.cards.clear(); await db.reviews.clear(); await db.tombstones.clear();
  const st1 = await importBackup(backupBefore);
  assert.ok(st1.cards >= 1, '新设备导入应新增卡片');
  assert.ok(await db.cards.get(c.id), '删除前备份导入后卡片复活');
  assert.ok((await db.reviews.where('cardId').equals(c.id).toArray()).length > 0, '复习记录随之恢复');

  // 再导入「删除后」备份 → 墓碑生效，卡片 + 复习记录再次删除
  const st2 = await importBackup(backupAfter);
  assert.equal(await db.cards.get(c.id), undefined, '墓碑传播：卡片被删除');
  assert.equal((await db.reviews.where('cardId').equals(c.id).toArray()).length, 0, '墓碑传播：复习记录级联删除');
  assert.ok(st2.deleted >= 1, '导入统计应记录删除数');
});

// ---------- 黄金路径 4：自我解释落盘 + 跨设备同步 ----------
test('黄金路径4：自我解释钩子落盘 + 跨设备同步合并', async () => {
  const c = await createCard({ front: '什么是死锁？', back: '互相等待资源', subject: '操作系统' });
  const r = await review(c.id, 0); // 答错
  assert.ok(r.reviewId, 'review 应返回 reviewId');

  // 落盘自我解释
  await attachSelfExplanation(r.reviewId, '死锁是互相等待，不是饥饿');
  const row = await db.reviews.get(r.reviewId);
  assert.equal(row.selfExplanation, '死锁是互相等待，不是饥饿');
  assert.ok(row.selfExplainAt > 0, 'selfExplainAt 应落盘');

  // 导出备份应携带 selfExplanation
  const backup = await buildBackup();
  const inBackup = backup.reviews.find(x => x.id === r.reviewId);
  assert.equal(inBackup.selfExplanation, '死锁是互相等待，不是饥饿');

  // 模拟设备 B：清空 reviews 再导入，反思应随之恢复（review 策略字段级合并）
  await db.reviews.clear();
  await importBackup(backup);
  const imported = await db.reviews.get(r.reviewId);
  assert.equal(imported.selfExplanation, '死锁是互相等待，不是饥饿');
});
