// tests/word-v27-learned.test.mjs —— 英语模块 v27 对标成熟单词 App 升级测试
// 覆盖：
//   A. 学习时长：recordWordStudyTime 累计 / 5 分钟封顶 / 空值忽略 / 今日与累计查询
//   B. 派生字段：derived / syllable 落库与更新往返（EXT_FIELDS 全链路）
//   C. word-llm：AI 生成结果含 syllable / defs / derived / rootAffix 的归一化
//   D. round18 闸门回归：derived 已进 WORD_EXT_FIELDS 并集保护（跨设备不丢）
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  createWordCard, updateWordCard,
  recordWordStudyTime, wordStudyTimeToday, wordStudyTimeTotal,
} from '../src/word-repo.js';
import { generateWordMaterials } from '../src/services/word-llm.js';
import { WORD_EXT_FIELDS } from '../src/sync-manifest.js';
import { EXT_FIELDS } from '../src/word-repo.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

// ---------------- A. 学习时长 ----------------

test('recordWordStudyTime：当日累计 + 查询', async () => {
  const before = await wordStudyTimeToday();
  await recordWordStudyTime(2 * 60 * 1000); // 2 分钟
  await recordWordStudyTime(60 * 1000);     // 1 分钟
  const after = await wordStudyTimeToday();
  assert.equal(after - before, 3 * 60 * 1000, '当日应累计 3 分钟');
});

test('recordWordStudyTime：单次增量封顶 5 分钟（防挂机虚增）', async () => {
  const before = await wordStudyTimeToday();
  await recordWordStudyTime(60 * 60 * 1000); // 1 小时 → 截断为 5 分钟
  const after = await wordStudyTimeToday();
  assert.equal(after - before, 5 * 60 * 1000);
});

test('recordWordStudyTime：非法增量（0/负数/NaN）静默忽略', async () => {
  const before = await wordStudyTimeToday();
  await recordWordStudyTime(0);
  await recordWordStudyTime(-1000);
  await recordWordStudyTime(NaN);
  assert.equal(await wordStudyTimeToday(), before, '不应有任何变化');
});

test('wordStudyTimeTotal：累计 = 全表 ms 求和（含当日）', async () => {
  const today = await wordStudyTimeToday();
  const total = await wordStudyTimeTotal();
  assert.ok(total >= today, '累计时长不小于今日时长');
});

// ---------------- B. 派生字段（derived / syllable） ----------------

test('derived / syllable：createWordCard 落库 + updateWordCard 往返', async () => {
  const derived = [
    { word: 'alternatively', meaning: 'adv. 或者' },
    { word: 'alternation', meaning: 'n. 交替' },
  ];
  const c = await createWordCard({
    word: 'alternative',
    meaning: '可替代的',
    syllable: 'al·ter·na·tive',
    derived,
  });
  assert.equal(c.syllable, 'al·ter·na·tive');
  assert.deepEqual(c.derived, derived);

  const u = await updateWordCard(c.id, {
    derived: [{ word: 'alternatively', meaning: 'adv. 或者' }],
  });
  assert.equal(u.derived.length, 1, '更新应整体覆盖 derived 数组');
});

// ---------------- C. word-llm：新字段归一化 ----------------

test('generateWordMaterials：syllable / defs / derived / rootAffix 归一化', async () => {
  const agentCtx = {
    runAgent: async () => JSON.stringify({
      syllable: '  al·ter·na·tive  ',
      defs: [
        { pos: 'adj.', meaning: '可替代的' },
        { pos: 'n.', meaning: '可供选择的事物' },
        null, // 噪音行应被过滤
      ],
      synonyms: ['substitute'],
      collocations: ['an alternative plan'],
      phrases: ['have no alternative but to do'],
      derived: [
        { word: 'alternatively', meaning: 'adv. 或者' },
        { word: '', meaning: '空词应被过滤' },
      ],
      rootAffix: '  alter(改变) + -ative(形容词后缀)  ',
      examples: [
        { level: 'simple', sentence: 'We need an alternative plan.', translation: '我们需要一个替代计划。' },
      ],
      pos: 'adj./n.',
      mnemonic: 'alt 记「改变」',
    }),
  };
  const out = await generateWordMaterials({ word: 'alternative', settings: {}, agentCtx });
  assert.equal(out.ok, true);
  assert.equal(out.data.syllable, 'al·ter·na·tive', '音节应 trim');
  assert.equal(out.data.defs.length, 2, 'defs 空行应被过滤');
  assert.deepEqual(out.data.defs[0], { pos: 'adj.', meaning: '可替代的' });
  assert.equal(out.data.derived.length, 1, '空 word 的派生项应被过滤');
  assert.equal(out.data.rootAffix, 'alter(改变) + -ative(形容词后缀)', '词根应 trim');
  // 补档：缺 long 例句应本地补一条
  assert.deepEqual(out.data.examples.map((e) => e.level).sort(), ['long', 'simple']);
});

// ---------------- D. round18 闸门回归（derived 并集保护） ----------------

test('derived 已进 WORD_EXT_FIELDS 并集保护（跨设备合并不丢）', () => {
  assert.ok(EXT_FIELDS.includes('derived'), 'repo 层 EXT_FIELDS 应含 derived');
  assert.ok(WORD_EXT_FIELDS.includes('derived'), 'sync 层 WORD_EXT_FIELDS 应含 derived');
});
