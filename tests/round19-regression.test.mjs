// tests/round19-regression.test.mjs —— round19 审计修复回归（node --test）
// 覆盖：
//   R19-1  番茄同源双标签页：同一轮专注（roundStartTs 派生 roundId）只入账一次，
//          不再依赖 lastPeerFinish 的 5s 墙钟窗口（后台节流会击穿致双写）。
//   R19-2  周报/成就/分析/今日番茄 统一走 isPomoCountable 单一谓词（partial 不计入）。
//   R19-3  rebuildIndex 须重建知识库向量：getStaleDocs 联合扫描 db.docFiles（非仅 db.docs）。
//   R19-4  indexDoc 取 subject 优先于 title（否则 subject 恒空、带 subject 检索失效）。
//   R19-5  FSRS 有限差分训练：plateau 时缩小 lr 继续而非立即 break，权重真正个性化。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────── R19-1 ───────────────────────────
test('R19-1：pomo 轮次幂等（同 roundStartTs 只入账一次）', async () => {
  const { makePomoRoundId, isRoundRecorded, markRoundRecorded } = await import('../src/utils/pomoDedup.js');
  const rid = makePomoRoundId(1700000000000);
  assert.equal(isRoundRecorded(rid), false, '初始未入账');
  markRoundRecorded(rid);
  assert.equal(isRoundRecorded(rid), true, '入账后应判重');
  // 重复标记幂等
  markRoundRecorded(rid);
  assert.equal(isRoundRecorded(rid), true);
  // 不同轮次（不同 roundStartTs）互不影响
  assert.equal(isRoundRecorded(makePomoRoundId(1700000000001)), false);
  assert.equal(isRoundRecorded(makePomoRoundId(0)), false);
  // 空 rid 安全
  assert.equal(isRoundRecorded(''), false);
  markRoundRecorded(''); // 不应抛错
});

// ─────────────────────────── R19-2 ───────────────────────────
test('R19-2：isPomoCountable 单一口径（partial 不计入、旧数据视为完整）', async () => {
  const { isPomoCountable } = await import('../src/repo.js');
  assert.equal(isPomoCountable({ partial: 1 }), false, 'partial 不计入');
  assert.equal(isPomoCountable({ partial: 0 }), true, '完整计入');
  assert.equal(isPomoCountable({}), true, '旧数据无 partial 字段视为完整');
  assert.equal(isPomoCountable(null), true, '空行视为完整');
});

// ─────────────────────────── R19-3 ───────────────────────────
test('R19-3：getStaleDocs 联合扫描 db.docFiles（知识库重建不漏）', async () => {
  const { db } = await import('../src/db.js');
  const { getStaleDocs } = await import('../src/agent/retrieval.js');
  await db.docFiles.put({ id: 'f_kb_1', name: '微积分讲义', subject: '数学', status: 'ready', createdAt: Date.now(), updatedAt: Date.now() });
  await db.embeddings.clear(); // 清空 → 该知识库文档应被判为 stale 待重建
  const stale = await getStaleDocs(10);
  const ids = stale.map((d) => d.id);
  assert.ok(ids.includes('f_kb_1'), `getStaleDocs 应含知识库 docFiles(f_kb_1)，实际: ${ids.join(',')}`);
});

// ─────────────────────────── R19-3b ───────────────────────────
test('R19-3b：getIndexStatus 覆盖率分母纳入 db.docFiles（防覆盖率失真）', async () => {
  const { db } = await import('../src/db.js');
  const { getIndexStatus } = await import('../src/agent/retrieval.js');
  const before = await getIndexStatus();
  const totalBefore = before.totalDocs;
  // 新增一条知识库文件（无 embedding）→ 分母应 +1（旧实现只数 db.docs，totalDocs 不变）
  await db.docFiles.put({
    id: 'f_kb_stat_' + Date.now(),
    name: '覆盖率分母测试',
    subject: '数学',
    status: 'ready',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const after = await getIndexStatus();
  assert.equal(after.totalDocs, totalBefore + 1, 'totalDocs 应随 docFiles 增加（分母纳入知识库文件）');
});

// ─────────────────────────── R19-4 ───────────────────────────
test('R19-4：docSubject 取 subject 优先于 title', async () => {
  const { docSubject } = await import('../src/agent/retrieval.js');
  assert.equal(docSubject({ subject: '数学' }), '数学', '优先 subject');
  assert.equal(docSubject({ title: '旧标题' }), '旧标题', '无 subject 时回退 title');
  assert.equal(docSubject({}), '', '皆空归未分类');
  assert.equal(docSubject(null), '', '空安全');
});

// ─────────────────────────── R19-5 ───────────────────────────
test('R19-5：FSRS 训练真正个性化（loss 下降 + 权重偏离默认，未早停在默认）', async () => {
  const { trainWeights, DEFAULT_WEIGHTS } = await import('../src/fsrs.js');
  // 合成可改进数据：每卡先 good(3) 后 again(1)，制造明确可学习信号
  const cardsById = new Map();
  const reviews = [];
  let t = 1_000_000_000_000;
  for (let c = 0; c < 40; c++) {
    cardsById.set('c' + c, { fsrs: null });
    reviews.push({ cardId: 'c' + c, rating: 3, reviewedAt: t }); t += 86_400_000;
    reviews.push({ cardId: 'c' + c, rating: 1, reviewedAt: t }); t += 86_400_000;
  }
  const r = trainWeights(reviews, cardsById, { iters: 60, lr: 0.02 });
  assert.ok(typeof r.loss === 'number' && Number.isFinite(r.loss), 'loss 应为有限数');
  // 权重应明显偏离默认 —— 证明训练真正个性化，而非首步不降即停、权重≈默认
  const moved = r.weights.some((w, i) => Math.abs(w - DEFAULT_WEIGHTS[i]) > 1e-3);
  assert.ok(moved, '训练后权重应偏离默认权重（证明未早停）');
  // 与仅跑 1 步（近似旧 break-early 下限）相比，不应更差
  const one = trainWeights(reviews, cardsById, { iters: 1, lr: 0.02 });
  assert.ok(r.loss <= (one.loss ?? r.loss) + 1e-9, '完整训练 loss 不应差于单步');
});
