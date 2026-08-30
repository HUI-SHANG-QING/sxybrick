/**
 * 自动分类器（纯函数层，零 LLM，本地 TF-IDF + cosine 相似度）
 *
 * 设计目标：用户上传资料 / 建卡 / 记笔记时，零配置自动归类到已有 subject/category，
 * 或给出「建议分类」列表。无需网络、无需 API key、可离线、可复现。
 *
 * 算法流程：
 *   1) tokenize(text)            中英混合分词（中文 bigram + 英文单词 + 数字）
 *   2) trainClassifier(docs)     训练：计算 IDF + 每个类别的中心向量（样本均值）
 *   3) predictCategory(text, m)  预测：TF-IDF 向量与各类别中心做 cosine，返回 top-k
 *   4) evaluateClassifier(docs,m) 留一法准确率评估
 *
 * 阈值约定（可调）：
 *   MIN_CONFIDENCE = 0.12   cosine 低于此 → 判「未分类」，给 top-3 建议
 *   MIN_DOCS_PER_CLASS = 1  每类至少 1 个样本才建中心
 *
 * 术语约定：中文按 bigram（二元组）切分，能较好捕捉「矩阵/特征值/线性」这类考研术语；
 *   英文按单词切分并小写；数字与符号剔除。停用词用高频常见字过滤（可选）。
 */

// ──────────────── 停用词（中文常见虚字 + 英文常见词，降低噪声） ────────────────

const STOPWORDS = new Set([
  // 中文
  '的', '了', '和', '是', '在', '有', '我', '你', '他', '她', '它', '这', '那', '与', '或', '而', '及', '等',
  '把', '被', '对', '从', '到', '于', '之', '为', '以', '就', '都', '还', '也', '不', '要', '会', '能', '可',
  // 英文
  'the', 'a', 'an', 'of', 'to', 'in', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been', 'for', 'on', 'with',
  'this', 'that', 'it', 'as', 'at', 'by', 'from', 'its', 'their', 'they', 'we', 'you', 'i', 'he', 'she',
]);

// ──────────────── 分词 ────────────────

/**
 * 中英混合分词：中文按 bigram + 英文单词 + 连续数字，统一小写。
 * 返回词频 Map（term -> count）。
 */
export function tokenize(text) {
  const freq = new Map();
  if (!text) return freq;
  const s = String(text).toLowerCase();

  // 英文单词 / 数字（含下划线、连字符）
  const latin = /[a-z0-9]+(?:[-_][a-z0-9]+)*/g;
  let lastLatinEnd = 0;
  let m;
  const cjkSegments = [];
  while ((m = latin.exec(s)) !== null) {
    // 前一个 latin 之后、当前 latin 之前的 CJK 段落
    const cjk = s.slice(lastLatinEnd, m.index);
    if (cjk) cjkSegments.push(cjk);
    // 英文/数字词直接加入（过滤停用词 + 过短）
    const w = m[0];
    if (!STOPWORDS.has(w) && w.length >= 2) addTerm(freq, w);
    lastLatinEnd = m.index + w.length;
  }
  // 尾部 CJK
  const tail = s.slice(lastLatinEnd);
  if (tail) cjkSegments.push(tail);

  // CJK 段落按 bigram 切分
  for (const seg of cjkSegments) {
    const cjkChars = seg.replace(/[^\u4e00-\u9fff]/g, ''); // 只保留汉字
    if (cjkChars.length < 2) continue;
    for (let i = 0; i < cjkChars.length - 1; i++) {
      const bigram = cjkChars.slice(i, i + 2);
      if (STOPWORDS.has(bigram)) continue;
      addTerm(freq, bigram);
    }
  }

  return freq;
}

function addTerm(freq, term) {
  freq.set(term, (freq.get(term) || 0) + 1);
}

// ──────────────── TF-IDF ────────────────

/**
 * 计算词频（term frequency）：词频 / 文档总词数
 */
export function computeTf(freq, totalTerms) {
  if (!totalTerms) return {};
  const tf = {};
  for (const [term, count] of freq) tf[term] = count / totalTerms;
  return tf;
}

/**
 * 计算逆文档频率：log(总文档数 / (含该词的文档数 + 1)) + 1
 */
export function computeIdf(docs) {
  const N = docs.length;
  const df = new Map(); // term -> 出现文档数
  const allTerms = new Set();
  for (const d of docs) {
    const freq = typeof d.freq === 'function' ? d.freq() : (d.freq || (d.text ? tokenize(d.text) : new Map()));
    for (const term of freq.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
      allTerms.add(term);
    }
  }
  const idf = {};
  for (const term of allTerms) {
    idf[term] = Math.log(N / (df.get(term) + 1)) + 1;
  }
  return idf;
}

/**
 * 构建 TF-IDF 向量（稀疏对象，仅含非零项）
 */
export function buildTfidfVector(text, idf, vocab) {
  const freq = typeof text === 'object' && text instanceof Map ? text : tokenize(text);
  const totalTerms = [...freq.values()].reduce((s, c) => s + c, 0);
  if (!totalTerms) return {};
  const tf = computeTf(freq, totalTerms);
  const vec = {};
  for (const term of Object.keys(tf)) {
    const w = idf[term] ?? 1; // 未见过的词给默认权重
    if (vocab && !vocab.has(term)) continue; // 可选词汇表约束
    vec[term] = tf[term] * w;
  }
  return vec;
}

