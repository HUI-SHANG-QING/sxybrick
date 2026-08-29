// tests/search-service.test.mjs —— M4 统一搜索服务测试
// 覆盖：
//   1) 纯函数：rowMatches 多字段/数组字段/大小写、highlight 高亮 + XSS 转义、plain 去 Markdown
//   2) search() 多模块检索（fake-indexeddb 灌入各模块数据，全量聚合 + 指定模块）
//   3) 空关键词/未知 scope 安全返回
//   4) 演示模式联动：search 走当前 db 实例（test 库搜不到 real 库数据）
//   5) listCards 搜索扩展：标签/科目/来源/助记 命中（原 front/back 行为兼容）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const { plain, rowMatches, highlight, search, SEARCH_ADAPTERS, SCOPE_ORDER, SCOPE_LABELS } =
  await import('../src/search/search-service.js');
const { db, setDbInstance, getDb, uid } = await import('../src/db.js');

after(async () => { try { setDbInstance('real'); getDb().close(); } catch {} });

// ---------- 1) 纯函数 ----------

test('rowMatches：多字段任意命中即匹配（大小写不敏感）', () => {
  const row = { front: 'TCP 三次握手', tags: ['计网'], subject: '计网' };
  assert.ok(rowMatches(row, 'tcp', ['front']));
  assert.ok(rowMatches(row, '握手', ['front', 'back']));
  assert.ok(rowMatches(row, '计网', ['tags']));
  assert.ok(!rowMatches(row, '量子', ['front', 'back', 'tags', 'subject']));
  assert.ok(!rowMatches(null, 'x', ['front']));
  assert.ok(!rowMatches(row, '', ['front']), '空关键词不匹配');
});

test('rowMatches：对象字段序列化匹配（导图 root / 考题 questions）', () => {
  assert.ok(rowMatches({ root: { name: '操作系统', children: [{ name: '进程' }] } }, '进程', ['root']));
  assert.ok(rowMatches({ questions: [{ front: '虚函数表' }, { front: '堆栈' }] }, '虚函数', ['questions']));
});

test('highlight：关键词包裹 mark，且先做 HTML 转义（防 XSS）', () => {
  assert.equal(highlight('hello world', 'world'), 'hello <mark>world</mark>');
  assert.equal(highlight('A和B', 'a'), '<mark>A</mark>和B', '大小写不敏感');
  assert.equal(highlight('<img src=x onerror=alert(1)>', 'img'),
    '&lt;<mark>img</mark> src=x onerror=alert(1)&gt;', 'HTML 必须先转义');
  assert.equal(highlight('no kw', ''), 'no kw', '空关键词原样转义返回');
  // 关键词含正则元字符不炸
  assert.equal(highlight('a.b c', 'a.b'), '<mark>a.b</mark> c');
});

test('plain：去 Markdown 语法保留可读文本', () => {
  assert.ok(plain('# 标题\n**加粗** `code` [x](y)').includes('标题'));
  assert.ok(!plain('**加粗**').includes('*'));
});

// ---------- 2) 多模块检索（fake-indexeddb 灌数） ----------

const T = Date.now();
function card(id, front, subject, tags) {
  return { id, front, back: '答案' + id, subject, tags: tags || [], ease: 2.5, level: 1,
    intervalDays: 1, dueAt: T, reviewedAt: T, createdAt: T, updatedAt: T };
}

before(async () => {
  setDbInstance('real');
  const d = getDb();
  await d.transaction('rw', d.cards, d.docs, d.memos, d.mindmaps, d.exams, d.notes, d.plans, d.analysisSessions, async () => {
    for (const t of [d.cards, d.docs, d.memos, d.mindmaps, d.exams, d.notes, d.plans, d.analysisSessions]) await t.clear();
    await d.cards.bulkAdd([
      card('sc-c1', '死锁的四个必要条件', '操作系统', ['同步']),
      card('sc-c2', '特征值与特征向量', '高数', ['线性代数']),
    ]);
    await d.docs.put({ id: 'sc-d1', title: '计网期末复习资料', content: 'TCP 与 UDP 对比', type: 'doc', createdAt: T, updatedAt: T });
    await d.memos.put({ id: 'sc-m1', text: '记住：模考前复习死锁专题', important: 1, urgent: 1, at: T, createdAt: T, updatedAt: T });
    await d.mindmaps.put({ id: 'sc-mm1', title: '操作系统死锁知识图谱', root: { name: 'OS', children: [{ name: '死锁', name2: '进程调度' }] }, createdAt: T, updatedAt: T });
    await d.exams.put({ id: 'sc-e1', title: '高数模考 #3', score: 88, total: 120, questions: [{ front: '中值定理' }, { front: '死锁条件辨析（送分题）' }], createdAt: T, updatedAt: T });
    await d.notes.put({ id: 'sc-n1', title: '复习方法笔记', content: '模考前先复习死锁专题，再用卡组分组', category: '方法', tags: ['复习'], createdAt: T, updatedAt: T });
    await d.plans.put({ id: 'sc-p1', title: '周末冲刺计划：死锁 + 级数', task: '死锁 + 级数', status: 'pending', date: '2026-09-05', createdAt: T, updatedAt: T });
    await d.analysisSessions.put({ id: 'sc-s1', title: '死锁与同步 等 2 卡', cardIds: '["sc-c1"]', mode: 'local', createdAt: T, updatedAt: T });
  });
});

