// 同步清单与合并语义回归测试（node --test）
// 覆盖：18 表登记（v18 新增 notes，含 embeddings + docFiles，不含 privacyRecords 默认）、
//   卡片双时间戳字段级合并、consolidation(R2) / wrongReasonAt(R1) 跨设备保留、
//   三种 merge 策略、墓碑 kind 传播与复活
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_TABLES, BACKUP_VERSION,
  EXCLUDED_FROM_SYNC, PRIVACY_SYNC_TABLES,
  CARD_SRS_FIELDS,
  mergeCardPair, mergeRows, mergeTombstones, applyTombstones, kindOf,
} from '../src/sync-manifest.js';

test('清单：20 张表全部登记且策略合法', () => {
  // v19 新增 dailyPlans + dailyTasks → 20 张同步表
  assert.equal(SYNC_TABLES.length, 20);
  assert.equal(BACKUP_VERSION, 5);
  const names = SYNC_TABLES.map(t => t.table);
  // privacyRecords 不在默认同步清单
  assert.ok(!names.includes('privacyRecords'), 'privacyRecords 不应默认入同步');
  for (const need of ['cards', 'reviews', 'images', 'aiChats', 'aiMemories', 'memos', 'plans', 'graphEdges', 'docs', 'docFiles', 'pomoSessions', 'mindmaps', 'weeklyReports', 'achievements', 'exams', 'embeddings', 'userOps', 'notes', 'dailyPlans', 'dailyTasks']) {
    assert.ok(names.includes(need), `缺少表 ${need}`);
  }
  for (const t of SYNC_TABLES) {
    assert.ok(['card', 'updatedAt', 'idOnly', 'review'].includes(t.merge), `${t.table} 策略非法`);
    assert.ok(t.kind, `${t.table} 缺 kind`);
  }
});

test('排除表：notifications/errors 故意不同步', () => {
  assert.ok(EXCLUDED_FROM_SYNC.includes('notifications'));
  assert.ok(EXCLUDED_FROM_SYNC.includes('errors'));
});

test('隐私表：默认不入同步，opt-in 清单存在', () => {
  assert.ok(PRIVACY_SYNC_TABLES.some(t => t.table === 'privacyRecords'));
  assert.ok(!SYNC_TABLES.some(t => t.table === 'privacyRecords'));
});

test('R2: consolidation 已入 CARD_SRS_FIELDS', () => {
  assert.ok(CARD_SRS_FIELDS.includes('consolidation'), 'consolidation 必须在 SRS 字段列表中');
});

test('R2 回归：consolidation 跨设备合并保留（复习推进不 bump updatedAt）', () => {
  // 设备A：复习把 consolidation 推进 1→2（不 bump updatedAt）
  const local = { id: 'c1', front: '旧文', back: '旧答', ease: 2.5, level: 2, consolidation: 2, reviewedAt: 2000, updatedAt: 1000 };
  // 设备B：编辑文字（bump updatedAt），consolidation 未变
  const incoming = { id: 'c1', front: '新文', back: '新答', ease: 2.0, level: 1, consolidation: 1, reviewedAt: 900, updatedAt: 2000 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '新文'); // 内容取 updatedAt 新者（设备B）
  assert.equal(m.consolidation, 2); // SRS 取 reviewedAt 新者（设备A），consolidation 必须保留
  assert.equal(m.ease, 2.5);
  assert.equal(m.level, 2);
});

test('R1 回归：wrongReason 用独立时间戳合并，不随 updatedAt 丢失', () => {
  // 设备A：复习写错因 wrongReason='概念混淆'，wrongReasonAt=3000（不 bump updatedAt=1000）
  const local = { id: 'c2', front: '旧文', back: '旧答', wrongReason: '概念混淆', wrongReasonAt: 3000, updatedAt: 1000, reviewedAt: 1000, ease: 2.5, level: 1 };
  // 设备B：编辑文字（bump updatedAt=2000），不写错因
  const incoming = { id: 'c2', front: '新文', back: '新答', updatedAt: 2000, reviewedAt: 900, ease: 2.0, level: 2 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '新文'); // 内容取设备B
  assert.equal(m.wrongReason, '概念混淆'); // 错因必须保留（设备A 的 wrongReasonAt 更新）
  assert.equal(m.wrongReasonAt, 3000);
});

test('R1 回归：wrongReason 反向场景（设备B 写了更新的错因）', () => {
  // 设备A：旧错因，wrongReasonAt=1000
  const local = { id: 'c3', front: '文', back: '答', wrongReason: '粗心', wrongReasonAt: 1000, updatedAt: 500, reviewedAt: 500, ease: 2.5, level: 1 };
  // 设备B：复习写新错因，wrongReasonAt=4000
  const incoming = { id: 'c3', front: '文', back: '答', wrongReason: '记忆不牢', wrongReasonAt: 4000, updatedAt: 500, reviewedAt: 4000, ease: 2.0, level: 2 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.wrongReason, '记忆不牢'); // 取 wrongReasonAt 更新者
  assert.equal(m.wrongReasonAt, 4000);
});

