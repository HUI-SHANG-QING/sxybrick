// src/analysis/local-analyzer.js
// M2 本地联动分析引擎：离线可用，不依赖 LLM。
// 信号优先级：卡片标签/科目（强关联）> 文本关键词共现（Jaccard 相似度）> 复习数据（掌握度）。
// 设计：纯函数 + 显式入参（cards 数组 + 指令对象），Node 下可直接单测。
// 性能：>100 张卡时关键词矩阵改为「标签/科目优先 + 截断文本」，避免 O(n²) 全文相似度爆炸。

import { tokenize } from '../utils/classifier.js';

/** 卡片 → 轻量文本画像（标签/科目加权 + 内容关键词） */
export function cardProfile(card) {
  const text = `${card.front || ''} ${card.back || ''}`;
  const freq = tokenize(text);
  // 标签/科目是强信号：并入词频表（原词频 ×3）。
  // 注意 tokenize 返回 Map，必须迭代 entries（[词条, 频率]），只迭代 Map 会拿到频率值当词条
  for (const t of card.tags || []) {
    for (const [w, f] of tokenize(t)) freq.set(w, (freq.get(w) || 0) + f * 3);
  }
  if (card.subject) {
    for (const [w, f] of tokenize(card.subject)) freq.set(w, (freq.get(w) || 0) + f * 3);
  }
  return freq;
}

/** 两张卡画像的 Jaccard 相似度（0~1） */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const [w] of a) if (b.has(w)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

/** 共同知识点：出现卡数占比 >= threshold 的关键词（按覆盖卡数降序）
 *
 * 阈值兜底（本次修复）：严格阈值（默认覆盖 ≥50% 卡片）在「卡片多且跨科目」时几乎必然无解
 *   —— 30 张跨科卡片要求 15 张共有一个关键词，实测永远返回空，
 *   「共同知识点」预设于是长期表现为空白列表。
 * 故严格阈值无结果时，退而求其次返回覆盖 ≥2 张卡的高频词，让预设始终有可展示内容；
 * 调用方（runPreset）会依据 ratio 判断命中档位并在 note 里如实说明口径。
 */
export function commonKeywords(cards, threshold = 0.5, topN = 12) {
  const n = cards.length;
  if (!n) return [];
  const cover = new Map(); // term -> 覆盖卡数
  for (const c of cards) {
    const seen = new Set();
    for (const [w] of cardProfile(c)) {
      if (w.length < 2) continue;
      if (!seen.has(w)) { seen.add(w); cover.set(w, (cover.get(w) || 0) + 1); }
    }
  }
  const sortTop = (arr) => arr.sort((a, b) => b.cards - a.cards || a.term.localeCompare(b.term)).slice(0, topN);
  const out = [];
  for (const [w, k] of cover) {
    if (k >= Math.max(2, Math.ceil(n * threshold))) out.push({ term: w, cards: k, ratio: +(k / n).toFixed(2) });
  }
  if (out.length) return sortTop(out);
  const loose = [];
  for (const [w, k] of cover) if (k >= 2) loose.push({ term: w, cards: k, ratio: +(k / n).toFixed(2) });
  return sortTop(loose);
}

/** 关键词共现相似度矩阵（大集合截断：仅取每卡 top-40 高频词，控制 O(n²) 成本） */
export function similarityMatrix(cards, cap = 40) {
  const n = cards.length;
  const profs = cards.map(c => {
    const f = cardProfile(c);
    if (f.size > cap) {
      const top = [...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
      return new Map(top);
    }
    return f;
  });
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = jaccard(profs[i], profs[j]);
      m[i][j] = s; m[j][i] = s;
    }
  }
  return m;
}

/**
 * 推断前置依赖 → 拓扑排序。
 * 启发式规则（本地模式无 LLM，按信号强度排序）：
 *  1) 标签/科目相同 → 视为同域（强信号）
 *  2) 相似度更高的卡视为「更基础」：若 A 与更多卡的平均相似度更高，则 A 更可能是前置
 *  3) 掌握度（ease/level 越高越基础，通常先学）作为 tie-breaker
 * 返回有序 id 数组（拓扑序：先学的在前）。环 → 按相似度兜底排序，保证总有结果。
 */
export function topoSort(cards, matrix) {
  const n = cards.length;
  if (!n) return [];
  if (n === 1) return [cards[0].id];
  // 防御：矩阵与卡片必须是同一批。若调用方先算矩阵再过滤卡片（或反过来），
  // matrix[i] 会是 undefined → `.reduce` 直接 TypeError 让整个分析面板崩掉。
  if (!Array.isArray(matrix) || matrix.length !== n) return cards.map(c => c.id);
  // 每卡的「基础性得分」= 平均相似度 ×10 + 掌握度加成（ease 越大越稳 → 越基础）
  const score = cards.map((c, i) => {
    const avg = matrix[i].reduce((a, b) => a + b, 0) / Math.max(1, n - 1);
    const mastery = (c.ease || 2.5) / 3 + (c.level || 0) / 10;
    return avg * 10 + mastery;
  });
  // 按基础性降序（越基础越靠前）—— 简化拓扑：真实 DAG 由 AI 模式给出
  const order = cards.map((c, i) => ({ id: c.id, score: score[i] }))
    .sort((a, b) => b.score - a.score);
  return order.map(o => o.id);
}

