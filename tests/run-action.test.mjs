// tests/run-action.test.mjs —— round107：统一动作包装 runAction 的行为契约
//
// 背景：一批「点一下就写库」的按钮此前是裸 `await repo.xxx()`，失败只进全局日志
// （用户看到"点了没反应"），且失败后**后续语句照旧执行**（成功才该有的 toast/刷新），
// 界面与数据分叉。runAction 把语义固定成：**失败必定提示、成功才走后续**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAction } from '../src/utils/action.js';

test('成功：返回 ok + 值，并按序执行 then（拿到同一份值）', async () => {
  const seen = [];
  const r = await runAction(async () => 42, { then: (v) => { seen.push(v); } });
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
  assert.deepEqual(seen, [42], 'then 必须拿到动作的返回值');
});

test('失败：不抛出、返回 ok=false，且**绝不执行 then**（这是"界面与数据分叉"的根源）', async () => {
  let thenRan = false;
  const boom = new Error('配额已满');
  const r = await runAction(async () => { throw boom; }, { then: () => { thenRan = true; } });
  assert.equal(r.ok, false);
  assert.equal(r.error, boom);
  assert.equal(thenRan, false, '动作失败时后续（成功提示/刷新）不得执行');
});

test('失败：同步抛错同样被捕获（不是只处理 promise reject）', async () => {
  const r = await runAction(() => { throw new Error('sync-boom'); });
  assert.equal(r.ok, false);
  assert.match(String(r.error.message), /sync-boom/);
});

test('成功但后续失败 ≠ 操作失败：返回 ok=true，不得把已写入的数据报成失败', async () => {
  const r = await runAction(async () => 'written', {
    then: () => { throw new Error('refresh-boom'); },
  });
  assert.equal(r.ok, true, '动作本身成功 → 必须 ok=true（否则用户会以为没写进去）');
  assert.equal(r.value, 'written');
});

test('silent：不弹提示但仍如实返回失败（供已有更精细反馈的场景用）', async () => {
  const r = await runAction(async () => { throw new Error('x'); }, { silent: true });
  assert.equal(r.ok, false);
});

test('无 then 时也正常工作（大量"只写库"的调用点）', async () => {
  const r = await runAction(async () => ({ id: 'c1' }));
  assert.deepEqual(r, { ok: true, value: { id: 'c1' } });
});

test('错误对象缺失 message 时不得崩（String(e) 兜底）', async () => {
  const r = await runAction(async () => { throw {}; }); // eslint-disable-line no-throw-literal
  assert.equal(r.ok, false);
});
