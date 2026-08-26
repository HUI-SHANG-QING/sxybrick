// src/intelligence.js
// 学习智能化引擎（P2·智能化阶段）
// 提供 4 大本地算法能力（零 LLM 开销，可叠加 AI 增强）：
//   #13 图谱关系自动推荐：基于卡片内容/科目/标签的相似度，自动建议知识图谱边
//   #14 今日最优学习序列：综合到期卡+薄弱卡+精力曲线+交错混科+变式分散，排出今日学习序列
//   #11 错题→费曼→补卡→图谱闭环：一键触发完整补救链路
//   #12 计划↔复习↔番茄联动：计划项关联卡片与番茄会话，自动汇总进度
//
// 设计原则：
//   - 纯本地：核心算法不依赖 LLM（零成本、零延迟、可离线）
//   - 可叠加：LLM 可作为增强器（传入 cfg 时调用），但不强依赖
//   - 可测试：纯函数 + 数据快照输入，便于回归验证
//   - 可解释：每个建议带 reason 字段，向用户解释"为什么"

import { db } from './db.js';
import {
  allCards, listGraphEdges, createGraphEdge,
  weakCards, getStats, getReviewSuggestion,
  createCard, applyCardFeedback, addPomoSession, updatePlan,
} from './repo.js';

const now = () => Date.now();
const DAY = 86400000;

// ---------- 文本工具：关键词提取（简版 TF + 位置加权） ----------

// 停用词表（中文常见虚词 + 英文高频词）
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '及', '也', '都', '就', '还', '又', '且', '而', '但', '则', '即',
  '这', '那', '其', '之', '以', '为', '被', '把', '让', '使', '对', '于', '由', '从', '向', '到', '上', '下',
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '百', '千', '万', '个', '些', '某', '每', '各', '另',
  '我', '你', '他', '她', '它', '们', '谁', '什', '么', '怎', '哪',
  '不', '没', '无', '非', '未', '勿', '莫',
  '有', '能', '会', '可', '应', '该', '要', '想', '须', '需',
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'by', 'from', 'into', 'out', 'up', 'down', 'over', 'under',
]);

// 分词：中文按字/词组滑动；英文按空格+标点
// 简版实现：提取 2-4 字中文词 + 英文单词
function tokenize(text) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|\-]/g, ' ')
    .replace(/[，。、；：？！,.;:?!()（）\[\]【】「」"''""']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = [];
  // 英文单词
  const en = s.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  for (const w of en) {
    const lw = w.toLowerCase();
    if (lw.length >= 2 && !STOP_WORDS.has(lw)) tokens.push(lw);
  }
  // 中文：2-4 字滑动窗口（粗分词，便于相似度计算）
  const cn = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cn) {
    if (seg.length === 1) {
      if (!STOP_WORDS.has(seg)) tokens.push(seg);
    } else {
      // 2-3 字词组（4 字过长会稀释相似度）
      for (let i = 0; i < seg.length; i++) {
        if (i + 2 <= seg.length) {
          const w = seg.slice(i, i + 2);
          if (!STOP_WORDS.has(w)) tokens.push(w);
        }
        if (i + 3 <= seg.length) {
          const w = seg.slice(i, i + 3);
          if (!STOP_WORDS.has(w)) tokens.push(w);
        }
      }
    }
  }
  return tokens;
}

function tokenFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// 余弦相似度（基于词频向量）
function cosineSimilarity(freqA, freqB) {
  let dot = 0, magA = 0, magB = 0;
  for (const [k, v] of freqA) {
    magA += v * v;
    const b = freqB.get(k);
    if (b) dot += v * b;
  }
  for (const [, v] of freqB) magB += v * v;
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Jaccard 相似度（基于词集合，简单但有效）
function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
}

// ---------- #13 图谱关系自动推荐 ----------