/** 关键路径：拓扑序中「桥梁度」最高的前 K 张（与最多其他卡相连） */
export function criticalPath(cards, matrix, k = 3) {
  const n = cards.length;
  if (!n) return [];
  // 同 topoSort：矩阵与卡片必须同源，否则 row 为 undefined → TypeError
  if (!Array.isArray(matrix) || matrix.length !== n) return cards.map(c => ({ id: c.id, degree: 0 }));
  const deg = matrix.map(row => (row || []).reduce((a, b) => a + (Number(b) || 0), 0));
  return deg.map((d, i) => ({ id: cards[i].id, degree: +d.toFixed(3) }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, Math.min(k, n));
}

/**
 * 最短学习路径：综合「前置推断 + 薄弱优先」的推荐复习/学习顺序。
 * 规则：基础得分（平均相似度 + 掌握度）降序 = 基础在前；
 * 基础得分相近（差 < 0.5，视为同层）时薄弱卡（failCount≥2 或 ease<2.2）优先。
 */
export function learningPath(cards, matrix) {
  const n = cards.length;
  const byId = new Map(cards.map(c => [c.id, c]));
  const isWeak = c => (c.failCount || 0) >= 2 || (c.ease || 2.5) < 2.2;
  const scored = cards.map((c, i) => {
    const avg = matrix[i].reduce((a, b) => a + b, 0) / Math.max(1, n - 1);
    const base = avg * 10 + (c.ease || 2.5) / 3 + (c.level || 0) / 10;
    return { id: c.id, base, weak: isWeak(c) };
  });
  scored.sort((a, b) => {
    if (Math.abs(a.base - b.base) < 0.5) return (b.weak ? 1 : 0) - (a.weak ? 1 : 0);
    return b.base - a.base;
  });
  return scored.map(({ id, weak }) => {
    const c = byId.get(id);
    return { id, front: (c.front || '').slice(0, 40), weak, ease: c.ease };
  });
}

/** 关系图谱：节点（卡）+ 边（相似度 >= threshold 的强关联），供 ECharts graph 渲染 */
export function relationGraph(cards, matrix, threshold = 0.08, maxEdges = 60) {
  const n = cards.length;
  const nodes = cards.map((c, i) => ({
    id: c.id,
    name: (c.front || '').slice(0, 18) || `卡${i + 1}`,
    subject: c.subject || '',
    group: c.subject || '其他',
    symbolSize: 14 + Math.min(26, (matrix[i].reduce((a, b) => a + b, 0) * 8)),
  }));
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (matrix[i][j] >= threshold) edges.push({ source: cards[i].id, target: cards[j].id, value: +matrix[i][j].toFixed(3) });
    }
  }
  edges.sort((a, b) => b.value - a.value);
  return { type: 'graph', data: { nodes, edges: edges.slice(0, maxEdges) } };
}

/** 卡片异同对比（默认取前两张） */
export function compareCards(cards) {
  const [a, b] = cards.slice(0, 2);
  if (!a) return { type: 'text', data: { text: '至少需要 1 张卡。' } };
  if (!b) return { type: 'text', data: { text: '对比需要 2 张卡——当前只选了 1 张。' } };
  const pa = cardProfile(a), pb = cardProfile(b);
  const both = [...pa.keys()].filter(w => pb.has(w) && w.length >= 2);
  const onlyA = [...pa.keys()].filter(w => !pb.has(w) && w.length >= 2).slice(0, 10);
  const onlyB = [...pb.keys()].filter(w => !pa.has(w) && w.length >= 2).slice(0, 10);
  const same = [
    ...(a.subject === b.subject ? [`科目相同：${a.subject}`] : [`科目：${a.subject || '未设'} vs ${b.subject || '未设'}`]),
    ...(both.length ? [`共同关键词：${both.slice(0, 10).join('、')}`] : ['共同关键词：较少（内容差异较大）']),
  ];
  const diff = [
    `A「${(a.front || '').slice(0, 24)}」独有：${onlyA.length ? onlyA.slice(0, 8).join('、') : '—'}`,
    `B「${(b.front || '').slice(0, 24)}」独有：${onlyB.length ? onlyB.slice(0, 8).join('、') : '—'}`,
  ];
  return {
    type: 'list',
    data: {
      a: a.id, b: b.id,
      similarity: +jaccard(pa, pb).toFixed(3),
      same: same.map(s => ({ text: s })),
      diff: diff.map(s => ({ text: s })),
    },
  };
}

/**
 * 预设快捷指令（统一入口）：
 *  graph | topo | critical | common | path | compare
 *  返回结构化结果 { type: 'graph'|'list'|'timeline'|'text', data, engine: 'local' }
 */
