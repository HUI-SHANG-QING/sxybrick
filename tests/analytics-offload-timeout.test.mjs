// tests/analytics-offload-timeout.test.mjs
// round94 P3-1 收口回归：offload worker 挂死时 promise 悬挂（无超时）。
//
// 修复语义：worker 在 WORKER_OFFLOAD_TIMEOUT_MS 内不回消息 → 该 pending 被
// setTimeout reject → 既有 catch(() => _FALLBACK) 语义不变 → 调用方走 inline 重算；
// 同时 terminate + 置空挂死的 worker（后续 offload 直接 _FALLBACK，不再白等）。
//
// Node 下没有真实 Worker，analytics.js 顶部 `new Worker(...)` 会抛 → catch 置 null
// → 全部调用走 inline。为了黑盒验证超时护栏，通过 __analyticsTestHooks 注入一个
// 「永不回消息」的 fake worker 与压缩的超时时长，走真正经过 offload 的
// getCrossModuleInsight，断言：① 挂死路径按超时 fallback inline；② 超时后 worker
// 被置空且 terminate；③ 正常回消息路径不被误杀。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import 'fake-indexeddb/auto';
await import('./_env.mjs');
const { db } = await import('../src/db.js');
const A = await import('../src/agent/analytics.js');
const { shutdownAnalyticsWorker } = A;

function seedCard(id) {
  return {
    id, front: 'F-' + id, back: 'B-' + id, subject: '计组', tags: [], type: 'basic',
    difficulty: 'basic', createdAt: Date.now(), updatedAt: Date.now(),
    ease: 2.5, level: 3, intervalDays: 5, dueAt: Date.now(), reviewedAt: Date.now(),
    fsrs: { s: 10, d: 5, reps: 3, lapses: 0, lastReviewedAt: Date.now(), state: 'review' },
  };
}

function makeFakeWorker({ silent = false } = {}) {
  const w = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage({ id }) {
      if (silent) return; // 挂死：永不回消息 → 触发超时护栏
      queueMicrotask(() => w.onmessage?.({ data: { id, result: { __fromWorker: true } } }));
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

test('offload 超时护栏：worker 挂死 → 超时后 fallback inline 重算，不再悬挂', async () => {
  await db.cards.clear(); await db.reviews.clear();
  await db.cards.bulkPut([seedCard('c1')]);
  const hooks = A.__analyticsTestHooks;
  assert.ok(hooks, '测试钩子应存在（仅测试注入用）');
  hooks.setTimeoutMs(50);
  const w = makeFakeWorker({ silent: true });
  hooks.setWorker(w);
  try {
    const t0 = Date.now();
    const r = await A.getCrossModuleInsight();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `应在超时后很快 inline 返回，实耗 ${elapsed}ms`);
    assert.ok(r && !r.__fromWorker, '应返回 inline 真实计算结果（而非挂死 worker 的结果）');
    assert.ok(w.terminated, '挂死 worker 应被 terminate');
    assert.equal(hooks.getWorker(), null, '挂死 worker 应被置空（后续 offload 直接 inline）');
  } finally {
    hooks.setWorker(null);
    hooks.setTimeoutMs(60000);
  }
});

test('offload 正常路径不受影响：worker 及时回消息 → 采用 worker 结果（护栏不误杀）', async () => {
  await db.cards.clear(); await db.reviews.clear();
  await db.cards.bulkPut([seedCard('c2')]);
  const hooks = A.__analyticsTestHooks;
  hooks.setTimeoutMs(60000);
  const w = makeFakeWorker({ silent: false });
  hooks.setWorker(w);
  try {
    const r = await A.getCrossModuleInsight();
    assert.ok(r && r.__fromWorker === true, '应及时采用 worker 结果（回归证明：正常路径无超时误杀）');
    assert.equal(w.terminated, false, '正常路径不应 terminate worker');
    assert.equal(hooks.getWorker(), w, '正常路径不应置空 worker');
  } finally {
    hooks.setWorker(null);
  }
});

after(async () => { await shutdownAnalyticsWorker(); });
