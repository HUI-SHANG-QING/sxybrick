// 锁定增量索引的「过期判定」纯函数（N2 修复核心）。
// 修复前 getStaleCards/getStaleDocs 在循环里对每张卡/文档做一次 db 查询（N 次）；
// 现改为一次 anyOf 批量查询 + 纯函数 computeStaleItems 判定，行为与旧逻辑完全一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEmbeddingStale, computeStaleItems } from '../src/agent/stale.js';

const SIG = 'deepseek-v4-flash@dim256';

test('isEmbeddingStale：无 embedding → 过期', () => {
  assert.equal(isEmbeddingStale({ id: 'a', updatedAt: 1 }, undefined, SIG), true);
});

test('isEmbeddingStale：模型签名不同 → 过期', () => {
  assert.equal(isEmbeddingStale({ id: 'a', updatedAt: 1 }, { sourceId: 'a', modelSig: 'old', updatedAt: 99 }, SIG), true);
});

test('isEmbeddingStale：embedding 早于内容更新 → 过期', () => {
  assert.equal(isEmbeddingStale({ id: 'a', updatedAt: 100 }, { sourceId: 'a', modelSig: SIG, updatedAt: 50 }, SIG), true);
});

test('isEmbeddingStale：签名一致且 embedding 不早于内容 → 未过期', () => {
  assert.equal(isEmbeddingStale({ id: 'a', updatedAt: 50 }, { sourceId: 'a', modelSig: SIG, updatedAt: 50 }, SIG), false);
  assert.equal(isEmbeddingStale({ id: 'a', updatedAt: 50 }, { sourceId: 'a', modelSig: SIG, updatedAt: 80 }, SIG), false);
});

test('computeStaleItems：按 embById 映射批量判定（替代 N 次查询）', () => {
  const cards = [
    { id: '1', updatedAt: 10 },
    { id: '2', updatedAt: 10 },
    { id: '3', updatedAt: 10 },
    { id: '4', updatedAt: 10 },
  ];
  const embById = new Map([
    ['1', { sourceId: '1', modelSig: SIG, updatedAt: 10 }], // 最新
    ['2', { sourceId: '2', modelSig: SIG, updatedAt: 5 }],  // 过期
    // '3' 缺 embedding
    ['4', { sourceId: '4', modelSig: 'old', updatedAt: 99 }], // 模型变了
  ]);
  const stale = computeStaleItems(cards, embById, SIG);
  assert.deepEqual(stale.map((c) => c.id).sort(), ['2', '3', '4']);
});

test('computeStaleItems：尊重 limit 上限', () => {
  const cards = [
    { id: '1', updatedAt: 1 },
    { id: '2', updatedAt: 1 },
    { id: '3', updatedAt: 1 },
  ];
  const embById = new Map(); // 全缺 → 全过期
  const stale = computeStaleItems(cards, embById, SIG, 2);
  assert.equal(stale.length, 2);
});

test('computeStaleItems：空输入不崩', () => {
  assert.deepEqual(computeStaleItems([], new Map(), SIG), []);
});
