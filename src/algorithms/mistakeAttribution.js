// src/algorithms/mistakeAttribution.js
// 错题归因本地化：不依赖 LLM，纯本地 TF-IDF + 余弦相似度对「错题」做概念聚类，
// 让用户看见「我反复错在哪些知识点」，直接驱动薄弱点复习。离线、确定性、零 API 成本。
//
// 文本特征：ASCII 词 + 中文二元语法（bigram），兼顾术语与中文语义碎片。

/** 分词：英文/数字词 + 中文二元语法 */
export function tokenize(text = '') {
  const t = String(text).toLowerCase();
  const tokens = [];
  // ASCII 词
  const ascii = t.match(/[a-z0-9]+/g);
  if (ascii) tokens.push(...ascii);
  // 中文串 → 二元语法
  const cjkRuns = t.match(/[一-鿿]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) tokens.push(run);
      else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 构建 TF-IDF 向量（归一化） */
function buildVectors(docs) {
  const df = new Map();
  const raw = docs.map(text => {
    const toks = tokenize(text);
    const tf = new Map();
    for (const tk of toks) tf.set(tk, (tf.get(tk) || 0) + 1);
    for (const tk of tf.keys()) df.set(tk, (df.get(tk) || 0) + 1);
    return tf;
  });
  const N = docs.length || 1;
  return raw.map(tf => {
    const vec = {};
    let norm = 0;
    for (const [tk, f] of tf) {
      const idf = Math.log((N + 1) / (df.get(tk) + 1)) + 1;
      const v = (1 + Math.log(f)) * idf;
      vec[tk] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (const k in vec) vec[k] /= norm;
    return vec;
  });
}

function cosine(a, b) {
  let dot = 0;
  const keys = Object.keys(a).length < Object.keys(b).length ? a : b;
  for (const k in keys) if (b[k] !== undefined && a[k] !== undefined) dot += a[k] * b[k];
  return dot;
}

// round26 M-5：O(n²) 两两余弦的输入上限——500 卡 = 12.5 万对比较，主线程可感卡顿。
// 超出时按 subject 分桶分别聚类再合并结果（错题按科目聚类本就语义更准：
// 「操作系统-死锁」与「数据结构-二叉树」不应被 TF-IDF 跨科误并）。
const MAX_CLUSTER_INPUT = 500;

/**
 * 对一批错题做概念聚类
 * @param {Array} cards [{ id, front, back, subject, tags?, wrongReason? }]
 * @param {object} opts { threshold?:number (默认 0.32) }
 * @returns Array<{ concept, cardIds, size, score, representative }>
 *   概念名取簇内高频 token；score = 簇内平均两两相似度；representative = 标题式摘要
 */
export function attributeMistakes(cards, opts = {}) {
  // round80 A7：threshold 必须先做域校验——`sim >= NaN` **恒 false**，会让所有卡片
  // 退化成单卡簇（看起来"没有聚类结果"，静默无簇，比报错更难查）。非法值回退默认 0.32。
  const rawThreshold = Number(opts.threshold ?? 0.32);
  const threshold = Number.isFinite(rawThreshold) ? Math.min(1, Math.max(0, rawThreshold)) : 0.32;
  // round80 审计 A4：守卫写错——`!cards` 成立后仍调 `cards.map` → 传 undefined/null 直接
  // TypeError（工具链路 cards 来自查询结果，异常路径可能给到空值）。先归一成数组再判断。
  const list = Array.isArray(cards) ? cards : [];
  if (list.length < 2) {
    // 单卡簇的 score 约定为 1（**无对可测**时的占位值，与合并路径 `Math.max(prev, c)` 一致）。
    // 注：这与「≥2 卡但两两相似度全为 0」的簇（score=0）刻意不同——后者是"测了，确实不像"，
    // 前者是"没法测"。改这个数字会直接移动错题集排序，而它没有唯一正确答案，故保持并写明。
    return list.map(c => ({ concept: c?.subject || '未分类', cardIds: [c?.id], size: 1, score: 1, representative: summarize(c) }));
  }
  if (cards.length > MAX_CLUSTER_INPUT) {
    // round26 M-5 修正：分桶后不再 slice(0, MAX_CLUSTER_INPUT) 丢弃尾部卡片。
    // 对每个桶做分块聚类（每块 ≤ MAX_CLUSTER_INPUT），再按块内 concept 合并。
    // 保证每张卡至少进入一个簇，绝不静默丢弃——静默丢数据是比性能更严重的问题。
    const buckets = new Map();
    for (const c of cards) {
      const key = c?.subject || '未分类';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(c);
    }
    const merged = [];
    for (const bucket of buckets.values()) {
      // 分块：每块 maxBlock 张，逐块聚类后收集所有簇
      for (let i = 0; i < bucket.length; i += MAX_CLUSTER_INPUT) {
        const chunk = bucket.slice(i, i + MAX_CLUSTER_INPUT);
        merged.push(...attributeMistakes(chunk, opts));
      }
    }
    // 跨块合并同名概念簇（2026-09-14 审计 P3）：同一概念横跨两块边界时会被切成
    // 两个独立簇（如「死锁」在块 1 和块 2 各成一簇）→ 错题集里同一知识点出现两次。
    // 桶内已是同科目，同名 concept（高频 token）即同一概念，cardIds 合并、size 重算。
    const byConcept = new Map();
    // 已测量「对数」= C(n,2)：与 score（簇内平均两两相似度）的定义同尺度，用于加权合并
    const pairCount = (n) => (n * (n - 1)) / 2;
    for (const c of merged) {
      const k = c.concept;
      const hit = byConcept.get(k);
      if (!hit) { byConcept.set(k, { ...c, cardIds: [...c.cardIds] }); continue; }
      // round48：合并后 score 应取「按已测量对数加权的平均」，而不是两者取最大值——
      // 取 max 会让一个内部相似度虚高的小子簇把整个合并簇的分数抬高，错题归因排序失真。
      const prevScore = hit.score;
      const w1 = pairCount(hit.cardIds.length);
      const w2 = pairCount(c.cardIds.length);
      const wsum = w1 + w2;
      hit.cardIds.push(...c.cardIds);
      hit.size = hit.cardIds.length;
      hit.score = wsum > 0
        ? Number(((prevScore * w1 + c.score * w2) / wsum).toFixed(3))
        : Math.max(prevScore, c.score); // 两簇都只有单卡（无对可测）时退回 max
    }
    // round80 A6：排序键必须与下面的主路径完全一致（size 降序 → score 降序）。
    // 此前只按 size 排，于是同一批卡片「走分块路径（≥500 张）还是主路径」会给出**不同顺序**，
    // 而下游（错题集）会截断取前 N 个 → 展示的簇集合都可能不同。
    return [...byConcept.values()].sort((a, b) => b.size - a.size || b.score - a.score);
  }
  const texts = cards.map(c => `${c.front || ''} ${c.back || ''} ${(c.tags || []).join(' ')} ${(c.wrongReason || '')}`);
  const vecs = buildVectors(texts);

  // 贪心单连接聚类
  const parent = cards.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = cosine(vecs[i], vecs[j]);
      if (sim >= threshold) {
        const a = find(i), b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  cards.forEach((c, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ idx: i, card: c });
  });

  const result = [];
  for (const [, items] of groups) {
    // 概念名：取簇内 token 频率最高的非停用词
    const freq = new Map();
    for (const { card } of items) {
      // round80 审计 A5：`card.front` 缺守卫 → undefined 拼出 token "undefined"，
      // 会被选成概念名，用户在归因结果里看到「undefined」这个"知识点"。
      for (const tk of tokenize(`${card?.front || ''} ${(card?.tags || []).join('')}`)) {
        if (STOP.has(tk)) continue;
        freq.set(tk, (freq.get(tk) || 0) + 1);
      }
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    const concept = top ? top[0] : (items[0].card.subject || '未分类');
    // 簇内平均相似度
    let sum = 0, n = 0;
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      sum += cosine(vecs[items[a].idx], vecs[items[b].idx]); n++;
    }
    const score = n ? sum / n : 1;
    result.push({
      concept,
      cardIds: items.map(x => x.card.id),
      size: items.length,
      score: Number(score.toFixed(3)),
      representative: summarize(items[0].card),
    });
  }
  return result.sort((a, b) => b.size - a.size || b.score - a.score);
}

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '这', '那', '和', '与', '及', '或', '等', '中', '为', '对', '不', '有', '个', '一', '也', '都', '要', '会', '能', '可', '把', '被', '从', '到']);

function summarize(card) {
  const f = (card.front || '').replace(/\n/g, ' ').slice(0, 42);
  return f || card.subject || '错题';
}
