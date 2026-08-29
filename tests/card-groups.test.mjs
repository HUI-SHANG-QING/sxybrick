// tests/card-groups.test.mjs —— M1 卡组（cardGroups + cardGroupLinks）测试
// 覆盖：
//   1) 卡组 CRUD（创建/重命名/状态切换/级联删除）
//   2) 多对多关联（setCardGroups 幂等移入/移出、一卡多组）
//   3) 分组不影响学习数据（卡片 SRS 字段随复习正常推进）
//   4) 备用卡组停车：getParkedCardIds 语义 + reviewQueue 过滤
//   5) 同步合并：卡组 updatedAt 合并 + 关联「移入 vs 移出」墓碑冲突
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, uid,
} from '../src/db.js';
import {
  createCard, updateCard, reviewQueue,
  createCardGroup, updateCardGroup, deleteCardGroup, listCardGroups,
  cardGroupCardIds, cardGroupsOfCard, setCardGroups, getParkedCardIds,
} from '../src/repo.js';
import { mergeRows, mergeTombstones, applyTombstones } from '../src/sync-manifest.js';

after(async () => { try { await db.close(); } catch {} });

async function newCard(front, back, subject = '计组') {
  return createCard({ front, back, subject, ease: 2.5, intervalDays: 10, dueAt: Date.now() + 3600e3, level: 1 });
}

// ---------- 1) 卡组 CRUD ----------

test('卡组创建：默认 active、名称必填', async () => {
  const g = await createCardGroup({ name: ' 数二·高数 ', description: '2027 考研', color: '#4f7cff' });
  assert.ok(g.id);
  assert.equal(g.name, '数二·高数'); // 名称 trim
  assert.equal(g.status, 'active');
  await assert.rejects(() => createCardGroup({ name: '   ' }), /名称不能为空/);
  const list = await listCardGroups();
  assert.ok(list.some(x => x.id === g.id));
  await deleteCardGroup(g.id);
});

test('卡组重命名/状态切换：updatedAt 推进', async () => {
  const g = await createCardGroup({ name: '临时组' });
  const before = g.updatedAt;
  const u = await updateCardGroup(g.id, { name: '正式组', status: 'archived' });
  assert.equal(u.name, '正式组');
  assert.equal(u.status, 'archived');
  assert.ok(u.updatedAt >= before);
  // 空名称被拒
  await assert.rejects(() => updateCardGroup(g.id, { name: '  ' }), /名称不能为空/);
  await deleteCardGroup(g.id);
});

test('删除卡组：级联删关联，卡片本体保留', async () => {
  const g = await createCardGroup({ name: '将删组' });
  const c = await newCard('q-将删', 'a-将删');
  await setCardGroups([c.id], [g.id], []);
  assert.equal((await cardGroupCardIds(g.id)).length, 1);
  const ok = await deleteCardGroup(g.id);
  assert.ok(ok);
  assert.equal((await listCardGroups()).find(x => x.id === g.id), undefined);
  assert.equal((await cardGroupsOfCard(c.id)).length, 0, '关联应级联清除');
  const rows = await db.cards.where('id').equals(c.id).count();
  assert.equal(rows, 1, '卡片本体不受删组影响');
  await db.cards.delete(c.id);
});

// ---------- 2) 多对多关联 ----------

test('一卡多组：幂等移入不重复插入', async () => {
  const g1 = await createCardGroup({ name: '组A' });
  const g2 = await createCardGroup({ name: '组B' });
  const c = await newCard('q-多组', 'a-多组');
  await setCardGroups([c.id], [g1.id, g2.id], []);
  // 再次移入同一组：幂等，不重复
  const r2 = await setCardGroups([c.id], [g1.id], []);
  assert.equal(r2.added, 0);
  assert.equal((await cardGroupsOfCard(c.id)).length, 2);
  assert.equal(new Set(await cardGroupCardIds(g1.id)).size, 1);
  // 无效 id 安全忽略
  await setCardGroups(['no-such-card'], [g1.id], []);
  await setCardGroups([c.id], ['no-such-group'], []);
  // 清理
  await setCardGroups([c.id], [], [g1.id, g2.id]);
  assert.equal((await cardGroupsOfCard(c.id)).length, 0);
  await db.cards.delete(c.id);
  await deleteCardGroup(g1.id);
  await deleteCardGroup(g2.id);
});