test('卡片双时间戳：内容按 updatedAt、SRS 按 reviewedAt 字段级合并', () => {
  const local = { id: 'c1', front: '旧文', back: '旧答', tags: ['a'], ease: 2.5, level: 2, dueAt: 100, updatedAt: 1000, reviewedAt: 1000 };
  const incoming = { id: 'c1', front: '新文', back: '新答', tags: ['b'], ease: 2.0, level: 0, dueAt: 500, updatedAt: 2000, reviewedAt: 900 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '新文'); // 内容取 updatedAt 新者
  assert.deepEqual(m.tags, ['b']);
  assert.equal(m.ease, 2.5);    // SRS 取 reviewedAt 新者（本地）
  assert.equal(m.level, 2);
  assert.equal(m.dueAt, 100);
  assert.equal(m.updatedAt, 2000);
});

test('卡片双时间戳：复习新于编辑时，编辑内容不被复习覆盖', () => {
  const local = { id: 'c2', front: '我新编辑的内容', back: 'b', updatedAt: 3000, reviewedAt: 1000, ease: 2.5, level: 1, dueAt: 111 };
  const incoming = { id: 'c2', front: '旧内容', back: 'b', updatedAt: 1500, reviewedAt: 4000, ease: 1.8, level: 3, dueAt: 999 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '我新编辑的内容'); // 内容不丢
  assert.equal(m.ease, 1.8);               // SRS 取复习新者
  assert.equal(m.dueAt, 999);
});

test('旧数据无 reviewedAt：退化为 updatedAt（向后兼容）', () => {
  const a = { id: 'x', front: 'A', updatedAt: 5, ease: 2.5, level: 2 };
  const b = { id: 'x', front: 'B', updatedAt: 9, ease: 1.8, level: 1, reviewedAt: 9 };
  const m = mergeCardPair(a, b);
  assert.equal(m.front, 'B');
  assert.equal(m.ease, 1.8);
});

test('mergeRows：updatedAt 谁新听谁 / idOnly 幂等', () => {
  const r1 = mergeRows([{ id: 'x', v: 1, updatedAt: 5 }, { id: 'y', v: 1, createdAt: 3 }], [{ id: 'x', v: 2, updatedAt: 4 }, { id: 'y', v: 2, updatedAt: 9 }], 'updatedAt');
  assert.equal(r1.find(r => r.id === 'x').v, 1);
  assert.equal(r1.find(r => r.id === 'y').v, 2);
  const r2 = mergeRows([{ id: 'a', unlockedAt: 1 }], [{ id: 'a', unlockedAt: 2 }], 'idOnly');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].unlockedAt, 1); // 已存在即保留
});

test('mergeRows：review 策略——主体不可变、selfExplanation 按 selfExplainAt 取新', () => {
  // 本地已有复习记录（无反思）；远端来了同一 id、带更新的反思
  const local = [{ id: 'r1', rating: 0, reviewedAt: 1000 }];
  const incoming = [{ id: 'r1', rating: 0, reviewedAt: 1000, selfExplanation: '我把死锁和饥饿搞混了', selfExplainAt: 2000 }];
  const m = mergeRows(local, incoming, 'review');
  assert.equal(m[0].rating, 0); // 主体字段不变
  assert.equal(m[0].selfExplanation, '我把死锁和饥饿搞混了'); // 反思合并进来
  assert.equal(m[0].selfExplainAt, 2000);
});

test('mergeRows：review 策略——反思谁新听谁（旧反思不被覆盖）', () => {
  const local = [{ id: 'r1', selfExplanation: '旧反思', selfExplainAt: 5000 }];
  const incoming = [{ id: 'r1', selfExplanation: '旧反思(远端)', selfExplainAt: 3000 }];
  const m = mergeRows(local, incoming, 'review');
  assert.equal(m[0].selfExplanation, '旧反思'); // 本地反思更新，保留
  assert.equal(m[0].selfExplainAt, 5000);
});

test('墓碑：kind 泛化 + deletedAt 谁新听谁 + 缺省 kind=card', () => {
  const tb = mergeTombstones(
    [{ id: 't1', kind: 'card', deletedAt: 10 }],
    [{ id: 't1', deletedAt: 5 }, { id: 't2', kind: 'doc', deletedAt: 7 }],
  );
  const t1 = tb.find(t => t.id === 't1');
  assert.equal(t1.deletedAt, 10);
  assert.equal(kindOf(t1), 'card');
  assert.equal(tb.find(t => t.id === 't2').kind, 'doc');
});

test('applyTombstones：旧行删除 / 新行复活标记 stale / kind 隔离', () => {
  const tombs = [
    { id: 'a', kind: 'mindmap', deletedAt: 8 },
    { id: 'b', kind: 'doc', deletedAt: 3 },
  ];
  const rows = [{ id: 'a', updatedAt: 5 }, { id: 'b', updatedAt: 20 }];
  const rMind = applyTombstones(rows, tombs, 'mindmap');
  assert.deepEqual(rMind.removed, ['a']);
  assert.equal(rMind.rows.length, 1);
  const rDoc = applyTombstones(rows, tombs, 'doc');
  assert.deepEqual(rDoc.stale, ['b']); // b 编辑晚于删除 → 复活，墓碑应清除
  assert.deepEqual(rDoc.removed, []);
});
