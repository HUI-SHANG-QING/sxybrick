// tests/embedding-id.test.mjs —— round112 P1：向量行的**确定性 id**（修「多设备向量重复堆积」）
//
// 症状：同一张卡在 A/B 两台设备各建一次索引 → 两条 uid() 随机 id 的行；
//   embeddings 是 merge:'idOnly'（同 id 幂等、异 id 各留）→ 两端都保留 → 行数随设备数倍增，
//   hybridSearch 里同一张卡占多个位、更快撞 FULLSCAN_ROW_LIMIT=3000，
//   rebuildIndex 只清本端又无墓碑（absence ≠ deletion）→ 跨端永不收敛。
// 本文件钉住六条不变量：
//   ① id 由 (sourceType, sourceId, chunkIdx) 确定性推导，且**不含 modelSig**
//      （含它会让两端配置不同时又算出不同 id = 重复堆积换个马甲）；
//   ② 写入侧（indexCard/indexDoc）逐源清掉历史行并写墓碑 → 一个 chunk 全库一行；
//   ③ 迁移把历史随机 id 行**原地改键**（保留原向量，不重算、不花 token）+ 旧 id 墓碑；
//   ④ 重新分块后多余的旧块必须墓碑化（否则对端/中枢把它推回来）；
//   ⑤ rebuildIndex 不制造墓碑风暴（被清的 id 紧接着会以同一个 id 重写）；
//   ⑥ 入站同步把旧版对端推来的随机 id 行归一并退休该 id（重复行不会重新长出来）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { embeddingRowId, embeddingIdPrefix, isCanonicalEmbeddingRowId } from '../src/agent/embedding-key.js';
import { indexCard, indexDoc, rebuildIndex, migrateLegacyEmbeddingIds } from '../src/agent/retrieval.js';
import { importBackup } from '../src/sync.js';
import { createCard, deleteCard, restoreFromTrash } from '../src/repo.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const VEC = () => new Array(8).fill(0.25); // 占位向量：本文件只验证「行的身份与生命周期」，不验证相似度
const legacyRow = (id, sourceId, extra = {}) => ({
  id, sourceType: 'card', sourceId, chunkIdx: 0, text: 't-' + id,
  vector: VEC(), updatedAt: 1000, modelSig: 'local:bigram-256', ...extra,
});

beforeEach(async () => {
  await db.embeddings.clear();
  await db.tombstones.clear();
  await db.cards.clear();
  try { localStorage.removeItem('sxy_embeddings_rekey_v1'); } catch { /* ignore */ }
});

// ---------------------------------------------------------------- ① id 形态

test('id 只由 (sourceType, sourceId, chunkIdx) 决定：稳定、可重算、不含 modelSig', () => {
  const a = embeddingRowId('card', 'c1', 0);
  assert.equal(a, 'embed-card-c1-0');
  assert.equal(embeddingRowId('card', 'c1', 0), a, '同一输入必须永远得到同一个 id');
  assert.equal(embeddingRowId('doc', 'c1', 0), 'embed-doc-c1-0', 'sourceType 参与区分（doc 与 card 同 id 也不冲突）');
  assert.equal(embeddingRowId('doc', 'c1', 3), 'embed-doc-c1-3', 'chunkIdx 参与区分');
  // 关键：id 里**不含** modelSig —— 否则「手机本地 256 维 / 电脑远程 1536 维」两端又算出不同 id
  assert.ok(!a.includes('bigram') && !a.includes('api:'), 'id 不得编码 embedding 配置');
  // 脏输入归一（NaN / 负数 / 字符串数字都不该产生第二个键空间）
  assert.equal(embeddingRowId('card', 'c1', NaN), 'embed-card-c1-0');
  assert.equal(embeddingRowId('card', 'c1', -3), 'embed-card-c1-0');
  assert.equal(embeddingRowId('weird', 'c1', 0), '', '源类型未知时不给 id（绝不猜类型：猜错会让该行永远清不掉）');
  assert.equal(embeddingRowId(undefined, 'c1', 0), '', '缺 sourceType 同理');
  assert.equal(embeddingRowId('card', '', 0), '', '无 sourceId 不给 id（调用方据此跳过写入）');
  assert.equal(embeddingIdPrefix('card', 'c1'), 'embed-card-c1-');
  assert.equal(isCanonicalEmbeddingRowId({ id: 'embed-card-c1-0', sourceType: 'card', sourceId: 'c1', chunkIdx: 0 }), true);
  assert.equal(isCanonicalEmbeddingRowId(legacyRow('u-1', 'c1')), false);
});

