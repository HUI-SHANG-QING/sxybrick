// tests/memory-ranking.test.mjs —— round110（自用优化）：记忆从「时间倒序」升级为「相关度 × 重要度 × 新鲜度 × 巩固度」
//
// 修复的真实症状：用户三个月前说「考数一、目标院校考数据结构」，之后聊过 20 条琐碎事实 ——
// 因为注入是「按 updatedAt 倒序取前 44 条」，那条关键记忆被挤出，AI 表现成"失忆"。
// 本文件钉住：相关度优先、core 保护、配额与字符上界不变、importance 真正生效、巩固节流且不动 updatedAt。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { buildMemoryText, addMemory, scoreMemories } from '../src/agent/memory.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const DAY = 86400000;
const raw = (id, category, content, opts = {}) => ({
  id, category, content,
  importance: opts.importance ?? 2,
  createdAt: opts.updatedAt ?? Date.now(),
  updatedAt: opts.updatedAt ?? Date.now(),
});

beforeEach(async () => { await db.aiMemories.clear(); });

test('相关度优先：三个月前的关键记忆不会被无关的新记忆挤出（核心症状回归）', async () => {
  const now = Date.now();
  // 1 条 90 天前的 core（关键身份信息）
  await db.aiMemories.put(raw('m-key', 'core', '考研数学一，目标院校初试考数据结构', { importance: 5, updatedAt: now - 90 * DAY }));
  // 12 条最近刷新的 core 噪声（配额正好 12 → 旧实现会把上面那条挤出去）
  const noise = [];
  for (let i = 0; i < 12; i++) noise.push(raw('noise' + i, 'core', '临时想法' + i, { updatedAt: now - i * 1000 }));
  await db.aiMemories.bulkPut(noise);

  const text = await buildMemoryText('我数学一这科该怎么复习？');
  assert.ok(text.includes('考研数学一'), `相关记忆必须被注入；实际注入：${text.slice(0, 200)}`);
});

test('反向保护：无关的旧记忆不会挤掉相关的新记忆', async () => {
  const now = Date.now();
  await db.aiMemories.bulkPut([
    raw('old-irrelevant', 'fact', '我喜欢喝美式咖啡不加糖', { updatedAt: now - 200 * DAY }),
    raw('new-relevant', 'fact', '线性代数特征值这块一直算错', { updatedAt: now - DAY }),
  ]);
  const text = await buildMemoryText('特征值怎么求');
  assert.ok(text.includes('特征值'), '相关的新事实必须在');
});

test('importance 真正生效（此前是只写不读的死字段）', async () => {
  const now = Date.now();
  await db.aiMemories.bulkPut([
    raw('low', 'fact', '随手记的低价值事实 A', { importance: 1, updatedAt: now }),
    raw('high', 'fact', '高价值事实 B', { importance: 5, updatedAt: now - 2 * DAY }),
  ]);
  const ranked = scoreMemories('', await db.aiMemories.toArray(), now);
  assert.equal(ranked[0].m.id, 'high', '重要度高的必须排在前面（无 query 时）');
});

test('无 query 时不崩且仍能产出记忆（向后兼容）', async () => {
  await db.aiMemories.put(raw('a', 'preference', '喜欢用表格总结'));
  const text = await buildMemoryText();
  assert.ok(text.includes('表格'), '不传 query 也要正常注入');
  const text2 = await buildMemoryText('');
  assert.ok(text2.length > 0);
});

test('配额与字符上界不变（token 不膨胀）', async () => {
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(raw('c' + i, 'core', '核心' + i));
  for (let i = 0; i < 40; i++) rows.push(raw('p' + i, 'preference', '偏好' + i));
  for (let i = 0; i < 60; i++) rows.push(raw('f' + i, 'fact', '事实' + i + '，'.repeat(80), { updatedAt: now - i * 1000 }));
  await db.aiMemories.bulkPut(rows);
  const text = await buildMemoryText('测试');
  assert.ok(text.length <= 1800 + 40, `总长必须守住 1800 字上界，实际 ${text.length}`);
  const coreCount = (text.match(/核心\d+/g) || []).length;
  assert.ok(coreCount <= 12, `core 最多 12 条，实际 ${coreCount}`);
  assert.ok(!text.includes('核心12'), 'core 第 13 条（核心12）不该出现');
});

