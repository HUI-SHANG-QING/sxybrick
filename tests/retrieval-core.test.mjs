// 检索打分 / 融合纯函数测试（无 Dexie、无网络、不挂）
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSemantic, scoreKeyword, fuseResults } from '../src/agent/retrieval-core.js';

test('scoreSemantic: 余弦相似度方向正确', () => {
  const qVec = [1, 0];
  const rows = [
    { sourceId: 'a', vector: [1, 0] },
    { sourceId: 'b', vector: [0, 1] },
    { sourceId: 'c' }, // 缺 vector → 视为 0 向量
  ];
  const out = scoreSemantic(qVec, rows);
  assert.equal(out.length, 3);
  const byId = Object.fromEntries(out.map((o) => [o.row.sourceId, o.score]));
  assert.ok(byId.a > 0.99, 'a 与查询向量同向，应接近 1');
  assert.ok(byId.b < 1e-9, 'b 与查询向量正交，应为 0');
  assert.equal(byId.c, 0, '缺 vector 视为 0 向量');
});

test('scoreSemantic: 空输入安全', () => {
  assert.deepEqual(scoreSemantic([1, 0], []), []);
  assert.deepEqual(scoreSemantic(null, [{ row: {}, vector: [1] }]), []);
});

test('scoreKeyword: CJK 命中率随覆盖提升', () => {
  const rows = [
    { sourceId: 'x', text: '线性代数研究向量空间与线性映射' },
    { sourceId: 'y', text: '这是一段无关内容' },
  ];
  const out = scoreKeyword('线性代数', rows);
  const byId = Object.fromEntries(out.map((o) => [o.row.sourceId, o.score]));
  assert.ok(byId.x > byId.y, '命中的行得分应高于未命中');
  assert.ok(byId.x > 0 && byId.x <= 1, '得分应在 (0,1]');
  assert.equal(byId.y, 0, '未命中行得 0');
});

test('scoreKeyword: 空查询返回空', () => {
  assert.deepEqual(scoreKeyword('', [{ row: { sourceId: 'a' }, text: 'x' }]), []);
});

test('fuseResults: 同 sourceId 取最高分 chunk 且按加权融合排序', () => {
  // 两张卡各两个 chunk，融合后应去重为 2 条，按 fused 降序
  const sem = [
    { row: { sourceId: 'cardA', chunk: 1 }, score: 0.9 },
    { row: { sourceId: 'cardA', chunk: 2 }, score: 0.3 },
    { row: { sourceId: 'cardB', chunk: 1 }, score: 0.5 },
  ];
  const kw = [
    { row: { sourceId: 'cardA', chunk: 1 }, score: 0.2 },
    { row: { sourceId: 'cardB', chunk: 1 }, score: 0.8 },
  ];
  const out = fuseResults(sem, kw, { topK: 10, semanticWeight: 0.65, keywordWeight: 0.35 });
  assert.equal(out.length, 2, '同 sourceId 去重为 2 条');
  const a = out.find((o) => o.row.sourceId === 'cardA');
  const b = out.find((o) => o.row.sourceId === 'cardB');
  // cardA 取 chunk1（sem 0.9 最高）；cardB sem0.5+kw0.8
  assert.equal(a.semScore, 0.9, 'cardA 取最高 sem chunk');
  assert.equal(b.kwScore, 0.8, 'cardB 取 kw 0.8');
  assert.ok(out[0].fused >= out[1].fused, '按 fused 降序');
  // 验证融合公式
  assert.ok(Math.abs(a.fused - (0.9 * 0.65 + 0.2 * 0.35)) < 1e-9);
  assert.ok(Math.abs(b.fused - (0.5 * 0.65 + 0.8 * 0.35)) < 1e-9);
});

test('fuseResults: topK 截断生效', () => {
  const sem = Array.from({ length: 5 }, (_, i) => ({ row: { sourceId: `c${i}` }, score: 1 - i * 0.1 }));
  const kw = [];
  const out = fuseResults(sem, kw, { topK: 3 });
  assert.equal(out.length, 3);
});

// BUG-10：融合改为 Map 查找后，语义应取「最高分 chunk」而非「首个 chunk」
test('fuseResults: 乱序输入仍取最高分 chunk（Map 语义）', () => {
  // sem 乱序：cardA 的低分 chunk 排前面，最高分 chunk 排后面
  const sem = [
    { row: { sourceId: 'cardA', chunk: 2 }, score: 0.3 },
    { row: { sourceId: 'cardA', chunk: 1 }, score: 0.9 },
    { row: { sourceId: 'cardB', chunk: 1 }, score: 0.5 },
  ];
  const kw = [
    { row: { sourceId: 'cardA', chunk: 1 }, score: 0.2 },
    { row: { sourceId: 'cardB', chunk: 1 }, score: 0.8 },
  ];
  const out = fuseResults(sem, kw, { topK: 10, semanticWeight: 0.65, keywordWeight: 0.35 });
  const a = out.find((o) => o.row.sourceId === 'cardA');
  // 关键断言：semScore 应取 cardA 的最高分 0.9，而不是乱序首项 0.3
  assert.equal(a.semScore, 0.9, '乱序输入也应取最高 sem 分');
  assert.ok(Math.abs(a.fused - (0.9 * 0.65 + 0.2 * 0.35)) < 1e-9);
});
