// 知识图谱「ID 空间」统一解析层（纯函数，Node 可测）
//
// 背景（本次修复的核心问题）：
//   db.graphEdges 里混着三种写法，导致图谱「看着有 2684 条关联，其实是一盘散沙」：
//     1) label 型：from/to 存卡片正面文本，另带 fromCardId/toCardId（AI 生成 / 智能推荐 / agent）
//     2) cardId 型：from/to 直接存卡片 UUID（graphAuto 自动构建，且不带 label/subject）
//     3) 资料型：from 是「📄 文件名」，to 是卡片文本（doc-graph）
//   图谱页过去只按「label 就是 from/to 字符串」渲染，于是第 2 类边全部变成
//   一串裸 UUID 节点、subject 为空（全落进「未分类」簇），与第 1 类节点永不相通——
//   看起来就是「有连线，但没有知识上的联系」。
//
// 统一策略：**显示名 = fromCardId/toCardId 反查卡片 front；没有 cardId 才退回字面量。**
// 这样同一张卡片无论被哪种方式建边，都收敛到同一个节点上，图谱才真正连通。

/** 卡片正面文本 → 节点显示名（与 recommendGraphEdges / doc-graph 的 30 字截断口径一致） */
export function cardLabel(card, { maxLen = 30 } = {}) {
  if (!card) return '';
  const raw = String(card.front ?? card.name ?? card.title ?? '').trim();
  if (!raw) return '';
  return raw.length > maxLen ? raw.slice(0, maxLen).trim() : raw;
}

/** 端点是否「看起来像裸 ID」而非人类可读文本（用于决定要不要标注为失效端点） */
export function looksLikeRawId(s) {
  const v = String(s ?? '').trim();
  if (!v) return false;
  // UUID v4：8-4-4-4-12 十六进制
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  // 旧版 uid 兜底：base36 时间戳 + 随机串（如 mt8j0q35qzd4wkyf / mt8j0q35-xxxx）
  if (/^[0-9a-z]{8}[0-9a-z-]{7,}$/i.test(v) && !/[\u4e00-\u9fff]/.test(v)) return true;
  return false;
}

/**
 * 解析一条边的两个端点。
 * @param {object} e    graphEdges 行
 * @param {Map} cardById 卡片 id → 卡片对象
 * @returns {{ fromLabel, toLabel, subject, fromMissing, toMissing }}
 */
export function resolveEdgeEnds(e, cardById) {
  // 兼容历史脏数据：早期 graphAuto 把卡片 id 直接写进 from/to 且不带 fromCardId/toCardId。
  // 只要 from/to 本身能在卡片表里查到，就当它是 cardId 用——这样老边不用重建也能显示成正常卡片。
  const fromKey = e.fromCardId || (cardById.has(String(e.from ?? '')) ? String(e.from) : '');
  const toKey = e.toCardId || (cardById.has(String(e.to ?? '')) ? String(e.to) : '');

  const fromCard = fromKey ? cardById.get(fromKey) : null;
  const toCard = toKey ? cardById.get(toKey) : null;

  let fromLabel = cardLabel(fromCard);
  let toLabel = cardLabel(toCard);
  let fromMissing = false;
  let toMissing = false;

  if (!fromLabel) {
    // 查不到卡片 → 退回字面量；字面量是裸 ID 说明这条边已失去语义（卡片已删或数据损坏）
    fromLabel = String(e.from ?? '').trim();
    if (fromKey) fromMissing = true;                                  // 有 id 却查不到卡 = 卡片已删
    else if (looksLikeRawId(e.from)) fromMissing = true;              // 无 id 且是裸 ID = 脏数据
  }
  if (!toLabel) {
    toLabel = String(e.to ?? '').trim();
    if (toKey) toMissing = true;
    else if (looksLikeRawId(e.to)) toMissing = true;
  }

  // 科目：边自带优先 → 两端卡片的科目 → 空
  const subject = String(e.subject || '').trim()
    || String(fromCard?.subject || '').trim()
    || String(toCard?.subject || '').trim();

  return { fromLabel, toLabel, subject, fromMissing, toMissing };
}

/**
 * 把原始边表解析成「图谱可直接渲染」的 nodes / edges。
 * @param {Array} rawEdges db.graphEdges 行
 * @param {Array} cards    db.cards 全量
 * @returns {{ nodes, edges, stats }}
 *   nodes: [{ id(节点键=显示名), label, subject }]
 *   edges: [{ id, from, to, label, subject, type, docId, resolved, missing }]
 *   stats: { total, resolved, missing, bySubject: Map }
 */
