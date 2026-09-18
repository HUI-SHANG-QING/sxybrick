// tests/round114-ghost-vector.test.mjs —— round114 P2：源内容清空后的**幽灵向量**
//
// 事故（round114 全量审计实证）：源内容被清空时，旧向量既不被覆盖也不被墓碑，永远留在库里。
//
//   indexDoc 旧实现：`const keepIds = embeddingRowIdsFor('doc', doc.id, chunks.length || 1)`
//     + 下方 `if (!chunks.length) return` 早退。
//     文档内容被清空（或解析出空文本）时 chunks.length === 0：
//       · `|| 1` 让 keepIds 含 `embed-doc-<id>-0` → 那块旧向量**被排除在删除名单外**；
//       · 紧接着早退，不写新行 → 它既没被覆盖也没被墓碑。
//     又 embeddingRowIdsFor 内部把 0 兜底成 1（`chunkCount > 0 ? chunkCount : 1`），
//     所以即使调用方老老实实传 0，结果一样 —— **两道都把 0 变成了 1**，双重保险一起失效。
//     后果：AI 检索仍会命中文档/卡片**已经不存在的旧正文**（幽灵内容）。
//
//   indexCard 旧实现同款：`if (!text.trim()) return` 早退，不清理同源旧行。
//
// 本文件钉住四条不变量：
//   ① embeddingRowIdsFor 显式传 0 必须返回**空集**（0 = 真的没有 chunk = 不该保留任何 id）；
//   ② indexDoc 收到空文本 → 该文档全部旧向量删除并**写墓碑**（idOnly 下 absence ≠ deletion）；
//   ③ indexCard 收到空正文 → 该卡全部旧向量删除并写墓碑；
//   ④ 正常路径不受影响：有内容时仍是「一个 chunk 一行」，旧的多余块照旧被墓碑。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { embeddingRowIdsFor } from '../src/agent/embedding-key.js';
import { indexCard, indexDoc } from '../src/agent/retrieval.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const VEC = () => new Array(8).fill(0.25);
const row = (id, sourceType, sourceId, chunkIdx, extra = {}) => ({
  id, sourceType, sourceId, chunkIdx, text: '旧内容-' + id,
  vector: VEC(), updatedAt: 1000, subject: '计组', modelSig: 'local:bigram-256', ...extra,
});

beforeEach(async () => {
  await db.embeddings.clear();
  await db.tombstones.clear();
});

// ------------------------------------------------- ① id 集合的 0 语义

test('embeddingRowIdsFor：显式 0 必须返回空集（0 表示真的没有 chunk，不是「至少 1 块」）', () => {
  assert.equal(embeddingRowIdsFor('doc', 'd1', 0).size, 0,
    '传 0 却返回 1 个 id，会让 indexDoc 的 keepIds 保住那块本该消失的旧向量');
  assert.equal(embeddingRowIdsFor('doc', 'd1', 3).size, 3, '正常分块数照旧');
  assert.equal(embeddingRowIdsFor('card', 'c1', 1).size, 1);
  // 未传 / 非法值仍保留 1 的向后兼容兜底（调用方漏传不该导致「一个 id 都没有」的意外）
  assert.equal(embeddingRowIdsFor('doc', 'd1', undefined).size, 1);
  assert.equal(embeddingRowIdsFor('doc', 'd1', NaN).size, 1);
  assert.equal(embeddingRowIdsFor('doc', 'd1', -2).size, 0, '负数不是合法 chunk 数，但也不该凭空补一块');
});

// ------------------------------------------------- ② 文档清空

test('indexDoc：文档内容被清空 → 旧向量必须全部删除并写墓碑（否则 AI 仍命中已清空内容）', async () => {
  await db.embeddings.put(row('embed-doc-d1-0', 'doc', 'd1', 0, { text: '旧的第一块正文' }));
  await db.embeddings.put(row('embed-doc-d1-1', 'doc', 'd1', 1, { text: '旧的第二块正文' }));
  // 混入一行历史随机 id（升级前遗留），也必须一起清掉
  await db.embeddings.put(row('legacy-random-uuid', 'doc', 'd1', 0));

  await indexDoc({ id: 'd1', text: '   ', subject: '计组' }); // 空白 → chunkText 返回 []

  const left = await db.embeddings.where('sourceId').equals('d1').toArray();
  assert.equal(left.length, 0, '文档清空后不得残留任何向量行（含历史随机 id 行）');
  const tb = await db.tombstones.get('embed-doc-d1-0');
  assert.equal(tb?.kind, 'embedding',
    '必须写墓碑：embeddings 是 merge:idOnly，absence ≠ deletion，不写墓碑对端会把旧行推回来');
  const tbLegacy = await db.tombstones.get('legacy-random-uuid');
  assert.equal(tbLegacy?.kind, 'embedding', '历史随机 id 行同样要墓碑');
});

// ------------------------------------------------- ③ 卡片清空

test('indexCard：卡片正文被清空 → 旧向量必须删除并写墓碑', async () => {
  await db.embeddings.put(row('embed-card-c1-0', 'card', 'c1', 0, { text: '旧的卡片正文' }));

  await indexCard({ id: 'c1', front: '', back: '', subject: '', tags: [] });

  const left = await db.embeddings.where('sourceId').equals('c1').toArray();
  assert.equal(left.length, 0, '卡片清空后不得残留旧向量');
  const tb = await db.tombstones.get('embed-card-c1-0');
  assert.equal(tb?.kind, 'embedding', '必须写墓碑，否则对端推回幽灵行');
});

// ------------------------------------------------- ④ 正常路径不回归

test('正常路径不受影响：有内容仍写确定性 id 行，旧的多余块照旧被墓碑', async () => {
  // 故意放一个「旧文更长」遗留的第 9 块，重新索引后必须消失
  await db.embeddings.put(row('embed-doc-d2-9', 'doc', 'd2', 9, { text: '旧文的第 9 块' }));

  await indexDoc({ id: 'd2', text: '这是一段足够短的内容，只会产生一块。', subject: '计组' });

  const rows = await db.embeddings.where('sourceId').equals('d2').toArray();
  assert.equal(rows.length, 1, '短文档只该有一块');
  assert.equal(rows[0].id, 'embed-doc-d2-0');
  assert.equal((await db.tombstones.get('embed-doc-d2-9'))?.kind, 'embedding',
    '重新分块后不再存在的旧块必须墓碑化');

  await indexCard({ id: 'c2', front: '问题', back: '答案', subject: '计组' });
  const cRows = await db.embeddings.where('sourceId').equals('c2').toArray();
  assert.equal(cRows.length, 1, '一卡一行');
  assert.equal(cRows[0].id, 'embed-card-c2-0');
});