/**
 * 自动推荐知识图谱边。
 * 算法分层（综合多信号）：
 *   1) 同科目 + 标签重叠 → 强信号（属于/同类）
 *   2) 同科目 + 内容关键词相似度 ≥ 阈值 → 中信号（相关）
 *   3) 跨科目 + 关键词相似度 ≥ 较高阈值 → 弱信号（对比/迁移）
 *   4) 变式卡（sourceCardId 相同）→ 必然关联（情境变式）
 *   5) 共现：两张卡常在同一复习时段被复习 → 隐式关联
 * 输出：按得分降序的建议列表（去重：已存在边不再推荐）
 *
 * @param {object} opt
 *   topN: 返回前 N 条建议（默认 30）
 *   subject: 仅在该科目内推荐（可选，跨科目分析时为空）
 *   withExisting: 是否把已存在的边也作为候选过滤（默认 true）
 * @returns {Promise<Array<{from, to, label, subject, score, reason}>>}
 */
export async function recommendGraphEdges(opt = {}) {
  const topN = Number(opt.topN) || 30;
  const cards = await allCards();
  if (cards.length < 2) return [];

  // 已存在的边集合，避免重复推荐
  const existing = opt.withExisting !== false ? await listGraphEdges() : [];
  const existPair = new Set();
  for (const e of existing) {
    // 双向去重：A→B 和 B→A 视为同一对
    const k1 = `${e.from}\u0001${e.to}`;
    const k2 = `${e.to}\u0001${e.from}`;
    existPair.add(k1); existPair.add(k2);
  }

  // 预处理：每张卡的词频 + 词集合 + 标签集合
  const cardInfos = cards.map(c => {
    const text = `${c.front || ''} ${c.back || ''} ${c.mnemonic || ''}`;
    const tokens = tokenize(text);
    return {
      card: c,
      tokens,
      freq: tokenFreq(tokens),
      tokenSet: new Set(tokens),
      tagSet: new Set(c.tags || []),
      label: String(c.front || '').slice(0, 30).trim() || c.id,
    };
  });

  // 变式卡：sourceCardId 相同的卡必然关联
  const variantGroups = new Map();
  for (const ci of cardInfos) {
    if (ci.card.sourceCardId) {
      if (!variantGroups.has(ci.card.sourceCardId)) variantGroups.set(ci.card.sourceCardId, []);
      variantGroups.get(ci.card.sourceCardId).push(ci);
    }
  }

  const candidates = [];

  // 1) 变式卡互相关联（必然）
  for (const [, group] of variantGroups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        candidates.push({
          from: a.label, to: b.label,
          fromId: a.card.id, toId: b.card.id,
          label: '情境变式', subject: a.card.subject || b.card.subject || '',
          score: 0.95, reason: '同源变式卡：同一知识点的不同情境呈现',
        });
      }
    }
  }

  // 2) 卡对相似度分析
  // 限制两两比较规模：>200 张卡时按科目分组后组内+跨科抽样（避免 O(n²) 爆炸）
  const bySubject = new Map();
  for (const ci of cardInfos) {
    const k = ci.card.subject || '未分类';
    if (!bySubject.has(k)) bySubject.set(k, []);
    bySubject.get(k).push(ci);
  }

  const subjects = [...bySubject.keys()];
  const pairs = [];

  // 同科目内两两比较
  for (const [, arr] of bySubject) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        pairs.push([arr[i], arr[j], 'same']);
      }
    }
  }
  // 跨科目抽样比较（每科最多取前 15 张代表，避免组合数爆炸）
  if (subjects.length > 1) {
    const reps = subjects.map(s => (bySubject.get(s) || []).slice(0, 15));
    for (let i = 0; i < reps.length; i++) {
      for (let j = i + 1; j < reps.length; j++) {
        for (const a of reps[i]) for (const b of reps[j]) {
          pairs.push([a, b, 'cross']);
        }
      }
    }
  }

  for (const [a, b, kind] of pairs) {
    if (a.card.id === b.card.id) continue;
    // 跳过变式对（已在上面处理）
    if (a.card.sourceCardId && b.card.sourceCardId && a.card.sourceCardId === b.card.sourceCardId) continue;

    const tagInter = [...a.tagSet].filter(t => b.tagSet.has(t)).length;
    const tagUnion = a.tagSet.size + b.tagSet.size - tagInter;
    const tagSim = tagUnion ? tagInter / tagUnion : 0;

    const cosine = cosineSimilarity(a.freq, b.freq);
    const jac = jaccard(a.tokenSet, b.tokenSet);

    let score = 0;
    let label = '相关';
    let reason = '';

    if (kind === 'same') {
      // 同科目：标签 + 内容相似度加权
      score = tagSim * 0.4 + cosine * 0.4 + jac * 0.2;
      if (tagInter > 0 && cosine >= 0.15) {
        label = '同类';
        reason = `同科目·${tagInter} 个共用标签·内容相似度 ${(cosine * 100 | 0)}%`;
        score = Math.min(1, score + 0.15);
      } else if (cosine >= 0.2) {
        label = '相关';
        reason = `同科目·内容关键词重叠 ${(cosine * 100 | 0)}%`;
      } else if (tagInter > 0) {
        label = '同类';
        reason = `同科目·${tagInter} 个共用标签`;
        score = Math.max(score, tagSim * 0.6);
      } else {
        continue; // 同科目但无任何信号 → 跳过
      }
    } else {
      // 跨科目：阈值略降低（0.18/0.15）以捕捉真正有迁移/对比价值的关联；
      // 同时要求至少一个较强信号（cosine≥0.22 或 jac≥0.18），避免噪声
      if (cosine < 0.18 && jac < 0.15) continue;
      if (cosine < 0.22 && jac < 0.18) continue;
      score = cosine * 0.6 + jac * 0.4;
      label = '对比';
      reason = `跨科目·关键词相似度 ${(cosine * 100 | 0)}%·词集合重合 ${(jac * 100 | 0)}%（可能存在对比/迁移关系）`;
    }

    if (score < 0.15) continue;

    candidates.push({
      from: a.label, to: b.label,
      fromId: a.card.id, toId: b.card.id,
      label, subject: a.card.subject || b.card.subject || '',
      score: Math.min(1, score), reason,
    });
  }

  // 3) 共现关联：常在同一复习时段出现的卡
  try {
    const reviews = await db.reviews.orderBy('reviewedAt').reverse().limit(500).toArray();
    if (reviews.length > 20) {
      // 按日分桶
      const byDay = new Map();
      for (const r of reviews) {
        const d = new Date(r.reviewedAt);
        const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(r.cardId);
      }
      // 统计两两共现次数
      const coOccur = new Map();
      for (const [, ids] of byDay) {
        const uniq = [...new Set(ids)];
        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) {
            const k = uniq[i] < uniq[j] ? `${uniq[i]}\u0001${uniq[j]}` : `${uniq[j]}\u0001${uniq[i]}`;
            coOccur.set(k, (coOccur.get(k) || 0) + 1);
          }
        }
      }
      const cardMap = new Map(cardInfos.map(ci => [ci.card.id, ci]));
      for (const [k, cnt] of coOccur) {
        if (cnt < 2) continue;
        const [aid, bid] = k.split('\u0001');
        const a = cardMap.get(aid), b = cardMap.get(bid);
        if (!a || !b) continue;
        // 共现加分用 log 衰减（避免高频共现卡被过度加权，cnt=2→0.10, cnt=5→0.16, cnt=10→0.19）
        const coBoost = Math.min(0.2, 0.07 * Math.log2(cnt + 1));
        // 已在候选列表里？加分；否则新增弱关联
        const exist = candidates.find(c =>
          (c.fromId === aid && c.toId === bid) || (c.fromId === bid && c.toId === aid));
        if (exist) {
          exist.score = Math.min(1, exist.score + coBoost);
          exist.reason += `·同日复习 ${cnt} 次`;
        } else {
          candidates.push({
            from: a.label, to: b.label,
            fromId: aid, toId: bid,
            label: '共现', subject: a.card.subject || b.card.subject || '',
            score: Math.min(0.5, 0.15 + coBoost),
            reason: `同一复习时段共现 ${cnt} 次（可能存在隐式关联）`,
          });
        }
      }
    }
  } catch { /* 共现分析失败不影响主流程 */ }

  // 去重 + 过滤已存在
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    // 双向键
    const k1 = `${c.from}\u0001${c.to}\u0001${c.label}`;
    const k2 = `${c.to}\u0001${c.from}\u0001${c.label}`;
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1); seen.add(k2);
    // 跳过已存在的边（按 pair）
    const pk1 = `${c.from}\u0001${c.to}`;
    const pk2 = `${c.to}\u0001${c.from}`;
    if (existPair.has(pk1) || existPair.has(pk2)) continue;
    out.push(c);
  }

  // 按得分降序
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
}