test('批量操作：多卡同时移入/移出多个组', async () => {
  const g = await createCardGroup({ name: '批量组' });
  const cs = [await newCard('q1-b', 'a1'), await newCard('q2-b', 'a2'), await newCard('q3-b', 'a3')];
  const r = await setCardGroups(cs.map(c => c.id), [g.id], []);
  assert.equal(r.added, 3);
  const ids = new Set(await cardGroupCardIds(g.id));
  assert.equal(ids.size, 3);
  const r2 = await setCardGroups(cs.slice(0, 2).map(c => c.id), [], [g.id]);
  assert.equal(r2.removed, 2);
  assert.equal(new Set(await cardGroupCardIds(g.id)).size, 1);
  for (const c of cs) await db.cards.delete(c.id);
  await deleteCardGroup(g.id);
});

// ---------- 3) 分组不影响学习数据 ----------

test('分组不隔离学习数据：复习仍写卡片全局 SRS', async () => {
  const g = await createCardGroup({ name: '学习组' });
  const c = await newCard('q-学习', 'a-学习');
  await setCardGroups([c.id], [g.id], []);
  // 复习（rating 2=还模糊，会推进 reviewedAt / SRS 字段）
  const { review } = await import('../src/repo.js');
  await review(c.id, 2);
  const after1 = await db.cards.get(c.id);
  assert.ok(after1.reviewedAt > 0, '复习应推进 reviewedAt');
  assert.ok(after1.dueAt > 0, 'SRS 间隔字段应存在');
  // 卡片仍只在组内（复习不改变分组）
  assert.equal((await cardGroupsOfCard(c.id)).length, 1);
  await setCardGroups([c.id], [], [g.id]);
  await db.cards.delete(c.id);
  await deleteCardGroup(g.id);
});

// ---------- 4) 备用卡组停车 ----------

test('getParkedCardIds：只属于备用组的卡被停车；未分组卡不停车', async () => {
  const arch = await createCardGroup({ name: '备用', status: 'archived' });
  const act = await createCardGroup({ name: '背诵', status: 'active' });
  const cPark = await newCard('q-停', 'a-停');          // 只在备用组 → 停
  const cRun = await newCard('q-跑', 'a-跑');            // 只在背诵组 → 不停
  const cBoth = await newCard('q-双', 'a-双');           // 双组（含 active）→ 不停
  const cNone = await newCard('q-无组', 'a-无组');       // 未分组 → 不停（向后兼容）
  await setCardGroups([cPark.id], [arch.id], []);
  await setCardGroups([cRun.id], [act.id], []);
  await setCardGroups([cBoth.id], [arch.id, act.id], []);

  const parked = await getParkedCardIds();
  assert.ok(parked.has(cPark.id), '只属于备用组 → 停车');
  assert.ok(!parked.has(cRun.id), '属于 active 组 → 不停车');
  assert.ok(!parked.has(cBoth.id), '双组含 active → 不停车');
  assert.ok(!parked.has(cNone.id), '未分组 → 不停车（旧行为兼容）');

  for (const c of [cPark, cRun, cBoth, cNone]) await db.cards.delete(c.id);
  await deleteCardGroup(arch.id);
  await deleteCardGroup(act.id);
});

test('reviewQueue：默认过滤停用卡；groupFilter 指定组 / 仅备用组', async () => {
  const arch = await createCardGroup({ name: 'R备用', status: 'archived' });
  const act = await createCardGroup({ name: 'R背诵', status: 'active' });
  const cPark = await newCard('q-r停', 'a-r停');
  const cRun = await newCard('q-r跑', 'a-r跑');
  await setCardGroups([cPark.id], [arch.id], []);
  await setCardGroups([cRun.id], [act.id], []);

  // 默认：停用卡不进队列
  const def = await reviewQueue(50, false, { includeDueOnly: false });
  assert.ok(def.some(c => c.id === cRun.id));
  assert.ok(!def.some(c => c.id === cPark.id), '备用组卡不进默认队列');

  // 指定组：只有组内卡
  const byGroup = await reviewQueue(50, false, { includeDueOnly: false, groupFilter: [arch.id] });
  assert.ok(byGroup.some(c => c.id === cPark.id));
  assert.ok(!byGroup.some(c => c.id === cRun.id));

  // 仅备用组
  const archOnly = await reviewQueue(50, false, { includeDueOnly: false, groupFilter: 'archived-only' });
  assert.ok(archOnly.some(c => c.id === cPark.id));
  assert.ok(!archOnly.some(c => c.id === cRun.id));

  // 显式关闭停车
  const noPark = await reviewQueue(50, false, { includeDueOnly: false, parkArchived: false });
  assert.ok(noPark.some(c => c.id === cPark.id), 'parkArchived=false → 备用组卡也参与');

  for (const c of [cPark, cRun]) await db.cards.delete(c.id);
  await deleteCardGroup(arch.id);
  await deleteCardGroup(act.id);
});

