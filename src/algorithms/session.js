// src/algorithms/session.js
// 复习会话编排：交错练习 + 检索分级 + 测试间隔效应（离线、纯函数）
//
// 认知科学依据：
//   - 交错练习（Interleaving）：混科/混题练习比集中练习（Blocked）显著提升远迁移
//     （Rohrer & Taylor 2007 等，幅度 40%+）；相邻卡片同主题会触发"答案顺拐"，
//     打散后每次作答都是真实检索。
//   - 检索分级（Retrieval Grading）：按「是否回忆成功 / 是否蒙对 / 作答强度 / 作答时长」
//     给每次提取定级。提取越吃力 → 记忆越接近断裂 → 间隔应越短（宜早重现）；
//     提取越流畅 → 记忆越巩固 → 间隔可拉长。
//   - 测试间隔效应（Testing & Spacing Effect）：主动检索本身就是学习（测试效应）；
//     同主题两次测试之间要有最小间隔（间隔效应）。interleaveQueue 的邻接窗口即
//     会话内间隔保证（相邻 N 张内不重复同科目/同题型/同变式）。

import { prioritizeForExam } from './scheduling.js';

/** 检索分级档位元信息（factor 供需要显式调制间隔的调用方使用） */
export const RETRIEVAL_GRADE_META = {
  failed: { label: '遗忘', factor: 0.6 },
  hard:   { label: '艰难', factor: 0.8 },
  medium: { label: '一般', factor: 1.0 },
  easy:   { label: '流畅', factor: 1.15 },
};

/**
 * 给一次检索尝试定级（纯函数）
 * @param {object} signal
 *   rating: 0没记住 / 1还模糊 / 2记住了
 *   guessed?: boolean 是否蒙对
 *   responseMs?: number 作答耗时（毫秒）
 *   retrievalStrength?: 'recognize'|'recall'|'generate'|'explain'
 * @returns {{ level:'failed'|'hard'|'medium'|'easy', score:number }} score∈[0,1]，越高=提取越流畅
 */
export function retrievalGrading(signal = {}) {
  const { rating = 0, guessed = false, responseMs = 0, retrievalStrength = '' } = signal;
  let level, score;
  if (rating === 0) {
    level = 'failed'; score = 0;
  } else if (rating === 1) {
    level = 'hard'; score = 0.35;
  } else if (guessed) {
    // 蒙对 ≠ 掌握：按艰难处理（不升级、早重现）
    level = 'hard'; score = 0.5;
  } else if (retrievalStrength === 'recognize') {
    // 看了选项才认出 → 只是再认，掌握度最低档的"成功"
    level = 'medium'; score = 0.65;
  } else if (retrievalStrength === 'generate') {
    level = 'easy'; score = 0.95;
  } else if (retrievalStrength === 'explain') {
    level = 'easy'; score = 1.0;
  } else {
    // recall 或未知：主动回忆，基准
    level = 'medium'; score = 0.8;
  }
  // 答对但超过 8 秒：提取不流畅，下调一档（间隔效应 → 更早重现）
  if (level !== 'failed' && responseMs > 8000) {
    if (level === 'easy') { level = 'medium'; score = 0.65; }
    else if (level === 'medium') { level = 'hard'; score = 0.45; }
  }
  return { level, score: Number(score.toFixed(2)) };
}

/**
 * 由一张卡的历史复习记录估计当前检索难度（0=最难，1=最流畅；无历史返回 null）
 * @param {object} card 仅作占位保留接口对称性
 * @param {Array} reviews [{ rating, guessed, responseMs, retrievalStrength }]
 */
export function estimateRetrievalDifficulty(card, reviews) {
  if (!reviews || !reviews.length) return null;
  let sum = 0;
  for (const r of reviews) sum += retrievalGrading(r).score;
  return Number((sum / reviews.length).toFixed(2));
}

/**
 * 交错队列：贪心 + 邻接惩罚。维护最近 WINDOW 张的维度集合，每步选惩罚最低者；
 * 惩罚并列时用 rank(c,i) 决胜（越小越优先，默认输入稳定序）。
 * 维度：科目（最强）/ 难度 / 题型 / 同源变式（防"假掌握"）。
 * @param {Array} cards 卡片数组
 * @param {object} opts { window?:number=3, weights?:{subject,difficulty,type,source}, keyOf?, rank? }
 * @returns 打散后的新数组（不修改入参）
 */