// ---------- #14 今日最优学习序列 ----------

/**
 * 生成今日最优学习序列。
 * 综合考量：
 *   - 优先级：到期+薄弱 > 仅到期 > 仅薄弱 > 新卡预热
 *   - 精力曲线：早晨穿插新内容，午后巩固，晚间只复习
 *   - 交错混科：避免同科目连串（提升辨识力，认知科学证据）
 *   - 难度梯度：先易后难（前 3 张作为热身），随后递进
 *   - 变式分散：同源变式卡不相邻（防止短时记忆作弊）
 *   - 短期巩固优先：consolidation 状态的卡必须今日完成
 *
 * @param {object} opt
 *   limit: 序列最大长度（默认 50）
 *   includeNew: 是否混入未到期的新卡预热（默认 false）
 *   focusSubject: 指定重点科目（可选）
 * @returns {Promise<{sequence, segments, summary, phase}>}
 *   sequence: 排序后的卡片数组
 *   segments: 分段说明（热身/主攻/收尾）
 *   summary: 文本摘要
 */
export async function recommendTodaySequence(opt = {}) {
  const limit = Math.min(100, Math.max(5, Number(opt.limit) || 50));
  const cards = await allCards();
  if (!cards.length) return { sequence: [], segments: [], summary: '还没有卡片', phase: 'unknown' };

  const nowTs = now();
  const reviews = await db.reviews.orderBy('reviewedAt').reverse().limit(2000).toArray();
  const failCount = new Map();
  for (const r of reviews) if (r.rating === 0) failCount.set(r.cardId, (failCount.get(r.cardId) || 0) + 1);

  const hour = new Date().getHours();
  // 精力曲线：早晨（6-11）适合混入新内容；午后（11-17）巩固；晚间（17-23）只复习
  const phase = hour >= 6 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'noon' : 'evening';

  // 评分每张卡（仅候选：到期+薄弱+巩固中）
  const candidates = [];
  for (const c of cards) {
    const due = c.dueAt <= nowTs;
    const fail = failCount.get(c.id) || 0;
    const weak = c.marked || fail >= 2;
    const consolidation = c.consolidation === 1 || c.consolidation === 2;

    // 候选筛选
    if (!due && !weak && !consolidation) {
      // 早晨可选混入新卡作为预热（少量）
      if (phase === 'morning' && opt.includeNew && c.level === 0) {
        // pass
      } else {
        continue;
      }
    }
    if (opt.focusSubject && c.subject !== opt.focusSubject) continue;

    // 优先级评分（越高越靠前）
    let priority = 0;
    if (consolidation) priority += 100;       // 短期巩固必须今日完成
    if (due && weak) priority += 80;
    else if (due) priority += 50;
    else if (weak) priority += 30;

    // 难度系数（用于排序，不改变优先级）
    // 兼容两种存储：字符串梯度（basic/applied/challenge）映射为 0/1/2；旧数值直接用
    const DIFF_RANK = { basic: 0, applied: 1, challenge: 2 };
    const difficulty = DIFF_RANK[c.difficulty] ?? (Number.isFinite(Number(c.difficulty)) ? Number(c.difficulty) : 1);
    // level 越低 = 越新 = 越简单（热身用）
    const level = c.level || 0;

    candidates.push({
      card: c, priority, difficulty, level, due, weak, consolidation, failCount: fail,
      // 用于交错分组的科目 key
      subjectKey: c.subject || '未分类',
      // 变式溯源
      variantKey: c.sourceCardId || c.id,
    });
  }

  if (!candidates.length) return { sequence: [], segments: [], summary: '今日暂无到期/薄弱卡片，可以放松一下，或主动开新卡', phase };

  // 第一轮排序：按优先级降序，同优先级按难度升序（易的在前）
  candidates.sort((a, b) => (b.priority - a.priority) || (a.difficulty - b.difficulty) || (a.level - b.level));

  // 第二轮：交错混科 + 变式分散
  // 按科目分组（保持组内已排序）
  const bySubject = new Map();
  for (const c of candidates) {
    if (!bySubject.has(c.subjectKey)) bySubject.set(c.subjectKey, []);
    bySubject.get(c.subjectKey).push(c);
  }

  const sequence = [];
  const used = new Set();
  const subjects = [...bySubject.keys()];

  // 交错取：轮流从各科取 1 张（轮转避免连串）
  let round = 0;
  while (sequence.length < limit && round < limit * 2) {
    let added = false;
    // 每轮把科目按最高优先级排序
    const shuffled = subjects.slice().sort((a, b) => {
      const aP = bySubject.get(a).find(c => !used.has(c.card.id))?.priority || 0;
      const bP = bySubject.get(b).find(c => !used.has(c.card.id))?.priority || 0;
      return bP - aP;
    });
    for (const s of shuffled) {
      if (sequence.length >= limit) break;
      const arr = bySubject.get(s);
      // 取该科下一张未用的
      const next = arr.find(c => !used.has(c.card.id));
      if (!next) continue;
      // 变式分散：相邻的同源卡跳过
      const last = sequence[sequence.length - 1];
      if (last && last.variantKey === next.variantKey && last.card.id !== next.card.id) {
        // 找该科下一张不同源
        const alt = arr.find(c => !used.has(c.card.id) && c.variantKey !== next.variantKey);
        if (alt) { sequence.push(alt); used.add(alt.card.id); added = true; continue; }
        // 没有替代 → 仍加入但标记（不阻塞流程）
      }
      sequence.push(next);
      used.add(next.card.id);
      added = true;
    }
    if (!added) break;
    round++;
  }

  // 第三轮：难度梯度调整（前 3 张热身：选难度最低的）
  if (sequence.length > 6) {
    const head = sequence.slice(0, 3);
    head.sort((a, b) => (a.difficulty - b.difficulty) || (a.level - b.level));
    sequence.splice(0, head.length, ...head);
  }

  // 生成段落说明
  const segments = [];
  if (sequence.length) {
    const warmup = sequence.slice(0, Math.min(3, Math.ceil(sequence.length * 0.15)));
    const main = sequence.slice(warmup.length, Math.min(sequence.length, warmup.length + Math.ceil(sequence.length * 0.7)));
    const tail = sequence.slice(warmup.length + main.length);

    segments.push({
      name: '热身', range: `1-${warmup.length}`,
      desc: `从 ${warmup.length} 张较易卡片入手，唤醒记忆`,
      cards: warmup.map(c => c.card.id),
    });
    if (main.length) segments.push({
      name: '主攻', range: `${warmup.length + 1}-${warmup.length + main.length}`,
      desc: `交错混科，主攻 ${[...new Set(main.map(c => c.subjectKey))].slice(0, 3).join('、')}等科目`,
      cards: main.map(c => c.card.id),
    });
    if (tail.length) segments.push({
      name: '收尾', range: `${warmup.length + main.length + 1}-${sequence.length}`,
      desc: `${tail.length} 张收尾巩固`,
      cards: tail.map(c => c.card.id),
    });
  }

  const subjDist = new Map();
  for (const c of sequence) subjDist.set(c.subjectKey, (subjDist.get(c.subjectKey) || 0) + 1);
  const summary = `今日序列 ${sequence.length} 张·${subjDist.size} 科交错：${
    [...subjDist.entries()].map(([s, n]) => `${s} ${n}张`).join('，')
  }。${phase === 'morning' ? '早晨头脑清醒，可适当穿插新内容' : phase === 'noon' ? '午后适合巩固' : '晚间以复习为主'}。`;

  return {
    sequence: sequence.map(c => c.card),
    segments,
    summary,
    phase,
  };
}

