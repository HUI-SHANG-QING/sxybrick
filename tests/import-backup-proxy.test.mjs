// tests/import-backup-proxy.test.mjs —— 数据包导入遇 Vue 响应式 Proxy 的回归
// 根因：Sync.vue 用 pendingBackup.value = backup 暂存数据包，Vue 的 ref 会做深度响应式包装，
// 整个数据包变成 Proxy；mergeRows 的零拷贝路径（sanitizeStripRow 无 strip 时原样返回行）
// 把 Proxy 行送入 bulkPut，structuredClone 遇 Proxy 抛 DataCloneError。
// 修复：① Sync.vue 的 pendingBackup 改 shallowRef；② importBackup 入口 JSON 深拷贝兜底。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { db } from '../src/db.js';
import { importBackup } from '../src/sync.js';

after(async () => { try { await db.close(); } catch {} });

test('importBackup 深拷贝剥掉 reactive Proxy，不抛 DataCloneError 且正确落库', async () => {
  await db.cards.clear();
  const backup = {
    app: 'sxybrick',
    version: 7,
    cards: [
      {
        id: 'px1',
        front: '响应式正面',
        back: '响应式背面',
        subject: '测试',
        type: 'basic',
        tags: [],
        createdAt: 100,
        updatedAt: 100,
      },
    ],
  };
  // 模拟 Sync.vue 的 pendingBackup = ref(backup)：深响应式包装成 Proxy
  const proxied = reactive(backup);
  assert.ok(typeof proxied.cards[0] === 'object');

  // 修复前此处抛 DataCloneError；修复后应正常返回并写入
  const stats = await importBackup(proxied, { skipSnapshot: true });

  assert.equal(stats.cards, 1, '应新增 1 张卡');
  const c = await db.cards.get('px1');
  assert.ok(c, '卡片应写入 IndexedDB');
  assert.equal(c.front, '响应式正面');
  assert.equal(c.back, '响应式背面');
});
