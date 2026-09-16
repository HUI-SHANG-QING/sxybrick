// tests/round93-reindex-order.test.mjs —— round93 P2 回归
//
// 缺陷：增量索引扫描 `db.cards.limit(limit*2)` 无 orderBy → Dexie 按**主键顺序**取前 N，
// 而卡片主键 `uid()` = crypto.randomUUID()（纯随机）→ 永远只扫「uuid 最靠前的固定 2×limit 张」，
// 其余卡片（尤其编辑过的）永远进不了增量重建集合 → 编辑后语义检索返回旧向量。
// 修复：getStaleCards/getStaleDocs 改为 `orderBy('updatedAt').reverse()`，最近编辑的优先进窗口。
//
// 本文件锁定：① 编辑过的卡必进窗口并排最前；② id 字母序最后但最新的卡不再被主键序截断；③ 文档同理。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { updateCard } from '../src/repo.js';
import { getStaleCards, getStaleDocs } from '../src/agent/retrieval.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const BASE = 1_700_000_000_000; // 固定基准时间，避免依赖真实时钟

async function clearAll() {
  await Promise.all([db.cards.clear(), db.docs.clear(), db.docFiles.clear(), db.embeddings.clear()]);
}
beforeEach(clearAll);

/** 造 60 张填充卡：id 字母序 c00..c59，updatedAt = BASE+i（越靠后越新）。全部无 embedding → 全 stale。 */
async function seedFillerCards() {
  for (let i = 0; i < 60; i++) {
    const id = 'c' + String(i).padStart(2, '0');
    await db.cards.put({
      id, front: 'f' + i, back: 'b' + i, subject: 'S', source: 'test',
      type: 'basic', tags: [], level: 0, ease: 2.5, intervalDays: 0, reviewedAt: 0,
      dueAt: BASE + i, createdAt: BASE + i, updatedAt: BASE + i,
    });
  }
}

test('getStaleCards：编辑过的卡进入扫描窗口且排最前（旧实现按主键序截断会漏掉它）', async () => {
  await seedFillerCards();
  // c40：id 不在主键序前 20，初始 updatedAt 也不是最大 → 旧实现必被截断排除。
  await updateCard('c40', { front: 'c40 编辑后的正面', back: 'b40', subject: 'S', source: 'test' });

  const stale = await getStaleCards(20);
  const ids = stale.map((c) => c.id);
  assert.ok(ids.includes('c40'), '编辑过的卡必须进入增量重建窗口（P2 根因）');
  assert.equal(ids[0], 'c40', '刚编辑的卡应排在最前（按 updatedAt 降序）');
  // 旧实现的固定窗口 c00..c19 里那些「未编辑且更旧」的卡，不应再压过刚编辑的 c40
  assert.ok(!ids.includes('c00'), '最旧的卡不应进入最近窗口');
});

test('getStaleCards：id 字母序最后但 updatedAt 最新 → 不再被主键序截断', async () => {
  await seedFillerCards();
  // id 字母序最后（'z' > 'c'），旧实现 `.limit(40)` 按主键序永远取不到它。
  await db.cards.put({
    id: 'z-card-newest', front: '最新编辑', back: 'b', subject: 'S', source: 'test',
    type: 'basic', tags: [], level: 0, ease: 2.5, intervalDays: 0, reviewedAt: 0,
    dueAt: BASE + 99999, createdAt: BASE, updatedAt: BASE + 99999,
  });

  const stale = await getStaleCards(20);
  const ids = stale.map((c) => c.id);
  assert.ok(ids.includes('z-card-newest'), '字母序最后的最近卡必须进入窗口');
  assert.equal(ids[0], 'z-card-newest', 'updatedAt 最大的卡应排最前');
});

test('getStaleDocs：id 字母序最后但 updatedAt 最新 → 不再被主键序截断', async () => {
  for (let i = 0; i < 60; i++) {
    const id = 'd' + String(i).padStart(2, '0');
    await db.docs.put({
      id, title: '文档' + i, content: '内容' + i, type: 'note', tags: [],
      createdAt: BASE + i, updatedAt: BASE + i,
    });
  }
  await db.docs.put({
    id: 'z-doc-newest', title: '最新文档', content: '最新内容', type: 'note', tags: [],
    createdAt: BASE, updatedAt: BASE + 99999,
  });

  const stale = await getStaleDocs(20);
  const ids = stale.map((d) => d.id);
  assert.ok(ids.includes('z-doc-newest'), '字母序最后的最近文档必须进入窗口');
  assert.equal(ids[0], 'z-doc-newest', 'updatedAt 最大的文档应排最前');
});