export function interleaveQueue(cards, opts = {}) {
  if (!cards || cards.length < 2) return cards ? cards.slice() : [];
  const WINDOW = opts.window ?? 3;
  const W = { subject: 3, difficulty: 1, type: 1, source: 5, ...(opts.weights || {}) };
  const keyOf = opts.keyOf || ((c) => ({
    subject: c.subject || '未分类',
    difficulty: c.difficulty ?? 'basic',
    type: c.type ?? 'basic',
    source: c.sourceCardId || '',
  }));
  const remaining = cards.slice();
  const result = [];
  const winSubject = [], winDiff = [], winType = [], winSource = [];
  const pushWin = (c) => {
    const k = keyOf(c);
    winSubject.push(k.subject); winDiff.push(k.difficulty); winType.push(k.type); winSource.push(k.source);
    if (winSubject.length > WINDOW) {
      winSubject.shift(); winDiff.shift(); winType.shift(); winSource.shift();
    }
  };
  const rank = opts.rank || ((c, i) => i);
  while (remaining.length) {
    let bestIdx = 0, bestPen = Infinity, bestRank = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const k = keyOf(remaining[i]);
      let pen = 0;
      if (winSubject.length) {
        for (let j = 0; j < winSubject.length; j++) {
          if (winSubject[j] === k.subject) pen += W.subject;
          if (winDiff[j] === k.difficulty) pen += W.difficulty;
          if (winType[j] === k.type) pen += W.type;
          if (k.source && winSource[j] === k.source) pen += W.source;
        }
      }
      const r = rank(remaining[i], i);
      if (pen < bestPen || (pen === bestPen && r < bestRank)) {
        bestPen = pen; bestIdx = i; bestRank = r;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    result.push(picked);
    pushWin(picked);
  }
  return result;
}

/**
 * 完整复习会话编排：考试优先级 → 检索难度优先（难卡早重现）→ 交错混科
 * 这是「测试间隔效应」的会话级实现：难卡/临考卡先练、同主题相邻不重复、
 * 考前因遗忘风险的卡被压缩进考前窗口（scheduling.js 软约束，不动 FSRS 状态）。
 * @param {Array} cards 待复习卡（含 fsrs/dueAt/difficulty/type/sourceCardId）
 * @param {object} opts
 *   examAt?: number 目标考试时间戳（触发考试窗口紧迫度排序）
 *   reviewsByCard?: Map<cardId, Array<review>> 用于检索分级（hardest first）
 *   interleave?: boolean 是否交错混科（默认 true）
 *   desiredRetention?: number
 * @returns {{ queue:Array, meta:{ interleaved, examUrgencyApplied, graded, spacing } }}
 */
export function buildReviewSession(cards, opts = {}) {
  const { examAt, reviewsByCard = new Map(), interleave = true, desiredRetention } = opts;
  let pool = cards.slice();
  let examUrgencyApplied = false;
  if (examAt) {
    pool = prioritizeForExam(pool, examAt, { desiredRetention });
    examUrgencyApplied = true;
  }
  // 每张卡的检索难度：无历史按 0.5（中等），有历史取平均提取流畅度
  const ds = new Map();
  let graded = 0;
  for (const c of pool) {
    const rs = reviewsByCard.get(c.id);
    const v = estimateRetrievalDifficulty(c, rs);
    if (v !== null) graded++;
    ds.set(c.id, v);
  }
  // 决胜键：考试紧迫度降序（主） → 检索难度升序·难卡优先（次） → 输入稳定序
  const rank = (c, i) => {
    const eu = c._examUrgency ?? 0;
    const v = ds.get(c.id);
    const d = v === null ? 0.5 : v;
    return (1 - eu) * 1000 + d * 10 + i * 1e-6;
  };
  let queue;
  if (interleave) queue = interleaveQueue(pool, { rank });
  else queue = pool.slice().sort((a, b) => rank(a, 0) - rank(b, 0));
  return {
    queue,
    meta: {
      interleaved: !!interleave,
      examUrgencyApplied,
      graded,
      spacing: interleave ? 1 : 0, // 会话内最小科目间隔（张）
    },
  };
}

/**
 * 错题聚类反哺出题：按错因簇组织一份「错题轰炸」测验序列。
 * 每个簇：先补未掌握的前置卡（derivePrereqPlan 结果，prereq 优先），再练簇内错题卡；
 * 全程交错排序防相似题连排。纯函数，零 LLM，确定性输出。
 * @param {Array} clusters attributeMistakes 输出（已按 size 降序）
 * @param {Array} cards 卡片全集（含簇内卡 + 可补充的前置卡）
 * @param {object} opts { limit?:number=5, count?:number=10, prereq?:Map<leadId,string[]>, interleave?:boolean=true }
 * @returns {{ clusters, sequence:Array<{id,subject,front,role,cluster,dueAt,level}>, meta }}
 */
export function planMistakeQuiz(clusters, cards, opts = {}) {
  const { limit = 5, count = 10, prereq = new Map(), interleave = true } = opts;
  if (!clusters || !clusters.length) return { clusters: [], sequence: [], meta: { note: '无错题簇' } };
  const byId = new Map((cards || []).map(c => [c.id, c]));
  const top = clusters.slice(0, limit);
  const picked = [];
  const seen = new Set();
  for (const cl of top) {
    const leadId = cl.cardIds[0];
    const pre = prereq.get(leadId) || [];
    for (const pid of pre) {
      if (picked.length >= count) break;
      if (!seen.has(pid) && byId.has(pid)) { seen.add(pid); picked.push({ id: pid, role: 'prereq', cluster: cl.concept }); }
    }
    for (const cid of cl.cardIds) {
      if (picked.length >= count) break;
      if (!seen.has(cid) && byId.has(cid)) { seen.add(cid); picked.push({ id: cid, role: 'weak', cluster: cl.concept }); }
    }
    if (picked.length >= count) break;
  }
  const seqCards = picked.map(p => ({ ...byId.get(p.id), _role: p.role, _cluster: p.cluster }));
  let sequence;
  if (interleave) {
    // 同惩罚时前置卡优先（role 0 < 1），交错仍按科目打散
    sequence = interleaveQueue(seqCards, { rank: (c, i) => (c._role === 'prereq' ? 0 : 1) + i * 1e-6 });
  } else {
    sequence = seqCards.slice();
  }
  return {
    clusters: top.map(c => ({ concept: c.concept, size: c.size, score: c.score, cardIds: c.cardIds })),
    sequence: sequence.map(c => ({
      id: c.id, subject: c.subject, front: String(c.front || '').slice(0, 80),
      role: c._role, cluster: c._cluster, dueAt: c.dueAt, level: c.level,
    })),
    meta: {
      total: sequence.length,
      prereqCount: sequence.filter(c => c._role === 'prereq').length,
      weakCount: sequence.filter(c => c._role === 'weak').length,
      interleaved: !!interleave,
    },
  };
}
