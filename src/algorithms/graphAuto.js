// src/algorithms/graphAuto.js
// 知识图谱自动构建：从「标签共现 / 学习顺序 / 错题同现 / 内容相似」推导 graphEdges，
// 写入 db.graphEdges（kind='auto'），驱动「先补前置、再练当前」的智能出题。
//
// 边类型：
//   prereq  前置依赖（同科目、难度更低 → 更高，且两张卡本身相关）
//   related 相关（标签共现 / 错题同现 / 文本相似）
// weight ∈ (0,1]，越大关系越强。
//
// 写入字段（本次修复重点）：
//   早期版本只写 {from, to, kind, weight}——from/to 直接是卡片 UUID，
//   没有 label、没有 subject、没有 fromCardId/toCardId。
//   后果：图谱页把它们渲染成一串裸 UUID 节点、subject 全空（全落进「未分类」簇），
//   且与「AI 生成 / 智能推荐」建的 label 型节点属于两套 ID 空间，永远连不通。
//   现在统一为：from/to = 卡片正面文本（显示用），fromCardId/toCardId = 稳定连接键。
//
// 性能（本次修复重点）：
//   原实现是 O(n²) 全量两两比对，2591 张卡 ≈ 670 万次集合运算，直接卡死主线程。
//   现改为倒排索引（tag → 卡片 / token → 卡片）只在候选对上算相似度，并按
//   maxEdgesPerCard / maxEdges 截断，保证大库也能秒级完成且图可读。

import { db } from '../db.js';
import { tokenize } from './mistakeAttribution.js';
import { resolvePrereqPlan } from './prereq.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 卡片正面 → 节点显示名（与 recommendGraphEdges / doc-graph 的 30 字口径一致） */
export function nodeLabelOf(card, maxLen = 30) {
  const s = String(card?.front ?? '').trim();
  return s ? (s.length > maxLen ? s.slice(0, maxLen).trim() : s) : '';
}

/**
 * 用倒排索引生成「共享 token」候选对及交集大小。
 *
 * 关键点：**按词频（df）升序处理**。
 * 冷门词区分度高、组合数少，先处理它们，保证「同专题的卡一定能被配对」；
 * 热门词（如「进程」「矩阵」这种整个科目都在用的词）组合数是平方级，
 * 放到后面填剩余预算，预算耗尽即止。
 *
 * ⚠️ 不能用「df 超过阈值就整词丢弃」的简单做法：
 * 2591 张卡的库里，学科高频词出现在几百张卡上是常态，一刀切会把它们全丢掉，
 * 结果一条边都建不出来（这个坑在性能护栏测试里被抓到过）。
 *
 * @param {Map<string, Set<string>>} setsById 卡片 id → token 集合
 * @param {number} maxDf 单个词参与配对的最大文档数（硬上限，防单个词炸掉内存）
 * @param {number} maxPairs 候选对总量预算，超过即停止
 * @returns {Map<string, number>} "idA|idB"（字典序）→ 交集大小
 */
export function buildCandidates(setsById, { maxDf = 600, maxPairs = 200000 } = {}) {
  const inverted = new Map(); // token -> [ids]
  for (const [id, set] of setsById) {
    for (const t of set) {
      if (!inverted.has(t)) inverted.set(t, []);
      inverted.get(t).push(id);
    }
  }
  // df 升序：先吃区分度高的冷门词，热门词用剩余预算
  const buckets = [...inverted.entries()]
    .filter(([, ids]) => ids.length >= 2 && ids.length <= maxDf)
    .sort((a, b) => a[1].length - b[1].length);

  const inter = new Map();
  for (const [, ids] of buckets) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        inter.set(key, (inter.get(key) || 0) + 1);
        if (inter.size > maxPairs) return inter;
      }
    }
  }
  return inter;
}

/**
 * 自动构建图谱（幂等：先清旧 auto 边再写入）
 * @param {object} opts
 *   similarityThreshold  文本重叠阈值（overlap coefficient），默认 0.3
 *   maxEdgesPerCard      单卡最多保留多少条边（按权重降序），默认 8
 *       maxEdges             全局边数上限，默认 4000
 *   maxDf                单词参与配对的最大文档数（硬上限），默认 600。
 *                        注意：热门词不是「超过就丢弃」，而是排到冷门词之后用剩余预算，
 *                        否则大库里的学科高频词会被整词滤掉、一条边都建不出来。
 * @returns { edges:[], stats:{ prereq, related, cards, truncated } }
 */