// ---------- #11 错题→费曼→补卡→图谱闭环 ----------

/**
 * 智能补救闭环：从一张错题/薄弱卡触发完整补救链路。
 * 链路：
 *   1) 诊断：分析错因、关联卡片、关联图谱节点
 *   2) 费曼建议：基于卡片内容生成费曼练习提示
 *   3) 补卡建议：基于该知识点生成 2 张变式卡（可选 AI）
 *   4) 图谱关联：把该卡片关联到图谱中相关节点（自动调 recommendGraphEdges）
 *
 * @param {string} cardId 起始卡片 id
 * @param {object} opt { aiCfg, generateCards, linkGraph }
 *   aiCfg: AI 配置（可选，无则跳过 AI 增强）
 *   generateCards: 是否生成变式卡（默认 false，仅建议）
 *   linkGraph: 是否自动建立图谱关联（默认 true）
 * @returns {Promise<{card, diagnosis, feynmanHint, variantCards, graphLinks}>}
 */
export async function smartRemediation(cardId, opt = {}) {
  const card = await db.cards.get(cardId);
  if (!card) throw new Error('卡片不存在');

  // 1) 诊断：错因 + 复习历史 + 关联卡
  const reviews = await db.reviews.where('cardId').equals(cardId).reverse().sortBy('reviewedAt');
  const last10 = reviews.slice(0, 10);
  const fail = last10.filter(r => r.rating === 0).length;
  const fuzzy = last10.filter(r => r.rating === 1).length;
  const failRate = last10.length ? fail / last10.length : 0;

  const diagnosis = {
    cardId,
    failCount: fail,
    fuzzyCount: fuzzy,
    failRate,
    wrongReason: card.wrongReason || '',
    level: card.level || 0,
    marked: !!card.marked,
    recent: last10.slice(0, 5).map(r => ({
      at: r.reviewedAt, rating: r.rating, wrongReason: r.wrongReason || '',
    })),
    summary: '',
  };
  if (failRate >= 0.5) diagnosis.summary = `近 ${last10.length} 次复习错误率 ${(failRate * 100 | 0)}%，属于高频遗忘卡`;
  else if (card.marked) diagnosis.summary = '已标记错题，需重点突破';
  else if (fail >= 2) diagnosis.summary = `累计失败 ${fail} 次，存在记忆断层`;
  else diagnosis.summary = '偶发错误，可能是粗心或情境不熟';

  // 2) 费曼练习建议：基于卡片内容生成提示
  const feynmanHint = {
    topic: String(card.front || '').slice(0, 60),
    prompt: `请用费曼学习法讲解：「${String(card.front || '').slice(0, 60)}」\n` +
      `要求：用自己的话讲给一个完全不懂的人听，不能照搬原话。讲完后自评覆盖率。`,
    reference: card.back || '',
    suggested: true,
  };

  // 3) 变式卡建议（不自动生成，仅给提示；如 opt.generateCards 且有 AI 配置则生成）
  let variantCards = [];
  if (opt.generateCards && opt.aiCfg) {
    try {
      const { chatAI } = await import('./ai.js');
      const r = await chatAI([
        { role: 'system', content: '你是变式题生成器。基于原题生成 2 张同知识点不同情境的变式卡。输出严格 JSON 数组：[{"front":"...","back":"...","wrongReason":""}]。只输出 JSON。' },
        { role: 'user', content: `原题：\n正面：${card.front}\n背面：${card.back}\n错因：${card.wrongReason || '未指定'}` },
      ], opt.aiCfg);
      const m = String(r).match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]);
        for (const v of arr.slice(0, 2)) {
          const created = await createCard({
            front: v.front, back: v.back, subject: card.subject,
            tags: card.tags || [], type: card.type || 'basic',
            wrongReason: v.wrongReason || card.wrongReason || '',
            sourceCardId: card.id,
          });
          variantCards.push(created);
        }
      }
    } catch (e) {
      variantCards = [{ error: e.message }];
    }
  }

  // 4) 图谱关联：自动找出该卡与其它卡的关联并保存
  let graphLinks = [];
  if (opt.linkGraph !== false) {
    // 用 token 相似度找最相关的 3 张卡
    const allCardsList = await allCards();
    const targetTokens = tokenize(`${card.front} ${card.back}`);
    const targetFreq = tokenFreq(targetTokens);
    const targetSet = new Set(targetTokens);
    const scored = [];
    for (const c of allCardsList) {
      if (c.id === card.id) continue;
      if (card.sourceCardId && c.sourceCardId === card.sourceCardId) {
        // 同源变式：直接强关联
        scored.push({ card: c, score: 0.95, label: '情境变式' });
        continue;
      }
      const t = tokenize(`${c.front} ${c.back}`);
      const f = tokenFreq(t);
      const s = new Set(t);
      const cos = cosineSimilarity(targetFreq, f);
      const jac = jaccard(targetSet, s);
      const tagInter = (card.tags || []).filter(tg => (c.tags || []).includes(tg)).length;
      let score = cos * 0.5 + jac * 0.3 + (tagInter > 0 ? 0.2 : 0);
      if (c.subject === card.subject) score += 0.1;
      if (score >= 0.2) scored.push({ card: c, score, label: c.subject === card.subject ? '同类' : '相关' });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 3);
    const fromLabel = String(card.front || '').slice(0, 30).trim();
    for (const t of top) {
      const toLabel = String(t.card.front || '').slice(0, 30).trim();
      const e = await createGraphEdge({
        from: fromLabel, to: toLabel,
        label: t.label,
        subject: card.subject || t.card.subject || '',
      });
      if (e) graphLinks.push(e);
    }
  }

  return { card, diagnosis, feynmanHint, variantCards, graphLinks };
}

