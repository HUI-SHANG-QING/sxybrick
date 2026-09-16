// tests/agent-word-tools.test.mjs —— round88
//
// 背景：用户反馈「单词模块只能看统计，看不到明细」。实证核验后确认根因在**工具层**：
//   `src/word-repo.js` 有 830 行、API 齐全（listWordCards / wordStats / wordGroupStats /
//   dueWordCards / wordReviewHistory …），但 `src/agent/tools/index.js` 的 61 个内置工具里
//   **一个单词工具都没有** —— 英语词库独立在 `db.wordCards`（与 `db.cards` 分表），
//   所以 AI 对单词模块的可见度是 0。用户问「我背了哪些单词 / 这个词什么意思」时，
//   学习答疑导师手上没有工具可调，只能回答「我看不到」——与卡片域修复前是同一类缺陷。
//
// 本轮补三个工具，按「列表四件套」分工：
//   list_words（摘要 + id + 分页 + 引导）→ get_word_detail（全文）→ get_word_stats（统计概览）。
//
// 本文件钉住：工具存在、四件套齐全、摘要不泄漏全文、过滤参数不被吞、单条读取两条定位路径、
// 以及「Agent 确实挂上了它们」（工具存在但没挂 = 对模型依旧不可见，是同一类 bug 的复发形态）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { toolRegistry, agentRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import '../src/agent/agents/index.js';
import { db } from '../src/db.js';
import { createWordCard, markFamiliar } from '../src/word-repo.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const WORD_TOOLS = ['list_words', 'get_word_detail', 'get_word_stats'];

async function resetWords() {
  await db.wordCards.clear();
  await db.wordGroups.clear();
  await db.wordGroupLinks.clear();
}

// ---------------- A. 工具存在 + 四件套 ----------------

test('三个单词工具必须已注册，且 list_words 具备分页（摘要 + id + 分页 + 详情引导）', () => {
  for (const n of WORD_TOOLS) assert.ok(toolRegistry.get(n), `工具 ${n} 未注册（AI 对单词模块依旧不可见）`);
  const list = toolRegistry.get('list_words');
  assert.ok('limit' in list.parameters, 'list_words 缺 limit：模型只能拿到默认条数');
  assert.ok('offset' in list.parameters, 'list_words 缺 offset：模型无法翻页取全，只能答「我只看到 N 条」');
  assert.ok(list.description.includes('get_word_detail'), 'list_words 描述要点名详情工具，否则模型不知道能取全文');
  assert.match(toolRegistry.get('get_word_stats').description, /list_words/, '统计工具要引导到取内容的工具，别把摘要当全文');
});

test('四类 Agent 都必须挂上单词工具（工具存在但没挂 = 对模型依旧不可见）', () => {
  const mustHave = {
    tutor: WORD_TOOLS,
    analyst: WORD_TOOLS,
    'smart-reviewer': WORD_TOOLS,
    quizmaster: ['list_words', 'get_word_detail'],
  };
  for (const [id, needed] of Object.entries(mustHave)) {
    const agent = agentRegistry.get(id);
    assert.ok(agent, `Agent ${id} 未注册`);
    for (const n of needed) {
      assert.ok((agent.tools || []).includes(n), `Agent「${agent.name}」缺工具 ${n}`);
    }
  }
});

test('单词模块此前完全没有 AI 工具——反向闸门：不得再退回 0 个', () => {
  const all = toolRegistry.list().map((t) => t.name);
  const wordish = all.filter((n) => /word/.test(n));
  assert.ok(wordish.length >= 3, `单词相关工具至少要 3 个（实际 ${wordish.length}：${wordish.join(', ')}）`);
});

// ---------------- B. list_words：摘要 + 分页 + 过滤 ----------------

test('list_words：每项给 id 与摘要，不回传全文；分页能翻完；过滤参数生效', async () => {
  await resetWords();
  const long = '释义很长'.repeat(60); // 240 字，超过摘要上限
  const N = 25;
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await createWordCard({
      word: `word${String(i).padStart(2, '0')}`,
      phonetic: `/w${i}/`,
      meaning: `${long}-${i}`,
      example: `This is word${i}.`,
      note: `笔记${i}`,
      kind: 'word',
    });
  }

  const list = toolRegistry.get('list_words');
  const p1 = await list.execute({ limit: 20 });
  assert.equal(p1.ok, true);
  assert.equal(p1.data.total, N);
  assert.equal(p1.data.items.length, 20);
  assert.equal(p1.data.hasMore, true, '还有剩余必须标记 hasMore');
  assert.ok(p1.data.items.every((x) => x.id && x.word), '每项必须有 id 与词形（否则无法跟进 get_word_detail）');
  assert.ok(p1.data.items.every((x) => x.meaning.length <= 161), '摘要必须截断，长释义不得整段回传（会撑爆上下文）');
  assert.ok(p1.data.items.every((x) => !('example' in x) && !('note' in x)), '列表不得回传例句/笔记全文');

  const p2 = await list.execute({ limit: 20, offset: 20 });
  assert.equal(p2.data.items.length, 5);
  assert.equal(p2.data.hasMore, false);
  const words = [...p1.data.items, ...p2.data.items].map((x) => x.word).sort();
  assert.equal(new Set(words).size, N, '两页合起来应覆盖全部词卡，无遗漏无重复');

  const byQ = await list.execute({ q: 'word07' });
  assert.equal(byQ.data.total, 1, '关键词检索应生效');
  assert.equal(byQ.data.items[0].word, 'word07');

  const byKind = await list.execute({ kind: 'sentence' });
  assert.equal(byKind.data.total, 0, '类别过滤应生效（本批全部是 word）');
});