test('search(all)：全量聚合命中所有模块，按分组返回', async () => {
  const r = await search('all', '死锁');
  assert.ok(r.total >= 5, `应命中多个模块，实际 total=${r.total} modules=${JSON.stringify(r.modules.map(m => [m.key, m.items.length]))}`);
  const byKey = Object.fromEntries(r.modules.map(m => [m.key, m.items]));
  assert.ok(byKey.cards?.some(i => i.id === 'sc-c1'), '卡片应命中');
  assert.ok(byKey.memos?.some(i => i.id === 'sc-m1'), '备忘应命中');
  assert.ok(byKey.plans?.some(i => i.id === 'sc-p1'), '计划应命中（task 字段经 content 序列化匹配）');
  assert.ok(byKey.analysis?.some(i => i.id === 'sc-s1'), '分析会话应命中（title）');
  assert.ok(byKey.mindmaps?.some(i => i.id === 'sc-mm1'), '导图应命中（title）');
  assert.ok(byKey.exams?.some(i => i.id === 'sc-e1'), '考题应命中（questions 对象数组序列化匹配）');
  assert.ok(byKey.notes?.some(i => i.id === 'sc-n1'), '笔记应命中（content）');
  assert.ok(byKey.docs?.every(i => i.id !== 'sc-d1'), '文档不应命中（内容无死锁）');
});

test('search(指定模块)：只在该模块内检索', async () => {
  const r = await search('cards', '特征值');
  assert.equal(r.modules.length, 1);
  assert.equal(r.modules[0].key, 'cards');
  assert.ok(r.modules[0].items.some(i => i.id === 'sc-c2'));

  const r2 = await search('memos', '死锁');
  assert.equal(r2.total, 1, '备忘模块内唯一命中');
});

test('search：空关键词/未知 scope 安全返回', async () => {
  assert.equal((await search('all', '   ')).total, 0);
  assert.equal((await search('no-such-scope', '死锁')).total, 0, '未知 scope 不炸');
  assert.equal((await search('all', 'zzz不存在zzz')).total, 0);
});

test('SCOPE 元数据：8 个模块登记完整，标签可用', () => {
  assert.equal(SCOPE_ORDER.length, 8);
  for (const k of SCOPE_ORDER) {
    assert.ok(SEARCH_ADAPTERS[k], `适配器 ${k} 缺失`);
    assert.ok(SCOPE_LABELS[k], `标签 ${k} 缺失`);
  }
});

// ---------- 4) 演示模式联动：search 跟随当前实例 ----------

test('演示模式：search 走当前 db 实例（real 数据搜不到 test 库，反之亦然）', async () => {
  // real 库现有「死锁」卡
  setDbInstance('real');
  const rReal = await search('cards', '死锁');
  assert.ok(rReal.total >= 1, 'real 模式应搜到 real 库的卡');

  // test 库空（或仅演示数据）：切换后搜同一词不应返回 real 的结果
  setDbInstance('test');
  const rTest = await search('cards', '特征值与特征向量');
  // test 库此时可能已被其它用例播种（demo 数据含特征值卡），用唯一性更强的断言：
  // sc-c2 只存在于 real 库
  assert.ok(!rTest.modules[0]?.items.some(i => i.id === 'sc-c2'), 'test 模式不应搜到 real 库专属卡 sc-c2');
  setDbInstance('real');
});

// ---------- 5) listCards 搜索扩展 ----------

test('listCards：q 覆盖标签/科目/来源/助记（原 front/back 兼容）', async () => {
  setDbInstance('real');
  const d = getDb();
  const cid = 'sc-lc-' + uid().slice(0, 8);
  await d.cards.put({
    id: cid, front: '量子纠缠简介', back: 'EPR 悖论', subject: '物理',
    tags: ['量子'], source: '演示扩展测试', mnemonic: '记住 EPR',
    ease: 2.5, level: 0, intervalDays: 0, dueAt: T, reviewedAt: 0, createdAt: T, updatedAt: T,
  });
  try {
    const { listCards } = await import('../src/repo.js');
    // front 命中（原行为）
    assert.ok((await listCards({ q: '量子纠缠' })).items.some(c => c.id === cid));
    // 标签命中（新能力）
    assert.ok((await listCards({ q: '量子' })).items.some(c => c.id === cid));
    // 科目命中
    assert.ok((await listCards({ q: '物理' })).items.some(c => c.id === cid));
    // 来源命中
    assert.ok((await listCards({ q: '演示扩展测试' })).items.some(c => c.id === cid));
    // 助记命中
    assert.ok((await listCards({ q: 'EPR' })).items.some(c => c.id === cid), '大小写不敏感');
    // 不命中
    assert.ok(!(await listCards({ q: 'zzz无此词zzz' })).items.some(c => c.id === cid));
  } finally {
    await d.cards.delete(cid);
  }
});
