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
import { hasLocalEntry, loadAllShards, localWords } from '../src/services/word-enrich.js';
import { WORD_EXT_FIELDS } from '../src/sync-manifest.js';
import { EXT_FIELDS } from '../src/word-repo.js';
import { readFileSync } from 'node:fs';

// 考研英语大纲词表（4956 词），用于本测试「动态挑一个未收录的大纲词」走 AI 通道。
const SYLLABUS = JSON.parse(
  readFileSync(new URL('../src/data/kaoyan-vocab-2027.json', import.meta.url), 'utf8'),
).words;

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

test('round38 ①：同一天多设备分片求和——一端时长不再丢失', async () => {
  await db.wordStudyLog.clear(); // 隔离
  await recordWordStudyTime(1000); // 本机 1s
  const local = (await db.wordStudyLog.toArray())[0];
  assert.ok(/_/.test(local.id) || /-/.test(local.id), '本机行 id 应含分片（date 之外）');
  assert.match(local.id, /^t-\d{4}-\d{2}-\d{2}-/, `本机 id 应为 t-<date>-<deviceId>，实际 ${local.id}`);
  // 模拟「另一台设备同步进来的同一天行」（不同 id、同一 date）
  await db.wordStudyLog.put({ id: `t-${local.date}-otherdevice`, date: local.date, ms: 2000, updatedAt: 1 });
  assert.equal(await wordStudyTimeToday(), 3000, '今日应为两台之和（1000 + 2000），不丢任何一端');
  assert.equal(await wordStudyTimeToday(), 3000, '重复读取不改变结果（幂等，无累加副作用）');
  // 旧格式行（升级前 `t-<date>`，无设备后缀）也须计入，且不重复计数
  await db.wordStudyLog.put({ id: `t-${local.date}`, date: local.date, ms: 500, updatedAt: 1 });
  assert.equal(await wordStudyTimeToday(), 3500, '旧格式行应一并汇总');
  await db.wordStudyLog.clear();
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
  // 本用例验证的是「AI 通道的脏数据归一化」：必须走 AI 通道，因此所选词需满足
  // 「在大纲内（否则被门控拒绝）」且「本地词库未收录（否则本地优先命中，不走 AI）」。
  // 自动词库扩充任务按字母顺序持续收录大纲词，任何硬编码词迟早会被收录；
  // 故此处动态从大纲中取「首个本地词库尚未收录」的词，从根本上避免前置断言回归。
  await loadAllShards();
  const enriched = new Set(localWords());
  const WORD = SYLLABUS.find((w) => !enriched.has(w));
  assert.ok(WORD, '应能从大纲中找到未收录的词用于 AI 通道测试');
  assert.ok(!hasLocalEntry(WORD), `动态选取的词 ${WORD} 不应已在本地词库收录（否则不走 AI）`);
  const agentCtx = {
    runAgent: async () => JSON.stringify({
      syllable: '  ban·ner  ',
      defs: [
        { pos: 'n.', meaning: '横幅，标语' },
        { pos: 'n.', meaning: '（网络）横幅广告' },
        null, // 噪音行应被过滤
      ],
      synonyms: ['flag'],
      collocations: ['hang a banner'],
      phrases: ['under the banner of'],
      derived: [
        { word: 'banner ad', meaning: 'n. 横幅广告' },
        { word: '', meaning: '空词应被过滤' },
      ],
      rootAffix: '  ban(旗) + -er(名词后缀)  ',
      examples: [
        { level: 'simple', sentence: 'A banner hung across the street.', translation: '一条横幅横挂在街上。' },
      ],
      pos: 'n.',
      mnemonic: 'ban 记「旗」',
    }),
  };
  const out = await generateWordMaterials({ word: WORD, settings: {}, agentCtx, allowAi: true });
  assert.equal(out.ok, true);
  assert.equal(out.data.syllable, 'ban·ner', '音节应 trim');
  assert.equal(out.data.defs.length, 2, 'defs 空行应被过滤');
  assert.deepEqual(out.data.defs[0], { pos: 'n.', meaning: '横幅，标语' });
  assert.equal(out.data.derived.length, 1, '空 word 的派生项应被过滤');
  assert.equal(out.data.rootAffix, 'ban(旗) + -er(名词后缀)', '词根应 trim');
  // 补档：缺 long 例句应本地补一条
  assert.deepEqual(out.data.examples.map((e) => e.level).sort(), ['long', 'simple']);
});

// ---------------- D. round18 闸门回归（derived 并集保护） ----------------

test('derived 已进 WORD_EXT_FIELDS 并集保护（跨设备合并不丢）', () => {
  assert.ok(EXT_FIELDS.includes('derived'), 'repo 层 EXT_FIELDS 应含 derived');
  assert.ok(WORD_EXT_FIELDS.includes('derived'), 'sync 层 WORD_EXT_FIELDS 应含 derived');
});
