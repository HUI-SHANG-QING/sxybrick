// 导出→导入往返一致性回归测试（node --test）
// 直接测试 sync-manifest.js 的纯合并函数（不 import sync.js，因其依赖 db.js/Dexie）
// 覆盖三类字段：
//   R2 consolidation（卡片 SRS 字段，跨设备复习推进不 bump updatedAt 时保留）
//   R1 wrongReason + wrongReasonAt（错因用独立时间戳合并，不随 updatedAt 丢失）
//   R3 embeddings 表（idOnly 幂等策略，向量嵌入确定性生成，已存在即保留）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_VERSION,
  mergeCardPair, mergeRows, mergeTombstones, applyTombstones, livenessTs,
} from '../src/sync-manifest.js';

test('BACKUP_VERSION = 5（导出包版本固定）', () => {
  assert.equal(BACKUP_VERSION, 5);
});

test('R2+R1 幂等性：mergeCardPair 来回合并不丢字段', () => {
  // 设备A：SRS 更新（reviewedAt/wrongReasonAt 更新），内容旧
  const a = {
    id: 'c1', front: 'A文', back: 'A答',
    ease: 2.5, level: 3, consolidation: 2, dueAt: 100, reviewedAt: 5000,
    wrongReason: 'CONCEPT_MIS', wrongReasonAt: 5000, updatedAt: 1000,
  };
  // 设备B：内容更新（updatedAt 更新），SRS/错因旧
  const b = {
    id: 'c1', front: 'B文', back: 'B答',
    ease: 2.0, level: 1, consolidation: 1, dueAt: 999, reviewedAt: 3000,
    wrongReason: 'CARELESS', wrongReasonAt: 3000, updatedAt: 2000,
  };

  const r1 = mergeCardPair(a, b);
  // 内容取 updatedAt 新者（B），SRS 取 reviewedAt 新者（A）→ consolidation(R2) 必须保留
  assert.equal(r1.front, 'B文');
  assert.equal(r1.ease, 2.5);
  assert.equal(r1.level, 3);
  assert.equal(r1.consolidation, 2); // R2
  // 错因取 wrongReasonAt 新者（A）→ R1 必须保留
  assert.equal(r1.wrongReason, 'CONCEPT_MIS');
  assert.equal(r1.wrongReasonAt, 5000);
  assert.equal(r1.updatedAt, 2000);

  // 往返幂等：r1 再与 b 合、再与 a 合，字段应稳定不丢
  const r2 = mergeCardPair(r1, b);
  const r3 = mergeCardPair(r2, a);
  assert.deepEqual(r2, r1, '与 incoming 再合应幂等');
  assert.deepEqual(r3, r1, '与 local 再合应幂等');
  assert.equal(r3.consolidation, 2);       // R2 不丢
  assert.equal(r3.wrongReason, 'CONCEPT_MIS'); // R1 不丢
  assert.equal(r3.wrongReasonAt, 5000);

  // 顺序无关：merge(b,a) 与 merge(a,b) 字段值一致
  const r4 = mergeCardPair(b, a);
  assert.equal(r4.front, r1.front);
  assert.equal(r4.consolidation, r1.consolidation);
  assert.equal(r4.wrongReason, r1.wrongReason);
  assert.equal(r4.ease, r1.ease);
  assert.equal(r4.updatedAt, r1.updatedAt);
});

test('R3: mergeRows 对 embeddings 表 idOnly 策略——已存在则保留旧值', () => {
  // embeddings 走 idOnly 策略（向量嵌入由 cardId+content 确定性生成，幂等即可）
  const local = [
    { id: 'e1', cardId: 'c1', vec: [0.1, 0.2], content: '旧文本' },
    { id: 'e2', cardId: 'c2', vec: [0.3, 0.4], content: '保留' },
  ];
  const incoming = [
    { id: 'e1', cardId: 'c1', vec: [0.9, 0.8], content: '新文本' }, // 同 id → 保留本地旧值
    { id: 'e3', cardId: 'c3', vec: [0.5, 0.6], content: '新增' },   // 新 id → 加入
  ];

  const merged = mergeRows(local, incoming, 'idOnly');
  assert.equal(merged.length, 3);
  const e1 = merged.find(r => r.id === 'e1');
  assert.deepEqual(e1.vec, [0.1, 0.2]);       // 旧值不被覆盖
  assert.equal(e1.content, '旧文本');
  assert.ok(merged.some(r => r.id === 'e3')); // 新增进入

  // 再次合并幂等：e1 仍保留本地值
  const merged2 = mergeRows(merged, incoming, 'idOnly');
  assert.equal(merged2.length, 3);
  assert.deepEqual(merged2.find(r => r.id === 'e1').vec, [0.1, 0.2]);
});

test('mergeRows 对 privacyRecords 的 updatedAt 策略——新者覆盖旧者', () => {
  // privacyRecords 走 updatedAt 策略（见 PRIVACY_SYNC_TABLES，opt-in 同步）
  const local = [
    { id: 'p1', content: '旧隐私', updatedAt: 1000 },
    { id: 'p2', content: '仅本地', updatedAt: 500 },
  ];
  const incoming = [
    { id: 'p1', content: '新隐私', updatedAt: 3000 }, // 更新 → 覆盖
    { id: 'p3', content: '新增隐私', updatedAt: 200 }, // 新增
  ];

  const merged = mergeRows(local, incoming, 'updatedAt');
  assert.equal(merged.length, 3);
  assert.equal(merged.find(r => r.id === 'p1').content, '新隐私'); // 新者覆盖
  assert.ok(merged.some(r => r.id === 'p2'));
  assert.ok(merged.some(r => r.id === 'p3'));

  // 旧者不覆盖：把 incoming 当本地、local 当 incoming，p1 仍是 updatedAt=3000 的那条
  const merged2 = mergeRows(incoming, local, 'updatedAt');
  assert.equal(merged2.find(r => r.id === 'p1').content, '新隐私');
});

