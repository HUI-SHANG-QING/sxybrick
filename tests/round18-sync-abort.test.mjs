// tests/round18-sync-abort.test.mjs —— 复现用户报告的同步模块 AbortError：
// "The transaction was aborted, so the request cannot be fulfilled. AbortError"
// 场景假设：hub 增量同步（buildIncrementalBackup → PUT → importBackup 大事务）与
// 单词复习提交（reviewWord / recordWordStudyTime 小事务）并发。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { reviewWord, recordWordStudyTime } from '../src/word-repo.js';
import { buildBackup, importBackup } from '../src/sync.js';

const after = (await import('node:test')).after;
after(async () => { try { await db.close(); } catch {} });

function mkWord(i, extra = {}) {
  return {
    id: `w-${i}`, word: `word${i}`, meaning: `释义${i}`, kind: 'word',
    subject: '英语', ease: 2.5, level: 0, intervalDays: 0,
    dueAt: 1000, reviewedAt: 0, createdAt: 1000, updatedAt: 1000,
    pos: 'n.', defs: [{ pos: 'n.', meaning: `释义${i}` }],
    synonyms: ['syn1'], collocations: [`word${i} up`],
    examples: [{ level: 1, sentence: `this is word${i} in use`, translation: '例句翻译' }],
    mnemonics: '词根记忆', ...extra,
  };
}

test('复现：hub 大事务导入与复习小事务并发不产生 AbortError', async () => {
  // 本地种 60 张单词卡
  const local = [];
  for (let i = 0; i < 60; i++) {
    await db.wordCards.put(mkWord(i));
    local.push(i);
  }

  // 「对端」备份：20 张新卡 + 20 张旧卡的更新（bump updatedAt），模拟 LAN 对端增量
  const backup = await buildBackup();
  const incoming = { ...backup, app: 'sxybrick' };
  incoming.cards = incoming.cards || [];
  incoming.wordCards = [];
  for (let i = 60; i < 80; i++) incoming.wordCards.push(mkWord(i));
  for (let i = 0; i < 20; i++) incoming.wordCards.push(mkWord(i, { updatedAt: 2000, meaning: `对端更新${i}` }));

  // 并发：importBackup 大事务进行中同时提交复习（不同表 wordCards/wordReviews/wordStudyLog）
  const importP = importBackup(incoming, { skipSnapshot: true });
  const reviewPs = [];
  for (let i = 0; i < 6; i++) {
    reviewPs.push(reviewWord(`w-${i}`, 2).catch((e) => e));
    reviewPs.push(recordWordStudyTime(3000).catch((e) => e));
  }
  const [stats] = await Promise.all([importP, Promise.all(reviewPs).then((rs) => rs.filter((r) => r instanceof Error))]);

  const errs = await Promise.all(reviewPs);
  const hardErrors = errs.filter((e) => e instanceof Error);
  assert.equal(hardErrors.length, 0, `并发复习不应失败：${hardErrors.map(String).join(' | ')}`);
  assert.ok(stats, '导入应成功');

  // 数据完整性：新卡进库、更新被合并、复习已落库
  const total = await db.wordCards.count();
  assert.ok(total >= 80, `应有 ≥80 张卡，实际 ${total}`);
  const rv = await db.wordReviews.count();
  assert.ok(rv >= 6, `应有 ≥6 条复习记录，实际 ${rv}`);
});

test('复现：wordCards 带扩展字段二次导入（幂等）+ 中文字段合并不 Abort', async () => {
  const backup = await buildBackup();
  const incoming = { ...backup, app: 'sxybrick' };
  incoming.wordCards = [];
  for (let i = 0; i < 30; i++) {
    incoming.wordCards.push(mkWord(i, { updatedAt: 3000 + i, meaning: `二次合并${i}` }));
  }
  // 同卡对端形状更简（无扩展字段）但 updatedAt 更新（5000>3000）——
  // 内容赢家语义：meaning 取 5000 行的默认值；AI 扩展字段并集保护不被清空
  incoming.wordCards.push({ ...mkWord(5), updatedAt: 5000, pos: undefined, defs: undefined, synonyms: undefined, collocations: undefined, examples: undefined, mnemonics: undefined });
  const stats = await importBackup(incoming, { skipSnapshot: true });
  assert.ok(stats);
  const row = await db.wordCards.get('w-5');
  assert.equal(row.meaning, '释义5', '内容赢家语义：updatedAt=5000 的行赢 meaning');
  assert.ok(Array.isArray(row.examples), 'AI 扩展字段应被并集保护不被清空');
  const row6 = await db.wordCards.get('w-6');
  assert.equal(row6.meaning, '二次合并6', '常规更新行内容应取胜');
});

test('复现：全 31 表带空数组/空对象数据的整包导入不 Abort', async () => {
  // 极端形状：每张同步表都有若干行为空对象/缺字段的行（filter 应兜住）
  const backup = await buildBackup();
  const incoming = { ...backup, app: 'sxybrick' };
  for (const key of ['wordReviews', 'reviews', 'graphEdges', 'embeddings', 'dailyPlans', 'dailyTasks', 'wordStudyLog']) {
    incoming[key] = [
      { id: `${key}-a`, updatedAt: 9000 },
      { id: `${key}-b` }, // 无任何时间戳
    ];
  }
  incoming.images = [{ id: 'img-x', data: 'invalid-base64!!', mime: 'image/png' }];
  await assert.doesNotReject(() => importBackup(incoming, { skipSnapshot: true }), '畸形数据导入不应以 AbortError 失败');
});
