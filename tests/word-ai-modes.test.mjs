// tests/word-ai-modes.test.mjs —— 英语 AI 智能模块（v31）
// 覆盖：13 模式契约 / 出题提示词 / 校验器（不信任 LLM）/ 归一化 / 合并 /
//       generateModeQuestions 全链路（fake agent 注入）/ batchGenerateMeanings 批量补释义。
// 关键设计：generateModeQuestions 内部走 callLlmJson，其「agent 优先」分支会调用
//   agentCtx.runAgent —— 测试用 fake agent 注入假 LLM 输出，即可在不联网、不 mock
//   模块的前提下验证「LLM 脏数据被 validateModeQuestion 拦截」的核心逻辑。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  REVIEW_MODES, MODE_IDS, modeContract, isChoiceMode,
  buildModesPrompt, validateModeQuestion, normalizeModeQuestions,
  generateModeQuestions, applyModeQuestions, batchGenerateMeanings, hasLlmChannel,
  MODES_BY_KIND, modesForCard, kindOf,
} from '../src/services/word-ai-modes.js';

const after = (await import('node:test')).after;
after(async () => { try { await db.close(); } catch {} });

const card = {
  word: 'abandon', meaning: '放弃，抛弃', pos: 'v.',
  defs: [{ pos: 'v.', meaning: '放弃，抛弃' }],
  synonyms: ['desert', 'forsake'], collocations: ['abandon hope'],
  examples: [{ sentence: 'They had to abandon the plan.' }],
};
// fake agent：runAgent 直接回传一段 JSON 字符串（模拟 LLM 返回），不碰网络
const fakeAgent = (data) => ({ runAgent: async () => JSON.stringify(data) });

test('13 模式契约：answerSide 分布正确、id 无重复', () => {
  assert.equal(REVIEW_MODES.length, 13);
  assert.equal(new Set(MODE_IDS).size, 13, '模式 id 必须唯一');
  const zh = REVIEW_MODES.filter((m) => m.answerSide === 'zh').map((m) => m.id);
  const en = REVIEW_MODES.filter((m) => m.answerSide === 'en').map((m) => m.id);
  assert.deepEqual(zh, ['adaptive', 'choice', 'listenChoice', 'spell', 'flashcard', 'readAloud']);
  assert.deepEqual(en, ['listenSpell', 'reverseChoice', 'cloze', 'sentenceCloze', 'englishEnglish', 'collocations']);
  assert.equal(REVIEW_MODES.find((m) => m.id === 'quiz').answerSide, 'mix');
  assert.equal(modeContract('choice').answerSide, 'zh');
  assert.equal(modeContract('nope'), null);
  assert.equal(isChoiceMode('choice'), true);
  assert.equal(isChoiceMode('spell'), false);
});

test('出题提示词：含词、只含指定模式、选择题要求 options', () => {
  const p = buildModesPrompt(card, ['choice', 'spell']);
  assert.match(p, /abandon/);
  assert.match(p, /- choice/);
  assert.match(p, /- spell/);
  assert.match(p, /options/, '选择题模式应要求生成干扰项');
  assert.doesNotMatch(p, /- listenSpell/, '未指定模式不应出现在提示词里');
});

test('校验器：zh 模式答案必须中文、en 模式答案必须是词本身', () => {
  assert.equal(validateModeQuestion('spell', { q: 'abandon', a: '放弃，抛弃' }, card).ok, true);
  assert.equal(validateModeQuestion('spell', { q: 'abandon', a: 'desert' }, card).ok, false, 'zh 模式英文答案应拒');
  const cloze = validateModeQuestion('cloze', { q: 'aba____', a: 'abandon' }, card);
  assert.equal(cloze.ok, true);
  assert.equal(cloze.item.a, 'abandon', 'en 模式统一回填标准词形');
  assert.equal(validateModeQuestion('cloze', { q: 'aba____', a: 'desert' }, card).ok, false, 'en 模式答案必须等于单词本身');
  assert.equal(validateModeQuestion('cloze', { q: 'aba____', a: '放弃' }, card).ok, false, 'en 模式中文答案应拒');
});

test('校验器：题干不得泄露答案', () => {
  assert.equal(
    validateModeQuestion('englishEnglish', { q: 'abandon means to give up', a: 'abandon' }, card).ok,
    false, 'en 模式题干含完整词 = 泄露答案');
  assert.equal(
    validateModeQuestion('spell', { q: '放弃，抛弃', a: '放弃，抛弃' }, card).ok,
    false, 'zh 模式题干含中文释义 = 泄露答案');
});

