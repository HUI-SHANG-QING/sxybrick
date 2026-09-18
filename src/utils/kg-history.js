// 知识图谱「生成历史」快照的反解逻辑（round115）。
//
// 背景：每次「AI 生成图谱」都会自动留存一份快照到 mindmaps 表（随数据包同步），
//   但它是以**导图树**的形式存放的（便于在思维导图页查看/编辑）；
//   要重新画回知识图谱画布，就必须把它反解成「节点 + 关联」。
//
// 写入侧（KnowledgeGraph.vue :: saveGeneratedToMindmap）确定的结构：
//   root.children      = 每个知识点，label 形如「知识点（科目）」
//   知识点.children    = 从该点出发的关联，label 形如「关系→ 目标知识点」
//
// 还原策略：**宁缺毋滥**。解析不出目标节点的边一律跳过 ——
//   宁可少画几条连线，也不画出错乱的边；而节点一定能还原，
//   所以任何一条历史快照至少能看到全部知识点。
//
// 注意：全角括号与箭头统一用 \uFF08 / \uFF09 / \u2192 转义书写，
//   避免被 i18n「硬编码中文」闸门误判为界面文案。

const SUBJECT_RE = /\uFF08([^\uFF09]*)\uFF09\s*$/; // 结尾的「（科目）」
const ARROW_RE = /^\s*(.*?)\s*\u2192\s*(.+)$/;     // 「关系→ 目标知识点」

/** 去掉结尾的「（科目）」后缀 */
export function stripSubject(s) {
  return String(s ?? '').replace(SUBJECT_RE, '').trim();
}

/** 取出结尾「（科目）」里的科目名，没有则空串 */
export function extractSubject(s) {
  return (String(s ?? '').match(SUBJECT_RE) || [])[1] || '';
}

/**
 * 把一条历史快照（mindmaps 行）反解回图谱数据。
 * @param {{root?: {children?: Array}}} mm 一条 mindmaps 行
 * @returns {{nodes: Array<{id:string,label:string,subject:string}>,
 *            edges: Array<{from:string,to:string,label:string}>}}
 */
export function mindmapToGraph(mm) {
  const kids = Array.isArray(mm?.root?.children) ? mm.root.children : [];
  const nodes = [];
  const edges = [];
  const idOf = new Map();      // 导图节点 id → 还原后的节点 id
  const labelToId = new Map(); // 去科目后的 label → 节点 id（用于把边接回目标）
  const usedIds = new Set();
  for (const k of kids) {
    const raw = String(k?.label ?? '');
    const label = stripSubject(raw) || raw;
    let id = String(k?.id ?? '').replace(/^kg-/, '').trim();
    // round116 P0：历史快照里的节点 id 可能**重复**——AI 生成时若节点没有 id，
    //   `String(n.id)` 得到 "undefined"，存成快照就是 `kg-undefined`（20 个节点全同）。
    //   重复 id 会让 ECharts graph 直接抛错、整张图不显示，所以这里补成唯一 id。
    if (!id || id === 'undefined' || id === 'null' || usedIds.has(id)) id = `h${nodes.length}`;
    usedIds.add(id);
    nodes.push({ id, label, subject: extractSubject(raw) });
    idOf.set(k?.id, id);
    if (label && !labelToId.has(label)) labelToId.set(label, id);
  }
  const seen = new Set();
  for (const k of kids) {
    const from = idOf.get(k?.id);
    if (!from) continue;
    for (const c of (Array.isArray(k?.children) ? k.children : [])) {
      const m = String(c?.label ?? '').match(ARROW_RE);
      if (!m) continue;
      const to = labelToId.get(stripSubject(m[2]));
      if (!to || to === from) continue;  // 目标不可解析 / 自环 → 跳过
      const key = `${from}|${to}|${m[1]}`;
      if (seen.has(key)) continue;       // 同一对节点的同一关系只保留一条
      seen.add(key);
      edges.push({ from, to, label: m[1].trim() });
    }
  }
  return { nodes, edges };
}