// ---------- #12 计划↔复习↔番茄联动 ----------

/**
 * 计划联动数据模型：
 *   plan.linkedCardIds: string[]      计划关联的卡片 id 列表
 *   plan.linkedPomoTag: string        关联的番茄会话 tag（如 "plan-xxx"）
 *   plan.autoProgress: boolean        是否自动从复习数据汇总进度
 *   plan.progress: { reviewed, total, pomoMinutes, pct, updatedAt }  自动计算的进度
 *
 * 实现：调用 refreshPlanProgress 重新计算计划的进度并回写
 */
export async function refreshPlanProgress(planId) {
  const plan = await db.plans.get(planId);
  if (!plan) return null;

  if (!plan.linkedCardIds?.length && !plan.linkedPomoTag) {
    return { reviewed: 0, total: 0, pomoMinutes: 0, pct: 0 };
  }

  let reviewed = 0, total = 0, pomoMinutes = 0;

  // 复习进度：关联卡片中有多少已今日复习
  if (plan.linkedCardIds?.length) {
    total = plan.linkedCardIds.length;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const todayReviews = await db.reviews.where('reviewedAt').aboveOrEqual(dayStart.getTime()).toArray();
    const reviewedIds = new Set(todayReviews.map(r => r.cardId));
    reviewed = plan.linkedCardIds.filter(id => reviewedIds.has(id)).length;
  }

  // 番茄进度：关联 tag 的今日会话总分钟数
  if (plan.linkedPomoTag) {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const sessions = await db.pomoSessions.where('startedAt').aboveOrEqual(dayStart.getTime()).toArray();
    pomoMinutes = sessions.filter(s => s.tag === plan.linkedPomoTag).reduce((s, x) => s + (x.duration || 0), 0);
  }

  const pct = total ? Math.round(reviewed / total * 100) : 0;
  const progress = { reviewed, total, pomoMinutes, pct, updatedAt: now() };
  await updatePlan(planId, { progress });
  return progress;
}

