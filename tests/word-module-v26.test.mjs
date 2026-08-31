// tests/word-module-v26.test.mjs —— 英语模块 v26 升级测试
// 覆盖：
//   A. word-print：A4 打印 HTML 构建（分页 / 三种版式 / 转义 / 乱序）
//   B. word-repo：v26 扩展字段 / 设置 CRUD / 每日签到 / 大纲元信息 / 统计
//   C. word-syllabus：大纲命中判定 + 词表数据质量（去重、无脏词）
//   D. word-llm：超纲跳过 / 未配置降级 / agent 通道解析与补档
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  createWordCard, updateWordCard, reviewWord,
  getWordSettings, saveWordSettings,
  todayStr, checkInToday, wordCheckinStreak, wordCheckinCalendar,
  saveSyllabusMetaRow, getSyllabusMetaRow,
  wordReviewedToday, wordReviewedTotal,
} from '../src/word-repo.js';
import { buildWordSheet, rowOf, shuffleCards, PAGE_SIZE } from '../src/services/word-print.js';
import { isInSyllabus, syllabusSize, listSyllabus, exportSyllabus, getSyllabusMeta } from '../src/services/word-syllabus.js';
import { generateWordMaterials } from '../src/services/word-llm.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const mkCards = (n) => Array.from({ length: n }, (_, i) => ({
  word: `word${i + 1}`, meaning: `释义${i + 1}`, phonetic: `p${i + 1}`,
}));

// ---------------- A. word-print ----------------

test('rowOf：三种版式互不重复（默写/中文词表/英文词表）', () => {
  const c = { word: 'ubiquitous', meaning: '无处不在的' };
  const a = rowOf(c, 'a4write');
  assert.deepEqual([a.left, a.rightBlank, a.leftIsEn], ['ubiquitous', true, true]);
  const z = rowOf(c, 'zhList');
  assert.deepEqual([z.left, z.rightBlank, z.leftIsEn], ['无处不在的', true, false]);
  const e = rowOf(c, 'enList');
  assert.deepEqual([e.left, e.right, e.rightBlank], ['ubiquitous', '无处不在的', false]);
  // 未知版式回退 a4write
  assert.equal(rowOf(c, 'nope').left, 'ubiquitous');
});

test('buildWordSheet：40 词/页分页 + 页码 + 空列表兜底一页', () => {
  assert.equal(PAGE_SIZE, 40);
  const r1 = buildWordSheet({ cards: mkCards(40), mode: 'a4write', title: 'T' });
  assert.equal(r1.pageCount, 1);
  assert.equal(r1.total, 40);
  assert.match(r1.html, /1 \/ 1/);

  const r2 = buildWordSheet({ cards: mkCards(41), mode: 'a4write', title: 'T' });
  assert.equal(r2.pageCount, 2);
  assert.equal((r2.html.match(/class="page"/g) || []).length, 2);
  assert.match(r2.html, /1 \/ 2/);
  assert.match(r2.html, /2 \/ 2/);
  // 第 41 词落到第二页
  assert.ok(r2.html.includes('word41'));

  // 空列表：仍渲染一页空模板（可直接打印当手写纸）
  const r0 = buildWordSheet({ cards: [], title: 'T' });
  assert.equal(r0.pageCount, 1);
  assert.equal(r0.total, 0);
});

test('buildWordSheet：留空线只出现在默写型版式', () => {
  const cards = mkCards(40);
  const blanks = (html) => (html.match(/class="blank"/g) || []).length;
  assert.equal(blanks(buildWordSheet({ cards, mode: 'a4write' }).html), 40);
  assert.equal(blanks(buildWordSheet({ cards, mode: 'zhList' }).html), 40);
  assert.equal(blanks(buildWordSheet({ cards, mode: 'enList' }).html), 0);
});