// ---------- 5) 同步合并 ----------

test('同步：cardGroups 按 updatedAt 合并（谁新听谁）', () => {
  const local = [{ id: 'g1', name: '旧名', status: 'active', updatedAt: 1000 }];
  const incoming = [{ id: 'g1', name: '新名', status: 'archived', updatedAt: 2000 }];
  const m = mergeRows(local, incoming, 'updatedAt');
  assert.equal(m.find(x => x.id === 'g1').name, '新名');
  // 反向：本地更新 → 保留本地
  const m2 = mergeRows(
    [{ id: 'g2', name: '本地新', updatedAt: 3000 }],
    [{ id: 'g2', name: '远端旧', updatedAt: 2000 }],
    'updatedAt',
  );
  assert.equal(m2.find(x => x.id === 'g2').name, '本地新');
});

test('同步：关联行 idOnly 幂等合并（加入不冲突重复）', () => {
  const local = [{ id: 'L1', cardId: 'c1', groupId: 'g1', addedAt: 1000 }];
  const incoming = [{ id: 'L1', cardId: 'c1', groupId: 'g1', addedAt: 1000 },
                   { id: 'L2', cardId: 'c2', groupId: 'g1', addedAt: 2000 }];
  const m = mergeRows(local, incoming, 'idOnly');
  assert.equal(m.length, 2);
  assert.ok(m.find(x => x.id === 'L1'));
  assert.ok(m.find(x => x.id === 'L2'));
});

test('同步：「移入 vs 移出」冲突按时间戳裁决（墓碑 kind=groupLink）', () => {
  // 设备1 在 t=3000 移出（墓碑）；设备2 在 t=2000 移入（行）
  // → 移出更新 → 最终不应有该关联
  const tomb = [{ id: 'L1', kind: 'groupLink', deletedAt: 3000 }];
  const rows = [{ id: 'L1', cardId: 'c1', groupId: 'g1', addedAt: 2000 }];
  const r = applyTombstones(rows, tomb, 'groupLink');
  assert.deepEqual(r.removed, ['L1'], '移出(t=3000) 新于 移入(t=2000) → 删');

  // 反向：设备1 移出 t=1000；设备2 移入 t=2000 → 移入更新 → 复活
  const tomb2 = [{ id: 'L1', kind: 'groupLink', deletedAt: 1000 }];
  const rows2 = [{ id: 'L1', cardId: 'c1', groupId: 'g1', addedAt: 2000 }];
  const r2 = applyTombstones(rows2, tomb2, 'groupLink');
  assert.deepEqual(r2.removed, []);
  assert.deepEqual(r2.stale, ['L1'], '移入(2000) 晚于 移出(1000) → 复活（墓碑应清除）');
});

test('同步：墓碑 kind 隔离——groupLink 墓碑不误伤其它表同 id 行', () => {
  const tomb = [{ id: 'X1', kind: 'groupLink', deletedAt: 9999 }];
  const cardRows = [{ id: 'X1', updatedAt: 1 }];
  const rCard = applyTombstones(cardRows, tomb, 'card');
  assert.deepEqual(rCard.removed, [], 'card 表不应被 groupLink 墓碑删除');
  const rLink = applyTombstones([{ id: 'X1', addedAt: 1 }], tomb, 'groupLink');
  assert.deepEqual(rLink.removed, ['X1'], 'groupLink 表应被删');
});
