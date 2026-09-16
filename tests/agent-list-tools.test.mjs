// tests/agent-list-tools.test.mjs —— round74
//
// 背景：用户反馈「AI 连卡片内容都看不到」，卡片域上一轮已修（search_cards 补 back + 翻页）。
// 本轮把同一类缺陷在**笔记 / AI 文档 / 资料库 / 计划 / 每日任务 / 备忘**六个模块补齐，
// 并把「列表类工具四件套」固化成闸门：**摘要 + id + 分页 + 详情引导**。
//
// 本轮抓到的真实事故（本文件第 1 条断言就是防它复发）：
//   `list_lib_docs` 的描述写着「再用 read_doc 读具体内容」——但注册表里**根本没有 read_doc**
//   （真实工具叫 read_lib_doc）。模型照描述去调 → 撞「未知工具」→ 白费一步并可能直接回答
//   「我看不到资料内容」。描述里的工具名与注册表必须一致。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import '../src/agent/agents/index.js';
import { agentRegistry } from '../src/agent/registry.js';
import { db } from '../src/db.js';
import {
  createNote, createDoc, createPlan, createDailyPlan, addMemo,
} from '../src/repo.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

/** 工具描述/参数里出现的 snake_case 标识符 —— 除下列「非工具词」外必须都是已注册工具 */
const NON_TOOL_TOKENS = new Set([
  // 参数取值枚举（出现在 parameters 说明里，不是工具名）
  'summary', 'note', 'plan', 'other', 'pending', 'partial', 'skipped', 'done', 'active', 'archived',
]);

// ---------------- A. 描述里引用的工具名必须真实存在 ----------------

test('工具描述/参数里出现的工具名必须已注册（防 read_doc 这类幽灵名）', () => {
  const names = new Set(toolRegistry.list().map((t) => t.name));
  const bad = [];
  for (const t of toolRegistry.list()) {
    const blob = [t.description, ...Object.values(t.parameters || {})].join(' ');
    for (const m of blob.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      const tok = m[0];
      if (names.has(tok) || NON_TOOL_TOKENS.has(tok)) continue;
      bad.push(`${t.name} 的描述引用了未注册的工具名：${tok}`);
    }
  }
  assert.deepEqual(bad, [], '描述里让模型去调的工具必须真实注册，否则模型必然撞「未知工具」');
});

test('Agent 的 tools 列表里每个名字都必须已注册（防拼错导致工具静默不可用）', () => {
  const names = new Set(toolRegistry.list().map((t) => t.name));
  for (const a of agentRegistry.list()) {
    for (const t of a.tools || []) {
      assert.ok(names.has(t), `Agent「${a.name}」挂了一个不存在的工具：${t}`);
    }
  }
});

// ---------------- B. 列表类工具四件套：摘要 + id + 分页 + 详情引导 ----------------

/** 列表工具 → 它的「读全文」搭档（null = 该项本身已是全文，无需详情工具） */
const LIST_TOOLS = {
  list_notes: 'read_note',
  list_docs: 'read_doc',
  list_plans: 'read_plan',
  list_lib_docs: 'read_lib_doc',
  search_cards: 'get_card_detail',
  get_weak_cards: 'get_card_detail',
  list_memos: null,
  list_daily_tasks: null,
  // round88：英语单词模块此前**连列表工具都没有**（AI 对 db.wordCards 可见度为 0）。
  // 新工具直接纳入这张表，四件套（摘要 + id + 分页 + 详情引导）由同一道闸门统一兜住。
  list_words: 'get_word_detail',
};

test('列表类工具必须提供分页参数（只给前 N 条又不让翻页 = 模型只能答"我只看到 N 条"）', () => {
  for (const name of Object.keys(LIST_TOOLS)) {
    const tool = toolRegistry.get(name);
    assert.ok(tool, `列表工具 ${name} 未注册`);
    assert.ok('offset' in (tool.parameters || {}), `${name} 缺少 offset 参数：模型无法翻页取全`);
    assert.ok('limit' in (tool.parameters || {}), `${name} 缺少 limit 参数`);
  }
});

