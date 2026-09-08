// tests/card-merge-fieldts.test.mjs —— round29 P0：卡片内容字段级合并
// 背景：mergeCardPair 的内容侧长期是**整行 LWW**（CARD_CONTENT_FIELDS 定义在
// sync-manifest.js:162，但从未参与合并），两端并发编辑不同字段会静默丢一端的修改。
// 现在按写入侧维护的字段级时间戳 fieldTs 逐字段取新；老数据无 fieldTs 时退回整行 LWW。
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCardPair, CARD_CONTENT_FIELDS } from '../src/sync-manifest.js';

const base = {
  id: 'c1', front: '原正面', back: '原背面', subject: '计组', tags: ['原标签'],
  mnemonic: '', source: '', type: 'basic', marked: false, difficulty: 'basic',
  updatedAt: 1000, reviewedAt: 0, ease: 2.5, level: 0, intervalDays: 0, dueAt: 0,
  fieldTs: Object.fromEntries(CARD_CONTENT_FIELDS.map(f => [f, 1000])),
};

test('字段级：两端改不同字段 → 两边修改都保留（旧实现会丢一端）', () => {
  const local = { ...base, front: 'A改的正面', updatedAt: 2000, fieldTs: { ...base.fieldTs, front: 2000 } };
  const incoming = { ...base, back: 'B改的背面', updatedAt: 3000, fieldTs: { ...base.fieldTs, back: 3000 } };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, 'A改的正面', 'A 的 front 修改必须保留');
  assert.equal(m.back, 'B改的背面', 'B 的 back 修改必须保留');
});

test('字段级：同一字段两端都改 → 取 fieldTs 更大的一方', () => {
  const local = { ...base, front: '旧的', updatedAt: 5000, fieldTs: { ...base.fieldTs, front: 2000 } };
  const incoming = { ...base, front: '新的', updatedAt: 1000, fieldTs: { ...base.fieldTs, front: 4000 } };
  // 注意：整行 updatedAt 是 local 更大，按旧逻辑会取旧的；字段级应取 front 时间戳更新的
  assert.equal(mergeCardPair(local, incoming).front, '新的');
});

test('向后兼容：两端都没有 fieldTs → 退回整行 LWW（与修复前行为一致）', () => {
  const noTs = (o) => { const { fieldTs, ...rest } = o; return rest; };
  const local = noTs({ ...base, front: 'L正面', updatedAt: 2000 });
  const incoming = noTs({ ...base, front: 'I正面', back: 'I背面', updatedAt: 3000 });
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, 'I正面', '无 fieldTs 时仍按整行 updatedAt 取新');
  assert.equal(m.fieldTs, undefined, '两端都无 fieldTs 时不凭空产出该字段');
});

test('健壮性：时间戳更新的那一端缺字段（undefined）→ 不覆盖已有有效值', () => {
  const local = { ...base, source: '本地来源', updatedAt: 1000, fieldTs: { ...base.fieldTs, source: 1000 } };
  const incoming = { ...base, updatedAt: 9000, fieldTs: { ...base.fieldTs, source: 9000 } };
  delete incoming.source; // 老版本包缺字段
  assert.equal(mergeCardPair(local, incoming).source, '本地来源');
});

test('fieldTs 自身取两端逐字段最大值（不参与 LWW 覆盖）', () => {
  const local = { ...base, fieldTs: { ...base.fieldTs, front: 2000, back: 7000 } };
  const incoming = { ...base, fieldTs: { ...base.fieldTs, front: 5000, back: 3000 } };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.fieldTs.front, 5000);
  assert.equal(m.fieldTs.back, 7000);
});

test('SRS 字段仍按 reviewedAt 合并（不受内容改动影响）', () => {
  const local = { ...base, ease: 2.5, level: 3, reviewedAt: 9000 };
  const incoming = { ...base, ease: 1.8, level: 1, reviewedAt: 1000 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.reviewedAt, 9000);
  assert.equal(m.ease, 2.5);
  assert.equal(m.level, 3);
});
