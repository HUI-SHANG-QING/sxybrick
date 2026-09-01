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

// ---------- round12：被跳过卡的关联数据必须重定向到保留卡（避免孤儿行） ----------

test('idRemap：异 id 同内容被跳过的卡映射到保留 id', () => {
  // 本地已有一张 C1(Q1/A1)；远端备份里 C2 与 C1 内容雷同 → 跳过，
  // 但 C2 关联了一张复习记录 / 一条图谱边，这些引用必须重定向到 C1。
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C2', 'Q1', 'A1'); // 内容雷同，异 id
  const baseById = new Map([[local.id, local]]);
  const { kept, duplicated, idRemap } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(duplicated, 1);
  assert.equal(kept.length, 0, 'C2 作为真重复被跳过');
  assert.equal(idRemap.size, 1);
  assert.equal(idRemap.get('C2'), 'C1', '跳过 id → 保留 id 的重定向映射');
});

test('idRemap：同 id 卡不产生重定向（SRS 合并路径）', () => {
  const local = card('C1', 'Q1', 'A1');
  const incoming = card('C1', 'Q1', 'A1');
  const baseById = new Map([[local.id, local]]);
  const { idRemap } = dedupeIncomingCards([incoming], baseById, [local]);
  assert.equal(idRemap.size, 0, '同 id 放行不应产生任何重定向');
});

test('导入前关联引用重定向：reviews/graphEdges/cardGroupLinks/embeddings 的卡 id 被改写', () => {
  // 复刻 importBackup 0b 步的重定向逻辑（与 src/sync.js 保持一致；
  // CARD_REF_FIELDS 含 sourceId——embeddings 的卡片引用字段，N-6 曾漏掉）
  const cardDedupe = { idRemap: new Map([['C2', 'C1']]) };
  const CARD_REF_FIELDS = ['cardId', 'fromCardId', 'toCardId', 'sourceId'];
  const remapBackup = (backup) => {
    for (const key of Object.keys(backup)) {
      if (key === 'cards' || !Array.isArray(backup[key])) continue;
      backup[key] = backup[key].map(r => {
        let row = r;
        for (const f of CARD_REF_FIELDS) {
          if (r[f] != null && cardDedupe.idRemap.has(r[f])) row = { ...row, [f]: cardDedupe.idRemap.get(r[f]) };
        }
        return row;
      });
    }
    return backup;
  };
  const backup = {
    cards: [{ id: 'C1', front: 'Q1', back: 'A1' }],
    reviews: [{ id: 'R1', cardId: 'C2', rating: 4 }], // 孤儿：本指向被跳过的 C2
    graphEdges: [{ id: 'E1', fromCardId: 'C2', toCardId: 'C3', label: '相关' }],
    cardGroupLinks: [{ id: 'L1', cardId: 'C2', groupId: 'G1' }],
    embeddings: [
      { id: 'V1', sourceType: 'card', sourceId: 'C2' }, // N-6：向量索引引用字段
      { id: 'V2', sourceType: 'doc', sourceId: 'DOC1' }, // 非卡片源不受影响
    ],
  };
  const out = remapBackup(backup);
  assert.equal(out.reviews[0].cardId, 'C1', '复习记录重定向到保留卡');
  assert.equal(out.graphEdges[0].fromCardId, 'C1', '图谱边起点重定向到保留卡');
  assert.equal(out.graphEdges[0].toCardId, 'C3', '无关引用保持不变');
  assert.equal(out.cardGroupLinks[0].cardId, 'C1', '卡组关联重定向到保留卡');
  assert.equal(out.embeddings[0].sourceId, 'C1', 'embeddings.sourceId 重定向到保留卡（N-6）');
  assert.equal(out.embeddings[1].sourceId, 'DOC1', '非卡片源 sourceId 不受影响');
});