/**
 * 为计划自动绑定番茄会话 tag（开启联动）。
 */
export async function linkPlanToPomodoro(planId) {
  const tag = `plan-${planId}`;
  await updatePlan(planId, { linkedPomoTag: tag, autoProgress: true });
  return tag;
}

/**
 * 把卡片绑定到计划（开启复习联动）。
 */
export async function linkCardsToPlan(planId, cardIds) {
  const plan = await db.plans.get(planId);
  if (!plan) throw new Error('计划不存在');
  const set = new Set([...(plan.linkedCardIds || []), ...cardIds]);
  await updatePlan(planId, { linkedCardIds: [...set], autoProgress: true });
  return set.size;
}

/**
 * 记录番茄会话时，若 tag 命中某计划，自动刷新该计划进度。
 * 在 addPomoSession 之后调用。
 */
export async function syncPomoToPlan(tag) {
  if (!tag || !tag.startsWith('plan-')) return;
  const planId = tag.slice(5);
  const plan = await db.plans.get(planId);
  if (plan?.autoProgress) await refreshPlanProgress(planId);
}

/**
 * 记录复习后，刷新所有引用了该卡片的计划进度。
 * 性能优化版：单次查今日 reviews + pomoSessions，避免对每个 plan 重复全表扫描。
 */