test('mergeTombstones + applyTombstones：对卡片与 embeddings 的影响', () => {
  // 设备A 删除卡 c1（card 墓碑）与嵌入 e1（embedding 墓碑）
  const tombs = mergeTombstones([], [
    { id: 'c1', kind: 'card', deletedAt: 1000 },
    { id: 'e1', kind: 'embedding', deletedAt: 900 },
  ]);
  assert.equal(tombs.length, 2);
  assert.equal(tombs.find(t => t.id === 'c1').kind, 'card');
  assert.equal(tombs.find(t => t.id === 'e1').kind, 'embedding');

  // 卡片：c1 旧于墓碑(1000) → 删除；c2 不在墓碑 → 保留
  const cards = [
    { id: 'c1', front: '被删卡', updatedAt: 500 },
    { id: 'c2', front: '存活卡', updatedAt: 2000 },
  ];
  const cardRes = applyTombstones(cards, tombs, 'card');
  assert.deepEqual(cardRes.removed, ['c1']);
  assert.equal(cardRes.rows.length, 1);
  assert.equal(cardRes.rows[0].id, 'c2');

  // embeddings：e1 旧于墓碑(900) → 删除；e2 保留（kind 隔离，card 墓碑不影响 embedding 行）
  const embs = [
    { id: 'e1', cardId: 'c1', vec: [0.1], updatedAt: 800 },
    { id: 'e2', cardId: 'c2', vec: [0.2], updatedAt: 950 },
  ];
  const embRes = applyTombstones(embs, tombs, 'embedding');
  assert.deepEqual(embRes.removed, ['e1']);
  assert.equal(embRes.rows.length, 1);
  assert.equal(embRes.rows[0].id, 'e2');
  // card 墓碑不会误删 embedding 行（kind 隔离）
  const embRes2 = applyTombstones(embs, tombs, 'card');
  assert.deepEqual(embRes2.removed, []); // embs 里没有 id=c1 的行

  // 复活：卡片 c3 编辑时间晚于墓碑 → 标记 stale，应清除墓碑
  const tombs2 = [{ id: 'c3', kind: 'card', deletedAt: 1000 }];
  const cards2 = [{ id: 'c3', front: '复活', updatedAt: 2000 }];
  const res2 = applyTombstones(cards2, tombs2, 'card');
  assert.deepEqual(res2.removed, []);
  assert.deepEqual(res2.stale, ['c3']);
  assert.equal(res2.rows.length, 1); // 行保留
});

// ---------- 增量同步时间判定（2026-08-29 修复回归）----------
// 背景：buildIncrementalBackup 按 livenessTs(row) > since 过滤增量。
// 此前按固定顺序取首个存在值（createdAt ?? startedAt ?? unlockedAt ?? t ?? 0），
// 而 reviews 只有 reviewedAt、embeddings 只有 updatedAt → 判定值恒为 0 →
// `0 > since` 恒假 → 这两张表永远不会进入增量包（复习历史跨设备全量丢失）。

test('增量判定：reviews 行（只有 reviewedAt）能被 since 正确过滤', () => {
  // 真实 reviews 行结构，见 repo.js 的 db.reviews.put
  const review = { id: 'r1', cardId: 'c1', reviewedAt: 5000, rating: 4, levelAfter: 3 };
  assert.ok(livenessTs(review) > 0, 'reviews 必须能取出非零时间戳，否则永不上传');
  assert.equal(livenessTs(review), 5000);
  assert.ok(livenessTs(review) > 4000, 'since=4000 时应判定为「有变更」');
  assert.ok(!(livenessTs(review) > 6000), 'since=6000 时应判定为「无变更」');
});

test('增量判定：embeddings 行（只有 updatedAt）能被 since 正确过滤', () => {
  const emb = { id: 'e1', sourceType: 'card', sourceId: 'c1', vector: [0.1], updatedAt: 8000 };
  assert.equal(livenessTs(emb), 8000);
  assert.ok(livenessTs(emb) > 7000);
});

test('增量判定：achievements（unlockedAt）与 userOps（t）不回归', () => {
  // 这两张表原本能被旧逻辑判定，补全字段后必须仍然正确
  assert.equal(livenessTs({ id: 'ach-x', key: 'x', unlockedAt: 3000 }), 3000);
  assert.equal(livenessTs({ id: 'op1', type: 'click', t: 9000 }), 9000);
});

test('增量判定：pomoSessions（createdAt/startedAt）、卡片（updatedAt/reviewedAt）取最大值', () => {
  assert.equal(livenessTs({ id: 'p1', startedAt: 100, createdAt: 200 }), 200);
  // 卡片：复习时间晚于编辑时间 → 取 max（复习后也应进入增量包）
  assert.equal(livenessTs({ id: 'c1', updatedAt: 1000, reviewedAt: 5000 }), 5000);
});

test('增量判定：空行与非法值一律返回 0，不污染比较', () => {
  assert.equal(livenessTs(null), 0);
  assert.equal(livenessTs(undefined), 0);
  assert.equal(livenessTs({}), 0);
  assert.equal(livenessTs({ updatedAt: NaN, reviewedAt: 'abc', t: null }), 0);
  assert.equal(livenessTs({ updatedAt: -100 }), 0, '负数时间戳应被忽略');
});
