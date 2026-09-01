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
import { createCard, review, reviewQueue, deleteCard, getStats, attachSelfExplanation, restoreFromTrash } from '../src/repo.js';
import { getCalibration } from '../src/agent/analytics.js';
import { buildBackup, importBackup, previewImport, backupScope } from '../src/sync.js';

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
  // round16 R16-1：删除级联从「只写卡墓碑」升级为「卡墓碑 + 每条复习记录的 review 墓碑」
  // （此前与 word 侧 deleteWordCard 的 wordReview 墓碑不对称，记忆卡侧漏写 → 对端孤儿复习）
  const ts = await db.tombstones.toArray();
  assert.equal(ts.length, 2, '应写 2 条墓碑：卡片 1 + 复习记录 1');
  assert.equal(ts.find(t => t.id === c.id)?.kind, 'card', '卡片墓碑');
  assert.ok(ts.some(t => t.kind === 'review' && t.id !== c.id), '复习记录也写 review 墓碑（R16-1）');

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

// ---------- round17 R17-2（P1）：客户端导入时 review 的错题反思字段级合并必须落库 ----------

test('R17-2 导入合并：他机补充的 selfExplanation 必须真正写库（mergeRows 不得原地改引用）', async () => {
  const c = await createCard({ front: 'Q-R17-2', back: 'A', subject: '操作系统' });
  const r = await review(c.id, 0); // 答错，便于后续补反思
  // 本机先写一条反思（selfExplainAt = T1）
  await attachSelfExplanation(r.reviewId, '本机反思 v1');
  const local = await db.reviews.get(r.reviewId);
  assert.equal(local.selfExplanation, '本机反思 v1');
  const T1 = local.selfExplainAt;

  // 模拟他机备份：同一 review id，反思更新（selfExplainAt 更晚）
  const mkBackup = (expl, at) => ({
    app: 'sxybrick', scope: backupScope(), version: 7, exportedAt: Date.now(),
    tombstones: [], images: [],
    reviews: [{ ...local, selfExplanation: expl, selfExplainAt: at }],
  });

  await importBackup(mkBackup('他机反思 v2（更晚）', T1 + 5000));
  let cur = await db.reviews.get(r.reviewId);
  assert.equal(cur.selfExplanation, '他机反思 v2（更晚）',
    '他机更晚的反思必须落库（R17-2：此前 mergeRows 原地改 cur，JSON 差异恒 0 导致从不写库）');
  assert.equal(cur.selfExplainAt, T1 + 5000);

  // 反向：他机更旧的反思不应覆盖本机更新的内容
  await importBackup(mkBackup('他机旧反思（更早）', T1 + 1000));
  cur = await db.reviews.get(r.reviewId);
  assert.equal(cur.selfExplanation, '他机反思 v2（更晚）', '更旧的入站反思不应覆盖本机内容');
  assert.equal(cur.selfExplainAt, T1 + 5000);

  await db.reviews.delete(r.reviewId);
  await db.cards.delete(c.id);
});
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

// ---------- 黄金路径 5（P2-22）：删除写入回收站 + 30 天恢复 ----------
test('黄金路径5（P2-22）：deleteCard 写入 trash，restoreFromTrash 可本地恢复且清墓碑', async () => {
  const c = await createCard({ front: '回收站测试正面', back: '背面内容', subject: '测试科目', tags: ['trash'] });
  const cid = c.id;

  // 删除：卡片移除、墓碑写入、trash 应有一条本卡快照（保留内容）
  await deleteCard(cid);
  assert.equal(await db.cards.get(cid), undefined, '删除后卡片不在 cards 表');
  const trashed = await db.trash.toArray();
  const myTrash = trashed.filter(t => t.id === cid);
  assert.equal(myTrash.length, 1, 'trash 应有一条本卡记录');
  assert.equal(myTrash[0].id, cid);
  assert.equal(myTrash[0].kind, 'card');
  assert.ok(myTrash[0].data && myTrash[0].data.front === '回收站测试正面', 'trash 快照应保留卡片内容');

  // 恢复：重新插入、清墓碑、清 trash，updatedAt bump 到墓碑之后（跨设备同步判定复活）
  const ok = await restoreFromTrash(myTrash[0]);
  assert.equal(ok, true, 'restoreFromTrash 应返回 true');
  const back = await db.cards.get(cid);
  assert.ok(back, '恢复后卡片回到 cards 表');
  assert.equal(back.front, '回收站测试正面');
  assert.equal(await db.trash.get(cid), undefined, 'trash 记录已清除');
  assert.equal(await db.tombstones.get(cid), undefined, '本地墓碑已清除');
  assert.ok((back.updatedAt || 0) > (myTrash[0].deletedAt || 0), '恢复时 updatedAt 应 bump 到墓碑之后');

  // 清理
  await deleteCard(cid);
  await db.trash.delete(cid);
  await db.tombstones.delete(cid);
});

