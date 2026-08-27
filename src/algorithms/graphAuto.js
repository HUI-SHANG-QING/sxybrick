// src/algorithms/graphAuto.js
// 知识图谱自动构建：从「标签共现 / 学习顺序 / 错题同现 / 内容相似」推导 graphEdges，
// 写入 db.graphEdges（kind='auto'），驱动「先补前置、再练当前」的智能出题。
//
// 边类型：
//   prereq  前置依赖（同科目、按难度/创建顺序，A 应在 B 之前掌握）
//   related 相关（标签共现 / 错题同现 / 文本相似）
// weight ∈ (0,1]，越大关系越强。

import { db } from '../db.js';
import { tokenize } from './mistakeAttribution.js';
import { resolvePrereqPlan } from './prereq.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 自动构建图谱（幂等：先清旧 auto 边再写入）
 * @param {object} opts { similarityThreshold?:number }
 * @returns { edges:[], stats:{ prereq, related, cards } }
 */
export async function autoBuildGraph(opts = {}) {
  const cards = await db.cards.toArray();
  const reviews = await db.reviews.toArray();
  const simTh = opts.similarityThreshold ?? 0.3;
  const byId = new Map(cards.map(c => [c.id, c]));

  const edges = new Map(); // key `${from}->${to}` → { from, to, kind, weight, updatedAt }
  const add = (from, to, kind, weight) => {
    if (from === to) return;
    const key = `${from}->${to}`;
    const e = edges.get(key) || { from, to, kind: 'related', weight: 0, updatedAt: Date.now() };
    // 取较强关系 / 较高权重
    if (kind === 'prereq') e.kind = 'prereq';
    e.weight = Math.max(e.weight, weight);
    edges.set(key, e);
  };

  // 1) 同科目、按创建顺序的前置链：难度低的 → 难度高的（basic→applied→challenge）
  const bySubject = new Map();
  for (const c of cards) {
    const k = c.subject || '未分类';
    (bySubject.get(k) || bySubject.set(k, []).get(k)).push(c);
  }
  const DIFF_RANK = { basic: 0, applied: 1, challenge: 2 };
  for (const [, list] of bySubject) {
    const sorted = list.slice().sort((a, b) =>
      (DIFF_RANK[a.difficulty] ?? 0) - (DIFF_RANK[b.difficulty] ?? 0) ||
      (a.createdAt || 0) - (b.createdAt || 0));
    for (let i = 1; i < sorted.length; i++) {
      add(sorted[i - 1].id, sorted[i].id, 'prereq', 0.5);
    }
  }

  // 2) 标签共现：共享 >=1 标签 → related
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i].tags || [], b = cards[j].tags || [];
      const sa = new Set(a), sb = new Set(b);
      let shared = 0;
      for (const t of sa) if (sb.has(t)) shared++;
      if (shared > 0) {
        const w = shared / Math.max(1, Math.min(sa.size, sb.size));
        if (w >= 0.5) add(cards[i].id, cards[j].id, 'related', w);
      }
    }
  }

  // 3) 错题同现：两张卡经常被「同一天/连续」答错 → related（互为薄弱簇）
  const wrongPairs = new Map();
  const wrongByDay = new Map();
  for (const r of reviews) if (r.rating === 0) {
    const day = Math.floor((r.reviewedAt) / DAY_MS);
    (wrongByDay.get(day) || wrongByDay.set(day, []).get(day)).push(r.cardId);
  }
  for (const ids of wrongByDay.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
      wrongPairs.set(key, (wrongPairs.get(key) || 0) + 1);
    }
  }
  for (const [key, cnt] of wrongPairs) {
    if (cnt >= 2) {
      const [a, b] = key.split('|');
      add(a, b, 'related', Math.min(1, 0.6 + cnt * 0.1));
    }
  }

  // 4) 文本相似（轻量）：复用 tokenize 做重叠
  const vecs = new Map();
  for (const c of cards) vecs.set(c.id, new Set(tokenize(`${c.front} ${c.back}`)));
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const A = vecs.get(cards[i].id), B = vecs.get(cards[j].id);
      let inter = 0;
      for (const t of A) if (B.has(t)) inter++;
      const ov = inter / Math.max(1, Math.min(A.size, B.size));
      if (ov >= simTh) add(cards[i].id, cards[j].id, 'related', ov);
    }
  }

  // 写入：删除旧 auto 边，批量 upsert 新边（graphEdges 未建 kind 索引，用 toArray 过滤）
  const existing = (await db.graphEdges.toArray()).filter(e => e.kind === 'auto');
  await db.graphEdges.bulkDelete(existing.map(e => e.id));
  const out = [...edges.values()];
  if (out.length) await db.graphEdges.bulkPut(out.map(e => ({ ...e, kind: 'auto', id: `auto-${e.from}-${e.to}` })));
  return { edges: out, stats: { prereq: out.filter(e => e.kind === 'prereq').length, related: out.filter(e => e.kind === 'related').length, cards: cards.length } };
}

/**
 * 给定一张薄弱卡，沿图谱向上回溯前置依赖，找出「尚未掌握的前置卡」优先补练。
 * @param {string} cardId
 * @returns { prereqCardIds:[], relatedCardIds:[] }
 */
export async function derivePrereqPlan(cardId) {
  const edges = await db.graphEdges.toArray();
  const cards = await db.cards.toArray();
  const mastered = new Set(cards.filter(c => (c.fsrs?.s ?? 0) >= 7 && (c.level ?? 0) >= 3).map(c => c.id));
  // 多层前驱回溯（N4 修复：原先只回溯单层，会漏掉「未掌握前置的前置」）
  return resolvePrereqPlan(edges, mastered, cardId);
}
