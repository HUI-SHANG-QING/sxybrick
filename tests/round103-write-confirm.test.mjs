// tests/round103-write-confirm.test.mjs —— round103 回归
//
// 诉求（用户原话）：「加一道"写入前先问你一句"的保险」。
// 实现：普通问答（assistant）路径开启 confirmWrites 后，写工具（writesData:true）
// 必须先经用户确认（前端弹确认框 → 批准后带 approvedWrite 重跑）才能执行。
// 本文件锁定：① 未批准 → 拦截且不真正执行；② 批准匹配 → 放行且一次性；
//            ③ 批准不匹配 → 仍拦截；④ 未开启 confirmWrites → 直接执行（工作台不回归）；
//            ⑤ 读工具不受影响。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { executeTool } from '../src/agent/agents/base.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

// 测试探针：写探针记录真实执行次数（用于断言"未执行/执行"）
let writeCalls = 0;
toolRegistry.register({
  name: 'test_write_probe_round103',
  description: 'round103 测试用写探针',
  parameters: {},
  writesData: true,
  async execute() { writeCalls++; return { ok: true, data: { done: true } }; },
});

let readCalls = 0;
toolRegistry.register({
  name: 'test_read_probe_round103',
  description: 'round103 测试用读探针',
  parameters: {},
  readsData: true,
  async execute() { readCalls++; return { ok: true, data: { done: true } }; },
});

const noop = () => {};

test('写工具：confirmWrites 开启且未批准 → 拦截（needsConfirm），不真正执行', async () => {
  writeCalls = 0;
  const res = await executeTool('test_write_probe_round103', { a: 1 }, { confirmWrites: true }, noop);
  assert.equal(res.ok, false);
  assert.equal(res.needsConfirm, true);
  assert.equal(res.name, 'test_write_probe_round103');
  assert.equal(writeCalls, 0, '拦截时绝不能执行写入');
});

test('写工具：confirmWrites 开启 + approvedWrite 匹配 → 放行执行一次，且批准被清除', async () => {
  writeCalls = 0;
  const ctx = { confirmWrites: true, approvedWrite: { name: 'test_write_probe_round103', args: { a: 1 } } };
  const res = await executeTool('test_write_probe_round103', { a: 1 }, ctx, noop);
  assert.equal(res.ok, true);
  assert.equal(writeCalls, 1);
  assert.equal(ctx.approvedWrite, undefined, '放行后批准应被清除（一次性，防止连续自动写）');
});

test('写工具：confirmWrites 开启 + approvedWrite 不匹配（不同工具名）→ 仍拦截', async () => {
  writeCalls = 0;
  const ctx = { confirmWrites: true, approvedWrite: { name: 'create_note', args: {} } };
  const res = await executeTool('test_write_probe_round103', { a: 1 }, ctx, noop);
  assert.equal(res.needsConfirm, true);
  assert.equal(writeCalls, 0, '批准了别的工具不能放行本工具');
});

test('写工具：confirmWrites 未开启（默认/工作台路径）→ 直接执行，行为不回归', async () => {
  writeCalls = 0;
  const res = await executeTool('test_write_probe_round103', {}, {}, noop);
  assert.equal(res.ok, true);
  assert.equal(writeCalls, 1, '工作台 Agent 不开启确认，写入应照常执行');
});

test('读工具：不受 confirmWrites 影响 → 直接执行', async () => {
  readCalls = 0;
  const res = await executeTool('test_read_probe_round103', {}, { confirmWrites: true }, noop);
  assert.equal(res.ok, true);
  assert.equal(readCalls, 1, '读工具不应被确认门波及');
});