// ──────────────── 向量运算 ────────────────

/** 点积 */
export function dot(a, b) {
  let s = 0;
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  for (const k in small) if (k in large) s += small[k] * large[k];
  return s;
}

/** L2 范数 */
export function norm(a) {
  let s = 0;
  for (const k in a) s += a[k] * a[k];
  return Math.sqrt(s);
}

/** cosine 相似度（零向量返回 0） */
export function cosine(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

// ──────────────── 训练 / 预测 ────────────────

/**
 * 训练分类器。
 * @param {Array<{ text: string, label: string }>} docs 带标签的样本
 * @returns {{
 *   labels: string[],          // 去重类别
 *   idf: object,               // term -> idf
 *   vocab: Set<string>,        // 词汇表
 *   centroids: { [label]: object }  // 类别 -> 中心向量（样本均值）
 * }}
 */
export function trainClassifier(docs) {
  if (!Array.isArray(docs) || !docs.length) return { labels: [], idf: {}, vocab: new Set(), centroids: {} };
  const idf = computeIdf(docs);
  const vocab = new Set(Object.keys(idf));

  // 按 label 分组
  const byLabel = new Map();
  for (const d of docs) {
    const label = String(d.label || '').trim();
    if (!label || !d.text) continue;
    const vec = buildTfidfVector(d.text, idf, vocab);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(vec);
  }

  // 每个类别中心 = 样本向量均值
  const centroids = {};
  for (const [label, vecs] of byLabel) {
    const sum = {};
    for (const v of vecs) for (const k in v) sum[k] = (sum[k] || 0) + v[k];
    const n = vecs.length;
    const center = {};
    for (const k in sum) center[k] = sum[k] / n;
    centroids[label] = center;
  }

  return { labels: [...byLabel.keys()], idf, vocab, centroids };
}

/**
 * 预测分类（返回 top-k 结果，按 cosine 降序）。
 * @returns {Array<{ label, score }>} 空数组 = 无样本可分类
 */
export function predictCategory(text, model, { k = 3 } = {}) {
  if (!model?.centroids || !Object.keys(model.centroids).length) return [];
  const vec = buildTfidfVector(text, model.idf, model.vocab);
  const scores = [];
  for (const [label, center] of Object.entries(model.centroids)) {
    scores.push({ label, score: cosine(vec, center) });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

/**
 * 高层的「分类决策」：给定阈值，返回 { label, confidence, suggestions, ok }。
 *   label:       最佳匹配类别；无把握时为 '未分类'
 *   confidence:  cosine 分数
 *   suggestions: top-k 建议（含分数）
 *   ok:          是否达到可信阈值（**判定的唯一依据**）
 *
 * ⚠️ 不能只用 `label === '未分类'` 判断「没分出来」：用户完全可能真有一个叫「未分类」的科目，
 * 那时每条预测都会命中它，上层会把所有卡片当成「不可分类」跳过——这正是
 * 「有 2591 条待分类，却提示可自动分类 0 条」的成因之一。故一律以 ok 为准。
 */
export function classify(text, model, { threshold = 0.12, k = 3 } = {}) {
  const scores = predictCategory(text, model, { k });
  if (!scores.length) return { label: '未分类', confidence: 0, suggestions: [], ok: false };
  const best = scores[0];
  if (best.score < threshold) {
    return { label: '未分类', confidence: best.score, suggestions: scores, ok: false };
  }
  return { label: best.label, confidence: best.score, suggestions: scores, ok: true };
}

// ──────────────── 评估 ────────────────

/**
 * 留一法（Leave-One-Out）准确率评估。
 * 对每个样本：用其余样本训练 → 预测 → 与真实标签比对。
 * @returns {{ accuracy: number, correct: number, total: number, details: Array }}
 */
export function evaluateClassifier(docs) {
  const total = docs.length;
  if (!total) return { accuracy: 0, correct: 0, total: 0, details: [] };
  let correct = 0;
  const details = [];
  for (let i = 0; i < total; i++) {
    const rest = docs.filter((_, j) => j !== i);
    const model = trainClassifier(rest);
    const pred = predictCategory(docs[i].text, model, { k: 1 });
    const guessed = pred[0]?.label || '未分类';
    const actual = docs[i].label;
    if (guessed === actual) correct++;
    details.push({ actual, guessed, correct: guessed === actual });
  }
  return { accuracy: correct / total, correct, total, details };
}

// ──────────────── 便捷工具 ────────────────

/**
 * 从「卡片 / 资料 / 笔记」里提取可分类的文本（front+back 或 text/content）。
 * 便于 callers 统一把实体转为 { text, label } 训练样本。
 */
export function toTrainSample(entity, { labelField = 'subject', textField = 'text' } = {}) {
  const label = String(entity?.[labelField] || '').trim();
  const parts = [];
  if (entity?.front) parts.push(entity.front);
  if (entity?.back) parts.push(entity.back);
  if (entity?.content) parts.push(entity.content);
  if (entity?.[textField] && entity?.[textField] !== entity?.content) parts.push(entity[textField]);
  const text = parts.filter(Boolean).join(' ');
  return { label, text };
}