test('list_words：familiar=0 不得被吞成「不过滤」（`Number(v) || undefined` 反模式回归）', async () => {
  await resetWords();
  const a = await createWordCard({ word: 'alpha', meaning: '甲' });
  await createWordCard({ word: 'beta', meaning: '乙' });
  await markFamiliar(a.id, 1);

  const list = toolRegistry.get('list_words');
  const onlyUnfamiliar = await list.execute({ familiar: 0 });
  assert.equal(onlyUnfamiliar.data.total, 1, 'familiar=0 必须真的只返回未标熟词');
  assert.equal(onlyUnfamiliar.data.items[0].word, 'beta');
  const onlyFamiliar = await list.execute({ familiar: 1 });
  assert.equal(onlyFamiliar.data.total, 1);
  assert.equal(onlyFamiliar.data.items[0].word, 'alpha');
  const all = await list.execute({});
  assert.equal(all.data.total, 2, '不传 familiar 才是「全部」');
  const blank = await list.execute({ familiar: '' });
  assert.equal(blank.data.total, 2, '空串同样应视为「全部」（Number("") === 0 是这里最危险的坑）');
});

test('list_words：词库整体为空时显式报错并给可执行指引（不静默返回 total:0）', async () => {
  await resetWords();
  const r = await toolRegistry.get('list_words').execute({});
  assert.equal(r.ok, false, '空词库要说清「还没导入」，否则模型容易误报成「没有匹配的单词」');
  assert.match(r.error, /单词/);
});

// ---------------- C. get_word_detail：两条定位路径 + 全文 ----------------

test('get_word_detail：按 id 与按单词都能取到全文，找不到时显式报错', async () => {
  await resetWords();
  const c = await createWordCard({
    word: 'protocol', phonetic: '/ˈprəʊtəkɒl/', meaning: 'n. 协议；规程',
    example: 'The protocol was ratified.', exampleTrans: '该协议已获批准。',
    note: '计网里指通信双方共同遵守的规则。', tags: ['计网', '高频'],
  });

  const d = toolRegistry.get('get_word_detail');
  const byId = await d.execute({ id: c.id });
  assert.equal(byId.ok, true);
  assert.equal(byId.data.word, 'protocol');
  assert.ok(byId.data.meaning.includes('协议'), '全文必须含完整释义');
  assert.equal(byId.data.exampleTrans, '该协议已获批准。', '例句翻译不能丢（用户背的就是这一对）');
  assert.ok(byId.data.note.includes('共同遵守'), '用户自己记的笔记必须能读到');
  assert.deepEqual(byId.data.tags, ['计网', '高频']);

  const byWord = await d.execute({ word: 'protocol' });
  assert.equal(byWord.data.id, c.id, '按词形也能定位到同一条');

  const miss = await d.execute({ word: 'definitely-not-in-vocab' });
  assert.equal(miss.ok, false, '找不到时必须显式报错（静默返回空会让模型编造释义）');
});

test('get_word_detail：只传 id 不存在时也要有可执行指引，不能空手而归', async () => {
  await resetWords();
  const r = await toolRegistry.get('get_word_detail').execute({ id: 'no-such-id' });
  assert.equal(r.ok, false);
  assert.match(r.error, /list_words/, '要给「下一步用哪个工具」的指引');
});

// ---------------- D. get_word_stats：统计概览 ----------------

test('get_word_stats：给出总量/到期/复习队列/已背次数，以及各词组掌握率', async () => {
  await resetWords();
  await createWordCard({ word: 'gamma', meaning: '丙' });
  await createWordCard({ word: 'delta', meaning: '丁', kind: 'template' });
  const { createWordGroup, setWordGroups } = await import('../src/word-repo.js');
  const g = await createWordGroup({ name: '考研核心' });
  const [first] = await db.wordCards.toArray();
  await setWordGroups([first.id], [g.id]);

  const s = toolRegistry.get('get_word_stats');
  const r = await s.execute({});
  assert.equal(r.ok, true);
  assert.equal(r.data.total, 2);
  assert.equal(r.data.templates, 1, '模板卡不计入可复习数');
  assert.equal(r.data.schedulable, 1);
  assert.ok(r.data.dueQueue >= 1, '新卡应立即到期，实际复习队列长度要给出');
  assert.equal(typeof r.data.reviewedTotal, 'number');
  const group = r.data.groups.find((x) => x.groupId === g.id);
  assert.ok(group, '各词组掌握率必须在结果里');
  assert.equal(group.name, '考研核心', '词组要带名字（只给 id 模型读不懂）');
  assert.equal(group.total, 1);
});

test('get_word_stats 只给统计、不给单词正文（避免模型把统计当内容回答）', async () => {
  await resetWords();
  await createWordCard({ word: 'epsilon', meaning: '戊' });
  const r = await toolRegistry.get('get_word_stats').execute({});
  const blob = JSON.stringify(r.data);
  assert.ok(!blob.includes('epsilon'), '统计工具不得泄漏具体单词（否则模型会拿它冒充「我看到了你的词」）');
});
