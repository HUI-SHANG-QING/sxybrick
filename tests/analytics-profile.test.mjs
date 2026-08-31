// tests/analytics-profile.test.mjs
// 学习画像 i18n 回归测试（2026-08-31 修复）：
//
// 历史缺陷：getLearningProfile() 在数据层直接拼中文等级（优秀/良好/…）和中文 summary
// 散文。切到英文界面后「学习画像」卡片仍显示中文，且问题不在任何 .vue 里，
// i18n 闸门（只扫视图）永远扫不到 —— 与 repo.bestWorstPartners 同一类跨层缺陷。
//
// 修复后：领域层只回 levelCode（excellent/good/fair/needsWork）+ dimensions 数值，
// 文案交给视图用 t() 组装。本文件三条断言分别堵：
//   1) 数据层不得再返回中文 level / summary（防回潮）
//   2) levelCode 必须能映射到四个等级码之一（防枚举漂移）
//   3) i18n 的 profile.level.* 与 profile.summary 在 zh/en 下都能解析（防键缺失）
import { test } from 'node:test';
import assert from 'node:assert/strict';

// fake-indexeddb 必须先于 db.js 加载（db.js 顶层 new Dexie 会读 indexedDB 全局）
import 'fake-indexeddb/auto';
await import('./_env.mjs');
const { db } = await import('../src/db.js');
const { getLearningProfile } = await import('../src/agent/analytics.js');
const { t, setLocale } = await import('../src/i18n/index.js');

const LEVEL_CODES = ['excellent', 'good', 'fair', 'needsWork'];

function seedCard(id, over = {}) {
  return {
    id, front: 'F-' + id, back: 'B-' + id, subject: '计组', tags: [], type: 'basic',
    difficulty: 'basic', createdAt: Date.now(), updatedAt: Date.now(),
    ease: 2.5, level: 3, intervalDays: 5, dueAt: Date.now(), reviewedAt: Date.now(),
    fsrs: { s: 10, d: 5, reps: 3, lapses: 0, lastReviewedAt: Date.now(), state: 'review' },
    ...over,
  };
}

test('getLearningProfile：数据层不得返回中文 level / summary（只回 levelCode + 数值维度）', async () => {
  await db.cards.clear(); await db.reviews.clear();
  await db.cards.bulkPut([seedCard('a'), seedCard('b')]);
  await db.reviews.bulkPut([
    { id: 'r1', cardId: 'a', rating: 2, reviewedAt: Date.now() },
    { id: 'r2', cardId: 'b', rating: 2, reviewedAt: Date.now() },
  ]);

  const p = await getLearningProfile();

  assert.ok(p.levelCode, '应返回 levelCode');
  assert.ok(LEVEL_CODES.includes(p.levelCode), `levelCode 必须是四档枚举之一，实际 ${p.levelCode}`);
  assert.equal(p.level, undefined, '数据层不得再返回中文 level（旧实现：优秀/良好/中等/待提升）');
  assert.equal(p.summary, undefined, '数据层不得再返回中文 summary 散文');
  assert.ok(p.dimensions && typeof p.dimensions === 'object', '应返回 dimensions');
  for (const k of ['mastery', 'correct', 'stable', 'coverage', 'activity', 'correction']) {
    assert.equal(typeof p.dimensions[k], 'number', `dimensions.${k} 应为数值，实际 ${p.dimensions[k]}`);
  }
});

test('i18n：profile.level.* 四档在 zh/en 都能翻译（等级名必须外置）', () => {
  for (const loc of ['zh-CN', 'en']) {
    setLocale(loc);
    for (const code of LEVEL_CODES) {
      const v = t('profile.level.' + code, 'FALLBACK');
      assert.equal(typeof v, 'string', `${loc}: profile.level.${code} 应返回字符串`);
      assert.notEqual(v, 'FALLBACK', `${loc}: profile.level.${code} 键缺失`);
      assert.ok(!v.includes('{'), `${loc}: profile.level.${code} 不应残留占位符，实际 ${v}`);
    }
  }
  // 中文不能是英文，英文不能是中文（防止两份字典都写成同一语言）
  setLocale('en');
  const enV = t('profile.level.excellent', 'FALLBACK');
  setLocale('zh-CN');
  const zhV = t('profile.level.excellent', 'FALLBACK');
  assert.notEqual(enV, zhV, 'zh/en 等级名不应相同');
});

test('i18n：profile.summary 插值在 zh/en 都能工作', () => {
  const dims = { mastery: 80, correct: 90, stable: 85, coverage: 60, activity: 70, correction: 100 };
  for (const loc of ['zh-CN', 'en']) {
    setLocale(loc);
    const s = t('profile.summary', 'FALLBACK', dims);
    assert.notEqual(s, 'FALLBACK', `${loc}: profile.summary 键缺失`);
    assert.ok(!s.includes('{mastery}'), `${loc}: 插值未生效，实际 ${s}`);
    assert.ok(s.includes('80'), `${loc}: 应包含掌握度数值 80`);
  }
});