test('列表类工具必须在描述里点名它的详情工具（否则模型不知道能取全文）', () => {
  for (const [name, detail] of Object.entries(LIST_TOOLS)) {
    if (!detail) continue;
    const tool = toolRegistry.get(name);
    assert.ok(tool.description.includes(detail), `${name} 的描述没有提到 ${detail}：模型不会去取全文`);
    assert.ok(toolRegistry.get(detail), `${name} 指向的详情工具 ${detail} 未注册`);
  }
});

test('「读全文」类工具必须支持 id 或标题两种定位方式', () => {
  for (const name of ['read_note', 'read_doc', 'read_plan', 'read_lib_doc']) {
    const tool = toolRegistry.get(name);
    assert.ok(tool, `${name} 未注册`);
    const p = tool.parameters || {};
    assert.ok('id' in p || 'docId' in p, `${name} 必须能用 id 精确定位`);
    assert.ok('title' in p || 'name' in p, `${name} 必须能用标题/名称模糊定位（模型常常只有标题）`);
  }
});

// ---------------- C. 真实数据端到端 ----------------

test('笔记：列表给摘要 + 分页，read_note 按 id 与标题都能取到全文', async () => {
  await db.notes.clear();
  const N = 25;
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await createNote({
      title: `笔记${i}`,
      content: `# 笔记${i}\n正文内容 ${'线'.repeat(60)}`,
      category: '线代',
      tags: ['特征值'],
    });
  }
  const list = toolRegistry.get('list_notes');
  const p1 = await list.execute({ limit: 20 });
  assert.equal(p1.data.total, N);
  assert.equal(p1.data.items.length, 20);
  assert.equal(p1.data.hasMore, true, '还有剩余必须标记 hasMore');
  assert.ok(p1.data.items.every((x) => x.id && 'preview' in x), '每项必须有 id 与正文摘要');
  assert.ok(p1.data.items.every((x) => x.preview.length > 0), '摘要不能为空（否则模型仍看不到内容）');
  assert.ok(p1.data.items.every((x) => !('content' in x)), '列表不得回传完整正文（会撑爆上下文）');

  const p2 = await list.execute({ limit: 20, offset: 20 });
  assert.equal(p2.data.items.length, 5);
  assert.equal(p2.data.hasMore, false);

  const read = toolRegistry.get('read_note');
  const byId = await read.execute({ id: p1.data.items[0].id });
  assert.ok(byId.data.content.includes('正文内容'), 'read_note 必须真的返回正文');
  assert.equal(byId.data.truncated, false);
  const byTitle = await read.execute({ title: '笔记7' });
  assert.equal(byTitle.data.title, '笔记7');
  const miss = await read.execute({ title: '不存在的笔记' });
  assert.equal(miss.ok, false, '找不到时必须显式报错（而不是静默返回空）');

  const filtered = await list.execute({ category: '线代', tags: '特征值', limit: 5 });
  assert.equal(filtered.data.total, N, '分类+标签过滤应命中全部');
});

test('AI 文档：列表给摘要与 hasImage，read_doc 取全文', async () => {
  await db.docs.clear();
  const img = '![image](sxy-img://00000000-1111-2222-3333-444444444444)';
  await createDoc({ title: '计网周报', content: `# 周报\n本周复习了停止-等待协议。\n${img}`, type: 'summary', tags: ['计网'] });
  const list = toolRegistry.get('list_docs');
  const r = await list.execute({});
  assert.equal(r.data.total, 1);
  const item = r.data.items[0];
  assert.ok(item.preview.includes('停止-等待'), '摘要要能体现正文要点');
  assert.equal(item.hasImage, true, '带图必须标记 hasImage（否则模型不知道有图可看）');
  assert.equal(item.contentChars > 0, true);

  const read = toolRegistry.get('read_doc');
  const full = await read.execute({ id: item.id });
  assert.ok(full.data.content.includes('sxy-img://'), '读全文必须保留图片引用（切坏引用 = 图静默丢失）');
  assert.equal(full.data.contentChars, full.data.content.length, 'contentChars 应是正文原长（用于判断是否被截断）');
});

