import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './_env.mjs';
import { db } from '../src/db.js';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';

function blob() { return new Blob(['x'], { type: 'image/png' }); }

test('get_image_assets：引用/可读/悬空三数正确，悬空样例精确（round90）', async () => {
  const live1 = '11111111-1111-4111-8111-111111111111';
  const live2 = '22222222-2222-4222-8222-222222222222';
  const dead  = '33333333-3333-4333-8333-333333333333';
  await db.cards.put({ id: 'c1', front: `![a](sxy-img://${live1}) 图一`, back: `![b](sxy-img://${dead}) 图三`, subject: '测试', updatedAt: Date.now() });
  await db.notes.put({ id: 'n1', content: `![c](sxy-img://${live2}) 图二`, updatedAt: Date.now() });
  await db.images.put({ id: live1, blob: blob(), mime: 'image/png', createdAt: Date.now() });
  await db.images.put({ id: live2, blob: blob(), mime: 'image/png', createdAt: Date.now() });

  const t = toolRegistry.get('get_image_assets');
  assert.ok(t, '工具应已注册');
  const r = await t.execute({ limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.data.imgRefs, 3, '引用总数');
  assert.equal(r.data.imgLive, 2, '可读数');
  assert.equal(r.data.imgDangling, 1, '悬空数');
  assert.ok(r.data.danglingSample.includes(dead), '悬空清单应精确列出缺失 id');
  assert.match(r.data.hint, /悬空图片引用/, '有悬空时应给原因引导');
  await db.images.put({ id: dead, blob: blob(), mime: 'image/png', createdAt: Date.now() });
  const r2 = await t.execute();
  assert.equal(r2.data.imgDangling, 0, '补图后悬空归零');
  assert.match(r2.data.hint, /健康/, '无悬空时应报健康');

  // get_stats 引导（同一会话内，close 放最后——fake-indexeddb 单例不可 reopen）
  const st = toolRegistry.get('get_stats');
  const sr = await st.execute();
  assert.equal(sr.ok, true);
  assert.match(String(sr.data.hint), /get_image_assets/, 'hint 应引导图片体检工具');
  assert.match(String(sr.data.hint), /list_words/, 'hint 应引导单词明细工具');
  await db.close();
});