export async function syncReviewToPlan(cardId) {
  const plans = await db.plans.toArray();
  const affected = plans.filter(p => p.autoProgress && p.linkedCardIds?.includes(cardId));
  if (!affected.length) return;

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayStartTs = dayStart.getTime();
  const [todayReviews, todaySessions] = await Promise.all([
    db.reviews.where('reviewedAt').aboveOrEqual(dayStartTs).toArray(),
    db.pomoSessions.where('startedAt').aboveOrEqual(dayStartTs).toArray(),
  ]);
  const reviewedIds = new Set(todayReviews.map(r => r.cardId));

  for (const plan of affected) {
    let reviewed = 0, total = 0, pomoMinutes = 0;
    if (plan.linkedCardIds?.length) {
      total = plan.linkedCardIds.length;
      reviewed = plan.linkedCardIds.filter(id => reviewedIds.has(id)).length;
    }
    if (plan.linkedPomoTag) {
      pomoMinutes = todaySessions.filter(s => s.tag === plan.linkedPomoTag).reduce((s, x) => s + (x.duration || 0), 0);
    }
    const pct = total ? Math.round(reviewed / total * 100) : 0;
    const progress = { reviewed, total, pomoMinutes, pct, updatedAt: now() };
    await updatePlan(plan.id, { progress });
  }
}

