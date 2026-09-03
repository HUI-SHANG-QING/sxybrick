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
  const threshold = opts.threshold ?? 0.32;
  if (!cards || cards.length < 2) {
    return cards.map(c => ({ concept: c.subject || '未分类', cardIds: [c.id], size: 1, score: 1, representative: summarize(c) }));
  }
  if (cards.length > MAX_CLUSTER_INPUT) {
    const buckets = new Map();
    for (const c of cards) {
      const key = c?.subject || '未分类';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(c);
    }
    const merged = [];
    for (const bucket of buckets.values()) {
      merged.push(...attributeMistakes(bucket.slice(0, MAX_CLUSTER_INPUT), opts));
    }
    return merged.sort((a, b) => b.size - a.size);
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
      for (const tk of tokenize(`${card.front} ${(card.tags || []).join('')}`)) {
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