// ---------------------------------------------------------------- ② 写入侧去重

test('indexCard：吸收同源历史随机 id 行并写墓碑 —— 一张卡全库只留一行', async () => {
  await db.embeddings.put(legacyRow('legacy-1', 'card-1', { text: '旧的行', vector: new Array(8).fill(9) }));
  await indexCard({ id: 'card-1', front: 'Q', back: 'A', subject: '计组' });

  const rows = await db.embeddings.where('sourceId').equals('card-1').toArray();
  assert.equal(rows.length, 1, '一卡一行（旧实现沿用随机 id，会让两端各自的随机行永远合不到一起）');
  assert.equal(rows[0].id, 'embed-card-card-1-0');
  assert.equal(rows[0].chunkIdx, 0);
  assert.ok(rows[0].vector.length > 8, '向量应是本次真实生成的（不是旧行的残留）');
  const tomb = await db.tombstones.get('legacy-1');
  assert.equal(tomb?.kind, 'embedding', '旧 id 必须退休：不写墓碑，对端会把它原样推回来');

  // 再索引一次：幂等，不会又长出第二行、也不重复写墓碑
  await indexCard({ id: 'card-1', front: 'Q2', back: 'A', subject: '计组' });
  assert.equal(await db.embeddings.where('sourceId').equals('card-1').count(), 1);
});

// ---------------------------------------------------------------- ③ 历史行迁移

test('migrateLegacyEmbeddingIds：原地改键（保留原向量）、合并同 chunk 多条、旧 id 墓碑、幂等', async () => {
  await db.embeddings.bulkPut([
    legacyRow('legacy-a', 'c-1', { vector: [1, 2, 3], updatedAt: 1000 }),
    legacyRow('legacy-b', 'c-1', { vector: [4, 5, 6], updatedAt: 2000 }), // 同 chunk 的第二条（另一台设备建的）
    legacyRow('legacy-c', 'c-2', { vector: [7, 8, 9], updatedAt: 1500 }),
  ]);

  const r = await migrateLegacyEmbeddingIds({ force: true });
  assert.equal(r.rekeyed, 2, '两条不同源的随机行各改一次键');
  assert.equal(r.merged, 1, '同 chunk 的第二条被合并掉');
  assert.equal(r.done, true);

  const rows = await db.embeddings.toArray();
  assert.equal(rows.length, 2, '两个 chunk → 两行（三条历史行收敛）');
  const c1 = rows.find((x) => x.sourceId === 'c-1');
  assert.equal(c1.id, 'embed-card-c-1-0');
  assert.deepEqual(c1.vector, [4, 5, 6], '赢家 = updatedAt 较新者，且向量**原样保留**（迁移不重算，不花 token）');
  assert.deepEqual(rows.find((x) => x.sourceId === 'c-2').vector, [7, 8, 9]);

  const tombs = (await db.tombstones.toArray()).map((t) => t.id).sort();
  assert.deepEqual(tombs, ['legacy-a', 'legacy-b', 'legacy-c'], '三个旧 id 全部退休（含被合并的那条）');
  assert.ok((await db.tombstones.toArray()).every((t) => t.kind === 'embedding'));

  const again = await migrateLegacyEmbeddingIds({ force: true });
  assert.equal(again.rekeyed + again.merged, 0, '幂等：第二次跑什么都不做');
  assert.equal(await db.tombstones.count(), 3, '不重复写墓碑');
});

