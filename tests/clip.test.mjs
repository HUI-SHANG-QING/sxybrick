// tests/clip.test.mjs —— round67：图片感知截断（AI 图片链路的关键修复）
// 背景：卡片正文里的图片标记 `![image](sxy-img://<36位uuid>)` 长 56 字符，
// 任何朴素 slice 都会切坏它 → 富集时查不到图 → AI 误以为「图没传过来」。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipText, hasImageRef } from '../src/utils/clip.js';
import { extractImageIds } from '../src/images.js';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const UUID2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const MARK = `![image](sxy-img://${UUID})`;
const LONG = '计算机网络习题：停止-等待协议的重传机制与超时重传分析'; // 27 字
const WITH_IMG = `${LONG}\n${MARK}`;

test('短文本原样返回（不做任何改动）', () => {
  assert.equal(clipText('短文', 60), '短文');
  assert.equal(clipText(WITH_IMG, 500), WITH_IMG);
});

test('无图片的长文本：按 maxLen 正常截断', () => {
  const out = clipText(LONG, 10);
  assert.equal(out.length, 10);
  assert.equal(out, LONG.slice(0, 10));
});

test('含图片的长正文：任何 maxLen 下图片 id 都必须完整（本模块存在的理由）', () => {
  for (const n of [5, 10, 20, 28, 40, 60, 80]) {
    const out = clipText(WITH_IMG, n);
    assert.ok(out.includes(UUID), `maxLen=${n} 时 uuid 被切坏：${JSON.stringify(out.slice(-40))}`);
    // 用真实消费方（enrichForLlm 走的同一函数）验证：能提取出完整 id
    assert.deepEqual(extractImageIds(out), [UUID], `maxLen=${n} 时提取不到完整 id`);
  }
});

test('正文确实被截短（保护图片不等于放弃长度控制）', () => {
  const out = clipText(WITH_IMG, 10);
  assert.ok(out.startsWith(LONG.slice(0, 10)), '正文部分应被截到 maxLen');
  assert.ok(!out.includes(LONG), '完整正文不应原样保留');
});

test('多张图片引用全部保留（不被 maxLen 逐个吃掉）', () => {
  const text = `${LONG}\n![image](sxy-img://${UUID})\n中段文字\n![image](sxy-img://${UUID2})`;
  const out = clipText(text, 30);
  assert.deepEqual(extractImageIds(out).sort(), [UUID, UUID2].sort());
});

test('裸 sxy-img://id 形态（无 Markdown 外壳）同样受保护', () => {
  const out = clipText(`${LONG} 参考 sxy-img://${UUID} 结束`, 10);
  assert.deepEqual(extractImageIds(out), [UUID]);
});

test('hasImageRef：识别准确且无 lastIndex 状态（连续调用结果一致）', () => {
  assert.equal(hasImageRef(WITH_IMG), true);
  assert.equal(hasImageRef(WITH_IMG), true, '第二次调用必须仍为 true（g 标志陷阱）');
  assert.equal(hasImageRef(`裸引用 sxy-img://${UUID}`), true);
  assert.equal(hasImageRef('纯文字没有图'), false);
  assert.equal(hasImageRef(''), false);
});

test('脏输入安全：null / undefined / 非法 maxLen', () => {
  assert.equal(clipText(null, 10), '');
  assert.equal(clipText(undefined, 10), '');
  assert.equal(clipText('abc', 0), '');
  assert.equal(clipText('abc', -1), '');
  assert.equal(clipText('abc', NaN), '');
  assert.equal(clipText('abc', '10'), 'abc');
  assert.equal(clipText(12345, 3), '123');
});

test('回归：列表工具（60/80 档）场景下图片不再丢失', () => {
  // 修前实测：正文前多 5 个字（60 档）/ 25 个字（80 档）即切坏 uuid
  const front60 = '这是一张带图的计算机网络错题卡片，正文里有图和解析\n' + MARK;
  const front80 = '这道题考的是停止-等待协议的重传机制，图里画了时序\n' + MARK;
  for (const [text, n] of [[front60, 60], [front80, 80]]) {
    const out = clipText(text, n);
    assert.deepEqual(extractImageIds(out), [UUID], `maxLen=${n} 场景下图片丢失`);
  }
});

test('sxy-doc:// 资料页引用同样完整保留（页码后缀被切会静默改变送图页码）', () => {
  const ref = 'sxy-doc://DocA1b2C3#1,3-5';
  const out = clipText(`${LONG}\n参考 ${ref} 的图表`, 10);
  assert.ok(out.includes(ref), `资料引用被切坏：${JSON.stringify(out)}`);
  assert.ok(out.includes('#1,3-5'), '页码后缀必须完整');
});

test('hasImageRef 同时识别资料页引用', () => {
  assert.equal(hasImageRef('见 sxy-doc://DocA1b2C3#2 第 2 页'), true);
  assert.equal(hasImageRef('见 sxy-doc://DocA1b2C3'), true);
});
