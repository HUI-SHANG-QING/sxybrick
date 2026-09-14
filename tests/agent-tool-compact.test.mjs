// tests/agent-tool-compact.test.mjs —— 工具结果进上下文的长度预算
// 背景（2026-09-14 用户实测）：ReAct 把工具结果原样 JSON 塞进上下文，
// search_cards 一次返回 11 张含 OCR 长文本的卡片就几万字符 → 请求超限/超时 →
// 用户看到「AI 合成回答暂不可用」反复失败（"每次都要失败 3 次左右"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactToolPayload } from '../src/agent/tools/compact.js';

test('小结果原样返回（零开销、不破坏 JSON 可解析性）', () => {
  const data = { ok: true, items: [{ id: 'a', title: '短标题' }] };
  const out = compactToolPayload(data);
  assert.equal(out, JSON.stringify(data));
  assert.deepEqual(JSON.parse(out), data, '未超限时必须仍是合法 JSON');
});

test('大数组：留前 N 项 + 明确标注还剩多少（不冒充"全部"）', () => {
  const data = { items: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, title: `卡片${i}` })) };
  const out = compactToolPayload(data, { maxChars: 500, maxItems: 8 });
  assert.ok(out.length <= 500, `压缩后应不超预算，实际 ${out.length}`);
  assert.match(out, /还有 32 项/, '要说明被省略的条数');
  assert.match(out, /卡片0/, '前几项应保留');
  assert.match(out, /卡片7/, '第 8 项（maxItems 边界）应保留');
  assert.ok(!out.includes('卡片9'), '超出 maxItems 的项应被省略')
});

test('长字符串字段：截断并标注原长度（模型据此知道还有内容）', () => {
  const long = 'x'.repeat(5000);
  const out = compactToolPayload({ text: long }, { maxChars: 800, maxStringLen: 100 });
  assert.ok(out.length <= 800, `实际 ${out.length}`);
  assert.match(out, /本字段共 5000 字，已截断/);
});

test('深层嵌套：限深省略，不无限递归', () => {
  // 要触发压缩必须先超预算，所以用「大数组包深对象」构造
  const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
  const big = { items: Array.from({ length: 60 }, () => deep) };
  const out = compactToolPayload(big, { maxChars: 600, maxDepth: 2, maxStringLen: 5 });
  assert.ok(out.length <= 600 + 200, `不会因递归膨胀，实际 ${out.length}`);
  assert.match(out, /层级过深|已省略|已截断/);
});

test('极端小预算：直接硬截断，不产出比预算还长的说明', () => {
  const out = compactToolPayload({ a: 'x'.repeat(5000) }, { maxChars: 50 });
  assert.equal(out.length, 50);
});

test('预算兜底：无论如何不超过 maxChars + 说明长度', () => {
  const huge = { items: Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, body: 'y'.repeat(2000) })) };
  const out = compactToolPayload(huge, { maxChars: 2000 });
  assert.ok(out.length <= 2000 + 80, `实际 ${out.length}，应贴近预算上限`);
});

test('真实场景：11 张带 OCR 长文本的卡片检索结果被压进预算', () => {
  const cards = Array.from({ length: 11 }, (_, i) => ({
    id: `id-${i}`,
    title: `#${i + 1} 计算机网络 · 数据链路层`,
    detail: '停止-等待协议：发送窗口 Wt=1、接收窗口 Wr=1；确认帧 ACK_i、超时重传、1 bit 编号、Wt+Wr≤2ⁿ；'.repeat(20),
  }));
  const raw = JSON.stringify(cards);
  assert.ok(raw.length > 8000, `原始结果应确实很大（实际 ${raw.length}）`);
  const out = compactToolPayload(cards, { maxChars: 4000 });
  assert.ok(out.length <= 4000 + 120, `压缩后 ${out.length} 应在预算内`);
  assert.match(out, /已按结构压缩/, '要告知模型这是压缩过的结果');
  assert.match(out, /计算机网络/, '关键结构信息应保留（可读性不丢）');
});

test('非 JSON 可序列化 / 空值：安全返回，不抛错', () => {
  assert.equal(compactToolPayload(undefined), '');
  assert.equal(compactToolPayload(null), 'null');
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => compactToolPayload(cyclic));
});