// ---------- 黄金路径 6（P2-23）：previewImport dry-run 分类且绝不写库 ----------
test('黄金路径6（P2-23）：previewImport 分类新增/覆盖/跳过且不写库', async () => {
  const local = await createCard({ front: 'preview 本地卡正面', back: '本地背面', subject: '预览测试' });
  const lid = local.id;
  assert.ok(await db.cards.get(lid), '本地卡应存在');

  const backup = await buildBackup();
  assert.ok(backup.cards.some(x => x.id === lid), '备份应含本地卡');

  // 1) 未改动的备份 → 该卡被判「跳过」，且 dry-run 不写库
  const pv1 = await previewImport(backup);
  assert.equal(pv1.valid, true, '合法 sxybrick 备份应 valid');
  const t1 = pv1.tables.find(t => t.table === 'cards');
  assert.ok(t1, '预览应含 cards 表');
  assert.ok(t1.skipped >= 1, '未改动卡应被判跳过');
  const before = await db.cards.count();
  await previewImport(backup); // 再跑一次，确认无副作用
  assert.equal(await db.cards.count(), before, 'previewImport 不写库：卡数不变');

  // 2) 改动备份中该卡正面 → 判「覆盖」，新增为 0
  const remote = JSON.parse(JSON.stringify(backup));
  const rc = remote.cards.find(x => x.id === lid);
  rc.front = '远端改过的正面';
  rc.updatedAt = (rc.updatedAt || Date.now()) + 60000;
  const pv2 = await previewImport(remote);
  const t2 = pv2.tables.find(t => t.table === 'cards');
  assert.ok(t2.overwritten >= 1, '改动卡应判覆盖');
  assert.equal(t2.added, 0, '覆盖不应计为新增');
  assert.equal(await db.cards.count(), before, '覆盖预览仍不写库');

  // 3) 备份里塞一张库里没有的新卡 → 判「新增」，但未真正插入
  const newId = 'preview-new-' + Date.now();
  remote.cards.push({ id: newId, front: '全新卡正面', back: 'b', subject: '预览测试', updatedAt: Date.now() });
  const pv3 = await previewImport(remote);
  const t3 = pv3.tables.find(t => t.table === 'cards');
  assert.ok(t3.added >= 1, '库里没有的卡应判新增');
  assert.equal(await db.cards.get(newId), undefined, '新增预览仍不写库（未真正插入）');

  // 4) 非法备份 → valid:false 且带错误信息
  const bad = await previewImport({ foo: 1 });
  assert.equal(bad.valid, false, '非 sxybrick 备份应判定无效');
  assert.ok(bad.error, '应带错误信息');

  // 清理
  await deleteCard(lid);
});

// ---------- 黄金路径 7（P2-26）：分享包 deckMeta 透传到导入预览 ----------
test('黄金路径7（P2-26）：分享包 deckMeta 透传 previewImport，导入者确认前可见署名', async () => {
  const subject = '分享包测试科目-' + Date.now();
  const c = await createCard({ front: '分享包卡正面', back: 'b', subject, tags: ['share'] });
  assert.ok(await db.cards.get(c.id), '分享卡应存在');

  // 模拟导出方：按科目打包 + 署名片（downloadSubjectBackup 的做法）
  const backup = await buildBackup(subject);
  backup.deckMeta = { author: '考研老王', description: '408 计网高频考点合集' };
  assert.ok(backup.cards.every(x => x.subject === subject), '科目包只含该科目卡片');
  assert.ok(backup.tombstones.length === 0, '科目包不携带墓碑（同学设备删除历史无关）');

  // 模拟导入方：预览应透传 deckMeta，且 dry-run 不写库
  const pv = await previewImport(backup);
  assert.equal(pv.valid, true, '合法分享包应 valid');
  assert.ok(pv.deckMeta, '预览应带 deckMeta');
  assert.equal(pv.deckMeta.author, '考研老王', '作者署名应透传');
  assert.equal(pv.deckMeta.description, '408 计网高频考点合集', '卡组说明应透传');

  // 真正导入（本地已有该卡 → 应为幂等 skip，不重复新增；stats.cards=0 但卡片仍在）
  const before = await db.cards.count();
  const stats = await importBackup(backup);
  assert.equal(stats.cards, 0, '重导自己的卡组不应重复新增');
  assert.equal(await db.cards.count(), before, '重导后卡数不变（幂等合并）');
  const imported = await db.cards.get(c.id);
  assert.ok(imported, '导入后该卡仍在库');
  assert.equal(imported.subject, subject, '导入卡片科目保持一致');

  // 无 deckMeta 的包预览应为 null
  const plain = await buildBackup();
  const pvPlain = await previewImport(plain);
  assert.equal(pvPlain.deckMeta, null, '无署名包 deckMeta 应为 null');

  // 清理
  await deleteCard(c.id);
});