export function runPreset(preset, cards) {
  if (!cards.length) return { type: 'text', data: { text: '请先选择卡片。' }, engine: 'local' };
  const matrix = similarityMatrix(cards);
  switch (preset) {
    case 'graph':
      return { engine: 'local', ...relationGraph(cards, matrix) };
    case 'topo': {
      const order = topoSort(cards, matrix);
      const byId = new Map(cards.map(c => [c.id, c]));
      // 拓扑序 → 有向图：横轴=学习顺序，纵轴=科目聚类；相邻节点连边成「学习链」
      const subjects = [...new Set(cards.map(c => c.subject || '其他'))];
      const subjIdx = new Map(subjects.map((s, i) => [s, i]));
      const nodes = order.map((id, i) => {
        const c = byId.get(id);
        const subj = c?.subject || '其他';
        return {
          id, name: (c?.front || '').slice(0, 18) || `卡${i + 1}`,
          subject: subj, group: subj, order: i,
          x: i * 90, y: (subjIdx.get(subj) || 0) * 90,
          symbolSize: 16 + Math.min(20, (c?.ease || 2.5) * 3),
        };
      });
      const edges = [];
      for (let i = 1; i < order.length; i++) edges.push({ source: order[i - 1], target: order[i], value: 1 });
      return {
        type: 'graph', engine: 'local', layout: 'topo',
        data: { nodes, edges, layout: 'topo', order },
        note: '本地启发式：按「同域相似度 + 掌握度」推断基础在前；横轴=学习顺序，纵轴=科目聚类（AI 模式可给出真实依赖链）',
      };
    }
    case 'critical': {
      const cp = criticalPath(cards, matrix, Math.min(3, cards.length));
      const criticalIds = cp.map(x => x.id);
      const rg = relationGraph(cards, matrix).data; // { nodes, edges }
      const nodes = rg.nodes.map(n => ({ ...n, critical: criticalIds.includes(n.id) }));
      const edges = rg.edges.map(e => ({ ...e, critical: criticalIds.includes(e.source) && criticalIds.includes(e.target) }));
      return {
        type: 'graph', engine: 'local', layout: 'critical',
        data: { nodes, edges, layout: 'critical', criticalIds },
        note: '关键路径 = 与最多其他卡强关联的核心卡（红大节点），掌握它们收益最大',
      };
    }
    case 'common': {
      const kw = commonKeywords(cards);
      // 判定命中档位：有词覆盖过半 = 强命中；否则是阈值兜底（覆盖 ≥2 张卡的高频词）
      const strong = kw.some(k => k.ratio >= 0.5);
      return {
        type: 'list', engine: 'local',
        data: kw.map(k => ({ term: k.term, cards: k.cards, ratio: k.ratio })),
        note: !kw.length
          ? '未发现显著共同知识点（所选卡片内容重叠不足，可多选几张同科目卡片再试）'
          : strong
            ? `共同知识点（覆盖 ≥50% 卡片，共 ${kw.length} 个）`
            : `未发现覆盖过半的共同知识点；以下为覆盖 ≥2 张卡的高频词（共 ${kw.length} 个，卡片跨科目时属正常）`,
      };
    }
    case 'path': {
      // ⚠️ CardLinkAnalysis.vue timeline 模板读 m.resultData?.steps，
      //   每个 step 需要 .step（序号）和 .front 字段。learningPath 原返回裸数组
      //   [{id,front,weak}]，直接赋给 .data → .steps===undefined → 渲染为空（Bug）。
      const steps = learningPath(cards, matrix).map((s, i) => ({ step: i + 1, ...s }));
      return {
        type: 'timeline', engine: 'local',
        data: { steps, order: steps.map(s => s.id) },
        note: '学习顺序：基础在前 + 薄弱优先',
      };
    }
    case 'compare': {
      // ⚠️ compareCards 原返回 {same:[{text},{text}],diff:[{text},{text}],similarity,...}，
      //   normalizeList 把 same/diff 两个子数组当作 Object.values 的「对象元素」产出，
      //   每个 v-for it 是外层数组 → it.term/it.text 全 undefined → 整列表空白。
      //   重写为 items 结构，每项对应 list 模板的 {term, text, detail} 字段。
      const cmp = compareCards(cards);
      const d = cmp.data || {};
      const jac = jaccard(cardProfile(cards[0]), cardProfile(cards[1]));
      const items = [
        {
          term: '卡片对比',
          detail: `A「${(cards[0]?.front || '').slice(0, 24)}」 vs B「${(cards[1]?.front || '').slice(0, 24)}」 · 内容相似度 ${(Number(d.similarity ?? jac) * 100).toFixed(1)}%`,
        },
        { term: '### 共同点', text: (d.same || []).map(x => `- ${typeof x === 'object' && x.text ? x.text : String(x)}`).join('\n') || '（未发现显著共同点）' },
        { term: '### 差异点', text: (d.diff || []).map(x => `- ${typeof x === 'object' && x.text ? x.text : String(x)}`).join('\n') || '（内容非常接近）' },
      ];
      return { type: 'list', engine: 'local', data: { items }, note: `内容相似度：${(Number(d.similarity ?? jac) * 100).toFixed(1)}%` };
    }
    default:
      return { type: 'text', data: { text: `未知预设：${preset}` }, engine: 'local' };
  }
}