test('migrateLegacyEmbeddingIds：完成标记生效（非 force 时不重复全表扫）', async () => {
  await db.embeddings.put(legacyRow('legacy-z', 'c-9'));
  const first = await migrateLegacyEmbeddingIds();
  assert.equal(first.rekeyed, 1);
  // 模拟「又冒出一条历史行」（例如旧版对端推来的）→ 非 force 时按标记跳过（不重扫）
  await db.embeddings.put(legacyRow('legacy-y', 'c-8'));
  const second = await migrateLegacyEmbeddingIds();
  assert.equal(second.scanned, 0, '有完成标记时不做全表扫（会话内/升级后只跑一次）');
});

// ---------------------------------------------------------------- ④ 重新分块

test('indexDoc：重新分块后不再存在的旧块必须墓碑化（否则对端推回幽灵块）', async () => {
  await db.embeddings.bulkPut([0, 1, 2, 3, 4].map((i) => ({
    id: embeddingRowId('doc', 'doc-1', i), sourceType: 'doc', sourceId: 'doc-1', chunkIdx: i,
    text: '旧块' + i, vector: VEC(), updatedAt: 1000, modelSig: 'local:bigram-256',
  })));

  await indexDoc({ id: 'doc-1', text: '只有一小段内容', subject: '计组' });

  const rows = await db.embeddings.where('sourceId').equals('doc-1').toArray();
  assert.equal(rows.length, 1, '新内容只有 1 块 → 只应剩 1 行');
  assert.equal(rows[0].id, embeddingRowId('doc', 'doc-1', 0));
  const tombIds = (await db.tombstones.toArray()).map((t) => t.id).sort();
  assert.deepEqual(tombIds, [1, 2, 3, 4].map((i) => embeddingRowId('doc', 'doc-1', i)).sort(),
    '被淘汰的第 1~4 块必须写墓碑（保留的第 0 块不写：它紧接着被原地重写，同 ms 会被自删）');
});

// ---------------------------------------------------------------- ⑤ 全量重建

test('rebuildIndex：清空后不产生墓碑风暴（被清的 id 紧接着以同一 id 重写）', async () => {
  await db.embeddings.put({
    id: embeddingRowId('card', 'ghost', 0), sourceType: 'card', sourceId: 'ghost', chunkIdx: 0,
    text: 'g', vector: VEC(), updatedAt: 1000, modelSig: 'local:bigram-256',
  });
  await db.tombstones.clear();
  await rebuildIndex();
  assert.equal(await db.embeddings.count(), 0, '本端已清空（库里没有对应卡可重建）');
  assert.equal(await db.tombstones.count(), 0, '不得为「马上要以同 id 重写」的行写墓碑');
});

// ---------------------------------------------------------------- ⑥ 入站同步归一

test('入站同步：旧版对端推来的随机 id 行被归一并退休原 id（同一 chunk 不滋生第二行）', async () => {
  const base = { sourceType: 'card', sourceId: 'card-9', chunkIdx: 0, text: 't', vector: VEC(), modelSig: 'local:bigram-256' };

  await importBackup({ app: 'sxybrick', version: 10, embeddings: [legacyRow('old-x1', 'card-9')] }, { skipSnapshot: true });
  let rows = await db.embeddings.toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'embed-card-card-9-0', '入站即归一（不能把随机 id 存下来）');
  assert.equal(rows[0].updatedAt, 1000);

  // 第二台设备推来「同一 chunk 的另一条随机行」：必须被吸收，而不是并存
  await importBackup({ app: 'sxybrick', version: 10, embeddings: [{ ...base, id: 'old-x2', updatedAt: 900 }] }, { skipSnapshot: true });
  rows = await db.embeddings.toArray();
  assert.equal(rows.length, 1, '同一 chunk 全库只应有一行（这就是「向量不再随设备数倍增」）');
  assert.equal(rows[0].updatedAt, 1000, 'idOnly 语义：本地已有则该行保持本地版本');

  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'embedding').map((t) => t.id).sort();
  assert.deepEqual(tombs, ['old-x1', 'old-x2'], '两个旧 id 都要退休，否则下一轮它们还会被推回来');
});