/**
 * 批量刷新所有开启联动的计划的进度（Plans.vue onMounted/load 用，避免 N 次 db 查询）。
 * 单次查今日 reviews + pomoSessions，O(N) 内存循环而非 O(N) db 查询。
 */
export async function refreshAllPlanProgress() {
  const plans = await db.plans.toArray();
  const autoPlans = plans.filter(p => p.autoProgress && (p.linkedCardIds?.length || p.linkedPomoTag));
  if (!autoPlans.length) return [];

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayStartTs = dayStart.getTime();
  const [todayReviews, todaySessions] = await Promise.all([
    db.reviews.where('reviewedAt').aboveOrEqual(dayStartTs).toArray(),
    db.pomoSessions.where('startedAt').aboveOrEqual(dayStartTs).toArray(),
  ]);
  const reviewedIds = new Set(todayReviews.map(r => r.cardId));

  const results = [];
  for (const plan of autoPlans) {
    let reviewed = 0, total = 0, pomoMinutes = 0;
    if (plan.linkedCardIds?.length) {
      total = plan.linkedCardIds.length;
      reviewed = plan.linkedCardIds.filter(id => reviewedIds.has(id)).length;
    }
    if (plan.linkedPomoTag) {
      pomoMinutes = todaySessions.filter(s => s.tag === plan.linkedPomoTag).reduce((s, x) => s + (x.duration || 0), 0);
    }
    const pct = total ? Math.round(reviewed / total * 100) : 0;
    const progress = { reviewed, total, pomoMinutes, pct, updatedAt: now() };
    await updatePlan(plan.id, { progress });
    results.push({ planId: plan.id, progress });
  }
  return results;
}

// ---------- 综合智能体能力：汇总各模块数据，供 Agent / 主动建议调用 ----------

/**
 * 生成今日学习画像（综合）：把今日序列 + 薄弱卡 + 统计 + 建议合并成一份。
 * 用于 Dashboard / Agent 上下文 / 主动建议引擎。
 */
export async function buildTodayInsight(opt = {}) {
  const [seq, weak, stats, suggestion] = await Promise.all([
    recommendTodaySequence(opt).catch(() => ({ sequence: [], segments: [], summary: '', phase: 'unknown' })),
    weakCards(20, 2).catch(() => []),
    getStats().catch(() => null),
    getReviewSuggestion().catch(() => null),
  ]);

  const insight = {
    date: new Date().toDateString(),
    phase: seq.phase || 'unknown',
    sequence: seq,
    weakCount: weak.length,
    weakSample: weak.slice(0, 5).map(c => ({
      id: c.id, front: String(c.front || '').slice(0, 40), subject: c.subject, failCount: c.failCount,
    })),
    stats: stats ? {
      totalCards: stats.totalCards, dueToday: stats.dueToday, todayReviews: stats.todayReviews,
      avgMastery: stats.avgMastery, ability: stats.ability,
    } : null,
    suggestion,
  };
  return insight;
}