test('淘汰按得分而非「最旧」：超上限时低价值事实先走，core 保留', async () => {
  const now = Date.now();
  const rows = [];
  // 305 条低价值 fact（很旧）
  for (let i = 0; i < 305; i++) rows.push(raw('f' + i, 'fact', '低价值事实' + i, { importance: 1, updatedAt: now - (400 + i) * DAY }));
  // 1 条极新的高价值 core
  rows.push(raw('keep-core', 'core', '核心：考研数一，目标院校考数据结构', { importance: 5, updatedAt: now - 400 * DAY }));
  await db.aiMemories.bulkPut(rows);
  await addMemory({ content: '触发一次淘汰', category: 'fact' }); // addMemory 末尾会 prune

  const left = await db.aiMemories.toArray();
  assert.ok(left.length <= 300, `淘汰后应回到 300 条以内，实际 ${left.length}`);
  assert.ok(left.some((m) => m.id === 'keep-core'), 'core 记忆必须被保护（不因"最旧"被删）');
});

test('巩固：被注入的记忆记一次使用，6 小时内不重复累加，且**不动 updatedAt**', async () => {
  await db.aiMemories.put(raw('u1', 'core', '我在准备考研数学一', { importance: 5 }));
  const before = (await db.aiMemories.get('u1')).updatedAt;
  await buildMemoryText('数一怎么复习');
  // consolidateUsage 是 fire-and-forget，等一个 tick 让它落库
  await new Promise((r) => setTimeout(r, 60));
  const mid = await db.aiMemories.get('u1');
  assert.equal(mid.useCount, 1, '注入一次应记一次使用');
  assert.equal(mid.updatedAt, before, 'updatedAt 不能被改动（它是对外同步的合并键）');

  await buildMemoryText('数一怎么复习'); // 6 小时内第二次
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await db.aiMemories.get('u1')).useCount, 1, '节流窗口内不得重复累加');
});

// ---------------------------------------------------------------- round112 P3：护栏与巩固计数必须一致

test('字符护栏：被总量上界整层丢掉的记忆**不得**记一次 useCount（P3 回归）', async () => {
  // 组装顺序固定 core → 偏好 → 事实，护栏从尾部（事实 → 偏好）整层丢弃。
  // 旧实现把 picked 在「类别配额」阶段就 push 好了，护栏用 lines.pop() 丢层时不动 picked →
  // 那些**从未进 prompt** 的 fact 照样被 consolidateUsage 记一次 useCount（计数与事实不符）。
  const rows = [raw('big-core', 'core', 'c'.repeat(600), { importance: 5 })  , raw('big-pref', 'preference', 'p'.repeat(600), { importance: 5 })];
  for (let i = 0; i < 20; i++) rows.push(raw('f' + i, 'fact', ('f' + i).padEnd(120, 'x'), { importance: 2 }));
  await db.aiMemories.bulkPut(rows);

  const text = await buildMemoryText('随便问问');
  await new Promise((r) => setTimeout(r, 80)); // consolidateUsage 是 fire-and-forget

  assert.ok(!text.includes('· 事实：'), '事实层应被总量护栏整层丢弃（否则本用例没测到目标分支）');
  assert.ok(text.includes('· 核心：') && text.includes('· 偏好：'), '核心与偏好层保留');
  const after = await db.aiMemories.toArray();
  assert.equal(after.find((m) => m.id === 'big-core').useCount, 1, '真正进了 prompt 的核心记忆要计数');
  assert.equal(after.find((m) => m.id === 'big-pref').useCount, 1, '真正进了 prompt 的偏好记忆要计数');
  assert.equal(after.filter((m) => m.category === 'fact' && m.useCount).length, 0,
    '被护栏丢掉的 fact 一条都不能计数（旧实现会把它们全记一遍）');
});

test('字符护栏：连偏好层也丢掉时，计数只落在真正保留的层上', async () => {
  // 每层配额是 core 12 / 偏好 12 / 事实 20，单条上限 120 字 —— 要让「丢掉事实后仍超上限」，
  // 必须把 core 与偏好都填满长条目（否则总量根本不触发护栏，用例会测到空分支）。
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(raw('c' + i, 'core', ('c' + i).padEnd(600, 'C'), { importance: 5 }));
  for (let i = 0; i < 12; i++) rows.push(raw('p' + i, 'preference', ('p' + i).padEnd(600, 'P'), { importance: 5 }));
  for (let i = 0; i < 20; i++) rows.push(raw('f' + i, 'fact', ('f' + i).padEnd(600, 'F'), { importance: 2 }));
  await db.aiMemories.bulkPut(rows);

  const text = await buildMemoryText('随便问问');
  await new Promise((r) => setTimeout(r, 80));

  assert.ok(!text.includes('· 偏好：') && !text.includes('· 事实：'), '偏好与事实两层都被丢弃');
  assert.ok(text.includes('· 核心：'), '核心层永远最后才丢（有内容就保留）');
  const after = await db.aiMemories.toArray();
  assert.equal(after.filter((m) => m.category === 'core' && m.useCount).length, 12, '保留的核心层全部计数');
  assert.equal(after.filter((m) => m.category !== 'core' && m.useCount).length, 0, '被丢掉的两层一条都不计数');
});
