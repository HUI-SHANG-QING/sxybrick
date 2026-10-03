// tests/word-mastered-consistency.test.mjs —— 词卡「已掌握」口径一致性门禁（round127）
//
// 背景（真实业务问题）：`isMastered`（level>=4 || intervalDays>=21）虽是单一事实源，
//   但「熟词（用户手动标记我认识）算不算已掌握」在各处**互相矛盾**：
//     · wordStats（词书统计）：原先**不算**熟词
//     · wordGroupStats（词组统计）：原先**算**熟词（且上方注释还写着"与 wordStats 对齐"）
//   ⇒ 用户在两个页面看到的「已掌握」数字不一样。
//
// 产品决策（2026-10-03）：**熟词算已掌握**。
// 本测试从**数据来源**层面锁死一致性 —— 不去断言内部实现，只断言
// 「同一批词，wordStats 与 wordGroupStats 必须给出同一个 mastered 数」，
// 这样将来任何一处口径改歪了都会立刻变红。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { wordStats, wordGroupStats } from '../src/word-repo.js';
import { isMastered, isWordMastered } from '../src/repo-core.js';

const T = 1_800_000_000_000;
const mk = (id, extra = {}) => ({
  id, word: id, kind: 'word', meaning: '释义', familiar: false,
  level: 1, intervalDays: 1, ease: 2.5, dueAt: T + 86400000,
  createdAt: T, updatedAt: T, ...extra,
});

beforeEach(async () => {
  await db.wordCards.clear();
  await db.wordGroups.clear();
  await db.wordGroupLinks.clear();
});

test('产品口径：熟词算已掌握（familiar 优先，其次 level>=4 || intervalDays>=21）', () => {
  // 熟词：等级再低也算已掌握
  assert.equal(isWordMastered({ familiar: true, level: 0, intervalDays: 0 }), true, '熟词应算已掌握');
  // 非熟词：走系统判定
  assert.equal(isWordMastered({ familiar: false, level: 4, intervalDays: 0 }), true, 'level>=4 算已掌握');
  assert.equal(isWordMastered({ familiar: false, level: 0, intervalDays: 21 }), true, '间隔>=21 天算已掌握');
  assert.equal(isWordMastered({ familiar: false, level: 3, intervalDays: 20 }), false, '未达标不算已掌握');
  // 通用卡（无 familiar 字段）不受影响
  assert.equal(isMastered({ level: 4 }), true, 'isMastered 对卡片口径不变');
  assert.equal(isMastered({ level: 3, intervalDays: 20 }), false);
});

test('口径一致性：wordStats 与 wordGroupStats 必须给出同一个 mastered 数', async () => {
  await db.wordCards.put(mk('w-fam', { familiar: true, level: 5, intervalDays: 30 }));
  await db.wordCards.put(mk('w-mastered', { level: 5, intervalDays: 30 }));
  await db.wordCards.put(mk('w-novice', { level: 1, intervalDays: 1 }));
  await db.wordCards.put(mk('w-tpl', { kind: 'template' }));   // 范文不参与调度
  await db.wordGroups.put({ id: 'g1', name: '组一' });
  for (const cid of ['w-fam', 'w-mastered', 'w-novice', 'w-tpl']) {
    await db.wordGroupLinks.put({ id: `l-${cid}`, groupId: 'g1', cardId: cid });
  }

  const s = await wordStats();
  const g = (await wordGroupStats()).find((x) => x.groupId === 'g1');

  assert.equal(s.familiar, 1, '熟词应被单独统计');
  // 熟词 + level5 非熟词 = 2（这是「熟词算已掌握」的直接体现）
  assert.equal(s.mastered, 2, '词书统计：熟词 + 已掌握 = 2');
  assert.equal(g.mastered, 2, '词组统计：熟词 + 已掌握 = 2');
  assert.equal(
    g.mastered, s.mastered,
    `两个页面的「已掌握」数必须一致——不一致就是用户能看到数字对不上（熟词算不算的锅）`,
  );
  assert.equal(g.schedulable, 3, '范文不计入可排程');
});