export function resolveGraph(rawEdges, cards, opts = {}) {
  const cardById = new Map((cards || []).map(c => [c.id, c]));
  const nodeMap = new Map();
  const edges = [];
  let resolved = 0, missing = 0;

  const putNode = (label, subject) => {
    const key = String(label || '').trim();
    if (!key) return;
    const hit = nodeMap.get(key);
    if (hit) {
      // 同一节点被多条边引用时，用第一次拿到的非空 subject 补全
      if (!hit.subject && subject) hit.subject = subject;
      return;
    }
    nodeMap.set(key, { id: key, label: key, subject: subject || '' });
  };

  for (const e of rawEdges || []) {
    const { fromLabel, toLabel, subject, fromMissing, toMissing } = resolveEdgeEnds(e, cardById);
    const bad = fromMissing || toMissing;
    if (bad) missing++; else resolved++;
    putNode(fromLabel, subject);
    putNode(toLabel, subject);
    edges.push({
      id: e.id,
      from: fromLabel,
      to: toLabel,
      label: String(e.label || '').trim() || '相关',
      subject,
      type: String(e.type || '').trim(),
      docId: String(e.docId || '').trim(),
      fromCardId: String(e.fromCardId || '').trim(),
      toCardId: String(e.toCardId || '').trim(),
      weight: typeof e.weight === 'number' ? e.weight : undefined,
      missing: bad,
      resolved: !bad,
    });
  }

  // 端点缺失的边默认不参与构图（否则又把裸 ID 节点混进图里），但可通过开关保留
  const includeMissing = opts.includeMissing === true;
  const visibleEdges = includeMissing ? edges : edges.filter(e => !e.missing);
  const used = new Set();
  for (const e of visibleEdges) { used.add(e.from); used.add(e.to); }
  const nodes = [...nodeMap.values()].filter(n => used.has(n.id));

  const bySubject = new Map();
  for (const e of edges) {
    const k = e.subject || '未分类';
    bySubject.set(k, (bySubject.get(k) || 0) + 1);
  }

  return { nodes, edges: visibleEdges, allEdges: edges, stats: { total: edges.length, resolved, missing, bySubject } };
}

/**
 * 归一化 ECharts graph 系列的 nodes/edges 端点。
 *
 * 用途：喂给 ECharts 之前把「按 id 写」和「按 name 写」两种来源统一成 **按 id**，
 * 否则节点带了 id 而边写的是 name 时，边会被 addEdge() 静默丢弃（见文件头说明）。
 *
 * 典型场景：LLM 生成的图谱。prompt 里明确要求用卡片 id，但模型经常照着语义
 * 返回节点名——本地分析器（relationGraph）用 id，AI 则可能用 name，
 * 两者走同一个 graphOption()，不归一化就会「数据明明有，图却是散点」。
 *
 * @returns {{ edges:Array, dropped:number }} dropped = 两端都定位不到的边数
 */
export function normalizeGraphEnds(nodes, edges) {
  const byId = new Map();
  const byName = new Map();
  for (const n of nodes || []) {
    const id = n?.id == null ? '' : String(n.id).trim();
    const name = n?.name == null ? '' : String(n.name).trim();
    if (id) byId.set(id, n);
    if (name && !byName.has(name)) byName.set(name, n);
  }
  const resolve = (v) => {
    const k = String(v ?? '').trim();
    if (!k) return null;
    const hit = byId.get(k) || byName.get(k);
    if (!hit) return null;
    const id = hit.id == null ? '' : String(hit.id).trim();
    return id || String(hit.name ?? '').trim() || null;
  };

  const out = [];
  let dropped = 0;
  for (const e of edges || []) {
    const s = resolve(e?.source);
    const t = resolve(e?.target);
    if (s == null || t == null) { dropped++; continue; }
    out.push({ ...e, source: s, target: t });
  }
  return { edges: out, dropped };
}

/**
 * 有向边 → 森林（防环），供「树状 / 导图」复用。
 * 与旧实现一致：入度为 0 的点都作为子树根，多个不连通子树包一层虚拟根。
 */
export function edgesToForest(edges, { rootLabel = '📚 知识图谱', virtualKey = '__virtual_root__' } = {}) {
  const childrenOf = new Map();
  const all = new Set();
  const inDeg = new Map();
  for (const e of edges || []) {
    const f = String(e.from || '').trim();
    const t = String(e.to || '').trim();
    if (!f || !t || f === t) continue;
    all.add(f); all.add(t);
    if (!childrenOf.has(f)) childrenOf.set(f, []);
    childrenOf.get(f).push(t);
    inDeg.set(t, (inDeg.get(t) || 0) + 1);
  }
  // 环上的点入度都 > 0，此时退化为「全部节点当候选根」，保证不丢节点
  let roots = [...all].filter(n => !inDeg.has(n));
  if (!roots.length) roots = [...all];

  const build = (label, visited) => {
    if (visited.has(label)) return null;
    visited.add(label);
    const kids = [];
    for (const k of childrenOf.get(label) || []) {
      const built = build(k, new Set(visited));
      if (built) kids.push(built);
    }
    return { name: label, children: kids };
  };

  const seen = new Set();
  const subTrees = [];
  for (const r of roots) {
    const t = build(r, new Set());
    if (!t) continue;
    // build 用 new Set(visited) 传副本，环上的点可能在多个子树里重复出现 → 去重
    const key = JSON.stringify(t);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const c of t.children) seen.add(JSON.stringify(c));
    subTrees.push(t);
  }
  const covered = new Set();
  const collect = n => { covered.add(n.name); for (const c of n.children) collect(c); };
  for (const t of subTrees) collect(t);
  // 环内节点（既非根又没被任何子树覆盖）单独补上，避免静默丢节点
  for (const n of all) {
    if (!covered.has(n)) subTrees.push({ name: n, children: [] });
  }

  if (subTrees.length === 1) return { root: subTrees[0], virtual: false };
  return { root: { name: rootLabel, [virtualKey]: true, children: subTrees }, virtual: true };
}
