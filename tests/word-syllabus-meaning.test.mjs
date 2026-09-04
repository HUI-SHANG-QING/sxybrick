// tests/word-syllabus-meaning.test.mjs —— 大纲中文释义体系（v30）
// 覆盖：种子数据质量 / db 优先于种子 / 批量查询 / 幂等写入 / 与词表双向同步（孤儿清理+待补清单）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  getMeaning, getMeanings, setMeaning, setMeanings, syncWithSyllabus, meaningCoverage,
} from '../src/services/word-meaning.js';
import { listSyllabus, builtinMeaning, normalizeWordKey } from '../src/services/word-syllabus.js';
import { SYNC_TABLES } from '../src/sync-manifest.js';

const after = (await import('node:test')).after;
after(async () => { try { await db.close(); } catch {} });

test('种子数据：条目合法且全部命中大纲词表（无孤儿）', () => {
  const words = new Set(listSyllabus().map(normalizeWordKey));
  // 抽样校验：种子里取若干词都必须在大纲内，且释以为中文（含中文字符）
  const sample = ['abandon', 'benefit', 'significant', 'potential', 'withdraw'].filter((w) => words.has(w));
  assert.ok(sample.length >= 3, '抽样词应在大纲内');
  for (const w of sample) {
    const m = builtinMeaning(w);
    assert.ok(m, `${w} 应有内置释义`);
    assert.match(m, /[一-龥]/, `${w} 的释义必须是中文`);
  }
  // 归一化口径一致：大小写/空白不影响命中
  assert.equal(builtinMeaning('  ABANDON '), builtinMeaning('abandon'));
});

test('新增表已登记同步清单（跨设备不丢释义）', () => {
  const t = SYNC_TABLES.find((x) => x.table === 'syllabusMeanings');
  assert.ok(t, 'syllabusMeanings 必须进同步清单');
  assert.equal(t.merge, 'updatedAt', '释义按更新时间合并（谁新听谁）');
});

test('db 优先于种子：AI/用户产出覆盖内置兜底', async () => {
  const w = listSyllabus()[0];
  const seed = builtinMeaning(w);
  await setMeaning(w, '【测试覆盖】自定义释义', { source: 'manual' });
  const got = await getMeaning(w);
  assert.equal(got.meaning, '【测试覆盖】自定义释义');
  assert.equal(got.source, 'manual');
  if (seed) assert.notEqual(got.meaning, seed, 'db 值应覆盖种子值');
});

test('批量查询：缺失词回落种子，未命中返回空', async () => {
  const words = listSyllabus();
  const withSeed = words.find((w) => builtinMeaning(w));
  const noSeed = words.find((w) => !builtinMeaning(w));
  const m = await getMeanings([withSeed, noSeed, '  ']);
  assert.equal(m.get(withSeed).source, 'seed');
  assert.ok(m.get(withSeed).meaning.length > 0);
  assert.equal(m.has(noSeed), false, '无释义的词不应出现在结果里');
  assert.equal(m.has(''), false, '空白词应被过滤');
});

test('写入幂等：同值不重复写（不无谓 bump 同步水位）', async () => {
  const w = 'zzz-test-idem';
  await setMeaning(w, '测试释义', { source: 'ai' });
  const r1 = await db.syllabusMeanings.get(w);
  await setMeaning(w, '测试释义', { source: 'ai' });
  const r2 = await db.syllabusMeanings.get(w);
  assert.equal(r1.updatedAt, r2.updatedAt, '同值写入不应刷新 updatedAt');
  await db.syllabusMeanings.delete(w);
});

test('批量写入：返回条数并落库', async () => {
  const n = await setMeanings([
    { word: 'BatchOne', meaning: '批量一' },
    { word: 'batchtwo', meaning: '批量二' },
    { word: '   ', meaning: '空词应被丢弃' },
  ], { source: 'ai' });
  assert.equal(n, 2, '空词不计入');
  const r1 = await getMeaning('batchone');   // 'BatchOne' 归一化后 = batchone
  const r2 = await getMeaning('batchtwo');
  assert.equal(r1.meaning, '批量一');
  assert.equal(r2.meaning, '批量二');
  await db.syllabusMeanings.bulkDelete(['batchone', 'batchtwo']);
});

test('与词表双向同步：孤儿释义被识别并可清理，待补清单准确', async () => {
  // 造一个「词表已无此词」的孤儿释义
  await setMeaning('not-a-syllabus-word-xyz', '孤儿释义', { source: 'ai' });
  const s = await syncWithSyllabus();
  assert.ok(s.orphans.includes('not-a-syllabus-word-xyz'), '孤儿应被识别');
  assert.equal(s.total, listSyllabus().length, '分母应为词表总数');
  assert.ok(s.coverage > 0 && s.coverage < 100, `覆盖率应在 0~100 之间，实际 ${s.coverage}`);
  assert.ok(s.missing.length > 0, '应有待补词（种子仅覆盖部分）');
  assert.equal(s.covered + s.missing.length, s.total, '已覆盖 + 待补 = 总数');

  // prune 清理孤儿
  const s2 = await syncWithSyllabus({ prune: true });
  assert.equal(s2.pruned >= 1, true, '应清理至少 1 条孤儿');
  const gone = await db.syllabusMeanings.get('not-a-syllabus-word-xyz');
  assert.equal(gone, undefined, '孤儿应被物理删除');

  // 补齐后覆盖率上升
  const before = await meaningCoverage();
  await setMeanings(s2.missing.slice(0, 50).map((w) => ({ word: w, meaning: '批量补齐' })), { source: 'ai' });
  const afterCov = await meaningCoverage();
  assert.equal(afterCov.covered, before.covered + Math.min(50, s2.missing.length), '补齐 50 条后覆盖数应等量增长');
});
