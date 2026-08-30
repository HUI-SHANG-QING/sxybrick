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
