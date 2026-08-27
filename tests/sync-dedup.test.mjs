// tests/sync-dedup.test.mjs — 跨设备导入卡片内容去重（P0 修复）单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeIncomingCards } from '../src/sync-dedup.js';

function card(id, front, back, subject) {
  return { id, front, back, subject: subject || '计组', ease: 2.5, level: 3, intervalDays: 10, dueAt: Date.now() };
}

// ---------- P0 核心：同 id 卡必须放行，不被内容去重丢弃 ----------

test('同 id 卡（仅 SRS 字段不同）被放行，交后续字段级合并', () => {
  const local = card('C1', 'Q1', 'A1'); // 本地：刚建，未复习
  const incoming = card('C1', 'Q1', 'A1'); // 远端：同一张，已复习（SRS 变）
  incoming.ease = 1.8; incoming.level = 5; incoming.intervalDays = 40;
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 0, '同 id 不应计入重复');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'C1');
  assert.equal(kept[0].ease, 1.8, '放行后由 mergeRows 合并 SRS');
});

test('异 id 但内容雷同 → 视为真重复跳过', () => {
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C2', 'Q1', 'A1'); // 内容完全相同但不同 id
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 1);
  assert.equal(kept.length, 0, '内容重复卡应被跳过，避免重复建卡');
});

test('异 id 且内容不同 → 保留导入', () => {
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C2', 'Q2', 'A2');
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'C2');
});

test('同 id 优先于内容去重：即便内容也雷同也放行', () => {
  // 极端：远端把卡内容也改了，但 id 仍是同一张 —— 必须放行（按 id 合并，而非按内容丢弃）
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C1', 'Q1-modified', 'A1-modified');
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'C1');
});

test('批次内重复（异 id 同内容）只保留首个', () => {
  const local = card('C1', 'Q1', 'A1');
  const baseById = new Map([[local.id, local]]);
  const incoming = [card('C2', 'Q2', 'A2'), card('C3', 'Q2', 'A2'), card('C4', 'Q3', 'A3')];
  const { kept, duplicated } = dedupeIncomingCards(incoming, baseById, [local]);
  assert.equal(duplicated, 1, 'C3 与 C2 内容重复');
  assert.deepEqual(kept.map(c => c.id), ['C2', 'C4']);
});

test('空输入安全', () => {
  const { kept, duplicated } = dedupeIncomingCards([], new Map(), []);
  assert.equal(kept.length, 0);
  assert.equal(duplicated, 0);
});
