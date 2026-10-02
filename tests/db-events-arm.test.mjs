// tests/db-events-arm.test.mjs —— 跨 tab 数据变更广播是否真的装配成功（round125 审计）
//
// 背景（真实缺陷）：`armDbNotify` 原本用 `dbInstance.on('creating'|'updating'|'deleting')` 装配，
//   但 Dexie 的**实例级** `db.on()` 只接受 populate / ready / versionchange ——
//   对 CRUD 三个事件名它会**直接抛错**（`Cannot read properties of undefined (reading 'subscribe')`），
//   CRUD 事件属于 **Table 级** 的 `table.hook(ev, cb)`。
//   而原实现外面裹着 try/catch ⇒ 错误被静默吞掉：装配「看似成功」、运行时**一次都不触发**
//   ⇒ 整套「跨 tab 数据变更广播」名存实亡：
//     · intelligence 的卡片缓存收不到失效通知（退化为 5s TTL 兜底）；
//     · WordBook / WordPhrases / WordGroups 在别的 tab 写库后永不自动刷新。
// 本测试在 jsdom 下实测「写 / 改 / 删是否真的派发了 sxy:dbchanged」。
import 'fake-indexeddb/auto';
import './_env.mjs';
import { JSDOM } from 'jsdom';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

// notifyDbChanged 走 window + CustomEvent（Node 下会空转），所以先备好 DOM 再**动态导入** db.js，
// 保证它顶层的 armDbNotify 装配发生在 window 就绪之后。
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.CustomEvent = dom.window.CustomEvent;

const { db } = await import('../src/db.js');
const { armDbNotify } = await import('../src/utils/dbEvents.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fired = 0;
dom.window.addEventListener('sxy:dbchanged', () => { fired += 1; });

const mk = (id) => ({ id, front: 'f', back: 'b', subject: 's', createdAt: 1, updatedAt: 1, dueAt: 1 });

before(async () => {
  await db.open();
  armDbNotify(db);              // 幂等（内部 __dbNotifyArmed 守卫）
  await db.cards.clear();
  await sleep(250);             // 吃掉 clear 可能产生的广播
  fired = 0;
});

test('写操作会派发 sxy:dbchanged（修复前一次都不触发）', async () => {
  fired = 0;
  await db.cards.put(mk('ev-1'));
  await sleep(300);             // 等 150ms trailing 节流
  assert.ok(fired > 0, `写入后应至少广播 1 次，实际 ${fired}（为 0 说明 hook 没装上）`);
});

test('改与删同样会派发', async () => {
  await db.cards.put(mk('ev-2'));
  await sleep(300);

  fired = 0;
  await db.cards.update('ev-2', { front: 'f2' });
  await sleep(300);
  assert.ok(fired > 0, `更新后应广播，实际 ${fired}`);

  fired = 0;
  await db.cards.delete('ev-2');
  await sleep(300);
  assert.ok(fired > 0, `删除后应广播，实际 ${fired}`);
});

test('批量连写被 trailing 节流成个位数广播（不产生广播风暴）', async () => {
  fired = 0;
  for (let i = 0; i < 50; i++) await db.cards.put(mk(`ev-b${i}`));
  await sleep(320);
  assert.ok(
    fired >= 1 && fired <= 4,
    `50 次连续写应被 150ms trailing 节流为个位数广播，实际 ${fired}`,
  );
});

test('重复装配不会让 hook 累积（__dbNotifyArmed 守卫）', async () => {
  armDbNotify(db);
  armDbNotify(db);
  await sleep(220);
  fired = 0;
  await db.cards.put(mk('ev-3'));
  await sleep(320);
  assert.ok(fired <= 2, `重复装配后单次写不应产生多次广播，实际 ${fired}`);
});

test('结构闸门：不得再对 Dexie 实例调用 db.on(creating|updating|deleting)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/utils/dbEvents.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:'"`])\/\/[^\n]*/, '$1'))
    .join('\n');
  assert.doesNotMatch(
    src, /\.on\(\s*['"](creating|updating|deleting)['"]/,
    'Dexie 实例级 db.on() 不支持 CRUD 事件（会抛错且被 try/catch 吞掉）——'
    + '必须改用 table.hook(ev, cb)。',
  );
});