export async function autoBuildGraph(opts = {}) {
  const {
    similarityThreshold = 0.3,
    maxEdgesPerCard = 8,
    maxEdges = 4000,
    maxDf = 600,
    minTagWeight = 0.5,
  } = opts;

  const cards = await db.cards.toArray();
  const reviews = await db.reviews.toArray();
  const byId = new Map(cards.map(c => [c.id, c]));

  const edges = new Map(); // key `${aId}|${bId}` → 边对象（aId < bId，无向）
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  /**
   * @param {string} aId 卡片 id
   * @param {string} bId 卡片 id
   * @param {'prereq'|'related'} kind
   * @param {number} weight
   * @param {string} label 关系名（给图谱显示用）
   * @param {boolean} directed 有向（a→b）；false 表示无向，按 id 字典序存
   */
  const add = (aId, bId, kind, weight, label, directed = false) => {
    if (!aId || !bId || aId === bId) return;
    if (!byId.has(aId) || !byId.has(bId)) return;
    // 同一对卡片只保留一条边；方向信息存在 aId/bId 的先后里（aId → bId）。
    //
    // 旧实现用两套 key：无向 `a|b`、有向 `a->b`。后果是同一对卡能同时留下
    // related 与 prereq 两条边，落库时又按 (aId,bId) 的先后拼出
    // `auto-a-b` / `auto-b-a` 两个不同 id：
    //   · 顺序一致 → 两个 id 相同，bulkPut 静默覆盖，related 边丢失；
    //   · 顺序相反 → 同对卡两条边并存，各吃掉 maxEdgesPerCard 的一个名额，图谱出现重复连线。
    // 命中哪种取决于「id 字典序」与「难度序」是否一致 —— 同一份数据重建结果不稳定。
    const key = pairKey(aId, bId);
    const existing = edges.get(key);
    if (existing) {
      // 后来者是前置关系：升级 kind，并把方向改成这次传入的顺序（低难度 → 高难度）。
      // 标签也要换掉，否则会出现「按前置关系走、图上却显示『同标签』」的错位。
      if (kind === 'prereq' && existing.kind !== 'prereq') {
        existing.kind = 'prereq';
        existing.directed = true;
        existing.aId = aId;
        existing.bId = bId;
        existing.label = label || existing.label;
        existing.weight = Math.max(existing.weight, weight);
        existing.updatedAt = Date.now();
        return;
      }
      if (weight > existing.weight) { existing.weight = weight; existing.label = label; }
      return;
    }
    edges.set(key, {
      aId, bId, kind, weight, label,
      directed,
      updatedAt: Date.now(),
    });
  };

  const DIFF_RANK = { basic: 0, applied: 1, challenge: 2 };

  // ---------- 1) 标签共现 ----------
  const tagSets = new Map();
  for (const c of cards) {
    const tags = (c.tags || []).map(t => String(t).trim()).filter(Boolean);
    if (tags.length) tagSets.set(c.id, new Set(tags));
  }
  if (tagSets.size) {
    for (const [key, shared] of buildCandidates(tagSets, { maxDf, maxPairs: 200000 })) {
      const [a, b] = key.split('|');
      const sa = tagSets.get(a), sb = tagSets.get(b);
      const w = shared / Math.max(1, Math.min(sa.size, sb.size));
      if (w >= minTagWeight) add(a, b, 'related', w, '同标签');
    }
  }

  // ---------- 2) 文本相似（倒排索引，避免 O(n²)） ----------
  const tokenSets = new Map();
  for (const c of cards) {
    const s = new Set(tokenize(`${c.front || ''} ${c.back || ''}`));
    if (s.size) tokenSets.set(c.id, s);
  }
  if (tokenSets.size) {
    for (const [key, interCount] of buildCandidates(tokenSets, { maxDf, maxPairs: 300000 })) {
      const [a, b] = key.split('|');
      const sa = tokenSets.get(a), sb = tokenSets.get(b);
      const ov = interCount / Math.max(1, Math.min(sa.size, sb.size));
      if (ov >= similarityThreshold) add(a, b, 'related', Math.min(1, ov), '内容相似');
    }
  }

  // ---------- 3) 错题同现：两张卡经常在同一天被答错 → 互为薄弱簇 ----------
  const wrongPairs = new Map();
  const wrongByDay = new Map();
  for (const r of reviews) {
    if (r.rating !== 0) continue;
    const day = Math.floor(Number(r.reviewedAt) / DAY_MS);
    if (!Number.isFinite(day)) continue;
    if (!wrongByDay.has(day)) wrongByDay.set(day, []);
    wrongByDay.get(day).push(r.cardId);
  }
  for (const ids of wrongByDay.values()) {
    const uniq = [...new Set(ids)];
    if (uniq.length > 60) continue; // 单日错题过多说明是整轮崩盘，不构成有意义的共现
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const k = pairKey(uniq[i], uniq[j]);
        wrongPairs.set(k, (wrongPairs.get(k) || 0) + 1);
      }
    }
  }
  for (const [key, cnt] of wrongPairs) {
    if (cnt < 2) continue;
    const [a, b] = key.split('|');
    add(a, b, 'related', Math.min(1, 0.6 + cnt * 0.1), '易错同现');
  }

  // ---------- 4) 前置依赖：同科目 + 已相关 + 难度递增 ----------
  // 早期实现是「同科目按难度/创建顺序串成整条链」，2591 张卡直接产生 2590 条边，
  // 但相邻两张卡往往毫无关系——链是假的。这里改为只给「本身已相关」的卡对定前置方向。
  const relatedPairs = [...edges.values()].filter(e => e.kind === 'related');
  for (const e of relatedPairs) {
    const A = byId.get(e.aId), B = byId.get(e.bId);
    if (!A || !B) continue;
    const subjA = String(A.subject || '').trim();
    const subjB = String(B.subject || '').trim();
    if (!subjA || subjA !== subjB) continue; // 跨科目不定前置
    const ra = DIFF_RANK[A.difficulty] ?? 0;
    const rb = DIFF_RANK[B.difficulty] ?? 0;
    if (ra === rb) continue;
    const [low, high] = ra < rb ? [A, B] : [B, A];
    add(low.id, high.id, 'prereq', Math.max(e.weight, 0.5), '前置', true);
  }

  // ---------- 5) 截断：先按边权重降序，再限制每卡边数 ----------
  let list = [...edges.values()].sort((x, y) => {
    if (y.weight !== x.weight) return y.weight - x.weight;
    return String(x.aId).localeCompare(String(y.aId));
  });
  const degree = new Map();
  const kept = [];
  let truncated = 0;
  for (const e of list) {
    if (kept.length >= maxEdges) { truncated++; continue; }
    const da = degree.get(e.aId) || 0;
    const db = degree.get(e.bId) || 0;
    if (da >= maxEdgesPerCard || db >= maxEdgesPerCard) { truncated++; continue; }
    degree.set(e.aId, da + 1);
    degree.set(e.bId, db + 1);
    kept.push(e);
  }
  list = kept;

  // ---------- 6) 落库 ----------
  const existing = (await db.graphEdges.toArray()).filter(e => e.kind === 'auto');
  if (existing.length) await db.graphEdges.bulkDelete(existing.map(e => e.id));

  const t = Date.now();
  const rows = list.map(e => {
    const A = byId.get(e.aId), B = byId.get(e.bId);
    const subject = String(A?.subject || B?.subject || '').trim();
    return {
      // id 用「排序后的卡片对」：与方向无关，两端设备算出同一个 id。
      // 旧实现按 (aId,bId) 的原始先后拼接，方向一变就是另一个 id，
      // 跨设备同步时同对卡会各写一条 → 派生边重复堆积。
      id: `auto-${[e.aId, e.bId].sort().join('-')}`,
      // from/to 用显示文本：与「AI 生成 / 智能推荐」建的边同一套 ID 空间，图谱才能连通
      from: nodeLabelOf(A) || e.aId,
      to: nodeLabelOf(B) || e.bId,
      fromCardId: e.aId,
      toCardId: e.bId,
      label: e.label || (e.kind === 'prereq' ? '前置' : '相关'),
      subject,
      kind: 'auto',
      weight: Number(e.weight.toFixed(4)),
      createdAt: t,
      updatedAt: t,
    };
  });
  if (rows.length) await db.graphEdges.bulkPut(rows);

  return {
    edges: rows,
    stats: {
      // 必须数内部 list，不能数 rows —— rows 的 kind 统一是 'auto'（派生边标记），
      // 按 'prereq'/'related' 过滤 rows 会恒为 0（旧实现就错在这里）。
      prereq: list.filter(e => e.kind === 'prereq').length,
      related: list.filter(e => e.kind === 'related').length,
      cards: cards.length,
      truncated,
    },
  };
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

