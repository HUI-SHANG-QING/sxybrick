// 资料 ↔ 卡片 知识图谱联动纯函数层（Phase 6.6）
// 目标：让「资料」成为知识图谱的一等节点，与它覆盖的卡片建立「涵盖」边。
// 匹配策略：零 LLM、零新索引——卡片 front 的核心（去空白/标点）是资料全文的子串，
//           说明这张卡片的知识点确实在资料里讲过（真题题干/讲义摘录场景高度可靠）。
// 纯函数无浏览器依赖，Node 可测。

/** 资料节点显示名（图谱里与卡片节点区分，带文档前缀） */
export function docNodeLabel(doc) {
  const name = String(doc?.name || doc?.title || '未命名资料').trim();
  return `📄 ${name}`;
}

/** 剥离标点/空白，提取文本「实义核心」（中英数，用于子串匹配） */
export function stripForMatch(s) {
  return String(s ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
}

/**
 * 判断一张卡片是否「出自」某资料。
 * 真题题干多为问句（「…有哪些？」），资料原文是陈述（「…有 LRU、FIFO」），整串子串不匹配。
 * 故用「前缀逐步缩尾」：取 front 核心前缀（最长 20 字）逐步缩短到 minLen，
 * 只要某个前缀是资料全文子串即命中——题干主体前缀在原文中高度可靠。
 */
export function cardInDoc(card, docText, { minLen = 6 } = {}) {
  const core = stripForMatch(card?.front);
  if (core.length < minLen) return false;
  const hay = stripForMatch(docText);
  const maxSeed = Math.min(core.length, 20);
  for (let len = maxSeed; len >= minLen; len--) {
    if (hay.includes(core.slice(0, len))) return true;
  }
  return false;
}

/**
 * 生成「资料 --涵盖--> 卡片」边（供 createGraphEdge 消费）。
 * @param {object} doc docFiles 行
 * @param {Array} cards 命中的卡片
 * @returns {Array<{from,to,label,subject,docId,type}>}
 */
export function buildDocCardEdges(doc, cards) {
  const label = docNodeLabel(doc);
  const subject = String(doc?.subject || '');
  return (cards || []).map((c) => ({
    from: label,
    to: String(c?.front || '').trim(),
    label: '涵盖',
    subject,
    docId: String(doc?.id || ''),
    type: 'doc-card',
  }));
}

/**
 * 在全文定位关键词并截取上下文片段（错题溯源/复习上下文用）。
 * 定位与截取都在「去空白/标点」后的文本上进行（保证题干问句也能命中原文陈述），
 * 返回去标点片段（内容完整，标点损耗可接受）。
 * @param {string} text 全文
 * @param {string} keyword 关键词（卡片 front 核心）
 * @param {object} opts { radius=160 } 前后各取多少字符
 * @returns {string} 片段；未命中返回空串
 */
export function excerptAround(text, keyword, { radius = 160 } = {}) {
  const stripped = stripForMatch(text);
  const core = stripForMatch(keyword);
  if (!core || core.length < 4) return '';
  // 与 cardInDoc 同策略：前缀缩尾定位（题干问句 → 原文陈述）
  let idx = -1;
  let matchedLen = 0;
  const minLen = 4;
  for (let len = Math.min(core.length, 20); len >= minLen; len--) {
    const i = stripped.indexOf(core.slice(0, len));
    if (i >= 0) { idx = i; matchedLen = len; break; }
  }
  if (idx < 0) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(stripped.length, idx + matchedLen + radius);
  return (start > 0 ? '…' : '') + stripped.slice(start, end) + (end < stripped.length ? '…' : '');
}

/** 卡片血缘是否指向某份资料（card.source 存 docFiles.id） */
export function traceCardDocId(card) {
  const s = String(card?.source || '').trim();
  return s || '';
}