test('计划：列表给摘要，read_plan 给完整安排；每日任务能按天与按区间取', async () => {
  await db.plans.clear();
  await db.dailyPlans.clear();
  await db.dailyTasks.clear();
  await createPlan({ title: '冲刺计划', content: '## 阶段一\n- 停止-等待\n- 滑动窗口\n' + '细'.repeat(400) });
  await createDailyPlan({
    rawInput: '今天复习线代和计网',
    date: '2026-09-15',
    tasks: [
      { title: '复习特征值', type: 'review', subject: '线性代数', estimatedMinutes: 45, scheduledHour: 9, important: true, urgent: false, quadrant: 'Q1' },
      { title: '计网错题重做', type: 'review', subject: '计算机网络', estimatedMinutes: 30, scheduledHour: 14, important: false, urgent: true, quadrant: 'Q2' },
    ],
  });

  const plans = toolRegistry.get('list_plans');
  const pl = await plans.execute({});
  assert.equal(pl.data.total, 1);
  assert.ok(pl.data.items[0].preview.includes('阶段一'), '摘要要能看出计划结构');
  assert.equal(pl.data.items[0].contentChars > 400, true, '必须给出正文原长，模型据此判断要不要取全文');
  assert.ok(!('content' in pl.data.items[0]));
  assert.match(plans.description, /read_plan/, '列表描述要点名详情工具');

  const readPlan = toolRegistry.get('read_plan');
  const full = await readPlan.execute({ title: '冲刺计划' });
  assert.ok(full.data.content.includes('阶段一'));
  assert.equal(full.data.truncated, false, '默认 3000 字应能装下这份计划');

  const tasks = toolRegistry.get('list_daily_tasks');
  const day = await tasks.execute({ date: '2026-09-15' });
  assert.equal(day.data.mode, 'day');
  assert.equal(day.data.total, 2);
  assert.equal(day.data.items[0].estimatedMinutes > 0, true);
  assert.ok(day.data.rawInput.includes('线代'), '当天口述原文也要给（用户原话最准）');

  const filtered = await tasks.execute({ date: '2026-09-15', status: 'done' });
  assert.equal(filtered.data.total, 0, '按状态过滤应生效');

  const summary = await tasks.execute({ days: 7 });
  assert.equal(summary.data.mode, 'summary');
  assert.ok(summary.data.total >= 1, '不带 date 应给最近 N 天的每日汇总');

  // 脏日期必须显式报错：静默返回空会让模型误报「那天没有计划」（用户以为记录丢了）
  const bad = await tasks.execute({ date: '2026/09/15' });
  assert.equal(bad.ok, false, '非法日期必须显式报错');
  assert.ok(bad.error.includes('YYYY-MM-DD'));
});

test('备忘：分页可用，且直接给全文（短句无需详情工具）', async () => {
  await db.memos.clear();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await addMemo({ text: `备忘${i}`, important: i === 0, urgent: false });
  }
  const list = toolRegistry.get('list_memos');
  const r = await list.execute({ limit: 2 });
  assert.equal(r.data.total, 3);
  assert.equal(r.data.items.length, 2);
  assert.equal(r.data.hasMore, true);
  assert.ok(r.data.items.every((m) => typeof m.text === 'string' && m.text.length > 0));
  await db.memos.clear();
});

test('资料库：列表给文字摘要 + 分页，且描述指向正确的详情工具 read_lib_doc', async () => {
  const list = toolRegistry.get('list_lib_docs');
  assert.match(list.description, /read_lib_doc/, '描述必须指向真实存在的 read_lib_doc');
  // 旧描述写的是「再用 read_doc 读具体内容」——而 read_doc 是「读 AI 文档」的工具，
  // 指错工具会让模型拿资料库问题去查 AI 文档，或撞上不存在的工具名。
  assert.ok(!list.description.includes('再用 read_doc 读具体内容'), '资料库列表不得把模型指向读 AI 文档的 read_doc');
  assert.match(list.description, /读资料库文件用 read_lib_doc/, '要明确区分两个 read 工具，避免混用');
  const r = await list.execute({ limit: 5, offset: 0 });
  assert.equal(r.ok, true, '空资料库也应正常返回（total=0），不抛错');
  assert.equal(typeof r.data.total, 'number');
  assert.equal('hasMore' in r.data, true);
});