/**
 * 清理「失效关联」：两端都查不到对应卡片的边（卡片已删、或历史脏数据把裸 ID 写进了 from/to）。
 * @returns {{ removed:number, ids:string[] }}
 */
export async function pruneDeadEdges() {
  const [edges, cards] = await Promise.all([db.graphEdges.toArray(), db.cards.toArray()]);
  const ids = new Set(cards.map(c => c.id));
  const dead = edges.filter(e => {
    const a = String(e.fromCardId || e.from || '').trim();
    const b = String(e.toCardId || e.to || '').trim();
    if (!a || !b) return true;
    // 资料边（doc-card）的 from 是「📄 文件名」，不参与卡片存在性校验
    if (e.type === 'doc-card' || e.docId) return false;
    return !ids.has(a) || !ids.has(b);
  });
  if (dead.length) {
    await db.graphEdges.bulkDelete(dead.map(e => e.id));
    // auto 边不进同步（派生数据，见 sync-manifest 的 exportFilter），
    // 给它们写墓碑只会让墓碑表无意义地膨胀
    const manual = dead.filter(e => e.kind !== 'auto');
    if (manual.length) {
      await db.tombstones.bulkPut(manual.map(e => ({ id: e.id, kind: 'graphEdge', deletedAt: Date.now() })));
    }
  }
  return { removed: dead.length, ids: dead.map(e => e.id) };
}