test('校验器：选择题选项含正确项且去重 ≥2', () => {
  const ok = validateModeQuestion('choice', {
    q: 'abandon', a: '放弃，抛弃',
    options: ['放弃，抛弃', '抛弃', '离弃', '丢弃'],
  }, card);
  assert.equal(ok.ok, true);
  assert.equal(ok.item.options.length, 4);
  const bad = validateModeQuestion('choice', {
    q: 'abandon', a: '放弃，抛弃', options: ['desert', 'forsake', 'quit'],
  }, card);
  assert.equal(bad.ok, false, '选项中无正确中文答案应拒');
  const dup = validateModeQuestion('choice', {
    q: 'abandon', a: '放弃，抛弃', options: ['放弃，抛弃', '放弃，抛弃'],
  }, card);
  assert.equal(dup.ok, false, '去重后不足 2 项应拒');
});

test('归一化：保留合法、丢弃非法并记录原因', () => {
  const data = { modes: {
    spell: { q: 'abandon', a: '放弃，抛弃' },
    cloze: { q: 'aba____', a: 'abandon' },
    choice: { q: 'abandon', a: 'desert' }, // 非法：zh 模式英文答案
  } };
  const n = normalizeModeQuestions(card, data, ['spell', 'cloze', 'choice']);
  assert.equal(n.count, 2);
  assert.ok(n.modes.spell && n.modes.cloze);
  assert.equal(n.dropped.length, 1);
  assert.equal(n.dropped[0].mode, 'choice');
});

test('合并：不覆盖已有其他模式、bump updatedAt', () => {
  const base = { id: 'c1', word: 'abandon', modeQuestions: { spell: { q: 'x', a: '放弃' } }, updatedAt: 100 };
  const out = applyModeQuestions(base, { cloze: { q: 'aba____', a: 'abandon' } });
  assert.ok(out.modeQuestions.spell, '保留已有 spell');
  assert.ok(out.modeQuestions.cloze, '新增 cloze');
  assert.ok(out.updatedAt > 100);
});

test('生成全链路：合法结果通过、脏数据被丢弃（fake agent 注入）', async () => {
  const good = { modes: {
    spell: { q: 'abandon', a: '放弃，抛弃' },
    cloze: { q: 'aba____', a: 'abandon' },
    choice: { q: 'abandon', a: '放弃，抛弃', options: ['放弃，抛弃', '抛弃', '离弃', '丢弃'] },
    quiz: { q: 'abandon', a: '放弃，抛弃', options: ['放弃，抛弃', '抛弃', '离弃', '丢弃'] },
    flashcard: { q: 'abandon', a: 'desert' }, // 非法：zh 模式英文答案
  } };
  const r = await generateModeQuestions({
    card, modes: ['spell', 'cloze', 'choice', 'quiz', 'flashcard'],
    settings: {}, agentCtx: fakeAgent(good),
  });
  assert.equal(r.ok, true);
  assert.equal(r.modes.spell.q, 'abandon');
  assert.ok(r.modes.cloze && r.modes.choice && r.modes.quiz);
  assert.equal(r.dropped.some((d) => d.mode === 'flashcard'), true, 'flashcard 脏数据应被丢弃');
  assert.equal(r.via, 'agent');
});

test('批量补释义：仅合法中文落库、非中文丢弃', async () => {
  const data = { meanings: { q1word: '测试一', q2word: 'test' } };
  const r = await batchGenerateMeanings({
    words: ['q1word', 'q2word'], settings: {}, agentCtx: fakeAgent(data), batchSize: 10,
  });
  assert.equal(r.generated, 1, '仅中文释义入库');
  assert.equal(r.failed, 1, '非中文丢弃');
  const m = await import('../src/services/word-meaning.js');
  const got = await m.getMeaning('q1word');
  assert.equal(got.meaning, '测试一');
  assert.equal(got.source, 'ai');
  await db.syllabusMeanings.delete('q1word');
});

test('通道判定：agent 或用户 Key 任一可用', () => {
  assert.equal(hasLlmChannel({}, { runAgent: () => {} }), true);
  assert.equal(hasLlmChannel({ llmProvider: 'deepseek', llmApiKey: 'k', llmModel: 'm' }, null), true);
  assert.equal(hasLlmChannel({}, null), false);
});

