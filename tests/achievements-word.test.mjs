// tests/achievements-word.test.mjs —— P2-B 单词模块接入成就体系
// 覆盖：
//   1) collectAchievementStats 返回 words/wordReviews/wordStreak 三项
//   2) 单词成就（words_20/words_100/word_reviews_50/word_streak_7）随数据解锁判定
//   3) 单词表不可用（旧库过渡）不阻断成就页
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDbInstance, getDb } from '../src/db.js';

const { collectAchievementStats, evaluateAchievements, ACHIEVEMENTS } = await import('../src/achievements.js');
const { unlockAchievement } = await import('../src/repo.js');

const T = Date.now();
const DAY = 86400000;

function seedWordData(db, { words = 0, reviews = 0, streakDays = 0 } = {}) {
  const jobs = [];
  for (let i = 1; i <= words; i++) {
    jobs.push(db.wordCards.put({ id: `aw-w${i}`, kind: 'word', word: `word${i}`, meaning: `释义${i}`, subject: '考研', familiar: 0, ease: 2.5, level: 0, intervalDays: 0, dueAt: T, reviewedAt: 0, createdAt: T, updatedAt: T }));
  }
  for (let i = 1; i <= reviews; i++) {
    jobs.push(db.wordReviews.put({ id: `aw-r${i}`, cardId: 'aw-w1', reviewedAt: T - i * 1000, rating: i % 2 ? 2 : 0, grade: i % 2 ? 'easy' : 'failed', gradeScore: i % 2 ? 0.95 : 0, levelAfter: 1 }));
  }
  const d = new Date();
  for (let back = streakDays - 1; back >= 0; back--) {
    const dd = new Date(d);
    dd.setDate(dd.getDate() - back);
    const date = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
    jobs.push(db.wordCheckins.put({ id: `c-${date}`, date, count: streakDays - back, createdAt: T }));
  }
  return Promise.all(jobs);
}

test('collectAchievementStats：返回单词维度 words/wordReviews/wordStreak', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.transaction('rw', db.wordCards, db.wordReviews, db.wordCheckins, async () => {
    for (const t of [db.wordCards, db.wordReviews, db.wordCheckins]) await t.clear();
  });
  await seedWordData(db, { words: 5, reviews: 12, streakDays: 3 });

  const s = await collectAchievementStats();
  assert.equal(s.words, 5, 'words 统计应来自 wordCards');
  assert.equal(s.wordReviews, 12, 'wordReviews 统计应来自 wordReviews');
  assert.equal(s.wordStreak, 3, 'wordStreak 应来自 wordCheckins 连续天数');
});

test('单词成就：words_20 / word_reviews_50 / word_streak_7 解锁判定', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.transaction('rw', db.wordCards, db.wordReviews, db.wordCheckins, async () => {
    for (const t of [db.wordCards, db.wordReviews, db.wordCheckins]) await t.clear();
  });
  // 22 词 + 55 次复习 + 连续 8 天签到 → 三个成就全部达标
  await seedWordData(db, { words: 22, reviews: 55, streakDays: 8 });

  const list = await evaluateAchievements();
  const byKey = Object.fromEntries(list.map(a => [a.key, a]));
  // unlocked 来自落库的 achievements 表（评估不自动落库），这里断言进度/数值 + 显式解锁验证真实流程
  assert.equal(byKey.words_20.value, 22, 'words_20 数值=22');
  assert.equal(byKey.words_20.progress, 1, 'words_20 进度满');
  assert.equal(byKey.words_100.progress, 0.22, 'words_100 进度 22/100');
  assert.equal(byKey.word_reviews_50.value, 55, 'word_reviews_50 数值=55');
  assert.equal(byKey.word_streak_7.value, 8, 'word_streak_7 数值=8');
  assert.ok(byKey.word_reviews_50.progress >= 1 && byKey.word_streak_7.progress >= 1, '达标成就进度满');
  // 解锁流程真实生效（unlockAchievement 落库，幂等）
  const row = await unlockAchievement('words_20');
  assert.ok(row && row.key === 'words_20', 'words_20 应解锁落库');
  const again = await unlockAchievement('words_20');
  assert.equal(again, null, '重复解锁返回 null（不可逆）');
  // 成就目录登记完整
  for (const k of ['words_20', 'words_100', 'word_reviews_50', 'word_streak_7']) {
    assert.ok(ACHIEVEMENTS.some(a => a.key === k), `成就 ${k} 应在目录中`);
  }
});

test('成就页：空单词数据不阻断（words 归 0，记忆卡成就不受影响）', async () => {
  setDbInstance('test');
  const db = getDb();
  await db.transaction('rw', db.wordCards, db.wordReviews, db.wordCheckins, db.cards, async () => {
    for (const t of [db.wordCards, db.wordReviews, db.wordCheckins, db.cards]) await t.clear();
  });
  await db.cards.put({ id: 'aw-c1', front: '卡一', back: '答', subject: '计网', tags: [], ease: 2.5, level: 1, intervalDays: 1, dueAt: T, reviewedAt: 0, createdAt: T, updatedAt: T });

  const s = await collectAchievementStats();
  assert.equal(s.words, 0, '无单词数据 words=0');
  assert.equal(s.wordStreak, 0, '无打卡 wordStreak=0');
  assert.equal(s.cards, 1, '记忆卡统计不受影响');
  const list = await evaluateAchievements();
  assert.equal(list.find(a => a.key === 'words_20').value, 0, '无单词数据 words_20 数值 0');
  assert.equal(list.find(a => a.key === 'words_20').progress, 0);
  assert.equal(list.find(a => a.key === 'first_card').value, 1, '记忆卡成就数值照常');
  const first = await unlockAchievement('first_card');
  assert.ok(first && first.key === 'first_card', '记忆卡成就照常解锁');

  setDbInstance('real');
});