test('buildWordSheet：HTML 转义防注入 + 页眉元素齐备', () => {
  const r = buildWordSheet({
    cards: [{ word: '<script>alert(1)</script>', meaning: '"恶意" & <b>' }],
    mode: 'enList',
    title: '<img src=x>',
    metaLine: 'a & b',
  });
  assert.ok(!r.html.includes('<script>alert'));
  assert.ok(r.html.includes('&lt;script&gt;'));
  assert.ok(!r.html.includes('<img src=x>'));
  assert.ok(r.html.includes('&amp;'));
  // 页眉三件套：标题 / 模版效果图徽标 / 二维码占位；页脚水印
  assert.match(r.html, /模版效果图/);
  assert.match(r.html, /qr-box/);
  assert.match(r.html, /SxyBrick/);
  assert.match(r.html, /@page \{ size: A4 portrait/);
});

test('buildWordSheet：音标开关生效', () => {
  const cards = [{ word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' }];
  assert.match(buildWordSheet({ cards, mode: 'a4write', phonetic: true }).html, /ˈæpl/);
  assert.ok(!buildWordSheet({ cards, mode: 'a4write', phonetic: false }).html.includes('ˈæpl'));
  // 中文词表左列是释义，不显示音标
  assert.ok(!buildWordSheet({ cards, mode: 'zhList', phonetic: true }).html.includes('ˈæpl'));
});

test('shuffleCards：返回副本、元素集合不变', () => {
  const src = mkCards(30);
  const snapshot = src.map((c) => c.word);
  const out = shuffleCards(src);
  assert.notEqual(out, src);
  assert.deepEqual(src.map((c) => c.word), snapshot); // 原数组未被改动
  assert.deepEqual(out.map((c) => c.word).sort(), snapshot.slice().sort());
});

// ---------------- B. word-repo v26 ----------------

test('v26 扩展字段：创建与更新都能落库（非索引字段）', async () => {
  const c = await createWordCard({
    word: 'ubiquitous',
    meaning: '无处不在的',
    pos: 'adj.',
    synonyms: ['omnipresent', 'pervasive'],
    collocations: ['ubiquitous presence'],
    phrases: ['become ubiquitous'],
    examples: [{ level: 'simple', sentence: 'Phones are ubiquitous.', translation: '手机无处不在。' }],
    mnemonics: ['ubi(处处) + qui'],
    rootAffix: 'ubi- 处处',
    confusions: [{ word: 'unique', meaning: '独特的' }],
    syllable: 'u-biq-ui-tous',
  });
  const row = await db.wordCards.get(c.id);
  assert.equal(row.pos, 'adj.');
  assert.deepEqual(row.synonyms, ['omnipresent', 'pervasive']);
  assert.equal(row.examples[0].level, 'simple');
  assert.equal(row.confusions[0].word, 'unique');
  assert.equal(row.rootAffix, 'ubi- 处处');

  const u = await updateWordCard(c.id, { synonyms: ['omnipresent'], mnemonics: ['新助记'] });
  assert.deepEqual(u.synonyms, ['omnipresent']);
  assert.deepEqual(u.mnemonics, ['新助记']);
  // 未在补丁里的扩展字段保持原样
  assert.equal(u.rootAffix, 'ubi- 处处');
});

test('wordSettings：默认值完整 + 补丁合并 + updatedAt 推进', async () => {
  const d = await getWordSettings();
  assert.equal(d.id, 'me');
  assert.equal(d.accent, 'en-US');
  assert.equal(d.aiEnabled, true);
  assert.equal(d.dailyGoal, 20);
  assert.deepEqual(d.exampleLevels, ['simple', 'long', 'en1', 'en2']);

  const s1 = await saveWordSettings({ accent: 'en-GB', dailyGoal: 35 });
  assert.equal(s1.accent, 'en-GB');
  assert.equal(s1.dailyGoal, 35);
  assert.ok(s1.updatedAt > 0);
  // 二次补丁不覆盖上次结果
  const s2 = await saveWordSettings({ spellHint: false });
  assert.equal(s2.accent, 'en-GB');
  assert.equal(s2.dailyGoal, 35);
  assert.equal(s2.spellHint, false);
  assert.equal((await db.wordSettings.toArray()).length, 1); // 单行
});

test('每日签到：首签写入 + 重复签到幂等 + 日历含今日', async () => {
  const first = await checkInToday();
  assert.equal(first.isNew, true);
  assert.equal(first.done, false);
  assert.equal(first.streak, 1);
  assert.equal(first.date, todayStr());

  const again = await checkInToday();
  assert.equal(again.done, true);
  assert.equal(again.streak, 1);
  assert.equal((await db.wordCheckins.toArray()).length, 1);
  assert.equal(await wordCheckinStreak(), 1);

  const cal = await wordCheckinCalendar(35);
  assert.equal(cal.length, 35);
  assert.equal(cal[34].date, todayStr());
  assert.equal(cal[34].checked, true);
  assert.equal(cal[0].checked, false);
  assert.ok(cal.every((d) => d.weekday >= 0 && d.weekday <= 6));
});

test('签到连续天数：昨天签过、今天未签 → 仍算 1 天', async () => {
  await db.wordCheckins.clear();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yd = todayStr(y);
  await db.wordCheckins.put({ id: `c-${yd}`, date: yd, count: 1, createdAt: Date.now() });
  assert.equal(await wordCheckinStreak(), 1);
  // 今天补签 → 连续 2 天
  const r = await checkInToday();
  assert.equal(r.streak, 2);
  assert.equal(await wordCheckinStreak(), 2);
});

test('大纲元信息行：写入后可读回，带 loadedAt', async () => {
  assert.equal(await getSyllabusMetaRow(), undefined);
  const row = await saveSyllabusMetaRow({ wordCount: 4956, source: 'kaoyan-vocab-2027.json' });
  assert.equal(row.id, 'kaoyan2027');
  assert.equal(row.wordCount, 4956);
  assert.ok(row.loadedAt > 0);
  const got = await getSyllabusMetaRow();
  assert.equal(got.source, 'kaoyan-vocab-2027.json');
});

test('统计：今日已背 / 累计复习次数', async () => {
  const before = await wordReviewedTotal();
  const c = await createWordCard({ word: 'statword', meaning: '统计词' });
  await reviewWord(c.id, 2);
  assert.equal(await wordReviewedTotal(), before + 1);
  assert.ok((await wordReviewedToday()) >= 1);
});

// ---------------- C. word-syllabus ----------------

test('isInSyllabus：大小写/空白容错，超纲词判负', () => {
  assert.equal(isInSyllabus('abandon'), true);
  assert.equal(isInSyllabus('  ABANDON  '), true);
  assert.equal(isInSyllabus('AbAnDoN'), true);
  assert.equal(isInSyllabus('zzzqqqxxx'), false);
  assert.equal(isInSyllabus(''), false);
  assert.equal(isInSyllabus(null), false);
});

test('词表数据质量：规模达标 / 无重复 / 无脏词 / 字母序', () => {
  const list = listSyllabus();
  assert.ok(syllabusSize() >= 4500, `词表规模不足：${syllabusSize()}`);
  assert.equal(new Set(list.map((w) => w.toLowerCase())).size, list.length, '存在重复词条');
  assert.ok(!list.includes('ableab'), '生成拼接脏词 ableab 未清理');
  assert.ok(list.includes('able'));
  // 全部为合法英文词条（字母/连字符/撇号/空格）
  const bad = list.filter((w) => !/^[a-z][a-z'\-. ]*$/i.test(w));
  assert.deepEqual(bad, []);
});

test('大纲元信息与导出：官方出版物口径 + 三种导出格式', () => {
  const meta = getSyllabusMeta();
  assert.match(meta.disclaimer, /教育部考试中心/);
  assert.match(meta.disclaimer, /免费使用/);
  const md = exportSyllabus('md');
  assert.ok(md.startsWith('# '));
  assert.match(md, /共 \d+ 词/);
  assert.match(exportSyllabus('csv'), /^index,word\n/);
  assert.match(exportSyllabus('txt'), /共 \d+ 词/);
});

// ---------------- D. word-llm ----------------

test('generateWordMaterials：空词与超纲词都不调用 LLM', async () => {
  const empty = await generateWordMaterials({ word: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty-word');

  const out = await generateWordMaterials({ word: 'zzzqqqxxx', settings: {} });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, 'zzzqqqxxx');
  assert.match(out.reason, /不在考研大纲词表内/);
});

test('generateWordMaterials：未配置 provider/key → 明确报错不静默', async () => {
  const out = await generateWordMaterials({ word: 'abandon', settings: {} });
  assert.equal(out.ok, false);
  assert.match(out.reason, /未配置 LLM/);
});

test('generateWordMaterials：agent 通道解析 ```json 包裹并补齐缺失难度档', async () => {
  const agentCtx = {
    runAgent: async () => '```json\n{"synonyms":["desert","forsake","quit","drop","relinquish","give up","extra"],'
      + '"collocations":["abandon hope"],"phrases":["abandon oneself to"],"pos":"v.","mnemonic":"a+band+on",'
      + '"examples":[{"level":"simple","sentence":"They abandoned the car.","translation":"他们弃车了。"},'
      + '{"level":"unknown","sentence":"x","translation":"y"}]}\n```',
  };
  const out = await generateWordMaterials({ word: 'abandon', settings: {}, agentCtx });
  assert.equal(out.ok, true);
  assert.equal(out.data.pos, 'v.');
  assert.equal(out.data.synonyms.length, 6, '同义词应截断到 6 个');
  // 非法难度档被丢弃，四档全部补齐
  assert.deepEqual(out.data.examples.map((e) => e.level).sort(), ['en1', 'en2', 'long', 'simple']);
  assert.equal(out.data.examples.find((e) => e.level === 'simple').sentence, 'They abandoned the car.');
  assert.ok(out.data.examples.every((e) => e.sentence && e.translation));
});

test('generateWordMaterials：agent 抛错且无 Key → 回落为未配置错误', async () => {
  const agentCtx = { runAgent: async () => { throw new Error('agent down'); } };
  const out = await generateWordMaterials({ word: 'abandon', settings: {}, agentCtx });
  assert.equal(out.ok, false);
  assert.match(out.reason, /未配置 LLM/);
});