// v40：按 kind 分轨出题（phrase 全 13 模式但答案=整短语；sentence 只 6 种中文答案模式；template 拒绝）
test('MODES_BY_KIND / modesForCard：分轨表正确且默认模式随 kind 变化', () => {
  assert.equal(MODES_BY_KIND.word.length, 13);
  assert.equal(MODES_BY_KIND.phrase.length, 13);
  assert.deepEqual(MODES_BY_KIND.sentence, ['adaptive', 'choice', 'spell', 'flashcard', 'readAloud', 'quiz']);
  assert.equal(MODES_BY_KIND.template.length, 0);
  // 未知 kind 回退 word
  assert.deepEqual(modesForCard({ kind: 'bogus' }), MODE_IDS);
  assert.equal(kindOf({}), 'word');
  assert.equal(kindOf({ kind: 'phrase' }), 'phrase');
});

test('buildModesPrompt：phrase 用「目标短语」、sentence 用「目标句子」且不含词性/义项行', () => {
  const phraseCard = { word: 'take place', meaning: '发生，举行', kind: 'phrase' };
  const p = buildModesPrompt(phraseCard);
  assert.ok(p.includes('目标短语：take place'), 'phrase 提示词应带目标短语标签');
  assert.ok(p.includes('请基于下面这个短语'), 'phrase 提示词应说明词条类型');
  assert.ok(!p.includes('义项'), 'phrase 不应出现义项行（只有单词有义项）');
  const sentCard = { word: 'The ceremony will take place on Friday.', meaning: '仪式将在周五举行。', kind: 'sentence' };
  const s = buildModesPrompt(sentCard);
  assert.ok(s.includes('目标句子：The ceremony will take place on Friday.'), 'sentence 提示词应带目标句子标签');
  assert.ok(!s.includes('义项'), 'sentence 不应出现义项行');
  assert.ok(!s.includes('词性：'), 'sentence 不应出现词性行');
  assert.ok(!s.includes('englishEnglish'), 'sentence 默认模式不含英英释义');
});

test('validateModeQuestion：phrase 答案必须整短语一致，单词单复数变形仍容忍', () => {
  // 单词：单数→复数变形仍通过（原行为）
  const wordCard = { word: 'abandon', meaning: '放弃', kind: 'word' };
  const wOk = validateModeQuestion('cloze', { q: 'aband__n', a: 'abandon' }, wordCard);
  assert.equal(wOk.ok, true);
  const wPlural = validateModeQuestion('cloze', { q: 'aband__n', a: 'abandons' }, wordCard);
  assert.equal(wPlural.ok, true, 'word 容忍单复数变形');
  // 短语：答案必须整短语一致，偷换单词/截断短语都拒绝
  const phraseCard = { word: 'take place', meaning: '发生', kind: 'phrase' };
  assert.equal(validateModeQuestion('cloze', { q: 'take ____', a: 'take place' }, phraseCard).ok, true);
  assert.equal(validateModeQuestion('cloze', { q: 'take ____', a: 'place' }, phraseCard).ok, false, '短语截断应拒绝');
  assert.equal(validateModeQuestion('cloze', { q: 'take ____', a: 'takes place' }, phraseCard).ok, false, '短语内单词变形应拒绝');
});

test('generateModeQuestions：template 卡返回 no-modes-for-template，sentence 卡默认 6 模式', async () => {
  const tpl = await generateModeQuestions({ card: { word: '模板', kind: 'template' }, settings: {}, agentCtx: fakeAgent({ modes: {} }) });
  assert.equal(tpl.ok, false);
  assert.equal(tpl.reason, 'no-modes-for-template');
  // sentence 默认 6 模式：fake agent 回 6 个全中文答案模式的合法题（choice/quiz 属选择题需带 options）
  const six = { modes: {} };
  for (const id of ['adaptive', 'choice', 'spell', 'flashcard', 'readAloud', 'quiz']) {
    six.modes[id] = (id === 'choice' || id === 'quiz')
      ? { q: '题目', a: '中文答案', options: ['中文答案', '干扰一', '干扰二', '干扰三'] }
      : { q: '题目', a: '中文答案' };
  }
  const sent = await generateModeQuestions({
    card: { word: 'It is well known that.', meaning: '众所周知。', kind: 'sentence' },
    settings: {}, agentCtx: fakeAgent(six),
  });
  assert.equal(sent.ok, true);
  assert.equal(Object.keys(sent.modes).length, 6);
});
