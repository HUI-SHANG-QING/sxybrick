// 思维导图 → 图结构（纯函数层，Node 可测）
// 抽出来的原因：这段逻辑踩过一个很隐蔽的坑（见下），必须有单测守住。

/**
 * 树 → 扁平 nodes/links（供 ECharts 桑基图、力导向图用）
 *
 * ⚠️ 关键：ECharts 的 graph / sankey 系列都走 createGraphFromNodeEdge，
 * 节点注册键是 `retrieve(node.id, node.name, index)`——**只要节点带了 id，
 * 边就只能按 id 匹配**。若 links 用 name 作 source/target，
 * `graph.addEdge()` 内部 `nodesMap[generateNodeKey(name)]` 查不到节点，
 * 会**静默 return**（不抛错、不告警），结果是「节点全在、连线全无」，
 * 用户看到的就是一堆互不相干的散点。
 *
 * 因此这里统一用节点 id 建边；同名节点合并后，边指向保留下来的那个节点的 id。
 *
 * @param {object} root 树根（形如 { id, label, children:[] } 或 { id, name, children:[] }）
 * @returns {{ nodes: Array<{name,id}>, links: Array<{source,target,value}> }}
 */
export function treeToFlat(root) {
  const nodes = [];
  const links = [];
  const byName = new Map();
  const linkSeen = new Set();
  let auto = 0;

  const ensureNode = (node, name) => {
    const hit = byName.get(name);
    if (hit) return hit;
    const n = { name, id: node.id || `mm-auto-${auto++}` };
    byName.set(name, n);
    nodes.push(n);
    return n;
  };

  const walk = (node, parent) => {
    if (!node) return;
    const name = String(node.name ?? node.label ?? '').trim();
    if (!name) return;
    const self = ensureNode(node, name);
    if (parent && parent.id !== self.id) {
      const key = `${parent.id} ${self.id}`;
      if (!linkSeen.has(key)) {
        linkSeen.add(key);
        links.push({ source: parent.id, target: self.id, value: 1 });
      }
    }
    for (const c of node.children || []) walk(c, self);
  };

  walk(root, null);
  return { nodes, links };
}

/**
 * 断言「每条 link 的两端都能在 nodes 里按 id 找到」——
 * 这正是 ECharts 建图时的匹配口径，用来兜住上面那个静默丢边的坑。
 * @returns {{ ok:boolean, orphans:Array }}
 */
export function verifyLinks(nodes, links) {
  const ids = new Set((nodes || []).map(n => n.id));
  const orphans = (links || []).filter(l => !ids.has(l.source) || !ids.has(l.target));
  return { ok: orphans.length === 0, orphans };
}

/**
 * 树 → 桑基图数据。
 *
 * ⚠️ 关键差异：ECharts 的 **sankey 系列**在节点带 `id` 时会把 `id` 当作
 * label 文本渲染（一堆字母），与 graph/force 系列用 `data.name` 不同。
 * 因此桑基图只用 `name` 作为节点唯一键，links 也按 `name` 匹配。
 * treeToFlat 内部已按 name 合并同名节点，故 name 唯一，可按 name 建边。
 *
 * @param {object} root 树根
 * @returns {{ nodes: Array<{name:string}>, links: Array<{source:string,target:string}> }}
 */
export function sankeyFromTree(root) {
  const { nodes, links } = treeToFlat(root);
  const nameById = new Map(nodes.map(n => [n.id, n.name]));
  return {
    nodes: nodes.map(n => ({ name: n.name })),
    links: links.map(l => ({
      source: nameById.get(l.source) || l.source,
      target: nameById.get(l.target) || l.target,
    })),
  };
}

/**
 * 桑基图需要的容器高度（px）。
 *
 * 背景：ECharts sankey 系列不支持 roam/zoom，节点数多时若容器高度不够，
 * nodeGap 无处施展，节点会被压扁糊成一团（用户反馈「桑基图太密集看不清」）。
 * 纯函数抽出便于单测，视图层用它动态撑高 .mm-chart 容器。
 *
 * 口径：nodeGap 取 Math.min(32, Math.max(14, 700/n))（与 Mindmap.vue buildOption
 * 保持一致）+ 每节点 minNodeHeight=6 + 上下边距 80，高度随节点数线性增长，
 * 上限 2400（超出部分靠用户滚动查看，容器本身不再无限长）。
 *
 * 注意：超过降级阈值（>120 节点或 >240 边，与 Mindmap.vue 的降级判断同源）时
 * 返回 0——此时视图层渲染的是力导向布局，沿用默认容器高度即可。
 *
 * @param {object} root 树根
 * @returns {number} 建议容器高度（px）；0 表示走降级力导向、无需撑高
 */
export function sankeyNeedHeight(root) {
  const { nodes, links } = sankeyFromTree(root);
  if (nodes.length > 120 || links.length > 240) return 0;
  const n = Math.max(1, nodes.length);
  const gap = Math.min(32, Math.max(14, 700 / n));
  const h = 80 + n * (gap + 6);
  return Math.min(2400, Math.max(560, Math.ceil(h)));
}
