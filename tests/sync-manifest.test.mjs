// 同步清单与合并语义回归测试（node --test）
// 覆盖：13 表登记、卡片双时间戳字段级合并、三种 merge 策略、墓碑 kind 传播与复活
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_TABLES, BACKUP_VERSION,
  mergeCardPair, mergeRows, mergeTombstones, applyTombstones, kindOf,
} from '../src/sync-manifest.js';

test('清单：14 张表全部登记且策略合法', () => {
  assert.equal(SYNC_TABLES.length, 14);
  assert.equal(BACKUP_VERSION, 3);
  const names = SYNC_TABLES.map(t => t.table);
  for (const need of ['cards', 'reviews', 'images', 'aiChats', 'aiMemories', 'memos', 'plans', 'graphEdges', 'docs', 'pomoSessions', 'mindmaps', 'weeklyReports', 'achievements', 'exams']) {
    assert.ok(names.includes(need), `缺少表 ${need}`);
  }
  for (const t of SYNC_TABLES) {
    assert.ok(['card', 'updatedAt', 'idOnly'].includes(t.merge), `${t.table} 策略非法`);
    assert.ok(t.kind, `${t.table} 缺 kind`);
  }
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