test('入站同步：一个包里同时带随机 id 行与确定性 id 行 → 不抛 ConstraintError，收敛成一行', async () => {
  const mk = (id, updatedAt) => ({
    id, sourceType: 'card', sourceId: 'card-7', chunkIdx: 0, text: 't' + id,
    vector: VEC(), updatedAt, modelSig: 'local:bigram-256',
  });
  // 旧实现若直接按 incoming id bulkAdd，两条归一到同一个 id 会撞主键 → 整个导入事务回滚
  await importBackup({
    app: 'sxybrick', version: 10,
    embeddings: [mk('embed-card-card-7-0', 1000), mk('old-y1', 2000)],
  }, { skipSnapshot: true });
  const rows = await db.embeddings.toArray();
  assert.equal(rows.length, 1, '同 chunk 两行 → 归一后只剩一行');
  assert.equal(rows[0].id, 'embed-card-card-7-0');
  assert.equal(rows[0].text, 'told-y1', '赢家按确定性规则选出（此处 updatedAt 较新者）');
  assert.equal((await db.tombstones.get('old-y1'))?.kind, 'embedding', '被顶掉的那条旧 id 也要退休');
});

test('入站同步不回退：确定性 id 行在新旧两端都保持同一身份（idOnly 幂等，不产生新墓碑）', async () => {
  const row = { id: 'embed-card-card-5-0', sourceType: 'card', sourceId: 'card-5', chunkIdx: 0, text: 't', vector: VEC(), updatedAt: 1000, modelSig: 'local:bigram-256' };
  await importBackup({ app: 'sxybrick', version: 10, embeddings: [row] }, { skipSnapshot: true });
  assert.equal((await db.tombstones.count()), 0, '确定性 id 无需退休任何东西');
  // 同一行再来一次（对方重传）：幂等，不新增行、不新增墓碑
  await importBackup({ app: 'sxybrick', version: 10, embeddings: [row] }, { skipSnapshot: true });
  assert.equal(await db.embeddings.count(), 1);
  assert.equal(await db.tombstones.count(), 0);
});

// ---------------------------------------------------------------- ⑦ 删卡→恢复：墓碑必须清得掉

test('删卡→回收站恢复：向量墓碑必须被清除（否则重建的向量会在下次同步被删掉）', async () => {
  // 这一条钉住一个「一直是死代码」的分支：restoreFromTrash 要用**向量行 id 的前缀**
  // 找出该源的 embedding 墓碑并清掉。旧实现的前缀写作 `embed-${cardId}-`（缺 sourceType 段）、
  // docFile 支更是拿资料 id 去比向量行 id —— 两支都永不命中。
  // 在随机 id 时代那只是无害死代码；id 换成确定性键后，重建出来的向量行**与墓碑同 id**：
  // 不清理就会在下一次同步被 applyTombstones 删掉 → RAG 对该卡/资料永久失明。
  const card = await createCard({ front: 'Q', back: 'A', subject: '计组' });
  await indexCard(card);
  const rowId = embeddingRowId('card', card.id, 0);
  assert.ok(await db.embeddings.get(rowId), '索引后应有确定性 id 的行');

  await deleteCard(card.id);
  assert.equal(await db.embeddings.get(rowId), undefined, '删卡级联删向量行');
  assert.equal((await db.tombstones.get(rowId))?.kind, 'embedding', '同时写墓碑（跨设备删除语义）');

  const snap = (await db.trash.toArray()).find((t) => t.id === card.id);
  assert.ok(snap, '回收站应有快照');
  assert.equal(await restoreFromTrash(snap), true, '恢复应成功');

  assert.equal(await db.tombstones.get(rowId), undefined,
    '恢复后必须清掉向量墓碑（含前缀匹配：这一处旧实现永远匹配不到）');
  // restoreFromTrash 会 fire-and-forget 触发 indexCard 重建向量，等它落库
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(await db.embeddings.get(rowId), '恢复后向量被重建，且 id 仍是同一个确定性 id');
});
